/**
 * dsh-ccf · 模型挖掘
 *
 * CCF 名单（`data/ccf-catalog.json`）只告诉我们"有哪些会"。截稿时间靠两条路：
 *
 *   1. **模型挖掘**（首选）：`ctx.web.search` 找会议官网 → `ctx.web.fetch` 拉页面 →
 *      `ctx.llm.stream` 让模型把时间点抽成 JSON。**这一步必须有模型**，没有模型就跳过。
 *   2. **回退**：没有模型（或挖掘失败）时用 ccfddl 的公开数据，并在所有出口注明来源、
 *      附上 ccfddl 的网址与致谢。
 *
 * 更新是**懒**的：只处理"名单里有、但本地没有截稿时间"或"挖过但已经过期"的会，
 * 每轮还有条数上限；一周才自动跑一次。
 */
import { parseInstant } from './core.js'
import { catalogConferences, matchVenue, normalizeVenue } from './catalog.js'

/** 数据出处与致谢（必须原样出现在提示、命令输出与面板里）。 */
export const ATTRIBUTION = {
  ccfddlSite: 'https://ccfddl.com',
  ccfddlRepo: 'https://github.com/ccfddl/ccf-deadlines',
  ccfddlApi: 'https://ccfddl.com/conference/allconf.json',
  paperDeadlines: 'https://yzyhhhstudy.github.io/paper-deadlines/',
  text: '截稿数据来自 CCFDDL 官方接口（https://ccfddl.com/conference/allconf.json，GitHub: ccfddl/ccf-deadlines），感谢其作者长期维护；接口取不到时回退 paper-deadlines。',
  short: '数据来源 CCFDDL（ccfddl.com），感谢维护者',
}

/** 模型不可用时的固定说法（不编数据，直接说需要模型）。 */
export const MODEL_REQUIRED = '挖掘会议主页需要模型（ctx.llm）；当前没有可用模型，只能使用 CCFDDL 接口与回退数据。'

const DAY = 24 * 60 * 60 * 1000

/** 判定模型是否可用的错误码。 */
export function modelUnavailableError(detail = '') {
  const error = new Error(`模型不可用${detail ? `（${detail}）` : ''}`)
  error.code = 'MODEL_UNAVAILABLE'
  return error
}

/**
 * 安全地取一个宿主服务。
 *
 * cordis 的 `ctx.<name>` 只有在插件声明过 `inject` 时才能读，否则抛
 * `cannot get property "<name>" without inject`；`ctx.get(name)` 则是宽容的。
 * 这里两条都试，并且**吞掉异常**——服务可不可用本身就是我们要判断的事实，
 * 不能让它变成一次崩溃。
 */
function serviceOf(ctx, name) {
  try {
    const viaGet = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    if (viaGet) return viaGet
  } catch {
    /* 没有 inject 声明时可能抛，忽略 */
  }
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/**
 * 宿主有没有把模型能力接进来 —— 并且**说清依据**。
 *
 * 只回一个 boolean 的时候，界面上只能写「模型：不可用」，用户没法判断是自己
 * 没配模型、还是插件根本没拿到服务；更糟的是同一次运行里 `/ccf update`
 * 可能报「用了模型」而 status 说「不可用」，两边都对不了账。
 */
export function modelState(ctx) {
  const hasGet = typeof ctx?.get === 'function'
  const llm = serviceOf(ctx, 'llm')
  const selection = defaultSelection(ctx)
  const picked = [selection?.provider, selection?.model].filter(Boolean).join('/')
  if (!llm) {
    return {
      ready: false,
      reason: hasGet ? '没读到 llm 服务：宿主没把模型接给这个插件（或它比插件更晚注册）' : '这个上下文没有 ctx.get()，读不到任何服务',
      selection: picked,
      hasGet,
    }
  }
  if (typeof llm.stream !== 'function') {
    return { ready: false, reason: '读到 llm 服务，但它没有 stream()（版本不匹配？）', selection: picked, hasGet }
  }
  return { ready: true, reason: '', selection: picked, hasGet }
}

/** 宿主有没有把模型能力接进来。 */
export function isModelAvailable(ctx) {
  return modelState(ctx).ready
}

/** 取默认模型的选择（provider/model），取不到就给 undefined，让宿主自己挑。 */
function defaultSelection(ctx) {
  try {
    const holder = serviceOf(ctx, 'agentDefaultModel')
    const selection = holder?.currentSelection?.()
    if (selection && (selection.provider || selection.model)) return selection
  } catch {
    /* 没有默认模型就算了 */
  }
  return {}
}

/** 构造一条用户消息：优先用 SDK 的 createUserMessage，拿不到就退化成一个同形对象。 */
async function userMessage(text) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm/message')
    if (typeof mod?.createUserMessage === 'function') {
      return mod.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user', form: 'notice', summary: 'dsh-ccf 会议数据挖掘' },
      })
    }
  } catch {
    /* 没装 SDK（离线单测）时走退路 */
  }
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', form: 'notice', summary: 'dsh-ccf 会议数据挖掘' },
  }
}

/**
 * 调一次模型，返回拼好的文本。
 * @param {any} ctx
 * @param {{system: string, user: string, signal?: AbortSignal}} options
 */
export async function callModel(ctx, { system, user, signal }) {
  const llm = serviceOf(ctx, 'llm')
  if (typeof llm?.stream !== 'function') throw modelUnavailableError()
  const selection = defaultSelection(ctx)
  const messages = [await userMessage(user)]
  const options = { messages }
  if (selection.provider) options.provider = selection.provider
  if (selection.model) options.model = selection.model
  if (system) options.system = system
  if (selection.reasoningEffort) options.reasoningEffort = selection.reasoningEffort
  if (signal) options.signal = signal

  let text = ''
  let failed = null
  for await (const chunk of llm.stream(options)) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') text += String(chunk.text ?? '')
    else if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted' || kind === 'max-tokens') failed = chunk.reason
    }
  }
  if (failed) {
    const error = new Error(`模型调用未完成：${failed.kind}${failed.message ? ` · ${failed.message}` : ''}`)
    error.code = 'MODEL_FAILED'
    throw error
  }
  return text
}

/** 某条记录属于哪个会（用简称比较，忽略大小写与年份）。 */
function recordVenueKey(record) {
  return normalizeVenue(record?.venue ?? record?.name ?? '')
}

/**
 * 这个会在缓存里有没有记录 —— 判定必须与面板/提示词同源（`catalog.matchVenue`）。
 *
 * 早先这里用"简称归一化后完全相等"，于是 `KDD` 的记录不算 `SIGKDD` 的、
 * `CVPR Workshops` 不算 `CVPR` 的：覆盖度说"有数据"，挖掘计划却说"待补"，
 * 同一轮里既白跑一次模型，又让用户看到两个数字。
 */
function recordsOf(records, conf) {
  return (Array.isArray(records) ? records : []).filter((record) => matchVenue(record?.venue ?? record?.name ?? '', conf))
}

/**
 * 懒更新计划：只挑需要补的会。
 * @param {object} options
 * @param {any} options.catalog 名单
 * @param {Array<any>} options.records 现有缓存记录
 * @param {number} [options.now]
 * @param {number} [options.refreshDays] 挖过的记录多久之后算过期
 * @param {number} [options.limit] 本轮最多处理几个会
 * @param {boolean} [options.force] true=把过期项也算进来（手动更新用）
 * @param {string|null} [options.focus] 只处理简称/全称里含这个片段
 * @param {string|null} [options.area] 只处理这个方向（如 `人工智能`、`CV`）
 * @param {number} [options.windowDays] 只看这个窗口内的年份（默认 400 天）
 */
export function planUpdate({ catalog, records = [], now = Date.now(), refreshDays = 30, limit = 6, force = false, focus = null, area = null, scope = null, windowDays = 400 }) {
  const conferences = catalogConferences(catalog)

  const needle = focus ? normalizeVenue(focus) : ''
  const areaNeedle = area ? normalizeVenue(area) : ''
  const queue = []
  let ok = 0
  let skipped = 0

  let focused = false

  for (const conf of conferences) {
    if (needle && !normalizeVenue(conf.abbr).includes(needle) && !normalizeVenue(conf.fullName).includes(needle)) continue
    if (needle) focused = true
    if (areaNeedle && !normalizeVenue(conf.area ?? '').includes(areaNeedle)) continue
    const existing = recordsOf(records, conf)
    const fresh = existing.filter((record) => Number.isFinite(record.deadline) || Number.isFinite(record.abstractDeadline))

    // 「只有往届」/「从未抓到」：面板把待补拆成这两类，补数据也要能按类挑。
    if (scope === 'never' && existing.length > 0) {
      skipped += 1
      continue
    }
    if (scope === 'past') {
      const hasFuture = existing.some((record) => Number.isFinite(record.deadline) && record.deadline >= now)
      if (existing.length === 0 || hasFuture) {
        skipped += 1
        continue
      }
    }
    if (fresh.length === 0) {
      queue.push({ ...conf, reason: existing.length === 0 ? 'new' : 'missing', existing: existing.length })
      continue
    }

    // 与覆盖度同口径：只要「没有任何未来截稿」就是待补，不管过去的截稿有多老。
    // （windowDays 只用于给 next-edition 的紧迫度排序，不再决定它算不算待补。）
    const hasFuture = existing.some((record) => Number.isFinite(record.deadline) && record.deadline >= now)
    if (!hasFuture) {
      queue.push({ ...conf, reason: 'next-edition', existing: existing.length })
      continue
    }

    const minedAt = Math.max(...existing.map((record) => (Number.isFinite(record.minedAt) ? record.minedAt : 0)))
    const stale = minedAt > 0 ? now - minedAt > refreshDays * DAY : false
    // 点名要重挖（focus）是明确意图：不能再被 refreshDays 拦下。
    // 否则面板上的「重挖这个会」在刚同步过的会上等于没反应，只会得到一句「懒更新」。
    if (needle) queue.push({ ...conf, reason: 'focus', existing: existing.length })
    else if (force && stale) queue.push({ ...conf, reason: 'stale', existing: existing.length })
    else ok += 1
  }

  // focus 指的是名单外的会：CCF 名单 362 个里没有它，但用户在面板/命令里点了它的名字。
  // 不给这条路，按钮点了等于没反应（"没有需要补的会"）。
  //
  // 名单里没有、缓存里也没有时也照挖：用户可能是先说出口再同步（`/ccf update --focus CoRL`）。
  // 代价是拼错的名字会白花一次模型调用——但这比"列表上有这张卡、按钮却什么都不做"轻得多。
  if (needle && !focused) {
    const known = (Array.isArray(records) ? records : []).find((record) => normalizeVenue(record?.venue ?? record?.name ?? '').includes(needle))
    const abbr = String(known?.venue ?? focus).trim()
    const conf = {
      abbr,
      fullName: String(known?.fullName ?? ''),
      rank: String(known?.rank ?? ''),
      area: String(known?.area ?? ''),
      dblp: '',
      outside: true,
    }
    const existing = recordsOf(records, conf)
    const hasFuture = existing.some((record) => Number.isFinite(record.deadline) && record.deadline >= now)
    if (!hasFuture) queue.push({ ...conf, reason: existing.length === 0 ? 'new' : 'next-edition', existing: existing.length })
    else queue.push({ ...conf, reason: 'focus', existing: existing.length })
  }

  const order = { missing: 0, new: 1, focus: 2, 'next-edition': 3, stale: 4 }
  queue.sort((a, b) => (order[a.reason] ?? 9) - (order[b.reason] ?? 9) || rankWeight(a.rank) - rankWeight(b.rank) || a.abbr.localeCompare(b.abbr))
  const selected = Number.isFinite(limit) && limit > 0 ? queue.slice(0, Math.floor(limit)) : queue

  return {
    total: queue.length,
    selected,
    healthy: ok,
    skipped,
    scanned: conferences.length,
    reasons: queue.reduce((acc, item) => {
      acc[item.reason] = (acc[item.reason] ?? 0) + 1
      return acc
    }, {}),
  }
}

function rankWeight(rank) {
  if (rank === 'CCF-A') return 0
  if (rank === 'CCF-B') return 1
  if (rank === 'CCF-C') return 2
  return 3
}

/** 从会议主页里挑最像"官方的、讲日期的"链接。 */
export function pickOfficialCandidates(sources, venue, limit = 3) {
  const abbr = normalizeVenue(venue.abbr)
  const hostBoost = [abbr.replace(/\s+/g, ''), 'conf', 'conference', 'symposium', 'acm', 'ieee', 'usenix', 'springer', 'openreview']
  const pathBoost = ['cfp', 'call', 'dates', 'deadline', 'important', 'authors', 'submit', 'conference', 'program']
  const blocked = ['ccfddl', 'dblp', 'wikicfp', 'scholar', 'twitter', 'x.com', 'facebook', 'linkedin', 'youtube', 'wikipedia', 'zhihu', 'csdn', 'baidu']
  const scored = []
  for (const source of Array.isArray(sources) ? sources : []) {
    const url = String(source?.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) continue
    let host = ''
    let path = ''
    try {
      const parsed = new URL(url)
      host = parsed.hostname.toLowerCase()
      path = parsed.pathname.toLowerCase()
    } catch {
      continue
    }
    if (blocked.some((token) => host.includes(token))) continue
    let score = 0
    if (abbr && host.replace(/[^a-z0-9]/g, '').includes(abbr.replace(/[^a-z0-9]/g, ''))) score += 6
    score += hostBoost.filter((token) => host.includes(token)).length * 2
    score += pathBoost.filter((token) => path.includes(token)).length * 2
    if (/\.(pdf|docx?|pptx?)$/i.test(path)) score -= 4
    scored.push({ url, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const seen = new Set()
  const out = []
  for (const item of scored) {
    if (seen.has(item.url)) continue
    seen.add(item.url)
    out.push(item.url)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 找会议官网：用宿主网页搜索，再按"像不像官方"排序。
 * @returns {Promise<string[]>}
 */
export async function discoverHomepage(ctx, venue, { maxResults = 6, limit = 3, signal } = {}) {
  const web = serviceOf(ctx, 'web')
  if (typeof web?.search !== 'function') throw new Error('宿主没有网页搜索能力（ctx.web）')
  const query = `${venue.abbr} ${venue.fullName} ${new Date().getFullYear()} conference call for papers important dates`
  const result = await web.search({ query, maxResults }, signal)
  return pickOfficialCandidates(result?.sources, venue, limit)
}

/** 抓一个页面，返回正文文本（html 原样，交给模型读）。 */
export async function fetchPageText(ctx, url, { maxChars = 16000, signal } = {}) {
  const web = serviceOf(ctx, 'web')
  if (typeof web?.fetch !== 'function') throw new Error('宿主没有网页抓取能力（ctx.web）')
  const result = await web.fetch({ url }, signal)
  const statusCode = Number(result?.statusCode ?? 0)
  const body = String(result?.body?.content ?? '')
  return { url, statusCode, ok: statusCode >= 200 && statusCode < 300 && body.length > 0, text: body.slice(0, maxChars), truncated: Boolean(result?.truncated) }
}

const SYSTEM_PROMPT = [
  '你是学术会议数据抽取器。只从给你的网页文本里抽取事实，不补充任何记忆或猜测。',
  '网页里没有的信息一律填 null，不要用"通常""一般"推测。',
  '输出必须是单个 JSON 对象，不要解释、不要 Markdown 代码围栏。',
].join('\n')

/** 组装给模型的提示：会议身份 + 页面正文。 */
export function buildPrompt(venue, pages) {
  const blocks = pages.map((page, index) => `--- 页面 ${index + 1}: ${page.url} (HTTP ${page.statusCode}) ---\n${page.text}`).join('\n\n')
  const user = [
    `会议：${venue.abbr}（全称 ${venue.fullName}，等级 ${venue.rank}，方向 ${venue.area}）`,
    '请从下面网页文本中抽取**下一届**（最近一个未开会的年份）的关键时间点。',
    '字段含义：',
    '- year: 届次年份（数字）',
    '- deadline: 论文截稿（ISO 8601，带时区偏移，例如 2026-11-13T23:59:59-08:00）',
    '- abstractDeadline: 摘要/注册截稿（同上，没有就 null）',
    '- notification: 审稿决定/录用通知（同上）',
    '- rebuttal: 作者回复（rebuttal）开始时间（同上）',
    '- confDate: 会期，原文怎么写就怎么填，例如 "2027-06-06 ~ 2027-06-11"',
    '- place: 开会地点，例如 "Honolulu, USA"',
    '- link: 你抽取这些信息所用的官网 URL',
    '只输出 JSON：{"year":…,"deadline":…,"abstractDeadline":…,"notification":…,"rebuttal":…,"confDate":…,"place":…,"link":…}',
    '',
    blocks,
  ].join('\n')
  return { system: SYSTEM_PROMPT, user }
}

/** 从模型输出里取出 JSON 对象（容忍 ```json 围栏与前后废话）。 */
export function parseMinedJson(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(body.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const ISO_HINT = /^\d{4}-\d{2}-\d{2}/

/**
 * 把模型给的字段清洗成一条记录。抽不到任何时间点就返回 null（宁缺勿编）。
 * @param {any} raw 模型返回的 JSON
 * @param {any} venue 名单条目
 * @param {{now?: number, pastDays?: number, futureDays?: number}} [options]
 */
export function sanitizeMined(raw, venue, { now = Date.now(), pastDays = 400, futureDays = 900 } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const pick = (value) => {
    if (value === null || value === undefined) return null
    const text = String(value).trim()
    if (!text || /^(null|n\/a|unknown|tbd|待定|未知)$/i.test(text)) return null
    if (!ISO_HINT.test(text) && !/^\d{4}\/\d{1,2}\/\d{1,2}/.test(text)) return null
    const instant = parseInstant(text.replace(/\//g, '-'), 'AoE')
    if (!Number.isFinite(instant)) return null
    if (instant < now - pastDays * DAY || instant > now + futureDays * DAY) return null
    return instant
  }

  const deadline = pick(raw.deadline)
  const abstractDeadline = pick(raw.abstractDeadline ?? raw.abstract_deadline)
  const notification = pick(raw.notification)
  const rebuttal = pick(raw.rebuttal)
  if (deadline === null && abstractDeadline === null && notification === null) return null

  let year = Number.isFinite(Number(raw.year)) ? Number(raw.year) : null
  if (!year && deadline !== null) year = new Date(deadline).getUTCFullYear()
  if (!year && abstractDeadline !== null) year = new Date(abstractDeadline).getUTCFullYear()
  if (!year) {
    const match = String(raw.confDate ?? '').match(/(19|20)\d{2}/)
    if (match) year = Number(match[0])
  }

  const name = year ? `${venue.abbr} ${year}` : venue.abbr
  return {
    key: `${venue.abbr.toLowerCase()}|${year ?? ''}`,
    venue: venue.abbr,
    year,
    name,
    fullName: venue.fullName ?? '',
    rank: venue.rank ?? '',
    area: venue.area ?? '',
    core: '',
    abstractDeadline,
    deadline,
    notification,
    rebuttal,
    confDate: raw.confDate ? String(raw.confDate).slice(0, 80) : '',
    place: raw.place ? String(raw.place).slice(0, 120) : '',
    link: raw.link && /^https?:\/\//i.test(String(raw.link)) ? String(raw.link) : '',
    submitLink: '',
    aliases: [],
    acceptRate: '',
    h5: null,
    history: [],
    verified: false,
    source: 'model',
    minedAt: now,
  }
}

/**
 * 挖一个会议：搜索官网 → 抓页面 → 模型抽取 → 清洗。
 * @returns {Promise<{record: any|null, pages: string[], error?: string}>}
 */
export async function mineVenue(ctx, venue, { now = Date.now(), signal, maxChars = 16000, maxPages = 2, logger } = {}) {
  let urls = []
  try {
    urls = await discoverHomepage(ctx, venue, { signal })
  } catch (error) {
    return { record: null, pages: [], error: `搜索失败：${error?.message ?? error}` }
  }
  if (urls.length === 0) return { record: null, pages: [], error: '没有找到官网候选链接' }

  const pages = []
  for (const url of urls.slice(0, maxPages)) {
    try {
      const page = await fetchPageText(ctx, url, { maxChars, signal })
      if (page.ok) pages.push(page)
    } catch (error) {
      logger?.warn?.(`dsh-ccf: 抓取失败 ${url} —— ${error?.message ?? error}`)
    }
  }
  if (pages.length === 0) return { record: null, pages: urls, error: '官网页面都抓不到' }

  const prompt = buildPrompt(venue, pages)
  let text = ''
  try {
    text = await callModel(ctx, { system: prompt.system, user: prompt.user, signal })
  } catch (error) {
    return { record: null, pages: pages.map((page) => page.url), error: `${error?.code ?? 'MODEL_FAILED'}：${error?.message ?? error}` }
  }

  const parsed = parseMinedJson(text)
  const record = sanitizeMined(parsed, venue, { now })
  if (!record) return { record: null, pages: pages.map((page) => page.url), error: '模型没给出可用时间点（或超出合理范围）' }
  if (!record.link) record.link = pages[0].url
  // 留个出处：模型说的是哪几页上的话，用户想核对时能点回去
  record.minedFrom = pages.map((page) => page.url)
  return { record, pages: record.minedFrom }
}

/**
 * 把挖到的记录并进现有记录：同 key 覆盖，但空字段不覆盖已有的非空值。
 * @param {Array<any>} records
 * @param {Array<any>} incoming
 */
export function mergeRecords(records, incoming) {
  const out = Array.isArray(records) ? records.slice() : []
  const index = new Map(out.map((record, position) => [record.key, position]))
  for (const record of Array.isArray(incoming) ? incoming : []) {
    const position = index.get(record.key)
    if (position === undefined) {
      index.set(record.key, out.length)
      out.push(record)
      continue
    }
    const merged = { ...out[position] }
    for (const [key, value] of Object.entries(record)) {
      const existing = merged[key]
      const empty = existing === null || existing === undefined || existing === '' || (Array.isArray(existing) && existing.length === 0)
      if (!empty) continue
      merged[key] = value
    }
    // 时间点以新挖到的为准（旧数据可能已经公告更新）
    for (const key of ['deadline', 'abstractDeadline', 'notification', 'rebuttal']) {
      if (Number.isFinite(record[key])) merged[key] = record[key]
    }
    merged.source = record.source ?? merged.source
    merged.minedAt = record.minedAt ?? merged.minedAt
    if (!merged.link && record.link) merged.link = record.link
    out[position] = merged
  }
  return out
}

/**
 * 跑一次更新：懒计划 → 逐个挖 → 合并 → 落盘。模型不可用时回退到 ccfddl。
 *
 * @param {object} options
 * @param {any} options.ctx cordis 上下文
 * @param {any} options.config 生效配置
 * @param {string} options.dataDir 数据目录
 * @param {() => any} options.currentCache 同步读缓存
 * @param {(signal?: AbortSignal) => Promise<any>} options.doSync 回退同步
 * @param {(cache: any) => Promise<any>} options.saveCache 落盘
 * @param {number} [options.limit]
 * @param {boolean} [options.force]
 * @param {string|null} [options.focus]
 * @param {AbortSignal} [options.signal]
 * @param {any} [options.logger]
 * @param {number} [options.now]
 */
export async function runUpdate({ ctx, config, dataDir, currentCache, doSync, saveCache, limit, force = false, focus = null, area = null, scope = null, signal, logger, now = Date.now(), onProgress = null }) {
  const refreshDays = Number(config?.refreshDays) > 0 ? Number(config.refreshDays) : 30
  const maxVenues = Number.isFinite(limit) ? Number(limit) : Number(config?.maxVenuesPerRun) > 0 ? Number(config.maxVenuesPerRun) : 6
  const catalog = config?.catalog ?? null
  if (!catalog) {
    return { ok: false, model: false, fallback: false, mined: [], failed: [], byArea: [], pending: 0, note: '没有 CCF 名单文件（data/ccf-catalog.json），无法按名单挖掘。', attribution: '' }
  }

  const cache = currentCache(false) ?? { schema: 'dsh-ccf/cache/v1', updatedAt: null, reports: [], records: [] }
  const records = Array.isArray(cache.records) ? cache.records : []
  const plan = planUpdate({ catalog, records, now, refreshDays, limit: maxVenues, force, focus, area, scope })

  const modelReady = isModelAvailable(ctx)
  const mined = []
  const failed = []
  const pagesById = {}
  const byArea = new Map()
  const bumpArea = (area, key) => {
    const name = String(area || '').trim() || '未标注方向'
    const entry = byArea.get(name) ?? { area: name, mined: 0, failed: 0 }
    entry[key] += 1
    byArea.set(name, entry)
  }

  if (modelReady) {
    // 一轮补数据要跑好几分钟，中间什么也不说的话，用户只会看到一个不动的秒表。
    // 每开始/结束一个会就报一次进度，面板拿它显示"正在补 3/6：CVPR"。
    const total = plan.selected.length
    const say = (payload) => {
      try {
        onProgress?.(payload)
      } catch {
        // 进度回调不该影响挖掘本身
      }
    }
    for (const [index, venue] of plan.selected.entries()) {
      if (signal?.aborted) break
      say({ phase: 'start', index: index + 1, total, venue: venue.abbr, fullName: venue.fullName })
      try {
        const result = await mineVenue(ctx, venue, { now, signal, logger })
        pagesById[venue.abbr] = result.pages
        if (result.record) {
          mined.push({ ...result.record, fullName: venue.fullName, rank: venue.rank, area: venue.area })
          bumpArea(venue.area, 'mined')
          say({ phase: 'done', index: index + 1, total, venue: venue.abbr, ok: true })
        } else {
          failed.push({ abbr: venue.abbr, reason: result.error ?? '未抽取到时间点' })
          bumpArea(venue.area, 'failed')
          say({ phase: 'done', index: index + 1, total, venue: venue.abbr, ok: false, reason: result.error ?? '未抽取到时间点' })
        }
      } catch (error) {
        failed.push({ abbr: venue.abbr, reason: String(error?.message ?? error) })
        bumpArea(venue.area, 'failed')
        say({ phase: 'done', index: index + 1, total, venue: venue.abbr, ok: false, reason: String(error?.message ?? error) })
      }
    }
  }

  const merged = mergeRecords(records, mined)
  const usedFallback = !modelReady || (merged.length === 0 && records.length === 0)

  let fallbackReport = ''
  let finalRecords = merged
  if (usedFallback) {
    try {
      const result = await doSync(signal)
      fallbackReport = result?.report ?? ''
      const synced = currentCache(true)
      if (synced && Array.isArray(synced.records)) finalRecords = mergeRecords(synced.records, mined)
    } catch (error) {
      fallbackReport = `回退同步失败：${error?.message ?? error}`
    }
  }

  const nextPlan = planUpdate({ catalog, records: finalRecords, now, refreshDays, limit: maxVenues, force: false, focus, area, scope })
  const next = {
    schema: 'dsh-ccf/cache/v1',
    updatedAt: mined.length > 0 || usedFallback ? now : cache.updatedAt ?? null,
    reports: Array.isArray(cache.reports) ? cache.reports : [],
    records: finalRecords,
    meta: {
      ...(cache.meta && typeof cache.meta === 'object' ? cache.meta : {}),
      lastUpdateAt: now,
      lastUpdateMined: mined.length,
      lastUpdateFailed: failed.length,
      modelUsed: modelReady && mined.length > 0,
      fallback: usedFallback,
      fallbackAttribution: usedFallback ? ATTRIBUTION.text : cache.meta?.fallbackAttribution ?? '',
      pending: nextPlan.total,
      catalogConferences: plan.scanned,
      pagesById,
      note: modelReady ? '' : MODEL_REQUIRED,
    },
  }
  try {
    if (typeof saveCache === 'function') await saveCache(next)
    else {
      const { saveCache: writeCache } = await import('./sync.js')
      await writeCache(dataDir, next)
    }
  } catch (error) {
    logger?.warn?.(`dsh-ccf: 写缓存失败 —— ${error?.message ?? error}`)
  }

  const lines = []
  if (!modelReady) {
    lines.push(`⚠ 没有可用模型 —— ${MODEL_REQUIRED}`)
    if (fallbackReport) lines.push(fallbackReport.split('\n')[0])
  } else {
    lines.push(`模型挖掘：本轮处理 ${plan.selected.length} 个会，成功 ${mined.length} 个，失败 ${failed.length} 个。`)
    if (scope) {
      const label = scope === 'past' ? '只有往届日期' : '从未抓到'
      lines.push(`本次范围：${label}（跳过 ${plan.skipped} 个不符合条件的会）`)
    }
    if (plan.selected.length === 0) {
      if (scope) {
        lines.push(`这个范围里已经没有要补的会了（跳过 ${plan.skipped} 个）。换「全部」或另一类待补再看。`)
      } else if (typeof focus === 'string' && focus.trim()) {
        lines.push(`没对上「${focus.trim()}」：名单和缓存里都没有这个名字。换个简称试试，或先用 /ccf list --search 看看数据里叫什么。`)
      } else {
        lines.push('没有需要补的会（懒更新：名单内都已有未来截稿）。')
      }
    }
    if (mined.length > 0) lines.push(`新数据：${mined.map((record) => record.name).join('、')}`)
    if (failed.length > 0) lines.push(`未搞定：${failed.slice(0, 5).map((item) => `${item.abbr}（${item.reason}）`).join('；')}`)
    const areaRows = Array.from(byArea.values())
    if (areaRows.length > 1 || (areaRows.length === 1 && areaRows[0].area !== '未标注方向')) {
      lines.push(`按方向：${areaRows.slice(0, 4).map((entry) => `${entry.area} ${entry.mined} 成功 / ${entry.failed} 失败`).join('；')}`)
    }
    lines.push(`仍待补：${nextPlan.total} 个会（名单共 ${plan.scanned} 个会议）`)
  }
  if (usedFallback) lines.push(`\n${ATTRIBUTION.text}`)

  return {
    ok: true,
    model: modelReady,
    fallback: usedFallback,
    mined: mined.map((record) => ({ venue: record.venue, year: record.year, deadline: record.deadline, link: record.link })),
    failed,
    byArea: Array.from(byArea.values()),
    pending: nextPlan.total,
    total: plan.scanned,
    skipped: plan.skipped,
    scope: scope ?? null,
    note: lines.join('\n'),
    attribution: usedFallback ? ATTRIBUTION.text : '',
    fallbackReport,
  }
}
