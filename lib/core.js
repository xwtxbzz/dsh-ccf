/**
 * dsh-ccf · 纯逻辑层（不 import 任何 DSH SDK，便于单元测试与独立复用）
 *
 * 负责四件事：
 *   1. 把两种上游格式（ccfddl 的 YAML、paper-deadlines 的 JSON）归一成同一种记录
 *   2. 处理截稿时间的时区语义（AoE / UTC / IANA），换算成绝对时刻
 *   3. 按窗口/等级/方向/关键词查询快要截稿的会议
 *   4. 渲染成人读的清单（含倒计时）与注入 system-prompt 的摘要
 *
 * 原则：不硬编码任何日期。没有同步到数据时，明确说"没有数据"，绝不猜。
 */

/** 插件默认配置。 */
export const DEFAULTS = Object.freeze({
  windowDays: 120,
  leadDays: 30,
  maxPromptItems: 8,
  prompt: true,
  ranks: null,
  areas: null,
  timezone: 'Asia/Shanghai',
  timeoutMs: 20000,
  dataDir: null,
  sources: null,
  staleHours: 168,
})

/** 默认数据源：先 JSON（一次请求拿到全量），再用 ccfddl 的本地目录/压缩包兜底。 */
export const DEFAULT_SOURCES = Object.freeze([
  {
    id: 'paper-deadlines',
    type: 'json',
    url: 'https://yzyhhhstudy.github.io/paper-deadlines/data.json',
  },
])

/** ccfddl 的领域代码 → 人读名（用于把 `sub` 字段翻译成方向）。 */
export const CCFDDL_SUB_LABELS = Object.freeze({
  AI: '人工智能',
  CG: '计算机图形学与多媒体',
  CT: '计算机理论',
  DB: '数据库/数据挖掘/内容检索',
  DS: '计算机体系结构/并行与分布计算/存储系统',
  HI: '人机交互与普适计算',
  MX: '交叉/综合/新兴',
  MS: '软件工程/系统软件/程序设计语言',
  NW: '计算机网络',
  OS: '计算机体系结构',
  SC: '高性能计算',
  SE: '软件工程',
  SP: '网络与信息安全',
  TH: '计算机理论',
})

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/* ------------------------------------------------------------------ *
 * 时间
 * ------------------------------------------------------------------ */

/**
 * 取某个 IANA 时区在某个绝对时刻的偏移（分钟，东为正）。
 * @param {string} timeZone
 * @param {number} instant
 */
export function tzOffsetMinutes(timeZone, instant) {
  if (timeZone === 'AoE') return -12 * 60
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return 0
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts = formatter.formatToParts(new Date(instant))
  const bag = {}
  for (const part of parts) bag[part.type] = part.value
  const asUtc = Date.UTC(
    Number(bag.year),
    Number(bag.month) - 1,
    Number(bag.day),
    Number(bag.hour) % 24,
    Number(bag.minute),
    Number(bag.second),
  )
  return (asUtc - instant) / MINUTE
}

/**
 * 把「某时区的墙面时间」换算成绝对毫秒。
 * @param {{year:number,month:number,day:number,hour?:number,minute?:number,second?:number}} wall
 * @param {string} timeZone
 * @returns {number}
 */
export function zonedToInstant(wall, timeZone) {
  const guess = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour ?? 0,
    wall.minute ?? 0,
    wall.second ?? 0,
  )
  // 两轮迭代即可收敛（DST 边界上第二轮会稳定到正确偏移）
  let instant = guess - tzOffsetMinutes(timeZone, guess) * MINUTE
  instant = guess - tzOffsetMinutes(timeZone, instant) * MINUTE
  return instant
}

const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})$/
const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * 解析上游给的时间字符串。
 * 带显式偏移的（`2026-11-13T23:59:59-08:00`）直接用；不带偏移的按 `timeZone` 解释；
 * 只有日期的按该时区当天 23:59:59 处理（截稿通常指当天结束）。
 * @param {unknown} text
 * @param {string} [timeZone]
 * @returns {number|null} 毫秒时间戳；解析不了返回 null
 */
export function parseInstant(text, timeZone = 'UTC') {
  if (text === null || text === undefined) return null
  const value = String(text).trim()
  if (!value) return null

  const offsetMatch = value.match(ISO_WITH_OFFSET)
  if (offsetMatch) {
    const [, y, mo, d, h, mi, s, zone] = offsetMatch
    let offset = zone
    if (zone !== 'Z') {
      const sign = zone[0] === '-' ? -1 : 1
      const digits = zone.slice(1).replace(':', '')
      offset = `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2, 4)}`
      void sign
    }
    return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s ?? '00'}${offset}`)
  }

  const localMatch = value.match(ISO_LOCAL)
  if (localMatch) {
    const [, y, mo, d, h, mi, s] = localMatch
    return zonedToInstant(
      { year: +y, month: +mo, day: +d, hour: +h, minute: +mi, second: s ? +s : 0 },
      timeZone,
    )
  }

  const dateMatch = value.match(DATE_ONLY)
  if (dateMatch) {
    const [, y, mo, d] = dateMatch
    return zonedToInstant({ year: +y, month: +mo, day: +d, hour: 23, minute: 59, second: 59 }, timeZone)
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

/** 把绝对时刻渲染成目标时区的可读时间。 */
export function formatInZone(instant, timeZone = 'Asia/Shanghai') {
  if (!Number.isFinite(instant)) return ''
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return formatter.format(new Date(instant)).replace(/\//g, '-')
}

/**
 * 倒计时文本：`13 天 9 小时` / `还剩 42 分钟` / `已过 2 天`。
 * @param {number} deltaMs 截稿时刻 - 现在
 */
export function countdownText(deltaMs) {
  if (!Number.isFinite(deltaMs)) return ''
  const past = deltaMs < 0
  const total = Math.abs(deltaMs)
  const days = Math.floor(total / DAY)
  const hours = Math.floor((total - days * DAY) / HOUR)
  const minutes = Math.floor((total - days * DAY - hours * HOUR) / MINUTE)
  let text
  if (days > 0) text = hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  else if (hours > 0) text = minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
  else if (minutes > 0) text = `${minutes} 分钟`
  else text = '不到 1 分钟'
  return past ? `已过 ${text}` : text
}

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

/** 名字里抽年份：`CVPR 2027` → 2027；没有则 null。 */
export function yearOf(text) {
  const match = String(text ?? '').match(/(19|20)\d{2}/)
  return match ? Number(match[0]) : null
}

/** 去掉名字末尾的年份与括号补充，得到干净的会议名：`KDD 2027 (Cycle 1)` → `KDD`。 */
export function venueOf(text) {
  const value = String(text ?? '').trim()
  if (!value) return ''
  return value
    .replace(/\((?:[^()]*)\)/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const RANK_ORDER = { 'CCF-A': 0, 'CCF-B': 1, 'CCF-C': 2, 'Non-CCF': 3 }

/**
 * 归一化 paper-deadlines JSON 的一条记录。
 * @param {any} raw
 * @param {string} source
 */
export function normalizeJsonRecord(raw, source = 'paper-deadlines') {
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.name ?? '').trim()
  if (!name) return null
  const venue = venueOf(name) || name
  const year = yearOf(name)
  return {
    key: `${venue.toLowerCase()}|${year ?? ''}`,
    venue,
    year,
    name,
    fullName: raw.fullName ? String(raw.fullName) : '',
    rank: raw.rank ? String(raw.rank) : '',
    area: raw.area ? String(raw.area) : '',
    core: raw.core ? String(raw.core) : '',
    abstractDeadline: parseInstant(raw.abstractDeadline, 'AoE'),
    deadline: parseInstant(raw.deadline, 'AoE'),
    notification: parseInstant(raw.notification, 'AoE'),
    confDate: raw.confDate ? String(raw.confDate) : '',
    place: raw.place ? String(raw.place) : '',
    link: raw.link ? String(raw.link) : '',
    submitLink: raw.submitLink ? String(raw.submitLink) : '',
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String) : [],
    acceptRate: raw.acceptRate ? String(raw.acceptRate) : '',
    h5: Number.isFinite(raw.h5) ? Number(raw.h5) : null,
    history: Array.isArray(raw.history) ? raw.history.map(String) : [],
    verified: raw.verified === true,
    source,
  }
}

/**
 * 归一化 ccfddl 的一个 venue 文档（`conferences/<venue>.yml`），每个 conf 年份一条记录。
 * @param {any} doc
 * @param {string} source
 */
export function normalizeCcfddlVenue(doc, source = 'ccfddl') {
  if (!doc || typeof doc !== 'object') return []
  const title = String(doc.title ?? doc.name ?? '').trim()
  const confs = Array.isArray(doc.confs) ? doc.confs : Array.isArray(doc.conferences) ? doc.conferences : []
  if (!title || confs.length === 0) return []
  const rank = doc.rank ? `CCF-${String(doc.rank).toUpperCase()}` : ''
  const area = doc.sub ? CCFDDL_SUB_LABELS[String(doc.sub).toUpperCase()] ?? String(doc.sub) : ''
  const records = []
  for (const conf of confs) {
    if (!conf || typeof conf !== 'object') continue
    const year = Number.isFinite(conf.year) ? Number(conf.year) : yearOf(conf.id)
    const timeline = Array.isArray(conf.timeline) ? conf.timeline : Array.isArray(conf.deadlines) ? conf.deadlines : []
    const timezone = conf.timezone ? String(conf.timezone) : 'AoE'
    let abstractDeadline = null
    let deadline = null
    for (const slot of timeline) {
      if (!slot || typeof slot !== 'object') continue
      const abstract = slot.abstract_deadline ?? slot.abstractDeadline
      const paper = slot.deadline ?? slot.paper_deadline
      if (abstract && abstractDeadline === null) abstractDeadline = parseInstant(abstract, timezone)
      if (paper && deadline === null) deadline = parseInstant(paper, timezone)
    }
    if (deadline === null && abstractDeadline === null) continue
    records.push({
      key: `${title.toLowerCase()}|${year ?? ''}`,
      venue: title,
      year,
      name: year ? `${title} ${year}` : title,
      fullName: doc.description ? String(doc.description) : '',
      rank,
      area,
      core: '',
      abstractDeadline,
      deadline,
      notification: null,
      confDate: conf.date ? String(conf.date) : '',
      place: conf.place ? String(conf.place) : '',
      link: conf.link ? String(conf.link) : '',
      submitLink: '',
      aliases: [],
      acceptRate: '',
      h5: null,
      history: [],
      verified: false,
      source,
      timezone,
    })
  }
  return records
}

/**
 * 把多源记录合并去重：同 venue+year 时，先出现的源优先，缺的字段用后面的补。
 * @param {Array<any>} records
 */
export function dedupeRecords(records) {
  const byKey = new Map()
  for (const record of records) {
    if (!record) continue
    const key = record.key || `${record.venue}|${record.year ?? ''}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...record })
      continue
    }
    for (const [field, value] of Object.entries(record)) {
      const current = existing[field]
      const empty = current === null || current === undefined || current === '' ||
        (Array.isArray(current) && current.length === 0)
      const incoming = value !== null && value !== undefined && value !== '' &&
        !(Array.isArray(value) && value.length === 0)
      if (empty && incoming) existing[field] = value
    }
  }
  return [...byKey.values()]
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

/**
 * 查快要截稿的会议。
 * @param {Array<any>} records
 * @param {{now?:number, windowDays?:number, ranks?:string[]|null, areas?:string[]|null,
 *          search?:string|null, limit?:number, includePast?:boolean, pastDays?:number}} [options]
 */
export function queryDeadlines(records, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const windowDays = Number.isFinite(options.windowDays) ? options.windowDays : DEFAULTS.windowDays
  const horizon = now + windowDays * DAY
  const floor = options.includePast ? now - (Number.isFinite(options.pastDays) ? options.pastDays : 14) * DAY : now
  const ranks = Array.isArray(options.ranks) && options.ranks.length > 0
    ? new Set(options.ranks.map((rank) => String(rank).toUpperCase().replace(/^CCF-?/, 'CCF-')))
    : null
  const areas = Array.isArray(options.areas) && options.areas.length > 0
    ? new Set(options.areas.map((area) => String(area).toLowerCase()))
    : null
  const search = options.search ? String(options.search).trim().toLowerCase() : null

  const rows = []
  for (const record of records) {
    if (!record) continue
    const instant = record.deadline
    if (!Number.isFinite(instant)) continue
    if (instant < floor || instant > horizon) continue
    if (ranks) {
      const normalized = String(record.rank ?? '').toUpperCase().replace(/^CCF-?/, 'CCF-')
      if (!ranks.has(normalized)) continue
    }
    if (areas) {
      const area = String(record.area ?? '').toLowerCase()
      if (!area || ![...areas].some((wanted) => area.includes(wanted))) continue
    }
    if (search) {
      const haystack = [record.venue, record.name, record.fullName, ...(record.aliases ?? [])]
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(search)) continue
    }
    rows.push({ ...record, deltaMs: instant - now })
  }

  rows.sort((left, right) => {
    const rankDelta = (RANK_ORDER[left.rank] ?? 9) - (RANK_ORDER[right.rank] ?? 9)
    if (left.deltaMs !== right.deltaMs) return left.deltaMs - right.deltaMs
    return rankDelta
  })
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : rows.length
  return rows.slice(0, limit)
}

/**
 * 查某个会议的详情（全部年份，按截稿时间倒序）。
 * @param {Array<any>} records
 * @param {string} query 会议名或别名（大小写不敏感，容忍 `CVPR`/`cvpr 2027`）
 */
export function queryVenue(records, query) {
  const needle = venueOf(query).toLowerCase()
  if (!needle) return []
  const exact = []
  const fuzzy = []
  for (const record of records) {
    if (!record) continue
    const names = [record.venue, record.name, record.fullName, ...(record.aliases ?? [])]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase())
    if (names.some((value) => venueOf(value) === needle)) exact.push(record)
    else if (names.some((value) => value.includes(needle))) fuzzy.push(record)
  }
  const rows = exact.length > 0 ? exact : fuzzy
  return rows.sort((left, right) => (right.deadline ?? 0) - (left.deadline ?? 0))
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/** 一行摘要：`CVPR 2027 · CCF-A · CV · 11-13 07:59 · 13 天 9 小时后`。 */
export function formatRow(record, { now = Date.now(), timeZone = DEFAULTS.timezone } = {}) {
  const parts = [record.name ?? record.venue]
  if (record.rank) parts.push(record.rank)
  if (record.area) parts.push(record.area)
  if (Number.isFinite(record.deadline)) {
    const wall = formatInZone(record.deadline, timeZone)
    parts.push(`${wall}（${countdownText(record.deadline - now)}${record.deadline > now ? '后' : '前'}）`)
  } else {
    parts.push('截稿时间未知')
  }
  return parts.join(' · ')
}

/**
 * 渲染截稿清单。
 * @param {Array<any>} rows
 * @param {{now?:number, windowDays?:number, timeZone?:string, title?:string, includeHistory?:boolean}} [options]
 */
export function formatList(rows, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const timeZone = options.timeZone ?? DEFAULTS.timezone
  const windowDays = Number.isFinite(options.windowDays) ? options.windowDays : DEFAULTS.windowDays
  if (rows.length === 0) {
    return [
      `未来 ${windowDays} 天内没有匹配的会议截稿。`,
      '可以放宽条件：`/ccf list 240` 或 `/ccf list 120 --rank CCF-B`；数据太旧就先 `/ccf sync`。',
    ].join('\n')
  }
  const lines = [
    options.title ?? `未来 ${windowDays} 天内 ${rows.length} 个截稿（时间按 ${timeZone} 显示，现在 ${formatInZone(now, timeZone)}）`,
  ]
  rows.forEach((record, index) => {
    lines.push(`${String(index + 1).padStart(2, ' ')}. ${formatRow(record, { now, timeZone })}`)
    const extras = []
    if (Number.isFinite(record.abstractDeadline)) {
      extras.push(`摘要 ${formatInZone(record.abstractDeadline, timeZone)}`)
    }
    if (Number.isFinite(record.notification)) {
      extras.push(`通知 ${formatInZone(record.notification, timeZone)}`)
    }
    if (record.confDate) extras.push(`会期 ${record.confDate}`)
    if (record.place && record.place !== 'TBD') extras.push(`地点 ${record.place}`)
    if (extras.length > 0) lines.push(`     ${extras.join(' · ')}`)
    if (record.link) lines.push(`     ${record.link}`)
    if (options.includeHistory && record.history.length > 0) {
      lines.push(`     往届截稿：${record.history.join(' / ')}`)
    }
  })
  return lines.join('\n')
}

/** 渲染单个会议详情。 */
export function formatVenue(rows, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const timeZone = options.timeZone ?? DEFAULTS.timezone
  if (rows.length === 0) return '没有找到这个会议。先 `/ccf sync`，再用 `/ccf list` 看看数据里有哪些会议。'
  const head = rows[0]
  const lines = [
    `${head.venue}${head.year ? ` ${head.year}` : ''}${head.rank ? ` · ${head.rank}` : ''}${head.area ? ` · ${head.area}` : ''}`,
  ]
  if (head.fullName) lines.push(`全称：${head.fullName}`)
  for (const record of rows) {
    const pieces = [`${record.year ?? '—'}:`]
    pieces.push(Number.isFinite(record.deadline)
      ? `截稿 ${formatInZone(record.deadline, timeZone)}（${countdownText(record.deadline - now)}）`
      : '截稿未知')
    if (Number.isFinite(record.abstractDeadline)) {
      pieces.push(`摘要 ${formatInZone(record.abstractDeadline, timeZone)}`)
    }
    if (Number.isFinite(record.notification)) {
      pieces.push(`通知 ${formatInZone(record.notification, timeZone)}`)
    }
    if (record.confDate) pieces.push(`会期 ${record.confDate}`)
    if (record.place) pieces.push(`地点 ${record.place}`)
    lines.push(`  - ${pieces.join(' · ')}`)
  }
  if (head.history.length > 0) lines.push(`往届截稿：${head.history.join(' / ')}`)
  if (head.acceptRate) lines.push(`录用率：${head.acceptRate}${head.h5 ? ` · h5 ${head.h5}` : ''}`)
  if (head.link) lines.push(`主页：${head.link}`)
  if (head.submitLink) lines.push(`投稿：${head.submitLink}`)
  return lines.join('\n')
}

/**
 * system-prompt 摘要：只注入"窗口内最近几条"，没有数据/数据太旧则不注入（返回空串）。
 * @param {{records:Array<any>, updatedAt:number|null}|null} cache
 * @param {{now?:number, leadDays?:number, maxPromptItems?:number, timeZone?:string, staleHours?:number}} [options]
 */
export function promptText(cache, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const leadDays = Number.isFinite(options.leadDays) ? options.leadDays : DEFAULTS.leadDays
  const maxItems = Number.isFinite(options.maxPromptItems) ? options.maxPromptItems : DEFAULTS.maxPromptItems
  const timeZone = options.timeZone ?? DEFAULTS.timezone
  const staleHours = Number.isFinite(options.staleHours) ? options.staleHours : DEFAULTS.staleHours
  if (!cache || !Array.isArray(cache.records) || cache.records.length === 0) return ''

  const ageHours = cache.updatedAt ? (now - cache.updatedAt) / HOUR : Infinity
  if (ageHours > staleHours) return ''

  const rows = queryDeadlines(cache.records, { now, windowDays: leadDays, limit: maxItems })
  if (rows.length === 0) return ''
  const lines = [
    '## 会议截稿（dsh-ccf）',
    `数据同步于 ${formatInZone(cache.updatedAt, timeZone)}，未来 ${leadDays} 天内有 ${rows.length} 个：`,
  ]
  for (const record of rows) {
    lines.push(`- ${formatRow(record, { now, timeZone })}`)
  }
  lines.push('需要更远的窗口或按等级/方向筛选时，调用 `ccf_deadlines`（days/rank/area/search）。**日期以工具返回为准，不要凭记忆补。**')
  return lines.join('\n')
}
