/**
 * 同步层测试：JSON 归一化、本地 ccfddl 目录、tar.gz 解包、缓存读写。
 *
 * tar 部分用本地 HTTP 服务喂一个真的 tar.gz（不联网），验证 gunzip + 512 字节头解析。
 *
 * 运行：node test/sync.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadCache, readTar, recordsFromCcfddlDir, recordsFromCcfddlTar, recordsFromJson, saveCache, syncSources } from '../lib/sync.js'

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const JSON_PAYLOAD = JSON.stringify([
  {
    name: 'CVPR 2027',
    fullName: 'IEEE/CVF CVPR',
    area: 'CV',
    rank: 'CCF-A',
    deadline: '2026-11-13T23:59:59-08:00',
    abstractDeadline: '2026-11-06T23:59:59-08:00',
    link: 'https://cvpr.thecvf.com',
  },
  { name: 'no deadline 2027', rank: 'CCF-B' },
])

const YAML_DOC = `- title: ICASSP
  description: IEEE ICASSP
  sub: SP
  rank: B
  confs:
    - year: 2027
      link: https://2027.ieeeicassp.org/
      timeline:
        - abstract_deadline: '2026-09-02 23:59:59'
          deadline: '2026-09-09 23:59:59'
      timezone: AoE
      date: May 2027
      place: TBD
`

/** 造一个 ustar 条目 + 512 字节对齐，供 readTar 解析。 */
function tarEntry(name, body) {
  const content = Buffer.from(body, 'utf8')
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'utf8')
  header.write('0000000\0', 108, 8, 'utf8')
  header.write('0000000\0', 116, 8, 'utf8')
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
  header.write('00000000000\0', 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8')
  header.write('0', 156, 1, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  header.write('00', 263, 2, 'utf8')
  const padding = 512 - (content.length % 512 || 512) + 512
  const pad = Buffer.alloc(content.length % 512 === 0 ? 0 : 512 - (content.length % 512), 0)
  void padding
  return Buffer.concat([header, content, pad])
}

function makeTar(entries) {
  return Buffer.concat([...entries.map(([name, body]) => tarEntry(name, body)), Buffer.alloc(1024, 0)])
}

console.log('sync.test')

await test('recordsFromJson：裸数组 / conferences / data，坏数据抛错', () => {
  const records = recordsFromJson(JSON_PAYLOAD, 'paper-deadlines')
  assert.equal(records.length, 1, '没有截稿/摘要截止的记录被丢掉')
  assert.equal(records[0].venue, 'CVPR')
  assert.equal(new Date(records[0].deadline).toISOString(), '2026-11-14T07:59:59.000Z')
  assert.equal(records[0].source, 'paper-deadlines')

  const wrapped = recordsFromJson(JSON.stringify({ conferences: [{ name: 'ICLR 2027', deadline: '2027-01-01' }] }), 'x')
  assert.equal(wrapped.length, 1)
  const dataWrapped = recordsFromJson(JSON.stringify({ data: [{ name: 'ICML 2027', deadline: '2027-02-01' }] }), 'x')
  assert.equal(dataWrapped.length, 1)

  assert.throws(() => recordsFromJson('{"nope":1}', 'x'), /conferences/)
})

await test('recordsFromCcfddlDir：读 conferences/*.yml', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ccf-dir-'))
  try {
    await mkdir(join(dir, 'conferences'), { recursive: true })
    await writeFile(join(dir, 'conferences', 'icassp.yml'), YAML_DOC, 'utf8')
    await writeFile(join(dir, 'conferences', 'README.md'), 'not yaml', 'utf8')
    const records = await recordsFromCcfddlDir(dir, 'ccfddl-dir')
    assert.equal(records.length, 1)
    assert.equal(records[0].venue, 'ICASSP')
    assert.equal(records[0].rank, 'CCF-B')
    assert.equal(new Date(records[0].deadline).toISOString(), '2026-09-10T11:59:59.000Z')

    const bad = await mkdtemp(join(tmpdir(), 'dsh-ccf-bad-'))
    await assert.rejects(() => recordsFromCcfddlDir(bad), /没有找到 conferences/)
    await rm(bad, { recursive: true, force: true })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('readTar：解析 512 字节头与 body', () => {
  const tar = makeTar([['pkg-main/conferences/icassp.yml', YAML_DOC], ['pkg-main/README.md', 'hi']])
  const entries = readTar(tar)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].name, 'pkg-main/conferences/icassp.yml')
  assert.equal(entries[0].body.toString('utf8'), YAML_DOC)
  assert.equal(entries[1].body.toString('utf8'), 'hi')
})

await test('recordsFromCcfddlTar：本地 HTTP + gzip 全链路', async () => {
  const tarGz = gzipSync(makeTar([
    ['ccf-deadlines-main/README.md', '# repo'],
    ['ccf-deadlines-main/conferences/icassp.yml', YAML_DOC],
  ]))
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/gzip' })
    response.end(tarGz)
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  try {
    const records = await recordsFromCcfddlTar(`http://127.0.0.1:${port}/main.tar.gz`, { timeoutMs: 5000 })
    assert.equal(records.length, 1)
    assert.equal(records[0].venue, 'ICASSP')
    assert.equal(records[0].source, 'ccfddl-tar')
  } finally {
    server.close()
  }
})

await test('syncSources：JSON 源成功、多源合并去重、失败时保留旧缓存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ccf-sync-'))
  const server = createServer((request, response) => {
    if (request.url === '/data.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON_PAYLOAD)
      return
    }
    response.writeHead(500)
    response.end('boom')
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  try {
    const result = await syncSources({
      dataDir: dir,
      sources: [
        { id: 'local-json', type: 'json', url: `http://127.0.0.1:${port}/data.json` },
        { id: 'broken', type: 'json', url: `http://127.0.0.1:${port}/missing.json` },
      ],
      timeoutMs: 5000,
    })
    assert.equal(result.ok, true)
    assert.equal(result.cache.records.length, 1)
    assert.match(result.report, /local-json：1 条/)
    assert.match(result.report, /broken：失败/)
    assert.equal(result.cache.reports.length, 2)

    const cached = await loadCache(dir)
    assert.equal(cached.records.length, 1)
    assert.equal(cached.schema, 'dsh-ccf/cache/v1')
    assert.ok(cached.updatedAt > 0)

    // 全部源失败：保留旧缓存，不把 updatedAt 改成"现在"
    const previousUpdatedAt = cached.updatedAt
    const failed = await syncSources({
      dataDir: dir,
      sources: [{ id: 'broken', type: 'json', url: `http://127.0.0.1:${port}/missing.json` }],
      timeoutMs: 5000,
    })
    assert.equal(failed.ok, false)
    assert.match(failed.report, /保留上次缓存 1 条/)
    const after = await loadCache(dir)
    assert.equal(after.records.length, 1)
    assert.equal(after.updatedAt, previousUpdatedAt)
    assert.ok(after.lastError)

    // 显式写入 + 读回
    await saveCache(dir, { schema: 'dsh-ccf/cache/v1', updatedAt: 1, records: [] })
    assert.deepEqual((await loadCache(dir)).records, [])
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

console.log(`\n${passed} passed`)
