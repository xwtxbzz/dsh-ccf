/**
 * 装配层测试：工具、命令、prompt 段（用替身 defineTool + 替身 ctx，不联网）。
 *
 * 运行：node test/plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCcf, parseFlags } from '../lib/create.js'

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const fakeDefineTool = (definition) => definition

function fakeContext() {
  const registered = { tools: [], commands: [], sections: [] }
  return {
    registered,
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      services: {
        tools: { register: (tool) => registered.tools.push(tool) },
        commands: { register: (command) => registered.commands.push(command) },
        systemPrompt: { section: (section) => registered.sections.push(section) },
      },
      get(name) { return this.services[name] },
      on() { return () => {} },
    },
  }
}

const NOW = Date.now()

const sampleRecords = [
  {
    key: 'cvpr|2027', venue: 'CVPR', year: 2027, name: 'CVPR 2027',
    fullName: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition',
    rank: 'CCF-A', area: 'CV', core: 'A*',
    abstractDeadline: NOW + 6 * 86400e3, deadline: NOW + 13 * 86400e3, notification: NOW + 80 * 86400e3,
    confDate: '2027-06', place: 'TBD', link: 'https://cvpr.thecvf.com', submitLink: '',
    aliases: [], acceptRate: '~23%', h5: 300, history: ['2026-11-14'], verified: false, source: 'paper-deadlines',
  },
  {
    key: 'icassp|2027', venue: 'ICASSP', year: 2027, name: 'ICASSP 2027', fullName: 'IEEE ICASSP',
    rank: 'CCF-B', area: 'Speech', core: '', abstractDeadline: null, deadline: NOW + 40 * 86400e3,
    notification: null, confDate: '2027-05', place: 'TBD', link: 'https://2027.ieeeicassp.org', submitLink: '',
    aliases: [], acceptRate: '', h5: null, history: [], verified: false, source: 'paper-deadlines',
  },
  {
    key: 'kdd|2027', venue: 'KDD', year: 2027, name: 'KDD 2027 (Cycle 1)', fullName: 'ACM SIGKDD',
    rank: 'CCF-A', area: 'Data Mining', core: '', abstractDeadline: null, deadline: NOW + 120 * 86400e3,
    notification: null, confDate: '2027-08', place: 'TBD', link: 'https://kdd.org', submitLink: '',
    aliases: ['SIGKDD'], acceptRate: '', h5: null, history: [], verified: false, source: 'paper-deadlines',
  },
]

const seeded = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ccf-plugin-'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'cache.json'), JSON.stringify({
    schema: 'dsh-ccf/cache/v1',
    updatedAt: NOW - 3600e3,
    reports: [{ id: 'paper-deadlines', ok: true, count: sampleRecords.length }],
    records: sampleRecords,
  }), 'utf8')
  return dir
}

console.log('plugin.test')

await test('注册 2 个工具 / 1 个命令 / 1 段 prompt', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)
    assert.equal(registered.tools.length, 2)
    assert.deepEqual(registered.tools.map((tool) => tool.name), ['ccf_deadlines', 'ccf_venue'])
    assert.equal(registered.commands.length, 1)
    assert.equal(registered.commands[0].name, 'ccf')
    assert.equal(registered.sections.length, 1)
    assert.equal(registered.sections[0].name, 'dsh-ccf')
    assert.equal(registered.sections[0].order, 150)
    assert.equal(typeof registered.sections[0].text, 'function', 'prompt 段必须是动态 provider')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('ccf_deadlines：默认窗口 120 天、按时间排序', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)
    const tool = registered.tools.find((item) => item.name === 'ccf_deadlines')
    const value = await tool.execute({})
    assert.equal(value.ok, true)
    assert.match(value.report, /CVPR 2027/)
    assert.match(value.report, /ICASSP 2027/)
    assert.match(value.report, /KDD 2027/)
    assert.equal(value.data.rows[0].venue, 'CVPR', '最近的排前面')
    assert.equal(value.data.rows.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('ccf_deadlines：天数/等级/方向/关键词过滤', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)
    const tool = registered.tools.find((item) => item.name === 'ccf_deadlines')

    const short = await tool.execute({ days: 20 })
    assert.deepEqual(short.data.rows.map((row) => row.venue), ['CVPR'])

    const aOnly = await tool.execute({ rank: 'CCF-A' })
    assert.deepEqual(aOnly.data.rows.map((row) => row.venue), ['CVPR', 'KDD'])

    const speech = await tool.execute({ area: 'Speech' })
    assert.deepEqual(speech.data.rows.map((row) => row.venue), ['ICASSP'])

    const searched = await tool.execute({ search: 'sigkdd' })
    assert.deepEqual(searched.data.rows.map((row) => row.venue), ['KDD'], '别名也能搜到')

    const past = await tool.execute({ days: 120, includePast: true })
    assert.equal(past.data.rows.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('ccf_venue：命中与未命中', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)
    const tool = registered.tools.find((item) => item.name === 'ccf_venue')

    const hit = await tool.execute({ venue: 'cvpr' })
    assert.equal(hit.ok, true)
    assert.match(hit.report, /CVPR 2027 · CCF-A/)
    assert.match(hit.report, /https:\/\/cvpr\.thecvf\.com/)

    const missing = await tool.execute({ venue: 'NIPS' })
    assert.equal(missing.ok, false)
    assert.match(missing.report, /数据里没有/)

    const empty = await tool.execute({})
    assert.equal(empty.ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('没有缓存：自动尝试同步，失败也如实说明而不是编日期', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ccf-empty-'))
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, {
      dataDir: dir,
      timeoutMs: 2000,
      sources: [{ id: 'dead', type: 'json', url: 'http://127.0.0.1:9/data.json' }],
    }, fakeDefineTool)
    const tool = registered.tools.find((item) => item.name === 'ccf_deadlines')
    const value = await tool.execute({})
    assert.equal(value.ok, false)
    assert.match(value.report, /还没有会议数据/)
    assert.match(value.report, /同步失败|取不到/)
    assert.equal(value.data.rows.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('/ccf status 与 /ccf config', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir, leadDays: 45 }, fakeDefineTool)
    const command = registered.commands[0]

    const status = await command.handler({ rawInput: 'status' })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /3 条会议/)
    assert.match(status.text, /paper-deadlines：3 条/)

    const empty = await createCcf(fakeContext().ctx, { dataDir: join(dir, 'nope') }, fakeDefineTool)
    assert.ok(empty)

    const config = await command.handler({ rawInput: 'config' })
    assert.equal(config.kind, 'success')
    assert.match(config.text, /默认窗口：120 天/)
    assert.match(config.text, /prompt 注入窗口：45 天/)
    assert.match(config.text, /Asia\/Shanghai/)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('/ccf list：位置参数天数 + 旗标', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)
    const command = registered.commands[0]

    const list = await command.handler({ rawInput: 'list 20' })
    assert.equal(list.kind, 'success')
    assert.match(list.text, /CVPR 2027/)
    assert.doesNotMatch(list.text, /ICASSP/)
    assert.match(list.text, /数据同步于/)

    const filtered = await command.handler({ rawInput: 'list 200 --rank CCF-A --search kdd' })
    assert.match(filtered.text, /KDD 2027/)
    assert.doesNotMatch(filtered.text, /ICASSP/)

    const bare = await command.handler({ rawInput: '' })
    assert.equal(bare.kind, 'success', '空输入等价于 list')

    const unknown = await command.handler({ rawInput: 'whatever' })
    assert.equal(unknown.kind, 'error')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('/ccf venue 与 /ccf sync（离线失败）', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, {
      dataDir: dir,
      timeoutMs: 2000,
      sources: [{ id: 'dead', type: 'json', url: 'http://127.0.0.1:9/data.json' }],
    }, fakeDefineTool)
    const command = registered.commands[0]

    const venue = await command.handler({ rawInput: 'venue cvpr' })
    assert.equal(venue.kind, 'success')
    assert.match(venue.text, /CVPR 2027/)

    const sync = await command.handler({ rawInput: 'sync' })
    assert.equal(sync.kind, 'error')
    assert.match(sync.text, /同步失败|取不到/)
    assert.match(sync.text, /保留上次缓存 3 条/)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('prompt 段：动态读缓存，窗口内才注入', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir, leadDays: 30 }, fakeDefineTool)
    const section = registered.sections[0]
    const text = section.text({})
    assert.match(text, /## 会议截稿（dsh-ccf）/)
    assert.match(text, /CVPR 2027/)
    assert.doesNotMatch(text, /ICASSP 2027/, '40 天后截稿的不进 30 天窗口')

    // 换一个没有缓存的目录 → 不注入
    const other = createCcf(fakeContext().ctx, { dataDir: join(dir, 'empty') }, fakeDefineTool)
    assert.equal(other.currentCache(false), null)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('parseFlags：天数、等级、方向、搜索、上限、past、refresh', async () => {
  assert.deepEqual(parseFlags(['30', '--rank', 'CCF-A']), {
    days: 30, rank: 'CCF-A', area: null, search: null, limit: null, includePast: false, refresh: false,
  })
  assert.deepEqual(parseFlags(['--area', 'CV,NLP', '--limit', '5', '--past', '--refresh']), {
    days: null, rank: null, area: 'CV,NLP', search: null, limit: 5, includePast: true, refresh: true,
  })
  assert.deepEqual(parseFlags([]), {
    days: null, rank: null, area: null, search: null, limit: null, includePast: false, refresh: false,
  })
})

console.log(`\n${passed} passed`)
