/**
 * dsh-ccf · CCF 官方名单
 *
 * 名单来自 CCF 官网（https://www.ccf.org.cn/Academic_Evaluation/By_category/），
 * 抓取后作为插件自带的 `data/ccf-catalog.json` 一起发布 —— 插件运行时**不联网**也能
 * 知道"CCF 一共有哪些会议、各是什么等级、属于哪个方向"。
 *
 * 这份名单只回答"有哪些会"，不回答"什么时候截稿"：截稿时间要么由模型从会议主页
 * 挖出来，要么回退到 ccfddl 的数据。两者都不会写进这个文件。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 名单文件的 schema 版本。 */
export const CATALOG_SCHEMA = 'dsh-ccf/catalog/v1'

/** 插件自带的名单路径（相对本文件）。 */
export const BUNDLED_CATALOG = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'ccf-catalog.json')

/**
 * 读名单文件，并把"没找到""读坏了"分开报出来。
 *
 * 名单是插件的地基：没有它，面板只能列 CCFDDL 收过的会、"待补"也数不出来。文件可能被删、
 * 被半截写入、被换成别的 JSON —— 这些情况原来一律返回 null，用户只看到"名单 0 个"。
 */
export function inspectCatalog(file) {
  const path = resolve(String(file || BUNDLED_CATALOG))
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', catalog: null, path, error: '' }
    return { state: 'unreadable', catalog: null, path, error: '读不出来：' + (error?.message ?? error) }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { state: 'corrupt', catalog: null, path, error: 'JSON 解析失败：' + (error?.message ?? error) }
  }
  if (!parsed || !Array.isArray(parsed.areas)) {
    return { state: 'corrupt', catalog: null, path, error: '结构不对：缺少 areas 数组' }
  }
  return { state: 'ok', catalog: parsed, path, error: '' }
}

/**
 * 读名单文件；读不到或结构不对返回 null（要区分原因用 `inspectCatalog`）。
 * @param {string} [file]
 */
export function loadCatalog(file = BUNDLED_CATALOG) {
  return inspectCatalog(file).catalog
}

/**
 * 把名单摊平成会议列表。
 * @param {any} catalog
 * @returns {Array<{abbr: string, fullName: string, rank: string, area: string, dblp: string}>}
 */
export function catalogConferences(catalog) {
  if (!catalog || !Array.isArray(catalog.areas)) return []
  const out = []
  for (const area of catalog.areas) {
    const areaName = String(area?.area ?? '')
    const byRank = area?.conferences ?? {}
    for (const rank of ['A', 'B', 'C']) {
      const list = Array.isArray(byRank[rank]) ? byRank[rank] : []
      for (const item of list) {
        const abbr = String(item?.abbr ?? '').trim()
        if (!abbr) continue
        out.push({
          abbr,
          fullName: String(item?.fullName ?? '').trim(),
          rank: `CCF-${rank}`,
          area: areaName,
          dblp: String(item?.dblp ?? '').trim(),
        })
      }
    }
  }
  return out
}

/** 名单统计，给 `/ccf status` 与面板用。 */
export function catalogSummary(catalog) {
  const conferences = catalogConferences(catalog)
  const byRank = { 'CCF-A': 0, 'CCF-B': 0, 'CCF-C': 0 }
  for (const item of conferences) if (item.rank in byRank) byRank[item.rank] += 1
  return {
    ok: Boolean(catalog),
    schema: catalog?.schema ?? null,
    sourceUrl: catalog?.sourceUrl ?? '',
    publisher: catalog?.publisher ?? '',
    fetchedAt: catalog?.fetchedAt ?? null,
    areas: Array.isArray(catalog?.areas) ? catalog.areas.length : 0,
    areaNames: Array.isArray(catalog?.areas)
      ? catalog.areas.map((area) => String(area?.area ?? '').trim()).filter(Boolean)
      : [],
    conferences: conferences.length,
    byRank,
  }
}

/** 名字归一化：去掉 "(CCF-A)"、年份、多余空格，转小写，用于宽松匹配。 */
export function normalizeVenue(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b(proceedings|conference|symposium|workshop|the)\b/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fa5+]+/g, ' ')
    .trim()
}

/**
 * 在名单里找会议：简称精确优先，其次全称包含，最后简称包含。
 * @param {any} catalog
 * @param {string} query
 */
export function findInCatalog(catalog, query) {
  const list = catalogConferences(catalog)
  const q = String(query ?? '').trim()
  if (!q) return []
  const upper = q.toUpperCase()
  const exact = list.filter((item) => item.abbr.toUpperCase() === upper)
  if (exact.length > 0) return exact
  const norm = normalizeVenue(q)
  if (!norm) return []
  const byFull = list.filter((item) => normalizeVenue(item.fullName).includes(norm))
  if (byFull.length > 0) return byFull
  return list.filter((item) => normalizeVenue(item.abbr).includes(norm) || norm.includes(normalizeVenue(item.abbr)))
}

/**
 * 按简称建索引（大写），并给每条记录补上"名单里有没有这个会"。
 * @param {any} catalog
 */
export function catalogIndex(catalog) {
  const index = new Map()
  for (const item of catalogConferences(catalog)) {
    const key = item.abbr.toUpperCase()
    if (!index.has(key)) index.set(key, item)
  }
  return index
}

// ---------------------------------------------------------------- 匹配与覆盖度

const VENDOR_WORDS = new Set(['acm', 'ieee', 'usenix', 'sig', 'the', 'cvf'])

/** 去掉 ACM/IEEE/USENIX 这类厂商前缀，剩下的才是会本身的简称。 */
function coreName(text) {
  const tokens = String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  while (tokens.length > 1 && VENDOR_WORDS.has(tokens[0])) tokens.shift()
  return tokens.join('')
}

/** 回退数据的惯例名 → CCF 名单里的官方简称。 */
export const VENUE_ALIASES = {
  kdd: 'sigkdd',
  // 不要加 'security' → 'sec'：USENIX Security 自己就是名单里的一个会，
  // 而 SEC 是 IFIP 的信息安全会，两者被这条别名搅在一起过（见评审 33/34 节）。
  siggraphasia: 'siggraph',
  acmccs: 'ccs',
  ubicomp: 'ubicompimwut',
}

/** 官方名单里同一个会的"主要会 + 卫星活动"后缀：`CVPR Workshops` 仍算 CVPR。 */
export const SATELLITE_SUFFIXES = ['workshops', 'workshop', 'asia', 'europe']

/**
 * 一条记录和名单里的一个会是不是同一个会。
 *
 * 名单用官方简称（`SIGKDD`、`S&P`、`SEC`），回退数据用惯例名（`KDD`、`IEEE S&P`、
 * `USENIX Security`）。先去掉厂商前缀，再按「完全相同 → 别名 → 卫星活动后缀」
 * 三级判定。**不做双向包含**：否则 `SPAA` 会被当成 `S&P`、`HOT CHIPS` 当成 `CHI`。
 *
 * 面板计数、`/ccf list` 的覆盖度行、提示词里的"还差多少"全都用这一个函数，
 * 否则同一个问题会出现两个数字。
 */
export function matchVenue(recordVenue, conference) {
  const left = coreName(recordVenue)
  const right = coreName(conference?.abbr)
  if (!left || !right) return false
  if (left === right) return true
  const alias = VENUE_ALIASES[left]
  if (alias && alias === right) return true
  const aliasBack = VENUE_ALIASES[right]
  if (aliasBack && aliasBack === left) return true
  for (const suffix of SATELLITE_SUFFIXES) {
    if (left.startsWith(right) && left.slice(right.length) === suffix) return true
    if (right.startsWith(left) && right.slice(left.length) === suffix) return true
  }
  return false
}

/**
 * 名单覆盖度：362 个会里，多少个已经有**未来**截稿、多少个只有往届、多少个一条记录都没有。
 *
 * 这是"还差多少"的唯一口径：面板标题栏、`/ccf status`、系统提示里的数据状态都用它，
 * 不再各自数自己的。
 *
 * @param {Array<any>} records 缓存记录
 * @param {any} catalog 名单
 * @param {{now?: number, conferences?: Array<any>}} [options] `conferences` 可直接给摊平后的名单
 */
/**
 * 名单里有些简称对应**两个不同的会**（实测：`FSE` 既是软工 CCF-A 的 ACM FSE，
 * 也是安全 CCF-B 的 Fast Software Encryption）。一条记录只能算给其中一个会，
 * 否则一份数据会把两个会同时"喂饱"，覆盖度与「待补」都跟着失真。
 *
 * 判断依据是记录的 `fullName`：与名单全称越像越可能是它自己。
 *
 * @param {any} row 数据记录（带 venue / fullName）
 * @param {Array<any>} candidates 简称匹配上的名单条目（>=2）
 */
/**
 * 记录全称和名单全称的相似度：完全相同 100、互相包含 50、否则按有区分度的词每个 10 分。
 * 0 分意味着"除了简称，一个字都对不上"——这种记录值得提示核对（可能是不同的会）。
 */
export function fullNameScore(row, conference) {
  const rowName = String(row?.fullName ?? '').trim().toLowerCase()
  const confName = String(conference?.fullName ?? '').trim().toLowerCase()
  if (!rowName || !confName) return null
  if (confName === rowName) return 100
  if (confName.includes(rowName) || rowName.includes(confName)) return 50
  const rowTokens = wordsOf(rowName)
  const confTokens = new Set(wordsOf(confName))
  let score = 0
  for (const token of rowTokens) if (confTokens.has(token)) score += 10
  return score
}

export function pickByFullName(row, candidates) {
  const rowName = String(row?.fullName ?? '').trim().toLowerCase()
  if (!rowName) return candidates[0]
  let best = null
  let bestScore = 0
  for (const conference of candidates) {
    const score = fullNameScore(row, conference) ?? 0
    if (score > bestScore) {
      best = conference
      bestScore = score
    }
  }
  // 多个候选、全称一个字都对不上：宁可算"名单外"，也不要把一个会的数据塞给另一个会
  return best
}

/** 只留下有区分度的英文词（去掉 on/of/conference/symposium 这类每个会名里都有的）。 */
const GENERIC_WORDS = new Set([
  'on', 'of', 'the', 'for', 'and', 'in', 'at', 'to', 'with',
  'international', 'conference', 'conferences', 'symposium', 'symposia', 'workshop', 'workshops',
  'annual', 'proceedings', 'meeting', 'joint', 'ieee', 'acm', 'usenix', 'sig',
])

function wordsOf(text) {
  return String(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !GENERIC_WORDS.has(word))
}

/**
 * 卫星会 / Workshop：名字里带 workshop/tutorial/doctoral 的，或是 "XX Asia"/"XX Europe" 这种分会场。
 * 它们不是名单里的那个主会：拿主会的截稿去代表它是错的，而让用户点「就是这个会」同样是错的。
 * 所以单独一类：不喂任何名单会，也不进「建议核对」。
 * 例外：名单里本来就有的 workshop（CCF 名单收了 14 个 workshop 会）不算卫星会。
 */
const SATELLITE_NAME = /\b(workshop|workshops|tutorial|tutorials|doctoral|poster)\b/i
const REGION_EDITION = /\b(asia|europe|pacific)\b/i

export function isSatelliteRecord(row, owner = null) {
  // 名单自己就有一条同名 workshop 会（owner 的全称里也带 workshop）→ 那是正经会议，不是卫星会
  if (owner && SATELLITE_NAME.test(String(owner.fullName ?? ''))) return false
  const text = `${row?.fullName ?? ''} ${row?.name ?? ''}`
  if (SATELLITE_NAME.test(text)) return true
  if (!owner) return false
  // "ACM SIGGRAPH ASIA" 这种：名字里带地区，且归属到的会上简称不同 → 它是主会的地区版
  if (!REGION_EDITION.test(text)) return false
  const rowName = coreName(row?.venue ?? row?.name ?? '')
  const ownerName = coreName(owner?.abbr ?? owner?.fullName ?? '')
  return Boolean(rowName) && Boolean(ownerName) && rowName !== ownerName
}

/**
 * 找某个会的卫星会：Workshop 或地区分会场（SIGGRAPH Asia / CVPR Workshops 这类）。
 * 查主会时告诉读者"另有一个 satellite，它另算"——否则用户会以为 workshop 的截稿被吞了。
 */
export function relatedSatellites(records, venue) {
  const base = coreName(String(venue ?? ''))
  if (!base) return []
  const fake = { abbr: base, fullName: '' }
  const out = []
  for (const row of Array.isArray(records) ? records : []) {
    const rowName = coreName(row?.venue ?? row?.name ?? '')
    if (!rowName || rowName === base) continue
    if (!isSatelliteRecord(row, fake)) continue
    if (!rowName.includes(base) && !base.includes(rowName)) continue
    out.push(row)
  }
  return out
}

export function catalogCoverage(records, catalog, options = {}) {
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  // 用户明确说过「这条不是这个会」的记录：不参与任何会的统计，算名单外
  const ignoredKeys = options.ignoredKeys instanceof Set ? options.ignoredKeys : new Set(options.ignoredKeys ?? [])
  // 用户核对过、明确说「就是它」的记录：照常参与统计，只是不再提示「建议核对」
  const confirmedKeys = options.confirmedKeys instanceof Set ? options.confirmedKeys : new Set(options.confirmedKeys ?? [])
  const conferences = Array.isArray(options.conferences) ? options.conferences : catalogConferences(catalog)
  const list = Array.isArray(records) ? records : []
  const future = []
  const past = []
  const never = []
  // 先给每条记录找一个"归属会"：同名不同会时只归一个，避免一份数据喂饱两个会。
  const weak = []
  const satellites = []
  const owned = new Map()
  const unmatched = []
  for (const row of list) {
    if (row?.key && ignoredKeys.has(row.key)) {
      unmatched.push(row)
      continue
    }
    const name = row?.venue ?? row?.name
    const candidates = conferences.filter((conference) => matchVenue(name, conference))
    // 只有一个候选就认它（全称措辞常常不同于名单，硬拒会把真数据丢掉），
    // 但全称一个字都对不上时记一笔，让面板/命令能提示"这条可能是别的会"。
    const owner = candidates.length === 1 ? candidates[0] : candidates.length > 0 ? pickByFullName(row, candidates) : null
    // 卫星会/分会场先判：workshop 名字一眼能认，不必先有归属会
    if (isSatelliteRecord(row, owner)) {
      satellites.push(row)
      // 卫星会单独一档（有自己的面板开关和 status 行），不再计进 outside ——
      // 否则「名单外 73 + 卫星会 9」两笔账互相包含，加起来对不上 404 条记录。
      continue
    }
    if (!owner) {
      unmatched.push(row)
      continue
    }
    if (fullNameScore(row, owner) === 0 && !(row?.key && confirmedKeys.has(row.key))) {
      weak.push({ key: row?.key ?? '', venue: row?.venue ?? row?.name ?? '', abbr: owner.abbr })
    }
    if (!owned.has(owner)) owned.set(owner, [])
    owned.get(owner).push(row)
  }
  for (const conference of conferences) {
    const rows = owned.get(conference) ?? []
    if (rows.length === 0) never.push(conference)
    else if (rows.some((row) => Number.isFinite(row?.deadline) && row.deadline >= now)) future.push(conference)
    else past.push(conference)
  }
  // 名单外的会：CCFDDL 收了、CCF 名单没收（CoRL、EACL、CICAI…）。
  // 它们不该被算进 362，但"面板里明明有这张卡"和"362 里没有它"同时成立，
  // 读者会以为数字错了 —— 所以单独数出来，由调用方决定怎么展示。
  const outside = unmatched
  const outsideFuture = outside.filter((row) => Number.isFinite(row?.deadline) && row.deadline >= now).length
  // "个会"和"条记录"是两回事：CoRL 收了 2026 和 2027 两条，但只有一个会。
  // 界面上一律说"个会"，所以这里按会去重后再数，别让数字和名词对不上。
  const venueCount = (rows) => new Set(rows.map((row) => coreName(String(row?.venue ?? row?.name ?? '')))).size
  const outsideVenues = venueCount(outside)
  const satelliteVenues = venueCount(satellites)

  return {
    total: conferences.length,
    weakMatches: weak,
    satellites,
    future,
    past,
    never,
    outside,
    pending: [...past, ...never],
    counts: {
      total: conferences.length,
      future: future.length,
      past: past.length,
      never: never.length,
      pending: past.length + never.length,
      outside: outside.length,
      outsideVenues,
      outsideFuture,
      weakMatches: weak.length,
      satellites: satellites.length,
      satelliteVenues,
    },
  }
}
