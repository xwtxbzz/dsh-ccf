/**
 * dsh-ccf · 可视化侧边栏的宿主侧
 *
 * 桌面端（DSH ≥ 0.1.0-rc.6）没有可注入的"右侧列"：`sidebar`/`conversation`/`details`
 * 三个槽都被官方 UI 占着，注册就是替换。所以面板挂在 `shell.overlay`（列表型、
 * 默认点击穿透）上，由客户端自己画一列贴右边缘的卡片。
 *
 * 客户端拿不到 Node 的文件系统，数据走宿主 HTTP 路由：浏览器里 `fetch('/dsh-ccf/api/v1/records')`。
 * 路由只对回环地址开放（同源页面的请求本来就是回环），避免把本机缓存暴露给局域网。
 */
import { catalogConferences, catalogCoverage, catalogSummary as summarizeCatalog, matchVenue } from './catalog.js'
import { applyPreferredAll, dedupeVenueYear, isBigConflict } from './core.js'

/** 路由前缀。 */
export const ROUTE_PREFIX = '/dsh-ccf/api/v1'

/** 面板数据的 schema 标识（客户端只认这个版本）。 */
export const PANEL_SCHEMA = 'dsh-ccf/panel/v1'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 请求是否来自本机。 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress ?? request?.connection?.remoteAddress ?? ''
  if (!address) return true // 单元测试与某些代理链路拿不到地址：按本机处理
  return LOOPBACK.has(String(address))
}

const toIso = (value) => (Number.isFinite(value) ? new Date(value).toISOString() : null)

/**
 * 「两个来源差了多久算冲突」的判据在 `core.js` 的 `isBigConflict`（36 小时）：
 * 命令行、工具、面板三处必须同一个口径，不然同一个会在一处红、一处不红。
 */
const normalizeName = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * 一条记录和名单里的一个会是不是同一个会。
 *
 * 实现在 `catalog.js` 的 `matchVenue`，这里只是历史名字（`create.js` 与老测试都用它），
 * 保证"面板计数 / 列表覆盖度 / 补数据计划"用的是同一个判定。
 */
export const sameVenue = matchVenue

/** 派生展示视图：把"采信另一来源"（含按会议系列的记忆）应用到每条记录上。 */
function arrayOf(records, venuePrefs) {
  return dedupeVenueYear(applyPreferredAll(records, venuePrefs))
}

/**
 * 补数据进度快照：宿主侧在跑时给面板一个"第几个 / 一共几个 / 正在补谁"的对象。
 *
 * 没在跑时返回 `{ busy: false }`（而不是 null），这样客户端不用区分"字段缺失"和"没在跑"。
 */
function progressOf(raw, now) {
  if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.startedAt)) return { busy: false }
  return {
    busy: true,
    startedAt: new Date(raw.startedAt).toISOString(),
    elapsedMs: Math.max(0, now - raw.startedAt),
    total: Number.isFinite(raw.total) && raw.total > 0 ? raw.total : null,
    index: Number.isFinite(raw.index) ? raw.index : null,
    done: Number.isFinite(raw.done) ? raw.done : 0,
    current: typeof raw.current === 'string' ? raw.current : '',
    ok: Number.isFinite(raw.ok) ? raw.ok : 0,
    failed: Number.isFinite(raw.failed) ? raw.failed : 0,
    last: typeof raw.last === 'string' ? raw.last : '',
  }
}

/**
 * 把缓存投影成面板需要的形状。
 *
 * 时间字段统一给 ISO 字符串，由客户端按它自己的时区渲染；没有数据的字段如实给 null，
 * 客户端显示"未提供"，绝不猜一个日期出来。
 *
 * @param {any} cache `{ records, updatedAt, reports?, meta? }`
 * @param {{
 *   now?: number, timezone?: string, dataDir?: string, windowDays?: number,
 *   catalog?: any, attribution?: string, version?: string,
 * }} options
 */
export function panelPayload(cache, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const timezone = typeof options.timezone === 'string' && options.timezone.trim() ? options.timezone : 'Asia/Shanghai'
  // 展示一律走派生视图：用户采信了另一来源时，按他选的那条显示（缓存里主记录不动）。
  // 「按会议系列记住的选择」也在这里生效：新一届会自动沿用去年选过的来源。
  const venuePrefs = cache?.meta && typeof cache.meta === 'object'
    ? cache.meta.preferredByVenue ?? null
    : null
  const records = arrayOf(cache?.records, venuePrefs)
  const meta = cache?.meta && typeof cache.meta === 'object' ? cache.meta : {}
  const conferences = Array.isArray(options.conferences) ? options.conferences : []
  // 「有数据」按"还没过截稿"算：往届的日期对"下次什么时候截稿"没有意义，
  // 上游尚未公布下一届的会一律算待补，这样面板计数与它能给出的答案一致。
  const upcoming = records.filter((row) => Number.isFinite(row?.deadline) && row.deadline >= now)
  // 「待补」用 catalog.js 的同一份覆盖度：既有"只有往届日期"的会，也有"一条记录都没有"的会。
  // 与 `/ccf status`、系统提示里的数字共用 matchVenue，避免同一个问题出现两个数。
  const ignoredKeys = new Set((cache?.meta?.ignoredKeys ?? []).filter(Boolean))
  // 用户核对过「建议核对」的卡片后说「就是它」：仍然参与统计，只是不再提示
  const confirmedKeys = new Set((cache?.meta?.confirmedKeys ?? []).filter(Boolean))
  const coverage = conferences.length > 0 ? catalogCoverage(records, null, { now, conferences, ignoredKeys, confirmedKeys }) : null
  // 名单外的会：要等 coverage 算完才知道是哪几条（它按 matchVenue 逐条对名单）。
  const outsideKeys = new Set((coverage?.outside ?? []).map((row) => row?.key))
  // 认领了但全称一个字都对不上的记录：提示核对，别让人以为它就是名单里那个会。
  const weakKeys = new Set((coverage?.weakMatches ?? []).map((item) => item?.key).filter(Boolean))
  // 卫星会/Workshop：数据是真的，但它不是名单里那个主会，单独标出来（不提示核对）
  const satelliteKeys = new Set((coverage?.satellites ?? []).map((item) => item?.key).filter(Boolean))
  const pending = coverage
    ? coverage.pending.map((conference) => ({
      key: `pending|${conference.abbr}|${conference.rank ?? ''}`,
      abbr: conference.abbr,
      fullName: conference.fullName ?? '',
      rank: conference.rank ?? '',
      area: conference.area ?? '',
      dblp: conference.dblp ?? '',
      pending: true,
    }))
    : []
  // 记录的 `area` 来自上游（英文子类，如 AI/ML、CV），而名单里的方向是中文大类
  // （如「人工智能」）。面板的方向下拉按中文大类过滤，所以这里给每条记录补一个
  // `areaGroup`：用 sameVenue 把记录对回名单条目，取它的中文方向。
  const areaOf = (row) => {
    if (conferences.length === 0) return ''
    const hit = conferences.find((conference) => sameVenue(row?.venue ?? row?.name, conference))
    return hit?.area ?? ''
  }
  return {
    ok: true,
    schema: PANEL_SCHEMA,
    version: typeof options.version === 'string' && options.version ? options.version : '',
    // 磁盘上的版本：和 version 不一样就说明进程里还是旧模块，重启桌面端才生效。
    versionDisk: typeof options.versionDisk === 'string' ? options.versionDisk : '',
    versionStale: Boolean(options.versionStale) === true,
    now: new Date(now).toISOString(),
    timezone,
    dataDir: typeof options.dataDir === 'string' ? options.dataDir : null,
    updatedAt: toIso(cache?.updatedAt),
    windowDays: Number.isFinite(options.windowDays) ? Number(options.windowDays) : null,
    count: records.length,
    counts: {
      records: records.length,
      conferences: conferences.length,
      pending: pending.length,
      withDeadline: upcoming.length,
      expired: records.length - upcoming.length,
      // 待补再拆一刀：只有往届日期的会 vs 一条记录都没有的会
      pendingPast: coverage ? coverage.counts.past : 0,
      pendingNever: coverage ? coverage.counts.never : 0,
      withFuture: coverage ? coverage.counts.future : 0,
      // 名单外的会：CCFDDL 收进来了、但 CCF 官方名单没收（CoRL / EACL / CICAI…）。
      // 它们不出现在「待补」里，也不计入 362 —— 但卡片确实在列表里，必须说清楚。
      outside: coverage ? coverage.counts.outside : 0,
      // 面板说"个会"，所以除了记录条数还要给按会去重的数（CoRL 2026/2027 是两条记录、一个会）
      outsideVenues: coverage ? coverage.counts.outsideVenues ?? coverage.counts.outside : 0,
      // 卫星会（Workshop / 地区分会场）：面板默认不列，但要说得出"有几个没显示"
      satellites: coverage ? coverage.counts.satellites : 0,
      satelliteVenues: coverage ? coverage.counts.satelliteVenues ?? coverage.counts.satellites : 0,
      outsideFuture: coverage ? coverage.counts.outsideFuture : 0,
      // 两个源说法不一致的会：不是错误，但用户有权知道。
      // 只把"差一天以上"算冲突（±1 天多是 AoE 与本地日历的边界差，天天亮红点只会吵）。
      // 只数默认视图里看得到的：被「不是这个会」否掉的、默认不列的卫星会，都不该在这个红点里算人头，
      // 否则点「不一致」进去会少几条 —— 报个数却找不到人，比不报还糟。
      // 已经过了截止的也不算：面板默认不列往届，「不一致 26」点进去只有 17 张卡片就是这样来的
      // （真机 402 条里 26 条冲突，其中 9 条已经过期）。过期的那几条单独计数，用 --past 才看得到。
      conflicts: records.filter((row) => isBigConflict(row) && !ignoredKeys.has(row?.key) && !satelliteKeys.has(row?.key)
        && Number.isFinite(row?.deadline) && row.deadline >= now).length,
      // 冲突但已经过了截止的：不在默认视图里，别让它悄悄消失，状态行要说一句。
      conflictsPast: records.filter((row) => isBigConflict(row) && !ignoredKeys.has(row?.key) && !satelliteKeys.has(row?.key)
        && !(Number.isFinite(row?.deadline) && row.deadline >= now)).length,
      // 这些冲突里已经采信过某个来源的：数量本身不会因为"你做了决定"而减少
      // （两个源的说法仍然不同），但用户需要知道还剩几条没决定。
      conflictsDecided: records.filter((row) => isBigConflict(row) && !ignoredKeys.has(row?.key) && !satelliteKeys.has(row?.key)
        && typeof row?.preferredSource === 'string' && row.preferredSource.length > 0).length,
    },
    pending,
    meta: {
      lastUpdateAt: toIso(meta.lastUpdateAt),
      lastUpdateMined: Number.isFinite(meta.lastUpdateMined) ? meta.lastUpdateMined : 0,
      lastUpdateFailed: Number.isFinite(meta.lastUpdateFailed) ? meta.lastUpdateFailed : 0,
      modelUsed: meta.modelUsed === true,
      modelReady: options.modelReady !== false,
      // 「模型：不可用」是个结论，说不出原因就等于让用户去猜：
      // 把判断依据与当前选中的 provider/model 一起带出去，面板悬停即可看到。
      modelReason: typeof options.modelReason === 'string' ? options.modelReason : '',
      modelSelection: typeof options.modelSelection === 'string' ? options.modelSelection : '',
      fallback: meta.fallback === true,
      pending: Number.isFinite(meta.pending) ? meta.pending : null,
      catalogConferences: Number.isFinite(meta.catalogConferences) ? meta.catalogConferences : null,
      note: typeof meta.note === 'string' ? meta.note : '',
      // 每个源这次成没成：只看"更新时间"的话，一个源悄悄失败只会让数据变旧而不报警。
      sources: Array.isArray(cache?.reports)
        ? cache.reports.map((report) => ({
          id: typeof report?.id === 'string' ? report.id : '',
          ok: report?.ok === true,
          count: Number.isFinite(report?.count) ? report.count : 0,
          error: typeof report?.error === 'string' ? report.error : '',
        }))
        : [],
      // 全部源都失败时会保留旧缓存，只把这次失败记在这里，避免假装新鲜。
      lastAttemptAt: toIso(cache?.lastAttemptAt),
      lastError: typeof cache?.lastError === 'string' ? cache.lastError : '',
      // 补数据的实时进度：一轮要跑几分钟，"已 N 秒"之外还得知道在补第几个、补的是谁。
      updateProgress: progressOf(options.progress, now),
      // 用户裁决过多少条：状态行直接用，不必为了两个数字读全量 records
      marks: { ignored: (cache?.meta?.ignoredKeys ?? []).length, confirmed: (cache?.meta?.confirmedKeys ?? []).length },
      // 缓存坏了要说"缓存坏了"，不能假装"还没有数据"
      cacheState: typeof options.cacheStatus?.state === 'string' ? options.cacheStatus.state : '',
      cacheError: typeof options.cacheStatus?.error === 'string' ? options.cacheStatus.error : '',
      cachePath: typeof options.cacheStatus?.path === 'string' && options.cacheStatus.path
        ? options.cacheStatus.path
        : typeof options.cacheStatus?.file === 'string' && options.cacheStatus.file
          ? options.cacheStatus.file
          : '',
    },
    catalog: options.catalog ?? null,
    catalogState: typeof options.catalogState === 'string' ? options.catalogState : null,
    attribution: typeof options.attribution === 'string' && options.attribution ? options.attribution : meta.fallbackAttribution ?? '',
    records: records.map((row) => ({
      key: row.key,
      venue: row.venue,
      year: row.year,
      name: row.name,
      fullName: row.fullName ?? '',
      rank: row.rank ?? '',
      area: row.area ?? '',
      areaGroup: areaOf(row),
      core: row.core ?? '',
      abstractDeadline: toIso(row.abstractDeadline),
      deadline: toIso(row.deadline),
      notification: toIso(row.notification),
      rebuttal: toIso(row.rebuttal),
      confDate: row.confDate ?? '',
      place: row.place ?? '',
      link: row.link ?? '',
      submitLink: row.submitLink ?? '',
      acceptRate: row.acceptRate ?? '',
      h5: Number.isFinite(row.h5) ? row.h5 : null,
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      history: Array.isArray(row.history) ? row.history.map(String) : [],
      timezone: row.timezone ?? '',
      source: row.source ?? '',
      minedAt: toIso(row.minedAt),
      mined: row.source === 'model',
      // 模型挖到的记录带出处：用户想核对时能点回它读过的页面
      minedFrom: Array.isArray(row.minedFrom) ? row.minedFrom.filter(Boolean).slice(0, 3) : [],
      // 全称与名单对不上却仍被认领：面板上标一行"建议核对"，不假装它一定是名单里那个会。
      weakMatch: weakKeys.has(row?.key),
      satellite: satelliteKeys.has(row?.key),
      // 用户标过「不是这个会」的记录：永远算名单外，不再喂给任何会
      ignored: ignoredKeys.has(row?.key),
      // 名单外的会：面板上能点到它、但它不在 362 里，也没有「待补」入口。
      // 标出来，卡片上才给得出"补这个会"（否则用户只能看着一张没有来源的卡）。
      outside: outsideKeys.has(row?.key),
      // 两个源给了不同的截止时间时，另一个说法也带上：面板不替用户断言谁对。
      alternatives: Array.isArray(row.alternatives)
        ? row.alternatives.map((item) => ({
          source: item?.source ?? '',
          deadline: toIso(item?.deadline),
          notification: toIso(item?.notification),
        }))
        : [],
      conflict: isBigConflict(row),
      // 用户手动采信过某一来源时，面板要能显示"你选的是这条"，并提供回到默认的入口。
      preferredSource: typeof row.preferredSource === 'string' ? row.preferredSource : '',
      preferred: row.preferred === true,
      // true 表示这条不是今年手点的，而是沿用了这个会往年在「采信」里留下的选择。
      preferredInherited: row.preferredInherited === true,
      // 用户点过「就是它」：卡片不再标「建议核对」
      confirmed: confirmedKeys.has(row?.key ?? ''),
    })),
  }
}

/** 读请求体里的 JSON（浏览器面板会带 {focus, scope, area, limit}；没有就返回 null）。 */
function readJsonBody(request, limit = 8192) {
  return new Promise((resolve) => {
    if (!request || typeof request.on !== 'function') {
      resolve(null)
      return
    }
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        finish(null)
        return
      }
      try {
        const parsed = JSON.parse(text)
        finish(parsed && typeof parsed === 'object' ? parsed : null)
      } catch {
        finish(null)
      }
    })
    request.on('error', () => finish(null))
  })
}

function sendJson(response, status, body, headers = {}) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  })
  response.end(text)
}

/**
 * 构造宿主路由：读缓存、触发同步（回退数据）、触发「模型挖掘」更新。
 *
 * @param {{
 *   currentCache: (force?: boolean) => any,
 *   doSync: (signal?: AbortSignal) => Promise<any>,
 *   runUpdate?: (options?: { force?: boolean, limit?: number, focus?: string|null }) => Promise<any>,
 *   config: { timezone?: string, windowDays?: number },
 *   dataDir: string,
 *   catalog?: any,
 * }} api
 * @returns {Array<{ kind: 'exact', path: string, handler: (req: any, res: any) => any }>}
 */
export function createUiRoutes(api) {
  // 每来一次请求都重新比对「跑着的版本」和「磁盘上的版本」：用户在改代码、
  // 进程还停在旧模块时，界面上得自己说出来，而不是让人去翻 package.json。
  const versionOptions = () => {
    const live = typeof api.versionState === 'function' ? api.versionState() : null
    return {
      versionDisk: live && typeof live.disk === 'string' ? live.disk : '',
      versionStale: Boolean(live && live.stale === true),
    }
  }
  const payload = (now) => panelPayload(api.currentCache(true), {
    now,
    timezone: api.config?.timezone,
    windowDays: api.config?.windowDays,
    dataDir: api.dataDir,
    version: api.version,
    ...versionOptions(),
    modelReady: api.modelReady,
    ...(typeof api.modelState === 'function'
      ? (() => {
          const live = api.modelState()
          return { modelReason: live?.reason ?? '', modelSelection: live?.selection ?? '' }
        })()
      : {}),
    catalog: api.catalog ? summarizeCatalog(api.catalog) : null,
  catalogState: api.catalogInfo?.state ?? null,
    conferences: api.catalog ? catalogConferences(api.catalog) : [],
    progress: typeof api.progress === 'function' ? api.progress() : null,
    cacheStatus: typeof api.cacheStatus === 'function' ? api.cacheStatus() : null,
  })

  const records = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/records`,
    async handler(request, response) {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: 'only local requests may read the cache' })
        return
      }
      try {
        sendJson(response, 200, payload(Date.now()))
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const sync = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/sync`,
    async handler(request, response) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: 'only local requests may trigger a sync' })
        return
      }
      try {
        const result = await api.doSync(undefined)
        sendJson(response, 200, { ...payload(Date.now()), synced: result?.ok === true, report: result?.report ?? '' })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const update = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/update`,
    async handler(request, response) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: 'only local requests may mine deadlines' })
        return
      }
      if (typeof api.runUpdate !== 'function') {
        sendJson(response, 501, { ok: false, error: 'this build has no miner wired in' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const options = { force: true }
        if (body && typeof body.focus === 'string' && body.focus.trim()) options.focus = body.focus.trim()
        if (body && (body.scope === 'past' || body.scope === 'never')) options.scope = body.scope
        if (body && typeof body.area === 'string' && body.area.trim()) options.area = body.area.trim()
        if (body && Number.isFinite(Number(body.limit)) && Number(body.limit) > 0) options.limit = Math.floor(Number(body.limit))
        const result = await api.runUpdate(options)
        // 409 而不是 200：面板据此知道"没跑成是因为上一轮还在跑"，而不是又补了一遍。
        if (result && result.busy === true) {
          sendJson(response, 409, { ok: false, busy: true, note: result.note ?? '上一轮补数据还在跑，等它结束再点。' })
          return
        }
        sendJson(response, 200, { ...payload(Date.now()), updated: result?.ok === true, model: result?.model === true, fallback: result?.fallback === true, mined: result?.mined ?? [], failed: result?.failed ?? [], byArea: result?.byArea ?? [], pending: result?.pending ?? null, note: result?.note ?? '', attribution: result?.attribution ?? '', skipped: result?.skipped ?? 0, scope: result?.scope ?? null })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const prefer = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/prefer`,
    async handler(request, response) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: 'only local requests may change the preferred source' })
        return
      }
      if (typeof api.prefer !== 'function' && typeof api.preferConflicts !== 'function') {
        sendJson(response, 501, { ok: false, error: 'this build cannot change the preferred source' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const key = body && typeof body.key === 'string' ? body.key.trim() : ''
        const source = body && typeof body.source === 'string' ? body.source.trim() : ''
        // 批量：面板「不一致」视图里一句「这批会都按 X 显示」
        if (body && body.batch === true) {
          if (!source) {
            sendJson(response, 400, { ok: false, error: 'need { batch: true, source }' })
            return
          }
          if (typeof api.preferConflicts !== 'function') {
            sendJson(response, 501, { ok: false, error: 'this build cannot change the preferred source in bulk' })
            return
          }
          const result = await api.preferConflicts({ source, undo: body.undo === true })
          if (result && result.ok === false) {
            sendJson(response, 400, { ok: false, error: result.note ?? '批量采信失败' })
            return
          }
          sendJson(response, 200, {
            ...payload(Date.now()),
            bulk: { source, changed: result?.changed ?? 0, skipped: result?.skipped ?? 0, conflicts: result?.conflicts ?? 0 },
          })
          return
        }
        if (!key) {
          sendJson(response, 400, { ok: false, error: 'need { key, source }（source 传空字符串表示恢复默认）' })
          return
        }
        if (typeof api.prefer !== 'function') {
          sendJson(response, 501, { ok: false, error: 'this build cannot change the preferred source' })
          return
        }
        const result = await api.prefer({ key, source })
        if (result && result.ok === false) {
          sendJson(response, 404, { ok: false, error: result.note ?? '没有这个会议，或者这一路来源没有给出日期' })
          return
        }
        sendJson(response, 200, { ...payload(Date.now()), preferred: { key, source } })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  const confirm = {
    kind: 'exact',
    path: `${ROUTE_PREFIX}/confirm`,
    async handler(request, response) {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' })
        response.end()
        return
      }
      if (!isLoopbackRequest(request)) {
        sendJson(response, 403, { ok: false, error: 'only local requests may confirm a match' })
        return
      }
      if (typeof api.confirm !== 'function') {
        sendJson(response, 501, { ok: false, error: 'this build cannot confirm a match' })
        return
      }
      try {
        const body = await readJsonBody(request)
        const key = body && typeof body.key === 'string' ? body.key.trim() : ''
        const undo = body?.undo === true
        // mark: 'confirm'（就是它，默认）| 'ignore'（不是这个会）；两者都只写 meta
        const mark = body?.mark === 'ignore' ? 'ignore' : 'confirm'
        if (!key) {
          sendJson(response, 400, { ok: false, error: 'need { key, mark?, undo? }' })
          return
        }
        const handler = mark === 'ignore' ? api.ignore : api.confirm
        if (typeof handler !== 'function') {
          sendJson(response, 501, { ok: false, error: `this build cannot record ${mark}` })
          return
        }
        const result = await handler({ key, undo })
        if (result && result.ok === false) {
          sendJson(response, 404, { ok: false, error: result.note ?? '没有这条记录' })
          return
        }
        sendJson(response, 200, { ...payload(Date.now()), marked: { key, mark, undo }, note: result?.note ?? '' })
      } catch (error) {
        sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }
  return [records, sync, update, prefer, confirm]
}
