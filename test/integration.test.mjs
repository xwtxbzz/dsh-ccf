/**
 * 端到端集成测试（需要网络）：
 *   真正的 cordis + `@deepseek-ai/dsh-host-webserver` + 本插件 → 起一个回环端口
 *   → POST /dsh-ccf/api/v1/sync 拉真实上游数据 → GET /dsh-ccf/api/v1/records 读到会议。
 *
 * 这条链路验证的是「客户端面板真正会走的那条路」，单元测试覆盖不到：
 * 服务发现、路由注册顺序、真实 HTTP 往返、真实缓存文件。
 *
 * 跑法：node test/integration.test.mjs   （npm run test:integration）
 * 没网时会跳过上游断言，只验证路由骨架。
 */
import { dedupeVenueYear } from '../lib/core.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = new URL('..', import.meta.url).pathname
const sdkRoot = 'C:/Users/15961/.dsh/profiles/node_modules/@deepseek-ai'
const loadSdk = (name) => import(`file:///${sdkRoot}/${name}/lib/index.js`)

const { Context } = await loadSdk('cordis')
const WebServer = (await loadSdk('dsh-host-webserver')).default
const { defineTool } = await loadSdk('dsh-tools')
const { createCcf } = await import(new URL('../lib/create.js', import.meta.url).href)

/**
 * 等价于 lib/index.js 的默认导出，只是 `defineTool` 用绝对路径拿到 ——
 * 本仓库没装 SDK 依赖（CI 也不装），真实安装后走的是正常的包名解析。
 */
class Plugin {
  constructor(ctx, config = {}) {
    this.ccf = createCcf(ctx, config, defineTool)
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-ccf-it-'))
const root = new Context()
root.logger = { info() {}, warn() {}, error() {} }

await root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
await root.plugin(Plugin, { dataDir, windowDays: 120, prompt: false })

const port = root.webServer.port
const base = `http://127.0.0.1:${port}`
console.log(`webserver on ${base} · dataDir=${dataDir}`)

try {
  // 1. 冷启动：没有缓存 → 200 + 0 条
  const cold = await (await fetch(`${base}/dsh-ccf/api/v1/records`)).json()
  assert.equal(cold.ok, true)
  assert.equal(cold.count, 0)
  // 冷启动时没有一条截稿数据，但名单应该已经能摊开给面板看
  assert.ok(cold.counts && cold.counts.conferences > 300, '面板应带上 CCF 名单（362 个会议）')
  assert.equal(cold.counts.pending, cold.counts.conferences, '没有数据时名单里的会全部算待补')
  console.log(`冷启动: 名单 ${cold.counts.conferences} 个会，全部待补`)

  // 2. 同步（真实上游）
  const syncResponse = await fetch(`${base}/dsh-ccf/api/v1/sync`, { method: 'POST' })
  const synced = await syncResponse.json()
  const cache = JSON.parse(readFileSync(join(dataDir, 'cache.json'), 'utf8'))
  console.log(`sync: status=${syncResponse.status} ok=${synced.ok} synced=${synced.synced} records=${cache.records.length}`)
  if (!synced.synced) {
    console.log('上游不可达（离线），跳过数据断言')
  } else {
    assert.ok(cache.records.length > 0)
    const after = await (await fetch(`${base}/dsh-ccf/api/v1/records`)).json()
    // 缓存里可能有两代记录指同一个会（S&P / IEEE S&P），面板只给去重后的一条
    assert.equal(after.count, dedupeVenueYear(cache.records).length)
    assert.ok(after.records.some((row) => row.deadline))
    const cvpr = after.records.find((row) => row.venue === 'CVPR')
    assert.ok(cvpr, 'CVPR 应该在数据里')
    assert.ok(cvpr.deadline, 'CVPR 应该有截稿时间')
    console.log(`面板可见: ${after.records.length} 条，CVPR 截稿=${cvpr.deadline}`)
    assert.ok(after.counts.pending > 0, '回退数据只覆盖一部分会，其余应列成待补')
    assert.ok(after.counts.pending + after.counts.records <= after.counts.conferences + after.counts.records, '计数自洽')
    assert.ok(after.pending.some((row) => row.rank === 'CCF-A'), '待补里应有 CCF-A 的会')
    console.log(`待补: ${after.counts.pending} 个会（名单 ${after.counts.conferences} 个）`)
  }

  // 3. 模型挖掘（本进程没有 llm 服务 → 必须如实降级到 ccfddl，并给出致谢）
  const updateResponse = await fetch(`${base}/dsh-ccf/api/v1/update`, { method: 'POST' })
  const updated = await updateResponse.json()
  assert.equal(updateResponse.status, 200)
  assert.equal(updated.ok, true)
  assert.equal(updated.model, false, '没有 llm 服务时必须报告模型不可用')
  assert.equal(updated.fallback, true, '没有模型时应回退到 ccfddl')
  assert.ok(updated.attribution.includes('ccfddl'), '回退必须注明出处')
  assert.ok(updated.attribution.includes('感谢'), '回退必须致谢')
  assert.ok(updated.catalog && updated.catalog.conferences > 300, '名单应被带上（362 个会议）')
  assert.ok(updated.meta && updated.meta.pending > 0, '名单里应还有大量会待补')
  assert.equal(updated.meta.modelUsed, false)
  console.log(`update: model=${updated.model} fallback=${updated.fallback} catalog=${updated.catalog.conferences} pending=${updated.meta.pending}`)

  // 4. 方法约束
  assert.equal((await fetch(`${base}/dsh-ccf/api/v1/records`, { method: 'POST' })).status, 405)
  assert.equal((await fetch(`${base}/dsh-ccf/api/v1/sync`)).status, 405)
  assert.equal((await fetch(`${base}/dsh-ccf/api/v1/update`)).status, 405)
  assert.equal((await fetch(`${base}/dsh-ccf/api/v1/prefer`)).status, 405)

  // 5. 采信另一来源：只改显示，缓存里的主记录不动
  const preferPayload = await (await fetch(`${base}/dsh-ccf/api/v1/records`)).json()
  const contested = preferPayload.records.find((row) => Array.isArray(row.alternatives) && row.alternatives.length > 0)
  if (contested) {
    const before = cache.records.find((row) => row.key === contested.key)
    const adopted = await (await fetch(`${base}/dsh-ccf/api/v1/prefer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: contested.key, source: contested.alternatives[0].source }),
    })).json()
    assert.equal(adopted.ok, true)
    const afterPrefer = adopted.records.find((row) => row.key === contested.key)
    assert.equal(afterPrefer.preferredSource, contested.alternatives[0].source)
    assert.equal(afterPrefer.deadline, contested.alternatives[0].deadline, '采信后显示另一来源的日期')
    assert.ok(afterPrefer.alternatives.some((item) => item.source === before.source), '原来的首选应变成"另一种说法"')
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'cache.json'), 'utf8')).records.find((row) => row.key === contested.key)
    assert.equal(onDisk.deadline, before.deadline, '缓存里的主记录不能被显示偏好改掉')

    const reset = await (await fetch(`${base}/dsh-ccf/api/v1/prefer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: contested.key, source: '' }),
    })).json()
    assert.equal(reset.records.find((row) => row.key === contested.key).preferredSource, '')
    console.log(`prefer: ${contested.key} 采信 ${contested.alternatives[0].source} → 显示 ${afterPrefer.deadline}，已恢复默认`)
  } else {
    console.log('prefer: 这轮数据里没有两源冲突的会，跳过')
  }

  console.log('INTEGRATION OK')
} finally {
  await root.fiber.dispose()
  rmSync(dataDir, { recursive: true, force: true })
}
