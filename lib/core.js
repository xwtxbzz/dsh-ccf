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
  maxPromptItems: 3,
  // 这个天数内有截稿才逐条列；没有就只写一行摘要（每轮注入，越短越好）
  promptSoonDays: 7,
  prompt: true,
  ranks: null,
  areas: null,
  timezone: 'Asia/Shanghai',
  timeoutMs: 20000,
  dataDir: null,
  sources: null,
  staleHours: 168,
  // 模型挖掘（懒更新）相关
  refreshDays: 30,
  maxVenuesPerRun: 6,
  autoUpdate: true,
  autoUpdateDays: 7,
  catalogPath: null,
  mining: true,
})

/** 默认数据源：先用 CCFDDL 官方接口（一次请求拿到全量会议目录），再用 paper-deadlines 兜底。 */
/**
 * 两个来源的截稿差了"一天以上"才算真冲突：±1 天基本是 AoE 与本地日历的边界差，
 * 每张卡片都亮红点会把面板吵成噪音；这种仍然留在详情里的「来源冲突」行。
 *
 * 放在 core 里是因为命令行、工具、面板三处都要用同一个判据（36 小时）。
 */
export function isBigConflict(row) {
  return Array.isArray(row?.alternatives) &&
    row.alternatives.some((item) => Number.isFinite(item?.deadline) && Number.isFinite(row.deadline) && Math.abs(item.deadline - row.deadline) > 36 * 3600 * 1000)
}

export const DEFAULT_SOURCES = Object.freeze([
  {
    id: 'ccfddl-api',
    type: 'ccfddl-api',
    url: 'https://ccfddl.com/conference/allconf.json',
  },
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
  OS: '计算机体系结构/并行与分布计算/存储系统',
  // CCFDDL 的 `SC` 是 Security & Cryptography（S&P / CCS / USENIX Security 都是它），
  // 不是"高性能计算"——写错会让安全方向的会在面板上显示成超算。
  SC: '网络与信息安全',
  SEC: '网络与信息安全',
  SE: '软件工程/系统软件/程序设计语言',
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
 * 上游时区写法的别名（ccfddl 用 `UTC-12`/`UTC+8`/`PT`/`AoE` 这类写法）。
 * 只映射到 IANA 或偏移量，不做任何"猜测某地时间"的事。
 */
const ZONE_ALIASES = Object.freeze({
  aoe: 'AoE',
  anywhereonearth: 'AoE',
  pt: 'America/Los_Angeles',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  et: 'America/New_York',
  est: 'America/New_York',
  edt: 'America/New_York',
  ct: 'America/Chicago',
  mt: 'America/Denver',
  cet: 'Europe/Berlin',
  cest: 'Europe/Berlin',
  bst: 'Europe/London',
  jst: 'Asia/Tokyo',
  kst: 'Asia/Seoul',
  cst: 'Asia/Shanghai',
  ist: 'Asia/Kolkata',
  sgt: 'Asia/Singapore',
})

const UTC_OFFSET_SPEC = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/i

/**
 * 把上游的时区写法规整成 `tzOffsetMinutes` 能吃的东西：
 * `AoE` / `UTC+8` / `UTC-12` 一律保留成偏移写法，`PT` 这类别名换成 IANA，其余原样返回。
 * @param {unknown} spec
 * @returns {string}
 */
/**
 * 这台机器自己的时区。插件默认按它显示时间：换一台电脑（人在国外）就不该默认北京时间，
 * 否则面板写着 Asia/Shanghai，读者还得自己换算。
 */
export function systemTimeZone(fallback = 'Asia/Shanghai') {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone.trim() ? zone : fallback
  } catch {
    return fallback
  }
}

export function resolveTimeZone(spec) {
  const text = String(spec ?? '').trim()
  if (!text) return 'AoE'
  if (/^(aoe|anywhere on earth)$/i.test(text)) return 'AoE'
  const offset = text.match(UTC_OFFSET_SPEC)
  if (offset) {
    const [, sign, hours, minutes] = offset
    return `UTC${sign}${String(Number(hours)).padStart(2, '0')}:${minutes ?? '00'}`
  }
  const alias = ZONE_ALIASES[text.toLowerCase()]
  return alias ?? text
}

/**
 * 把各种时间戳写法收敛成毫秒数（或 null）。
 *
 * 缓存里的 `updatedAt` 正常是毫秒数，但手改过的缓存、早期版本写的缓存、或别的工具生成的文件里
 * 可能是 ISO 字符串；直接喂给 `formatInZone` 会静默显示空字符串，于是出现"数据时间 （前）"这种句子。
 */
export function toInstant(value) {
  if (value instanceof Date) {
    const at = value.getTime()
    return Number.isFinite(at) ? at : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    const at = Date.parse(text)
    return Number.isFinite(at) ? at : null
  }
  return null
}

/**
 * 带时间的、对固定偏移（`UTC-12:00`）也安全的格式化：Intl 不接受后者，
 * 所以固定偏移走"平移 + UTC getter"，IANA 时区仍交给 Intl。
 */
export function formatInZoneSafe(instant, timeZone = 'Asia/Shanghai') {
  const at = toInstant(instant)
  if (at === null) return ''
  const zone = typeof timeZone === 'string' ? timeZone.trim() : ''
  // `AoE` 与 `UTC±H[:MM]` 都不是 Intl 认识的时区名（Intl 会抛 RangeError: Invalid time zone specified），
  // 一律走"平移 + UTC getter"。早期版本只判了 `UTC±`，于是任何 `timezone: "AoE"` 的记录都会把
  // 整次 ccf_venue 调用炸掉——上游绝大多数记录正是 AoE。
  const fixed = !zone || zone.toLowerCase() === 'aoe' || /^(?:UTC|GMT)[+-]/.test(zone)
  if (!fixed) return formatInZone(at, zone)
  const offset = tzOffsetMinutes(zone || 'Asia/Shanghai', at)
  const shifted = new Date(at + offset * 60 * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
}

/**
 * 按某个时区把绝对时刻写成 `YYYY-MM-DD`（用于"往届截稿"这类只需要日期的场景）。
 * 固定偏移（`UTC-12:00`）与 `AoE` 不能直接喂 Intl，所以统一走偏移换算。
 */
export function formatDateInZone(at, timeZone = 'AoE') {
  if (!Number.isFinite(at)) return ''
  const offset = tzOffsetMinutes(timeZone, at)
  const shifted = new Date(at + offset * 60 * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** 一条记录的往届截稿（新的在前，最多 max 条），例如 `['2026: 2025-11-13']`。 */
export function historyFromEditions(editions, picked, { max = 3 } = {}) {
  if (!Array.isArray(editions)) return []
  const base = Number.isFinite(picked?.slot?.deadline) ? picked.slot.deadline : null
  const rows = editions
    .filter(
      (edition) =>
        edition !== picked &&
        Number.isFinite(edition.slot?.deadline) &&
        (base === null || edition.slot.deadline < base),
    )
    .sort((left, right) => right.slot.deadline - left.slot.deadline)
    .slice(0, max)
    .map((edition) => {
      const day = formatDateInZone(edition.slot.deadline, edition.zone)
      return edition.year ? `${edition.year}: ${day}` : day
    })
  return rows
}

export function tzOffsetMinutes(timeZone, at) {
  // AoE 与 UTC±H 都不是 IANA 名，先按字符串判；大小写都算（上游子类里出现过小写）。
  const name = String(timeZone ?? '').trim()
  if (/^aoe$/i.test(name)) return -12 * 60
  if (name === 'UTC' || name === 'Etc/UTC') return 0
  const fixed = name.match(UTC_OFFSET_SPEC)
  if (fixed) {
    const sign = fixed[1] === '-' ? -1 : 1
    const hours = Number(fixed[2])
    const minutes = Number(fixed[3] ?? '0')
    return sign * (hours * 60 + minutes)
  }
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
  const parts = formatter.formatToParts(new Date(at))
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
  return (asUtc - at) / MINUTE
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
  let at = guess - tzOffsetMinutes(timeZone, guess) * MINUTE
  at = guess - tzOffsetMinutes(timeZone, at) * MINUTE
  return at
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
  const at = toInstant(instant)
  if (at === null) return ''
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return formatter.format(new Date(at)).replace(/\//g, '-')
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
 * 「按会议系列记住采信来源」用的键：去年份、去括号、去厂商前缀后的简称。
 *
 * `CVPR 2027`、`IEEE/CVF CVPR`、`cvpr` 都落到同一个 `cvpr`，这样去年点过一次的选择
 * 明年还会生效，不用每年重新点。
 */
export function venueKey(text) {
  const prefix = /^(?:acm|ieee|usenix|sig|the|cvf)(?:[\s/]+|$)/i
  let value = venueOf(text)
  // 「IEEE/CVF CVPR」这种一串厂商前缀要去干净，否则同一个会落到两个键上。
  for (let i = 0; i < 4 && prefix.test(value); i += 1) value = value.replace(prefix, '')
  return value.toLowerCase()
}

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
    // 上游只有一部分记录带 rebuttal；没有就是 null，展示层如实说"未提供"。
    rebuttal: parseInstant(raw.rebuttal ?? raw.rebuttalStart, 'AoE'),
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
 * 归一化 CCFDDL 官方接口（`https://ccfddl.com/conference/allconf.json`）的会议目录。
 *
 * 结构：`{ conferences: [{ title, description, sub, rank:{ccf,core,thcpl}, dblp,
 *          confs:[{ year, id, link, timeline:[{abstract_deadline, deadline,
 *          rebuttal_deadline, decision_deadline}], timezone, date, place }] }] }`
 *
 * 每个会议保留一届：优先"最近一个还没过截稿的年份"，没有则保留最新一届；
 * 同一届有多轮（timeline 多个节点）时取离现在最近的那个截稿点。
 *
 * @param {any} doc
 * @param {string} [source]
 * @param {{now?:number, keepFromYear?:number}} [options]
 */
export function normalizeCcfddlApi(doc, source = 'ccfddl-api', options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const list = Array.isArray(doc)
    ? doc
    : Array.isArray(doc?.conferences)
      ? doc.conferences
      : Array.isArray(doc?.data)
        ? doc.data
        : []
  const currentYear = new Date(now).getUTCFullYear()
  const keepFromYear = Number.isFinite(options.keepFromYear) ? options.keepFromYear : currentYear - 1
  const records = []

  for (const item of list) {
    const title = String(item?.title ?? item?.name ?? '').trim()
    if (!title) continue
    const rankBag = item.rank && typeof item.rank === 'object' ? item.rank : null
    const rank = rankBag?.ccf
      ? (String(rankBag.ccf).toUpperCase() === 'N' ? 'Non-CCF' : `CCF-${String(rankBag.ccf).toUpperCase()}`)
      : typeof item.rank === 'string'
        ? item.rank
        : ''
    const area = item.sub ? CCFDDL_SUB_LABELS[String(item.sub).toUpperCase()] ?? String(item.sub) : ''
    const confs = Array.isArray(item.confs) ? item.confs : []
    const editions = []
    for (const conf of confs) {
      if (!conf || typeof conf !== 'object') continue
      const year = Number.isFinite(conf.year) ? Number(conf.year) : yearOf(conf.id)
      if (Number.isFinite(year) && year < keepFromYear) continue
      const zone = resolveTimeZone(conf.timezone)
      const timeline = Array.isArray(conf.timeline) ? conf.timeline : Array.isArray(conf.deadlines) ? conf.deadlines : []
      const slots = []
      for (const slot of timeline) {
        if (!slot || typeof slot !== 'object') continue
        const deadline = parseInstant(slot.deadline ?? slot.paper_deadline, zone)
        const abstractDeadline = parseInstant(slot.abstract_deadline, zone)
        if (!Number.isFinite(deadline) && !Number.isFinite(abstractDeadline)) continue
        slots.push({
          deadline,
          abstractDeadline,
          notification: parseInstant(slot.decision_deadline ?? slot.notification, zone),
          rebuttal: parseInstant(slot.rebuttal_deadline ?? slot.rebuttal, zone),
        })
      }
      if (slots.length === 0) continue
      // 多轮投稿：取还没过的最早一轮；都过了就取最后一轮
      const upcoming = slots
        .filter((slot) => Number.isFinite(slot.deadline) && slot.deadline >= now)
        .sort((left, right) => left.deadline - right.deadline)
      const chosen = upcoming[0]
        ?? [...slots].sort((left, right) => (right.deadline ?? 0) - (left.deadline ?? 0))[0]
      editions.push({
        year,
        zone,
        link: conf.link ? String(conf.link) : '',
        confDate: conf.date ? String(conf.date) : '',
        place: conf.place ? String(conf.place) : '',
        slot: chosen,
      })
    }
    if (editions.length === 0) continue
    const withUpcoming = editions.filter((edition) => Number.isFinite(edition.slot.deadline) && edition.slot.deadline >= now)
    const picked = (withUpcoming.length > 0
      ? withUpcoming.sort((left, right) => (left.year ?? 0) - (right.year ?? 0))[0]
      : editions.sort((left, right) => (right.year ?? 0) - (left.year ?? 0))[0])
    const { slot } = picked
    // 往届截稿：同一系列其它届的时间点（新的在前，最多 3 条），给面板"这个会往年什么时候截"用。
    const history = historyFromEditions(editions, picked)
    records.push({
      key: `${title.toLowerCase()}|${picked.year ?? ''}`,
      venue: title,
      year: Number.isFinite(picked.year) ? picked.year : null,
      name: Number.isFinite(picked.year) ? `${title} ${picked.year}` : title,
      fullName: item.description ? String(item.description) : '',
      rank,
      area,
      core: rankBag?.core ? String(rankBag.core) : '',
      abstractDeadline: slot.abstractDeadline ?? null,
      deadline: slot.deadline ?? null,
      notification: slot.notification ?? null,
      rebuttal: slot.rebuttal ?? null,
      confDate: picked.confDate,
      place: picked.place,
      link: picked.link,
      submitLink: '',
      aliases: [],
      acceptRate: '',
      h5: null,
      history,
      verified: false,
      timezone: picked.zone,
      source,
    })
  }
  return records
}

/**
 * 把多源记录合并去重：同 venue+year 时，先出现的源优先，缺的字段用后面的补。
 *
 * 两个源都给了截稿时间却不一样时，**不能默默丢掉后者**：会在 `alternatives` 里留痕
 * （`{source, deadline, notification}`），面板据此显示"来源不一致，另一来源给的是 X"。
 * @param {Array<any>} records
 */
/**
 * 合并两份记录：以 next 为准（这一轮刚挖到/刚同步到的值），但把 latest 里 next 没有的会补回来。
 *
 * 场景：一个窗口在补数据（几十秒），另一个窗口刚跑完 /ccf sync 拿到新会；补数据最后写缓存时
 * 用的是它开始时那份快照，直接覆盖就把新会丢了。
 */
export function mergeKeepingNewlyAdded(next, latest) {
  const list = Array.isArray(next) ? next : []
  const other = Array.isArray(latest) ? latest : []
  const known = new Set(list.map((record) => record?.key).filter(Boolean))
  const extra = other.filter((record) => record?.key && !known.has(record.key))
  return extra.length === 0 ? list : [...list, ...extra]
}

export function dedupeRecords(records) {
  const byKey = new Map()
  const sameMoment = (left, right) => (left ?? null) === (right ?? null)
  for (const record of records) {
    if (!record) continue
    const key = record.key || `${record.venue}|${record.year ?? ''}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, { ...record })
      continue
    }
    // 先记冲突：同一个会，另一条来源给出的截止时间与已采用的不同。
    const differs = !sameMoment(existing.deadline, record.deadline) || !sameMoment(existing.notification, record.notification)
    if (differs && Number.isFinite(record.deadline || record.notification)) {
      const list = Array.isArray(existing.alternatives) ? existing.alternatives : []
      if (!list.some((item) => item.source === record.source && item.deadline === record.deadline && item.notification === record.notification)) {
        list.push({ source: record.source, deadline: record.deadline ?? null, notification: record.notification ?? null })
        existing.alternatives = list
      }
    }
    for (const [field, value] of Object.entries(record)) {
      if (field === 'alternatives') continue
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

/**
 * 用户「采信另一来源」之后，让展示跟着他选的那个源走。
 *
 * 只改派生出来的视图，**不改缓存里的主记录**：下轮挖掘与同步仍然按原来的主来源合并，
 * 否则一次点击就把两路数据的优先级永久改了，以后说不清哪条是"数据源说的"。
 *
 * `venuePrefs` 是「按会议系列记住的选择」（key 形如 `cvpr`）：同一个会每年都会冲突一次，
 * 记在系列上就不用每年点。记录自己身上的 `preferredSource` 优先于系列记忆。
 *
 * @param {any} record
 * @param {Record<string, string>} [venuePrefs]
 * @returns {any} 交换过 deadline/notification/source 的记录（无偏好时原样返回）
 */
export function applyPreferred(record, venuePrefs = null) {
  if (!record || typeof record !== 'object') return record
  const alternatives = Array.isArray(record.alternatives) ? record.alternatives : []
  if (alternatives.length === 0) return record

  const own = typeof record.preferredSource === 'string' ? record.preferredSource : ''
  const inherited = !own && venuePrefs && typeof venuePrefs === 'object'
    ? venuePrefs[venueKey(record.venue ?? record.name ?? '')] ?? ''
    : ''
  const preferred = own || inherited
  if (!preferred) return record

  const picked = alternatives.find((item) => item && item.source === preferred)
  if (!picked) return record

  const previous = {
    source: record.source ?? '',
    deadline: Number.isFinite(record.deadline) ? record.deadline : null,
    notification: Number.isFinite(record.notification) ? record.notification : null,
  }
  const others = alternatives.filter((item) => item !== picked)
  return {
    ...record,
    deadline: Number.isFinite(picked.deadline) ? picked.deadline : null,
    notification: Number.isFinite(picked.notification) ? picked.notification : null,
    source: picked.source ?? record.source ?? '',
    preferred: true,
    preferredSource: preferred,
    preferredInherited: !own,
    alternatives: [previous, ...others],
  }
}

/** 批量版本，见 {@link applyPreferred}。 */
export function applyPreferredAll(records, venuePrefs = null) {
  return Array.isArray(records) ? records.map((record) => applyPreferred(record, venuePrefs)) : []
}

/** 一条记录"信息有多全"：同一年有两个名字时，留信息多的那条。 */
function completeness(record) {
  let score = 0
  for (const field of ['deadline', 'abstractDeadline', 'notification', 'rebuttal']) {
    if (Number.isFinite(record?.[field])) score += 1
  }
  if (record?.link) score += 1
  if (record?.place) score += 1
  if (record?.fullName) score += 1
  if (typeof record?.preferredSource === 'string' && record.preferredSource) score += 1
  return score
}

/**
 * 同一个会、同一年、两个名字（实测 `S&P 2027` 与 `IEEE S&P 2027`）只算一条。
 *
 * CCFDDL 里两个系列名各有一条记录、截稿还是同一天，不合并的话清单里会重复出现同一个会：
 * 用户要投的会看起来"有两个截稿"，`/ccf list 30` 的数字也会虚高。
 * 合并规则：按信息完整度留一条（截稿/摘要/通知/地点/链接/采信来源越多越优先）。
 */
export function dedupeVenueYear(records) {
  const list = Array.isArray(records) ? records : []
  const kept = new Map()
  const order = []
  for (const record of list) {
    const key = `${venueKey(record?.venue ?? record?.name ?? '')}|${record?.year ?? ''}`
    const current = kept.get(key)
    if (!current) {
      kept.set(key, record)
      order.push(record)
      continue
    }
    if (completeness(record) > completeness(current)) {
      const at = order.indexOf(current)
      if (at >= 0) order[at] = record
      kept.set(key, record)
    }
  }
  return order
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
  return queryDeadlinesWithMeta(records, options).rows
}

/**
 * 同 {@link queryDeadlines}，但把"匹配到多少"也带回来。
 *
 * 面板/命令的回答一律说"未来 N 天内 X 个截稿"，如果 X 是 limit 截断后的条数，
 * 用户（和模型）会以为一共就这么多 —— 曾出现"365 天内只有 8 个"这种假象，
 * 实际是 8 是 limit。截断必须自己说出来。
 *
 * @returns {{rows: Array<any>, matched: number, limit: number, hidden: number}}
 */
export function queryDeadlinesWithMeta(records, options = {}) {
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
  const matched = rows.length
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : matched
  const visible = rows.slice(0, limit)
  return { rows: visible, matched, limit, hidden: Math.max(0, matched - visible.length) }
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
  if (record.satellite === true) parts.push('卫星会')
  // 两个源给的日期差了一天以上：这个日期不是唯一说法，别让读的人当成定论
  if (record.conflict === true) parts.push('来源冲突')
  // 用户已经裁决过这条冲突：清单上要能看出"这条不用再决定了"，否则每次扫一眼都是同一批
  if (typeof record.preferredSource === 'string' && record.preferredSource) parts.push(`按 ${record.preferredSource} 显示`)
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
      '如果这类会本来就少，可能是它不在 CCF 名单里：用 `/ccf list --pending --search <关键词>` 看名单里有没有还没数据的会，或用 `ccf_venue` 直接查一个会的名字。',
    ].join('\n')
  }
  const matched = Number.isFinite(options.matched) ? Number(options.matched) : rows.length
  const hidden = Math.max(0, matched - rows.length)
  const heading = hidden > 0
    ? `未来 ${windowDays} 天内共 ${matched} 个截稿，这里按最近排序列出前 ${rows.length} 个（用 limit 调大，或用 --rank / --area / 更短天数缩小范围）`
    : `未来 ${windowDays} 天内 ${rows.length} 个截稿`
  const lines = [
    options.title ?? `${heading}（时间按 ${timeZone} 显示，现在 ${formatInZone(now, timeZone)}）`,
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
/**
 * 官方口径：ccfddl 的截稿是按 AoE / UTC 标注的，而面板默认按本地时区显示。
 * 用户对照官网时看到的经常是 AoE 的日期，所以这里补一段"官方时区下是几号几点"。
 */
export function officialZoneText(record, now = Date.now()) {
  const zone = typeof record?.timezone === 'string' ? record.timezone.trim() : ''
  if (!zone) return null
  const deadlines = [record.deadline, record.abstractDeadline].filter((value) => Number.isFinite(value))
  if (deadlines.length === 0) return null
  const parts = []
  if (Number.isFinite(record.deadline)) parts.push(`截稿 ${formatInZoneSafe(record.deadline, zone)}`)
  if (Number.isFinite(record.abstractDeadline)) parts.push(`摘要 ${formatInZoneSafe(record.abstractDeadline, zone)}`)
  return `${zone}：${parts.join(' · ')}`
}

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
    const label = `${record.year ?? '—'}:`
    const pieces = []
    const zone = officialZoneText(record, now)
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
    if (zone) pieces.push(`官方口径 ${zone}`)
    lines.push(`  - ${label} ${pieces.join(' · ')}`.replace(/:\s+$/, ':'))
  }
  // 旧缓存里的记录没有 history 字段（0.9.0 才有），这里不能假定它一定存在。
  const history = Array.isArray(head.history) ? head.history : []
  if (history.length > 0) lines.push(`往届截稿：${history.join(' / ')}`)
  if (head.acceptRate) lines.push(`录用率：${head.acceptRate}${head.h5 ? ` · h5 ${head.h5}` : ''}`)
  if (head.link) lines.push(`主页：${head.link}`)
  // 模型挖到的记录：把"它读的是哪几页"写出来，用户才能核对（不然只能凭信）
  const minedFrom = Array.isArray(head.minedFrom) ? head.minedFrom.filter(Boolean) : []
  if (head.source === 'model' && minedFrom.length > 0) {
    lines.push(`挖自：${minedFrom.slice(0, 2).join(' ；')}`)
  }
  if (head.submitLink) lines.push(`投稿：${head.submitLink}`)
  // 两个来源说法不一致时如实列出，别让用户以为只有一种答案。
  // 按行（年份）分别列：往年那个会没冲突，不等于今年也没冲突。
  for (const record of rows) {
    const alternatives = Array.isArray(record.alternatives) ? record.alternatives : []
    if (alternatives.length === 0) continue
    const said = alternatives
      .slice(0, 3)
      .map((item) => {
        const when = Number.isFinite(item.deadline) ? formatInZone(item.deadline, timeZone) : '截稿未知'
        return `${item.source || '另一来源'} ${when}`
      })
      .join('；')
    const which = rows.length > 1 && record.year ? `（${record.year}）` : ''
    lines.push(`来源不一致${which}：${said}（上面显示的是首选来源）`)
  }
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

  const soonDays = Number.isFinite(options.promptSoonDays) ? options.promptSoonDays : DEFAULTS.promptSoonDays
  const query = queryDeadlinesWithMeta(cache.records, { now, windowDays: leadDays, limit: maxItems })
  const rows = query.rows
  if (rows.length === 0) return ''
  // 近期没有截稿时只留一行：让模型知道"有这件事、有多少"，但不占三段列表的位置。
  const soon = rows.filter((row) => Number.isFinite(row.deadline) && row.deadline - now <= soonDays * DAY)
  if (soon.length === 0) {
    const first = rows[0]
    const when = Number.isFinite(first.deadline) ? formatInZone(first.deadline, timeZone) : '时间未知'
    const firstFlagged = isBigConflict(first)
    // 只写"最近这个会"时，别的会也在打架就提个数，别让模型以为只有这一条有问题。
    const otherConflicts = queryDeadlinesWithMeta(cache.records, { now, windowDays: leadDays, limit: null })
      .rows.filter((record) => isBigConflict(record) && record?.key !== first?.key).length
    const flag = firstFlagged
      ? '（来源冲突：两个源给的截稿差一天以上，转述时别当定论）'
      : otherConflicts > 0
        ? `（另有 ${otherConflicts} 个会的两个来源说法不一致）`
        : ''
    return [
      '## 会议截稿（dsh-ccf）',
      `未来 ${leadDays} 天内共 ${query.matched} 个截稿，${soonDays} 天内没有要交的；最近：${first.name || first.venue || '—'}${first.rank ? `（${first.rank}）` : ''} ${when}（${countdownText(first.deadline - now)}后）${flag}。查全部用 \`ccf_deadlines\`。`,
    ].join('\n')
  }
  // 只列前 N 条时，别把 N 说成总数：模型会把这句话当真话转述给用户
  const total = query.matched
  const head = total > rows.length
    ? `数据同步于 ${formatInZone(cache.updatedAt, timeZone)}，未来 ${leadDays} 天内共 ${total} 个截稿，这里按最近排序列出前 ${rows.length} 个：`
    : `数据同步于 ${formatInZone(cache.updatedAt, timeZone)}，未来 ${leadDays} 天内有 ${total} 个：`
  const lines = [
    '## 会议截稿（dsh-ccf）',
    head,
  ]
  // 冲突要在**整个窗口**里数：`rows` 只截了前 N 条，拿它计数会说出
  // 「标了「来源冲突」的 1 个会」这种绝对数字，而窗口里可能有二十几个。
  const conflictedAll = queryDeadlinesWithMeta(cache.records, { now, windowDays: leadDays, limit: null })
    .rows.filter((record) => isBigConflict(record))
  const conflictKeys = new Set(conflictedAll.map((record) => record?.key).filter(Boolean))
  let shownConflicted = 0
  for (const record of rows) {
    // 注入给模型的那几行同样是"清单"：日期有两个说法时不标出来，
    // 模型会把它当成定论转述（这正是 0.54.0 在命令行侧修过的同一个问题）。
    // 按 key 认（query 出来的行可能是拷贝，用对象身份比会漏标）。
    const flagged = conflictKeys.size > 0 ? conflictKeys.has(record?.key) : isBigConflict(record)
    if (flagged) shownConflicted += 1
    lines.push(`- ${formatRow(flagged ? { ...record, conflict: true } : record, { now, timeZone })}`)
  }
  if (conflictedAll.length > 0) {
    const scope = total > rows.length ? `（这里列出的 ${rows.length} 个里有 ${shownConflicted} 个）` : ''
    lines.push(`窗口内有 ${conflictedAll.length} 个会标了「来源冲突」${scope}：两个来源给的截稿差了一天以上，日期不是唯一说法，转述时要说清，别当成定论。`)
  }
  lines.push('需要更远的窗口或按等级/方向筛选时，调用 `ccf_deadlines`（days/rank/area/search）。**日期以工具返回为准，不要凭记忆补。**')
  return lines.join('\n')
}
