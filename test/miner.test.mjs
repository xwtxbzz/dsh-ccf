// 模型挖掘：懒更新计划、官网候选筛选、JSON 解析、清洗、runUpdate 的成功/回退两条路。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadCatalog } from '../lib/catalog.js'
import {
  ATTRIBUTION,
  callModel,
  isModelAvailable,
  mergeRecords,
  mineVenue,
  modelState,
  parseMinedJson,
  pickOfficialCandidates,
  planUpdate,
  runUpdate,
  sanitizeMined,
} from '../lib/miner.js'

const catalog = loadCatalog()
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-31T00:00:00Z')

// ---- 1. 懒更新计划 --------------------------------------------------------
const records = [
  // 有截稿时间、刚挖过 → 健康，不该进队列
  { key: 'cvpr|2027', venue: 'CVPR', year: 2027, deadline: NOW + 14 * DAY, source: 'model', minedAt: NOW - DAY },
  // 有记录但没截稿时间 → missing
  { key: 'icml|2027', venue: 'ICML', year: 2027, deadline: null, source: 'model', minedAt: NOW - 40 * DAY },
]
const plan = planUpdate({ catalog, records, now: NOW, refreshDays: 30, limit: 10 })
assert.ok(plan.scanned > 300)
assert.ok(plan.total > 300, '名单里绝大多数会都还没有数据')
assert.ok(plan.healthy >= 1, 'CVPR 应是健康的')
const missing = plan.selected.find((item) => item.abbr === 'ICML')
assert.ok(missing && missing.reason === 'missing', 'ICML 应被判定为缺截稿时间')
assert.ok(!plan.selected.some((item) => item.abbr === 'CVPR'), 'CVPR 不该进队列')
assert.ok(plan.selected.length <= 10, 'limit 应生效')

// 优先补"有记录但没时间"的，再补全新的，A 类优先
assert.equal(plan.selected[0].reason, 'missing')
assert.equal(plan.selected[0].rank, 'CCF-A')

// force 才把过期的也重挖
const stalePlan = planUpdate({ catalog, records, now: NOW + 60 * DAY, refreshDays: 30, limit: 5, force: true })
assert.ok(stalePlan.selected.some((item) => item.reason === 'stale' || item.reason === 'missing'))

// focus 只留匹配的
const focused = planUpdate({ catalog, records, now: NOW, limit: 5, focus: 'CVPR' })
assert.ok(focused.selected.every((item) => item.abbr.includes('CVPR')))

// 点名的会即使刚挖过、数据还新鲜，也必须重挖：
// 面板上的「重挖这个会」如果被 refreshDays 拦下，用户只会看到"没有需要补的会"。
{
  const justMined = [{ key: 'cvpr|2027', venue: 'CVPR', year: 2027, deadline: NOW + 14 * DAY, source: 'model', minedAt: NOW - 60 * 1000 }]
  const refocus = planUpdate({ catalog, records: justMined, now: NOW, refreshDays: 30, limit: 5, focus: 'CVPR' })
  assert.equal(refocus.selected.length, 1, '点名的会要进队列')
  assert.equal(refocus.selected[0].reason, 'focus')
  // 不点名、也不 force 的时候，新鲜的会照旧跳过（懒更新不能失效）
  const lazy = planUpdate({ catalog, records: justMined, now: NOW, refreshDays: 30, limit: 5 })
  assert.equal(lazy.selected.filter((item) => item.abbr === 'CVPR').length, 0, '懒更新时新鲜的会不该重挖')
}

// 名单外的会、且已经有未来截稿：点名重挖时也要进队列（以前这里 `ok += 1`，
// 于是面板上「重挖这个会」对名单外的会永远是"没有需要补的会"）。
{
  const outsideFresh = planUpdate({
    catalog,
    records: [{ key: 'corl|2027', venue: 'CoRL', year: 2027, deadline: NOW + 30 * DAY, source: 'model', minedAt: NOW - DAY }],
    now: NOW,
    limit: 5,
    focus: 'CoRL',
  })
  assert.equal(outsideFresh.selected.length, 1, '名单外的会点名也要排进计划')
  assert.equal(outsideFresh.selected[0].reason, 'focus')
}

// area 只补这个方向的会（中文方向名 + 英文片段都认）
const byArea = planUpdate({ catalog, records, now: NOW, limit: 8, area: '人工智能' })
assert.ok(byArea.selected.length > 0, '人工智能方向应有会议')
assert.ok(byArea.selected.every((item) => String(item.area || '').includes('人工智能')), '只应留下人工智能方向的会')
const byAreaEn = planUpdate({ catalog, records, now: NOW, limit: 8, area: 'CV' })
assert.ok(byAreaEn.selected.every((item) => String(item.area || '').toLowerCase().includes('cv')), '英文片段也应生效')

// scope 按「待补」的两类分开补：past=只有往届日期，never=一条记录都没有
const scopedRecords = [
  // 有未来截稿 → 两类都不该进
  { key: 'cvpr|2027', venue: 'CVPR', year: 2027, deadline: NOW + 14 * DAY, source: 'model', minedAt: NOW - DAY },
  // 只有往届 → 只该进 past
  { key: 'stoc|2025', venue: 'STOC', year: 2025, deadline: NOW - 400 * DAY, source: 'model' },
]
const pastOnly = planUpdate({ catalog, records: scopedRecords, now: NOW, limit: 50, scope: 'past' })
assert.deepEqual(pastOnly.selected.map((item) => item.abbr), ['STOC'], 'past 只留"有记录但只有往届"的会')
const neverOnly = planUpdate({ catalog, records: scopedRecords, now: NOW, limit: 50, scope: 'never' })
assert.ok(neverOnly.total > 300, 'never 只留"一条记录都没有"的会')
assert.ok(neverOnly.selected.every((item) => item.abbr !== 'STOC' && item.abbr !== 'CVPR'), 'never 不该包含有记录的会')
assert.ok(neverOnly.skipped >= 2, '跳过的会要记数，回执才能解释"为什么只补了这些"')

// 判定与面板同源：KDD 的记录要算到名单里的 SIGKDD 头上，不该再被当成"待补"
const convention = planUpdate({ catalog, records: [{ key: 'kdd|2027', venue: 'KDD', year: 2027, deadline: NOW + 20 * DAY }], now: NOW, limit: 500 })
assert.ok(!convention.selected.some((item) => item.abbr === 'SIGKDD'), 'KDD 的数据应算作 SIGKDD 的数据')

// 名单外的会也能按名字补（CoRL 不在 CCF 名单里，但面板上就有它的卡片）
const outsideNew = planUpdate({ catalog, records: [], now: NOW, limit: 5, focus: 'CoRL' })
assert.equal(outsideNew.selected.length, 1, '名单外的会也要能排进计划，否则按钮点了等于没反应')
assert.equal(outsideNew.selected[0].reason, 'new')
assert.equal(outsideNew.selected[0].outside, true)
const outsidePast = planUpdate({
  catalog,
  records: [{ key: 'corl|2026', venue: 'CoRL', year: 2026, deadline: NOW - 30 * DAY }],
  now: NOW,
  limit: 5,
  focus: 'CoRL',
})
assert.equal(outsidePast.selected[0].reason, 'next-edition', '名单外的会只有往届日期时也要补')
// 已经有过未来截稿的名单外会：以前这里不排（"不该再排一次"），但它就是「重挖这个会」要的效果——
// 用户点了按钮是想刷新，不是想被告知"数据还新鲜"。所以现在点名一律进队列（reason: focus）。
const outsideHealthy = planUpdate({
  catalog,
  records: [{ key: 'corl|2027', venue: 'CoRL', year: 2027, deadline: NOW + 30 * DAY }],
  now: NOW,
  limit: 5,
  focus: 'CoRL',
})
assert.equal(outsideHealthy.selected.length, 1, '点名重挖时，名单外的会也要真的去挖')
assert.equal(outsideHealthy.selected[0].reason, 'focus')

// ---- 2. 官网候选筛选 ------------------------------------------------------
const sources = [
  { url: 'https://www.ccfddl.com/conf/cvpr' },
  { url: 'https://dblp.org/db/conf/cvpr' },
  { url: 'https://cvpr.thecvf.com/Conferences/2027/ImportantDates' },
  { url: 'https://example.com/somewhere/else' },
]
const picked = pickOfficialCandidates(sources, { abbr: 'CVPR', fullName: 'IEEE/CVF CVPR' }, 2)
assert.equal(picked.length, 2)
assert.ok(picked[0].includes('cvpr.thecvf.com'), '官网应排第一')
assert.ok(!picked.some((url) => url.includes('dblp')), 'dblp 应被排除')

// ---- 3. 模型输出解析 ------------------------------------------------------
assert.deepEqual(parseMinedJson('```json\n{"year":2027}\n```'), { year: 2027 })
assert.deepEqual(parseMinedJson('好的，结果如下：{"year":2027,"place":"X"} 完毕'), { year: 2027, place: 'X' })
assert.equal(parseMinedJson('完全没有 JSON'), null)

// ---- 4. 清洗：宁缺勿编 ----------------------------------------------------
const venue = { abbr: 'CVPR', fullName: 'IEEE/CVF CVPR', rank: 'CCF-A', area: '人工智能' }
const good = sanitizeMined(
  { year: 2027, deadline: '2026-11-13T23:59:59-08:00', notification: '2027-01-19', confDate: '2027-06-06', place: 'Honolulu, USA', link: 'https://cvpr.thecvf.com' },
  venue,
  { now: NOW },
)
assert.ok(good && good.source === 'model')
assert.equal(good.venue, 'CVPR')
assert.equal(good.rank, 'CCF-A')
assert.equal(new Date(good.deadline).toISOString(), '2026-11-14T07:59:59.000Z')
assert.equal(Object.hasOwn(good, 'cameraReady'), false, 'CR 时间不抽了，挖出来的记录里也不该有')

assert.equal(sanitizeMined({ deadline: null, notification: null }, venue, { now: NOW }), null, '一个时间点都没有 → 丢')
assert.equal(sanitizeMined({ deadline: '2020-01-01' }, venue, { now: NOW }), null, '太老的日期 → 丢')
assert.equal(sanitizeMined({ deadline: '2099-01-01' }, venue, { now: NOW }), null, '太远的日期 → 丢')
assert.equal(sanitizeMined({ deadline: 'soon' }, venue, { now: NOW }), null, '非日期字符串 → 丢')

// ---- 5. 合并：新数据补空字段，时间点以新为准 ------------------------------
const merged = mergeRecords(
  [{ key: 'cvpr|2027', venue: 'CVPR', year: 2027, deadline: null, place: '', source: 'paper-deadlines', minedAt: null }],
  [good],
)
assert.equal(merged.length, 1)
assert.equal(merged[0].place, 'Honolulu, USA', '空字段应被补上')
assert.equal(merged[0].deadline, good.deadline, '时间点应更新')

// ---- 6. 假宿主：llm + web -------------------------------------------------
function fakeCtx({ withModel = true } = {}) {
  const calls = { stream: 0, search: 0, fetch: 0 }
  const llm = {
    async *stream() {
      calls.stream += 1
      yield { type: 'text-delta', index: 0, text: '```json\n' }
      yield { type: 'text-delta', index: 0, text: '{"year":2027,"deadline":"2027-05-20T23:59:59-08:00","notification":"2027-07-01","rebuttal":"2027-06-01","cameraReady":"2027-07-15","confDate":"2027-09","place":"Somewhere","link":"https://a.acm.org/x"}' }
      yield { type: 'text-delta', index: 0, text: '\n```' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const web = {
    async search({ query }) {
      calls.search += 1
      return { sources: [{ url: `https://conf.example.org/${encodeURIComponent(query.slice(0, 3))}` }, { url: 'https://dblp.org/x' }], truncated: false }
    },
    async fetch({ url }) {
      calls.fetch += 1
      return { url, statusCode: 200, body: { kind: 'html', content: '<html>Important Dates: paper deadline Nov 13 2026</html>' }, truncated: false }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') return withModel ? llm : undefined
      if (name === 'web') return web
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
    logger: { info() {}, warn() {}, debug() {} },
  }
  return { ctx, calls }
}

assert.equal(isModelAvailable(fakeCtx().ctx), true)
assert.equal(isModelAvailable(fakeCtx({ withModel: false }).ctx), false)

// 「模型：不可用」是个结论，得说得出依据：是没读到服务、还是服务里没 stream()。
{
  const ready = modelState(fakeCtx().ctx)
  assert.equal(ready.ready, true)
  assert.equal(ready.reason, '')
  assert.equal(ready.selection, 'p/m', '要能说出当前选中的 provider/model')

  const missing = modelState(fakeCtx({ withModel: false }).ctx)
  assert.equal(missing.ready, false)
  assert.match(missing.reason, /没读到 llm 服务/, '缺服务时要说清是服务没接进来')

  const noStream = modelState({ get: (name) => (name === 'llm' ? { chat() {} } : undefined) })
  assert.equal(noStream.ready, false)
  assert.match(noStream.reason, /没有 stream\(\)/, '服务在但没有 stream() 时要说清是接口不匹配')

  const noGet = modelState({})
  assert.equal(noGet.ready, false)
  assert.equal(noGet.hasGet, false)
  assert.match(noGet.reason, /ctx\.get/, '连 ctx.get 都没有时要说是上下文的问题')
}

const { ctx: modelCtx, calls } = fakeCtx()
const text = await callModel(modelCtx, { system: 's', user: 'u' })
assert.ok(text.includes('2027-05-20'))
assert.equal(calls.stream, 1)

const mined = await mineVenue(modelCtx, venue, { now: NOW })
assert.ok(mined.record, `应挖到记录，实际 ${mined.error ?? ''}`)
assert.equal(mined.record.source, 'model')
assert.ok(calls.search >= 1 && calls.fetch >= 1)
// 出处：挖到的记录要记住它读的是哪几页，用户才能核对
assert.ok(Array.isArray(mined.record.minedFrom) && mined.record.minedFrom.length > 0, '应记下挖自哪几页')
assert.equal(mined.record.minedFrom[0], mined.pages[0], '第一条出处应与抓到的第一页一致')
assert.match(mined.record.minedFrom[0], /^https?:\/\//)

// ---- 7. runUpdate：有模型 → 挖 + 合并 + meta ------------------------------
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-ccf-miner-'))
let saved = null
const cache = { schema: 'dsh-ccf/cache/v1', updatedAt: null, reports: [], records: [] }
const result = await runUpdate({
  ctx: modelCtx,
  config: { catalog, refreshDays: 30, maxVenuesPerRun: 2 },
  dataDir,
  currentCache: () => cache,
  doSync: async () => ({ ok: true, report: 'fallback', cache }),
  saveCache: async (next) => {
    saved = next
  },
  limit: 1,
  now: NOW,
})
assert.equal(result.ok, true)
assert.equal(result.model, true)
assert.equal(result.fallback, false)
assert.equal(result.mined.length, 1, '应该挖到 1 个会')
assert.ok(saved && saved.records.length === 1)
assert.equal(saved.meta.modelUsed, true)
assert.equal(saved.meta.lastUpdateMined, 1)
assert.ok(saved.meta.pending > 300, '其余会仍是待补状态')
assert.equal(saved.updatedAt, NOW)
assert.equal(Array.isArray(result.byArea), true, '回执里要带按方向的统计')
assert.equal(result.byArea.reduce((sum, entry) => sum + entry.mined + entry.failed, 0), 1, '一个会要落进某个方向')
assert.match(result.note, /模型挖掘：本轮处理 1 个会/, '回执首行仍要有一轮总数')

// ---- 7b. 进度回调：每开始/结束一个会都要报 ------------------------------
{
  const events = []
  const progressRun = await runUpdate({
    ctx: modelCtx,
    config: { catalog, refreshDays: 30, maxVenuesPerRun: 3 },
    dataDir,
    currentCache: () => ({ schema: 'dsh-ccf/cache/v1', updatedAt: null, reports: [], records: [] }),
    doSync: async () => ({ ok: true, report: 'fallback', cache }),
    saveCache: async () => {},
    limit: 3,
    now: NOW,
    onProgress: (event) => events.push(event),
  })
  assert.equal(progressRun.mined.length, 3)
  const starts = events.filter((event) => event.phase === 'start')
  const dones = events.filter((event) => event.phase === 'done')
  assert.equal(starts.length, 3, '每个会开始补时都要报一次')
  assert.equal(dones.length, 3, '每个会结束时也要报一次')
  assert.deepEqual(starts.map((event) => event.index), [1, 2, 3], '序号要递增')
  assert.ok(starts.every((event) => event.total === 3), '总数要在每个事件里都说清楚')
  assert.ok(starts.every((event) => typeof event.venue === 'string' && event.venue.length > 0), '要说清楚在补哪个会')
  assert.ok(dones.every((event) => event.ok === true))
  // 回调里抛异常不能把挖掘搞挂
  const stillFine = await runUpdate({
    ctx: modelCtx,
    config: { catalog, refreshDays: 30, maxVenuesPerRun: 1 },
    dataDir,
    currentCache: () => ({ schema: 'dsh-ccf/cache/v1', updatedAt: null, reports: [], records: [] }),
    doSync: async () => ({ ok: true }),
    saveCache: async () => {},
    limit: 1,
    now: NOW,
    onProgress: () => {
      throw new Error('boom')
    },
  })
  assert.equal(stillFine.ok, true)
  assert.equal(stillFine.mined.length, 1)
}

// ---- 8. runUpdate：没有模型 → 回退 ccfddl + 致谢 --------------------------
const { ctx: noModelCtx } = fakeCtx({ withModel: false })
const fallbackCache = {
  schema: 'dsh-ccf/cache/v1',
  updatedAt: null,
  reports: [],
  records: [{ key: 'icml|2027', venue: 'ICML', year: 2027, deadline: NOW + 30 * DAY, source: 'paper-deadlines', minedAt: null }],
}
const fallback = await runUpdate({
  ctx: noModelCtx,
  config: { catalog, refreshDays: 30, maxVenuesPerRun: 2 },
  dataDir,
  currentCache: () => fallbackCache,
  doSync: async () => ({ ok: true, report: '已同步 1 条', cache: fallbackCache }),
  saveCache: async () => {},
  limit: 1,
  now: NOW,
})
assert.equal(fallback.model, false)
assert.equal(fallback.fallback, true)
assert.equal(fallback.mined.length, 0)
assert.ok(fallback.note.includes('没有可用模型'))
assert.ok(fallback.attribution.includes('ccfddl'))
assert.ok(fallback.attribution.includes('感谢'), '致谢要写出来')
assert.equal(ATTRIBUTION.ccfddlSite, 'https://ccfddl.com')

// 没有名单 → 明确说做不了（不猜）
const noCatalog = await runUpdate({
  ctx: modelCtx,
  config: { catalog: null },
  dataDir,
  currentCache: () => cache,
  doSync: async () => ({ ok: true }),
  saveCache: async () => {},
})
assert.equal(noCatalog.ok, false)
assert.match(noCatalog.note, /ccf-catalog\.json/)

console.log('miner.test: 全部通过')
