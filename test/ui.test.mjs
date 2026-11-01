/**
 * 宿主侧面板路由的单元测试：不起 HTTP 服务器，直接喂假的 req/res。
 */
import assert from 'node:assert/strict'

import { PANEL_SCHEMA, ROUTE_PREFIX, createUiRoutes, isLoopbackRequest, panelPayload, sameVenue } from '../lib/ui.js'
import { catalogConferences } from '../lib/catalog.js'

const SAT_CONFERENCES = [
  { key: 'siggraph', abbr: 'SIGGRAPH', fullName: 'ACM Special Interest Group on Computer Graphics', rank: 'CCF-A', area: '计算机图形学与多媒体', dblp: '' },
]
const SAT_CACHE_RECORD = {
  key: 'acm siggraph asia|2026', venue: 'ACM SIGGRAPH ASIA', year: 2026, name: 'ACM SIGGRAPH ASIA 2026',
  fullName: 'ACM SIGGRAPH Annual Conference in Asia', rank: 'CCF-A', area: '计算机图形学与多媒体',
  abstractDeadline: null, deadline: Date.now() + 10 * 86400000, notification: null,
  rebuttal: null, cameraReady: null, confDate: '2026-12', place: 'Tokyo', link: '', submitLink: '',
  acceptRate: '', h5: null, aliases: [], source: 'ccfddl-api',
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

const CACHE = {
  updatedAt: Date.parse('2026-10-31T10:00:00Z'),
  records: [
    {
      key: 'cvpr|2027',
      venue: 'CVPR',
      year: 2027,
      name: 'CVPR 2027',
      fullName: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition',
      rank: 'CCF-A',
      area: 'CV',
      core: 'A',
      abstractDeadline: Date.parse('2026-11-13T07:59:59Z'),
      deadline: Date.parse('2026-11-20T07:59:59Z'),
      notification: Date.parse('2027-01-20T07:59:59Z'),
      rebuttal: Date.parse('2027-02-05T07:59:59Z'),
      confDate: '2027-06',
      place: 'Honolulu, USA',
      link: 'https://cvpr.thecvf.com',
      submitLink: '',
      aliases: ['CVPR'],
      acceptRate: '22%',
      h5: 120,
      history: ['2026: 2025-11-13'],
      timezone: 'UTC-12:00',
      aliases2: undefined,
      source: 'paper-deadlines',
    },
  ],
}

function fakeResponse() {
  const captured = { status: null, headers: null, body: null }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers || {}
    },
    end(text) {
      captured.body = text === undefined ? null : JSON.parse(String(text))
    },
  }
}

const request = (method, address = '127.0.0.1', body = null) => {
  // 模拟可读流：路由会读 JSON body（POST /update 用它传 focus/scope）。
  const listeners = { data: [], end: [], error: [] }
  const stub = {
    method,
    socket: { remoteAddress: address },
    on(event, handler) {
      (listeners[event] || (listeners[event] = [])).push(handler)
      return stub
    },
  }
  queueMicrotask(() => {
    if (body !== null) for (const handler of listeners.data) handler(Buffer.from(JSON.stringify(body), 'utf8'))
    for (const handler of listeners.end) handler()
  })
  return stub
}

test('routes are exact and live under the prefix', () => {
  const routes = createUiRoutes({ currentCache: () => CACHE, doSync: async () => ({ ok: true, report: '' }), config: {}, dataDir: '/tmp/x' })
  assert.equal(routes.length, 5)
  assert.deepEqual(routes.map((route) => [route.kind, route.path]), [
    ['exact', `${ROUTE_PREFIX}/records`],
    ['exact', `${ROUTE_PREFIX}/sync`],
    ['exact', `${ROUTE_PREFIX}/update`],
    ['exact', `${ROUTE_PREFIX}/prefer`],
    ['exact', `${ROUTE_PREFIX}/confirm`],
  ])
})

test('loopback detection', () => {
  assert.equal(isLoopbackRequest(request('GET', '127.0.0.1')), true)
  assert.equal(isLoopbackRequest(request('GET', '::1')), true)
  assert.equal(isLoopbackRequest(request('GET', '::ffff:127.0.0.1')), true)
  assert.equal(isLoopbackRequest(request('GET', '192.168.1.5')), false)
  assert.equal(isLoopbackRequest({}), true)
})

test('GET /records returns the panel payload', async () => {
  const routes = createUiRoutes({ currentCache: () => CACHE, doSync: async () => ({ ok: true }), config: { timezone: 'Asia/Shanghai', windowDays: 120 }, dataDir: '/tmp/ccf' })
  const response = fakeResponse()
  await routes[0].handler(request('GET'), response)
  assert.equal(response.captured.status, 200)
  const body = response.captured.body
  assert.equal(body.ok, true)
  assert.equal(body.schema, PANEL_SCHEMA)
  assert.equal(body.timezone, 'Asia/Shanghai')
  assert.equal(body.count, 1)
  assert.equal(body.dataDir, '/tmp/ccf')
  const [record] = body.records
  assert.equal(record.venue, 'CVPR')
  assert.equal(record.deadline, '2026-11-20T07:59:59.000Z')
  assert.equal(record.rebuttal, '2027-02-05T07:59:59.000Z')
  assert.equal(Object.hasOwn(record, 'cameraReady'), false, 'CR 时间已去掉，面板投影里不该再有')
  assert.equal(record.place, 'Honolulu, USA')
  // 面板要能印"官方口径"和"往届截稿"，所以这两个字段必须透出来
  assert.equal(record.timezone, 'UTC-12:00')
  assert.deepEqual(record.history, ['2026: 2025-11-13'])
})

test('GET /records rejects non-GET and non-loopback', async () => {
  const routes = createUiRoutes({ currentCache: () => CACHE, doSync: async () => ({ ok: true }), config: {}, dataDir: '/tmp/ccf' })
  const wrongMethod = fakeResponse()
  await routes[0].handler(request('POST'), wrongMethod)
  assert.equal(wrongMethod.captured.status, 405)
  assert.equal(wrongMethod.captured.headers.allow, 'GET')

  const remote = fakeResponse()
  await routes[0].handler(request('GET', '10.0.0.9'), remote)
  assert.equal(remote.captured.status, 403)
  assert.equal(remote.captured.body.ok, false)
})

test('POST /sync runs the sync and returns refreshed rows', async () => {
  let calls = 0
  const routes = createUiRoutes({
    currentCache: () => CACHE,
    doSync: async () => {
      calls += 1
      return { ok: true, report: 'paper-deadlines: 75 条' }
    },
    config: { timezone: 'UTC' },
    dataDir: '/tmp/ccf',
  })
  const response = fakeResponse()
  await routes[1].handler(request('POST'), response)
  assert.equal(calls, 1)
  assert.equal(response.captured.status, 200)
  assert.equal(response.captured.body.synced, true)
  assert.match(response.captured.body.report, /75/)

  const wrongMethod = fakeResponse()
  await routes[1].handler(request('GET'), wrongMethod)
  assert.equal(wrongMethod.captured.status, 405)
  assert.equal(wrongMethod.captured.headers.allow, 'POST')
})

test('POST /update passes focus and scope from the JSON body', async () => {
  const seen = []
  const routes = createUiRoutes({
    currentCache: () => CACHE,
    doSync: async () => ({ ok: true }),
    runUpdate: async (options) => {
      seen.push(options)
      return { ok: true, model: true, mined: [{ venue: 'CV' }], failed: [], byArea: [{ area: '人工智能', mined: 1, failed: 0 }], pending: 250, note: '补了 1 个' }
    },
    config: {},
    dataDir: '/tmp/ccf',
  })
  // 面板「补这个会」：focus 单会 + limit 1
  const one = fakeResponse()
  await routes[2].handler(request('POST', '127.0.0.1', { focus: 'CVPR', limit: 1 }), one)
  assert.equal(one.captured.status, 200)
  assert.equal(seen[0].focus, 'CVPR')
  assert.equal(seen[0].limit, 1)
  assert.equal(seen[0].force, true)
  assert.deepEqual(one.captured.body.mined, [{ venue: 'CV' }])
  assert.match(one.captured.body.note, /补了 1 个/)

  // 待补视图「补往届」：scope=past
  const scoped = fakeResponse()
  await routes[2].handler(request('POST', '127.0.0.1', { scope: 'past' }), scoped)
  assert.equal(seen[1].scope, 'past')
  assert.equal(seen[1].focus, undefined)

  // 非法 scope 被忽略，不会把脏参数透给挖掘器
  const invalid = fakeResponse()
  await routes[2].handler(request('POST', '127.0.0.1', { scope: 'whatever' }), invalid)
  assert.equal(seen[2].scope, undefined)

  // 没有 body 也能跑（老客户端）
  const plain = fakeResponse()
  await routes[2].handler(request('POST'), plain)
  assert.equal(seen[3].force, true)
  assert.equal(plain.captured.status, 200)

  // 非回环地址不许挖
  const remote = fakeResponse()
  await routes[2].handler(request('POST', '10.0.0.9', { scope: 'never' }), remote)
  assert.equal(remote.captured.status, 403)
  assert.equal(seen.length, 4)
})

test('POST /update answers 501 when no miner is wired', async () => {
  const routes = createUiRoutes({ currentCache: () => CACHE, doSync: async () => ({ ok: true }), config: {}, dataDir: '/tmp/ccf' })
  const response = fakeResponse()
  await routes[2].handler(request('POST'), response)
  assert.equal(response.captured.status, 501)
})

test('POST /update answers 409 while another run is still in flight', async () => {
  const routes = createUiRoutes({
    currentCache: () => CACHE,
    doSync: async () => ({ ok: true }),
    config: {},
    dataDir: '/tmp/ccf',
    runUpdate: async () => ({ ok: false, busy: true, note: '上一轮补数据还在跑（已 12 秒），等它结束再点。' }),
  })
  const response = fakeResponse()
  await routes[2].handler(request('POST'), response)
  assert.equal(response.captured.status, 409)
  assert.equal(response.captured.body.busy, true)
  assert.match(response.captured.body.note, /还在跑/)
})

test('sync failures surface as 500 without killing the route', async () => {  const routes = createUiRoutes({
    currentCache: () => CACHE,
    doSync: async () => {
      throw new Error('network down')
    },
    config: {},
    dataDir: '/tmp/ccf',
  })
  const response = fakeResponse()
  await routes[1].handler(request('POST'), response)
  assert.equal(response.captured.status, 500)
  assert.match(response.captured.body.error, /network down/)
})

test('panelPayload tolerates a missing cache', () => {
  const body = panelPayload(null, { now: Date.parse('2026-10-31T00:00:00Z'), timezone: 'Asia/Shanghai' })
  assert.equal(body.count, 0)
  assert.deepEqual(body.records, [])
  assert.equal(body.updatedAt, null)
})

test('panelPayload carries the plugin version so the panel can prove it is fresh', () => {
  assert.equal(panelPayload(null, {}).version, '')
  const body = panelPayload(null, { version: '0.4.1' })
  assert.equal(body.version, '0.4.1')
  assert.equal(body.schema, PANEL_SCHEMA)
})

test('panelPayload carries a competing deadline from another source', () => {
  const cache = {
    ...CACHE,
    records: [
      // 差 42 天：要亮「来源不一致」
      { ...CACHE.records[0], alternatives: [{ source: 'ccfddl-api', deadline: Date.parse('2026-11-14T07:59:59Z'), notification: null }] },
      // 只差一天：仍然写进详情，但不打红字标记
      { ...CACHE.records[0], key: 'iclr|2027', venue: 'ICLR', alternatives: [{ source: 'ccfddl-api', deadline: Date.parse('2026-11-21T07:59:59Z'), notification: null }] },
      // 第三个得换个会：同一个会同年只算一条（去重后就不会有第三条了）
      { ...CACHE.records[0], key: 'aaai|2027', venue: 'AAAI', name: 'AAAI 2027' },
    ],
  }
  const body = panelPayload(cache, { now: Date.parse('2026-10-31T10:00:00Z') })
  assert.equal(body.records[0].conflict, true)
  assert.deepEqual(body.records[0].alternatives, [{ source: 'ccfddl-api', deadline: '2026-11-14T07:59:59.000Z', notification: null }])
  assert.equal(body.records[1].alternatives.length, 1, '差一天也要留下痕迹')
  assert.equal(body.records[1].conflict, false, '差一天不算冲突，不打红字')
  assert.equal(body.records[2].conflict, false)
  assert.equal(body.counts.conflicts, 1, '状态行只数真正的冲突')
})

test('counts.conflicts 只数默认视图里看得到的记录', () => {
  // 「不一致 N」是个能点进去的入口：数进去的必须点得出来。
  // 标过「不是这个会」的记录、以及默认不列的卫星会，都不该算进这个人头。
  const cache = {
    ...CACHE,
    meta: { ignoredKeys: ['ignored|2027'] },
    records: [
      { ...CACHE.records[0], key: 'real|2027', alternatives: [{ source: 'ccfddl-api', deadline: Date.parse('2026-11-14T07:59:59Z'), notification: null }] },
      { ...CACHE.records[0], key: 'ignored|2027', alternatives: [{ source: 'ccfddl-api', deadline: Date.parse('2026-11-14T07:59:59Z'), notification: null }] },
    ],
  }
  const body = panelPayload(cache, { now: Date.parse('2026-10-31T10:00:00Z') })
  assert.equal(body.counts.conflicts, 1, '被否掉的会不再算来源不一致')
})

test('panelPayload tells the panel whether a model is available', () => {
  // 没有模型时面板要能把「补数据」禁掉，不能让人点了半天什么也没发生。
  assert.equal(panelPayload(null, {}).meta.modelReady, true)
  assert.equal(panelPayload(null, { modelReady: false }).meta.modelReady, false)
})

const MINI_CATALOG = {
  areas: [
    { area: 'CV', conferences: { A: [{ abbr: 'CVPR', fullName: 'IEEE/CVF CVPR', dblp: 'https://dblp.org/db/conf/cvpr/index.html' }] } },
    {
      area: 'AI',
      conferences: {
        A: [
          { abbr: 'SIGKDD', fullName: 'ACM SIGKDD Conference', dblp: 'https://dblp.org/db/conf/kdd/index.html' },
          { abbr: 'AAAI', fullName: 'AAAI Conference', dblp: 'https://dblp.org/db/conf/aaai/index.html' },
        ],
        B: [{ abbr: 'ECAI', fullName: 'European Conference on AI', dblp: 'https://dblp.org/db/conf/ecai/index.html' }],
      },
    },
    { area: 'Security', conferences: { A: [{ abbr: 'S&P', fullName: 'IEEE Symposium on Security and Privacy', dblp: 'https://dblp.org/db/conf/sp/index.html' }] } },
  ],
}

test('sameVenue matches list abbreviations against convention names', () => {
  assert.equal(sameVenue('CVPR', { abbr: 'CVPR' }), true)
  assert.equal(sameVenue('KDD', { abbr: 'SIGKDD' }), true)
  assert.equal(sameVenue('IEEE S&P', { abbr: 'S&P' }), true)
  assert.equal(sameVenue('USENIX Security', { abbr: 'USENIX Security' }), true)
  // 曾经把 'security' 当别名映射到 SEC（IFIP 信息安全会），结果 USENIX Security 的数据被它认领；
  // 现在 USENIX Security 在名单里有自己的条目，这条别名已删。
  assert.equal(sameVenue('USENIX Security', { abbr: 'SEC' }), false)
  assert.equal(sameVenue('CCS', { abbr: 'CCS' }), true)
  assert.equal(sameVenue('ACM CCS', { abbr: 'CCS' }), true)
  assert.equal(sameVenue('CVPR Workshops', { abbr: 'CVPR' }), true)
  assert.equal(sameVenue('CVPR', { abbr: 'ICCV' }), false)
  // 不做双向包含：这两个曾经被误判成同一个会
  assert.equal(sameVenue('SPAA', { abbr: 'S&P' }), false)
  assert.equal(sameVenue('HOT CHIPS', { abbr: 'CHI' }), false)
  assert.equal(sameVenue('', { abbr: 'CHI' }), false)
})

test('panelPayload lists list-only conferences as pending rows', () => {
  const body = panelPayload(CACHE, {
    now: Date.parse('2026-10-31T00:00:00Z'),
    timezone: 'Asia/Shanghai',
    conferences: catalogConferences(MINI_CATALOG),
  })
  assert.equal(body.count, 1)
  assert.equal(body.counts.records, 1)
  assert.equal(body.counts.conferences, 5)
  assert.equal(body.counts.pending, 4)
  // CVPR 已经有记录，不该再出现在待补里
  assert.equal(body.pending.some((row) => row.abbr === 'CVPR'), false)
  const sigkdd = body.pending.find((row) => row.abbr === 'SIGKDD')
  assert.equal(sigkdd.rank, 'CCF-A')
  assert.equal(sigkdd.area, 'AI')
  assert.equal(sigkdd.pending, true)
  assert.equal(body.pending.filter((row) => row.rank === 'CCF-A').length, 3)
  // 计数要自洽：有未来截稿的会 + 待补 = 名单总数；待补再拆成"只有往届"和"从未抓到"
  assert.equal(body.counts.withFuture, 1)
  assert.equal(body.counts.withFuture + body.counts.pending, body.counts.conferences)
  assert.equal(body.counts.pendingPast + body.counts.pendingNever, body.counts.pending)
  // 记录自己的 area 是上游英文子类，但 areaGroup 必须是名单里的方向，
  // 否则面板按方向过滤会把有数据的会全部滤掉。
  assert.equal(body.records[0].areaGroup, 'CV')
  assert.equal(body.pending.find((row) => row.abbr === 'SIGKDD').area, 'AI')
})

test('panelPayload counts the conferences that the CCF list does not carry', () => {
  // 真实数据里差不多少 68 张卡是这种：CCFDDL 收了、CCF 名单没收（CoRL、EACL、CICAI…）。
  // 它们不进「待补」，也不进「有未来截稿」，但卡片就在列表里 —— 面板必须单独说一句。
  const cache = {
    updatedAt: Date.parse('2026-10-31T00:00:00Z'),
    records: [
      ...CACHE.records,
      { key: 'corl|2026', venue: 'CoRL', year: 2026, name: 'CoRL 2026', rank: 'Non-CCF', source: 'ccfddl-api', deadline: Date.parse('2026-12-01T00:00:00Z') },
      { key: 'cicai|2026', venue: 'CICAI', year: 2026, name: 'CICAI 2026', rank: 'Non-CCF', source: 'ccfddl-api', deadline: Date.parse('2026-01-01T00:00:00Z') },
    ],
  }
  const body = panelPayload(cache, {
    now: Date.parse('2026-10-31T00:00:00Z'),
    timezone: 'Asia/Shanghai',
    conferences: catalogConferences(MINI_CATALOG),
  })
  assert.equal(body.counts.outside, 2)
  assert.equal(body.counts.outsideFuture, 1, 'CICAI 的日期已经过去')
  assert.equal(body.counts.records, 3)
  // 362 这套账不能因为多出来的卡而失衡
  assert.equal(body.counts.withFuture + body.counts.pending, body.counts.conferences)
  // 名单外的会不该出现在待补里
  assert.equal(body.pending.some((row) => row.abbr === 'CoRL'), false)
  // 但在列表里要标出来（卡片据此给"补这个会"），名单内的会不能误标
  assert.equal(body.records.find((row) => row.venue === 'CoRL').outside, true)
  assert.equal(body.records.find((row) => row.venue === 'CICAI').outside, true)
  assert.equal(body.records.find((row) => row.venue === 'CVPR').outside, false)
})

test('panelPayload applies the per-venue preferred source to a new edition', () => {
  const cache = {
    updatedAt: Date.parse('2026-10-31T00:00:00Z'),
    records: [{
      key: 'cvpr|2028',
      venue: 'CVPR',
      year: 2028,
      name: 'CVPR 2028',
      rank: 'CCF-A',
      source: 'ccfddl-api',
      deadline: Date.parse('2027-11-16T11:59:59Z'),
      notification: null,
      alternatives: [{ source: 'paper-deadlines', deadline: Date.parse('2027-11-13T07:59:59Z'), notification: null }],
    }],
    // 去年给 CVPR 点过「采信 paper-deadlines」，今年这一届没再点
    meta: { preferredByVenue: { cvpr: 'paper-deadlines' } },
  }
  const body = panelPayload(cache, { now: Date.parse('2026-10-31T00:00:00Z'), timezone: 'Asia/Shanghai' })
  const row = body.records[0]
  assert.equal(row.deadline, '2027-11-13T07:59:59.000Z')
  assert.equal(row.source, 'paper-deadlines')
  assert.equal(row.preferred, true)
  assert.equal(row.preferredInherited, true)
  // 缓存里的主记录仍然是接口给的日期
  assert.equal(cache.records[0].deadline, Date.parse('2027-11-16T11:59:59Z'))
  // 没有系列记忆时退回主记录
  const plain = panelPayload({ ...cache, meta: {} }, { now: Date.parse('2026-10-31T00:00:00Z') })
  assert.equal(plain.records[0].preferred, false)
  assert.equal(plain.records[0].preferredInherited, false)
})

test('panelPayload tells the panel how far the mining run got', () => {
  const now = Date.parse('2026-10-31T00:00:00Z')
  const idle = panelPayload(CACHE, { now })
  assert.equal(idle.meta.updateProgress.busy, false)

  const running = panelPayload(CACHE, {
    now,
    progress: { startedAt: now - 42000, total: 6, index: 3, done: 2, current: 'CVPR', ok: 2, failed: 0, last: 'ICML 2026 补到' },
  })
  const progress = running.meta.updateProgress
  assert.equal(progress.busy, true)
  assert.equal(progress.total, 6)
  assert.equal(progress.index, 3)
  assert.equal(progress.done, 2)
  assert.equal(progress.current, 'CVPR')
  assert.equal(progress.elapsedMs, 42000)
  assert.equal(progress.last, 'ICML 2026 补到')
})

test('POST /prefer switches the shown source, and an unknown key is a 404', async () => {
  const seen = []
  const routes = createUiRoutes({
    currentCache: () => CACHE,
    doSync: async () => ({ ok: true }),
    prefer: async ({ key, source }) => {
      seen.push({ key, source })
      return key === 'cvpr|2027' ? { ok: true } : { ok: false, note: '缓存里没有这个会。' }
    },
    config: {},
    dataDir: '/tmp/ccf',
  })
  const route = routes.find((item) => item.path === `${ROUTE_PREFIX}/prefer`)
  assert.equal(route.kind, 'exact')

  const ok = fakeResponse()
  await route.handler(request('POST', '127.0.0.1', { key: 'cvpr|2027', source: 'paper-deadlines' }), ok)
  assert.equal(ok.captured.status, 200)
  assert.deepEqual(seen[0], { key: 'cvpr|2027', source: 'paper-deadlines' })
  assert.deepEqual(ok.captured.body.preferred, { key: 'cvpr|2027', source: 'paper-deadlines' })

  // source 传空 = 恢复默认
  const reset = fakeResponse()
  await route.handler(request('POST', '127.0.0.1', { key: 'cvpr|2027', source: '' }), reset)
  assert.equal(reset.captured.status, 200)
  assert.deepEqual(seen[1], { key: 'cvpr|2027', source: '' })

  const missing = fakeResponse()
  await route.handler(request('POST', '127.0.0.1', { key: 'nope|2027' }), missing)
  assert.equal(missing.captured.status, 404)

  const empty = fakeResponse()
  await route.handler(request('POST', '127.0.0.1', {}), empty)
  assert.equal(empty.captured.status, 400)

  const remote = fakeResponse()
  await route.handler(request('POST', '10.0.0.9', { key: 'cvpr|2027' }), remote)
  assert.equal(remote.captured.status, 403)

  const wrongMethod = fakeResponse()
  await route.handler(request('GET', '127.0.0.1'), wrongMethod)
  assert.equal(wrongMethod.captured.status, 405)
})

test('POST /prefer 批量：{batch:true, source} 走 preferConflicts，回执带改了几个', async () => {
  const calls = []
  const routes = createUiRoutes({
    currentCache: () => CACHE,
    doSync: async () => ({ ok: true }),
    preferConflicts: async ({ source, undo }) => {
      calls.push({ source, undo })
      return { ok: true, source, conflicts: 3, changed: 2, skipped: 1 }
    },
    config: {},
    dataDir: '/tmp/ccf',
  })
  const route = routes.find((item) => item.path === `${ROUTE_PREFIX}/prefer`)

  const ok = fakeResponse()
  await route.handler(request('POST', '127.0.0.1', { batch: true, source: 'paper-deadlines' }), ok)
  assert.equal(ok.captured.status, 200)
  assert.deepEqual(calls[0], { source: 'paper-deadlines', undo: false })
  assert.deepEqual(ok.captured.body.bulk, { source: 'paper-deadlines', changed: 2, skipped: 1, conflicts: 3 })
  assert.equal(ok.captured.body.schema, PANEL_SCHEMA, '批量采信后照样回完整面板数据，面板一次刷新到位')

  const noSource = fakeResponse()
  await route.handler(request('POST', '127.0.0.1', { batch: true }), noSource)
  assert.equal(noSource.captured.status, 400)

  const noImpl = fakeResponse()
  const plain = createUiRoutes({ currentCache: () => CACHE, doSync: async () => ({ ok: true }), config: {}, dataDir: '/tmp/ccf' })
  await plain.find((item) => item.path === `${ROUTE_PREFIX}/prefer`).handler(request('POST', '127.0.0.1', { batch: true, source: 'x' }), noImpl)
  assert.equal(noImpl.captured.status, 501, '旧宿主没有批量能力时要说清，不能假装成功')
})

for (const [name, fn] of tests) {
  await fn()
  console.log(`  ✓ ${name}`)
}
test('panelPayload surfaces per-source health and the last failed attempt', () => {
  const payload = panelPayload({
    ...CACHE,
    reports: [
      { id: 'ccfddl-api', ok: true, count: 379 },
      { id: 'paper-deadlines', ok: false, count: 0, error: 'ECONNRESET' },
    ],
    lastAttemptAt: Date.parse('2026-10-31T03:00:00Z'),
    lastError: '全部源都没拉到',
  }, { now: Date.parse('2026-11-01T00:00:00Z') })

  assert.deepEqual(payload.meta.sources.map((item) => [item.id, item.ok, item.count]), [
    ['ccfddl-api', true, 379],
    ['paper-deadlines', false, 0],
  ])
  assert.equal(payload.meta.sources[1].error, 'ECONNRESET')
  assert.equal(payload.meta.lastAttemptAt, '2026-10-31T03:00:00.000Z')
  assert.equal(payload.meta.lastError, '全部源都没拉到')
})

test('panelPayload 把"缓存坏了"带进 meta，而不是只留一张空表', () => {
  const body = panelPayload(null, {
    now: Date.now(),
    conferences: [],
    cacheStatus: {
      state: 'corrupt',
      error: 'JSON 解析失败：Unexpected end of JSON input',
      path: 'C:\\Users\\x\\.dsh\\ccf\\cache.json',
    },
  })
  assert.equal(body.count, 0)
  assert.equal(body.meta.cacheState, 'corrupt')
  assert.match(body.meta.cacheError, /JSON/)
  assert.match(body.meta.cachePath, /cache\.json$/)
})
test('panelPayload 把名单状态带给面板（名单坏了不能装作没有名单）', async () => {
  const routes = createUiRoutes({
    currentCache: () => CACHE,
    doSync: async () => ({ ok: true }),
    config: { timezone: 'Asia/Shanghai', windowDays: 120 },
    dataDir: '/tmp/ccf',
    catalogInfo: { state: 'corrupt', error: 'JSON 解析失败：x', path: '/tmp/ccf-catalog.json' },
  })
  const records = routes.find((route) => route.path === '/dsh-ccf/api/v1/records')
  const response = fakeResponse()
  await records.handler(fakeRequest('GET', '127.0.0.1'), response)
  const body = JSON.parse(response.body)
  assert.equal(body.meta.catalogState, 'corrupt')
  assert.equal(body.ok, true, '名单坏了也不能让整个面板 500')
})

test('panelPayload 把挖到的出处带给面板', async () => {
  const cache = {
    schema: 'dsh-ccf/cache/v1',
    updatedAt: 1_700_000_000_000,
    reports: [],
    records: [{
      key: 'cvpr|2027', venue: 'CVPR', year: 2027, name: 'CVPR 2027', rank: 'CCF-A', area: 'CV',
      deadline: 1_900_000_000_000, notification: null, confDate: '2027-06', place: 'Honolulu',
      link: 'https://cvpr.thecvf.com', submitLink: '', aliases: [], history: [],
      source: 'model', minedAt: 1_700_000_000_000,
      minedFrom: ['https://cvpr.thecvf.com/Dates', 'https://cvpr.thecvf.com/'],
    }],
  }
  const routes = createUiRoutes({ currentCache: () => cache, doSync: async () => ({ ok: true }), config: {}, dataDir: '/tmp/ccf' })
  const records = routes.find((route) => route.path === '/dsh-ccf/api/v1/records')
  const response = fakeResponse()
  await records.handler(fakeRequest('GET', '127.0.0.1'), response)
  const body = JSON.parse(response.body)
  const row = body.records.find((item) => item.key === 'cvpr|2027')
  assert.equal(row.mined, true)
  assert.deepEqual(row.minedFrom, ['https://cvpr.thecvf.com/Dates', 'https://cvpr.thecvf.com/'])
})

test('panelPayload 标出"全称对不上、建议核对"的记录', async () => {
  const catalog = {
    areas: [
      { area: '网络与信息安全', conferences: { A: [{ abbr: 'USENIX Security', fullName: 'USENIX Security Symposium', dblp: '' }] } },
      { area: '网络与信息安全', conferences: { C: [{ abbr: 'SEC', fullName: 'IFIP International Information Security Conference', dblp: '' }] } },
    ],
  }
  const cache = {
    schema: 'dsh-ccf/cache/v1',
    updatedAt: 1_700_000_000_000,
    reports: [],
    records: [{
      key: 'sec|2026', venue: 'SEC', year: 2026, name: 'SEC 2026',
      fullName: 'ACM/IEEE Symposium on Edge Computing',
      rank: 'CCF-C', area: 'SC', deadline: 1_900_000_000_000, notification: null,
      confDate: '2026-11', place: 'Osaka', link: '', submitLink: '', aliases: [], history: [],
      source: 'ccfddl-api',
    }],
  }
  const routes = createUiRoutes({ currentCache: () => cache, doSync: async () => ({ ok: true }), config: {}, dataDir: '/tmp/ccf', catalog })
  const records = routes.find((route) => route.path === '/dsh-ccf/api/v1/records')
  const response = fakeResponse()
  await records.handler(fakeRequest('GET', '127.0.0.1'), response)
  const body = JSON.parse(response.body)
  assert.equal(body.records[0].weakMatch, true, '全称对不上的记录要标出来')
  assert.ok(body.counts.weakMatches >= 1)
})

await test('panelPayload 把"标过「不是这个会」"的记录算名单外，并带上标记', async () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const CACHE = {
    schema: 'dsh-ccf/cache/v1',
    updatedAt: now - 60_000,
    reports: [{ id: 'ccfddl-api', ok: true, count: 2 }],
    meta: { ignoredKeys: ['sec|2026'] },
    records: [
      { key: 'cvpr|2027', venue: 'CVPR', name: 'CVPR 2027', year: 2027, rank: 'CCF-A', area: 'CV', deadline: now + 20 * 86400e3, source: 'ccfddl-api' },
      { key: 'sec|2026', venue: 'SEC', name: 'SEC 2026', year: 2026, rank: 'Non-CCF', area: 'SC', deadline: now + 8 * 86400e3, source: 'ccfddl-api' },
    ],
  }
  const body = panelPayload(CACHE, { now, timezone: 'UTC', dataDir: 'x', conferences: catalogConferences(CATALOG) })
  const sec = body.records.find((row) => row.key === 'sec|2026')
  assert.equal(sec.ignored, true, '标过的记录要带 ignored 标记')
  assert.equal(body.records.find((row) => row.key === 'cvpr|2027').ignored, false)
  assert.ok(body.counts.outside >= 1, '标过的记录算名单外')
})

await test('panelPayload 尊重「就是这个会」：不再标建议核对，但照样算它的数据', async () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const CACHE = {
    schema: 'dsh-ccf/cache/v1',
    updatedAt: now,
    reports: [{ id: 'ccfddl-api', ok: true, count: 1 }],
    meta: { confirmedKeys: ['sec-x|2027'] },
    records: [{ key: 'sec-x|2027', venue: 'SEC', name: 'SEC 2027', deadline: now + 5 * 86400e3, source: 'ccfddl-api' }],
  }
  const body = panelPayload(CACHE, { now, timezone: 'UTC', conferences: catalogConferences(CATALOG) })
  const row = body.records[0]
  assert.equal(row.confirmed, true, '带上已确认标记')
  assert.equal(row.weakMatch, false, '不再建议核对')
  assert.equal(body.counts.weakMatches, 0)
  assert.equal(body.counts.withFuture, 1, '仍然算这个会的数据')
})

await test('POST /confirm 记下核对结论：mark=ignore 走同一条路', async () => {
  const seen = []
  const routes = createUiRoutes({
    currentCache: () => CACHE,
    doSync: async () => ({ ok: true }),
    config: { timezone: 'UTC', windowDays: 120, leadDays: 30 },
    dataDir: '/tmp/x',
    catalog: CATALOG,
    confirm: async (payload) => { seen.push({ kind: 'confirm', payload }); return { ok: true, note: 'ok' } },
    ignore: async (payload) => { seen.push({ kind: 'ignore', payload }); return { ok: true, note: 'ok' } },
  })
  const route = routes.find((item) => item.path === '/dsh-ccf/api/v1/confirm')
  assert.ok(route, '要有 /confirm 路由')

  const first = fakeResponse()
  await route.handler(request('POST', '127.0.0.1', { key: 'sec|2026' }), first)
  assert.equal(first.captured.status, 200)
  assert.equal(seen[0].kind, 'confirm')

  const second = fakeResponse()
  await route.handler(request('POST', '127.0.0.1', { key: 'sec|2026', mark: 'ignore', undo: true }), second)
  assert.equal(second.captured.status, 200)
  assert.equal(seen[1].kind, 'ignore')
  assert.equal(seen[1].payload.undo, true)

  const missing = fakeResponse()
  await route.handler(request('POST', '127.0.0.1', {}), missing)
  assert.equal(missing.captured.status, 400)
})

await test('meta.marks 告诉面板我裁决过多少条', async () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const CACHE = {
    schema: 'dsh-ccf/cache/v1',
    updatedAt: now,
    reports: [],
    meta: { ignoredKeys: ['a|2027', 'b|2027'], confirmedKeys: ['c|2027'] },
    records: [{ key: 'a|2027', venue: 'CVPR', name: 'CVPR 2027', deadline: now + 86400e3 }],
  }
  const body = panelPayload(CACHE, { now, timezone: 'UTC' })
  assert.deepEqual(body.meta.marks, { ignored: 2, confirmed: 1 })
})

await test('panelPayload 把卫星会标出来：数据是真的，但不算主会的截稿', () => {
  const body = panelPayload(
    { schema: 'dsh-ccf/cache/v1', updatedAt: Date.now(), records: [SAT_CACHE_RECORD] },
    { now: Date.now(), conferences: SAT_CONFERENCES },
  )
  const row = body.records.find((item) => item.key === SAT_CACHE_RECORD.key)
  assert.equal(row.satellite, true, '卫星会要带 satellite 标记')
  assert.equal(row.weakMatch, false, '卫星会不再提示「建议核对」')
  assert.equal(body.counts.satellites, 1)
})

console.log(`ui: ${tests.length} passed`)
