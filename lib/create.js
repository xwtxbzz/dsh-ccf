/**
 * dsh-ccf · 装配层
 *
 * 把「CCF 会议截稿」能力装配成三样东西：
 *   1. 两个模型工具：`ccf_deadlines`（查快截稿的）、`ccf_venue`（查某个会议的详情）
 *   2. `/ccf` 人用命令：sync / list / venue / status / config
 *   3. 一段 system-prompt 摘要（order 100–199 是工具引导段位），只在有新鲜数据时注入
 *
 * 依赖注入：defineTool 由 index.js 传入，便于在没有宿主的单元测试里替换。
 */
import { readFileSync, statSync } from 'node:fs'
import { mkdir, open, readFile as readFileAsync, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULTS,
  DEFAULT_SOURCES,
  applyPreferredAll,
  countdownText,
  dedupeVenueYear,
  formatInZone,
  formatInZoneSafe,
  formatList,
  formatVenue,
  isBigConflict,
  mergeKeepingNewlyAdded,
  toInstant,
  promptText,
  queryDeadlines,
  queryDeadlinesWithMeta,
  queryVenue,
  venueKey,
  systemTimeZone,
} from './core.js'
import {
  catalogConferences,
  catalogCoverage,
  catalogSummary,
  findInCatalog,
  inspectCatalog,
  normalizeVenue,
  pickByFullName,
  relatedSatellites,
} from './catalog.js'
import { ATTRIBUTION, MODEL_REQUIRED, isModelAvailable, planUpdate, runUpdate } from './miner.js'
import { cachePathOf, defaultDataDir, describeWriteFailure, loadCache, saveCache, syncSources } from './sync.js'
import { ROUTE_PREFIX, createUiRoutes, sameVenue } from './ui.js'

/** system-prompt 段位：100–199 为工具引导。 */
export const POLICY_ORDER = 150

/**
 * 插件版本：面板底部与 `/ccf status` 都会显示它。
 *
 * 存在的理由是产品问题而不是工程问题——宿主端服务模块与客户端 bundle 的生效时机不同，
 * 改完代码后"界面没变化"时，用户唯一能判断的依据就是界面上印的版本号。
 */
export const VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** `/ccf help` 与未知子命令共用的用法说明。 */
export const USAGE = [
  'dsh-ccf —— CCF 会议截稿侦测',
  '',
  '  /ccf                  最近要截稿的会（默认 120 天）',
  '  /ccf list [天数]      按天数窗口列，支持 --rank CCF-A / --area CV / --search neur / --past / --satellites / --conflicts',
  '  /ccf pending          列出名单里还没有截稿数据的会',
  '  /ccf venue <名字>     查单个会议的详情',
  '  /ccf ignore <名字> [--undo]',
  '                        这条记录其实不是这个会（同简称的两个会，如 SEC / FSE）：标了就不算进任何会的覆盖度',
  '  /ccf confirm <名字> [--undo]',
  '                        核对过「建议核对」的卡片后说「就是它」：不再反复提示，撤销同样用 --undo',
  '  /ccf marks           我做过的裁决：哪些会标了「不是这个会」、哪些确认了「就是这个会」',
  '  /ccf prefer <名字> [来源]',
  '                        两个来源给的截稿不一样时，采信其中一个（不带来源=看当前采信，--reset=恢复默认）',
  '  /ccf prefer <来源> --conflicts [--undo]',
  '                        把这些冲突的会一次都采信这个来源（--undo 撤回），不用一条条点',
  '  /ccf update [--limit n] [--force] [--focus CVPR] [--area 人工智能] [--scope past|never]',
  '                        用模型搜会议官网补数据（懒更新；--area 按方向补、--scope 只补往届/从未抓到的）',
  '  /ccf sync             从 CCFDDL 官方接口拉数据（不需要模型）',
  '  /ccf status           版本、缓存、名单、模型可用性',
  '  /ccf config           当前配置',
  '  /ccf help             这份说明',
].join('\n')

/** `ccf_deadlines` 的参数 DSL（同时导出，便于用真实 SDK 校验）。 */
export const DEADLINE_PARAMETERS = {
  days: {
    type: 'number',
    description: `往后看多少天内的截稿（默认 ${DEFAULTS.windowDays}）。`,
  },
  rank: {
    type: 'string',
    description: '只要这个 CCF 等级：CCF-A / CCF-B / CCF-C。省略=全部。',
  },
  area: {
    type: 'string',
    description: '只要这个方向，如 AI/ML、CV、NLP、DB、Security、SE、Systems。省略=全部。',
  },
  search: {
    type: 'string',
    description: '按会议名/别名过滤，如 "neuro"、"ICLR"。',
  },
  limit: {
    type: 'number',
    description: '最多返回几条（默认全部）。',
  },
  includePast: {
    type: 'boolean',
    description: 'true 时把刚过去 14 天内的也算进来（看"错过了什么"）。',
  },
  pending: {
    type: 'boolean',
    description: 'true 时改为列出 CCF 名单里还没有截稿数据的会（"哪些会还没挖到"），不返回日期。',
  },
  includeSatellites: {
    type: 'boolean',
    description: 'true 时把 Workshop / 地区分会场也列进来（默认只列名单里的主会，它们不算进主会统计）。',
  },
  conflictsOnly: {
    type: 'boolean',
    description: 'true 时只列两个来源截稿说法不一致（差一天以上）的会——这些日期不是唯一说法，别当成定论转述。',
  },
  refresh: {
    type: 'boolean',
    description: 'true 时先联网同步再查（默认 false，用本地缓存）。',
  },
}

/** `ccf_venue` 的参数 DSL。 */
export const VENUE_PARAMETERS = {
  venue: {
    type: 'string',
    description: '会议名，如 "CVPR"、"ICLR 2027"、"NeurIPS"。',
  },
  refresh: {
    type: 'boolean',
    description: 'true 时先联网同步再查（默认 false）。',
  },
}

/** `ccf_update` 的参数 DSL。 */
export const UPDATE_PARAMETERS = {
  limit: {
    type: 'number',
    description: '本轮最多挖几个会（默认取配置 maxVenuesPerRun，通常是 6）。',
  },
  force: {
    type: 'boolean',
    description: 'true 时连"挖过但已超过 refreshDays"的会也重挖；默认只补没有数据的会。',
  },
  focus: {
    type: 'string',
    description: '只处理简称/全称里含这个词的会，如 "CVPR"、"Neur"（调试用）。',
  },
  area: {
    type: 'string',
    description: '只补这个方向的会，如 "人工智能"、"计算机图形学"、"数据库"；也接受 "CV" 这类英文片段。',
  },
  scope: {
    type: 'string',
    enum: ['past', 'never'],
    description: '"past" 只补"缓存里只有往届日期"的会，"never" 只补"一条记录都没有"的会；省略=两类都补。',
  },
}

/** 没数据时模型看到的话（也是引导它去同步）。 */
const NO_DATA_HINT = `还没有会议数据。先运行 \`/ccf sync\`（或再调一次本工具并带 refresh: true）把上游数据抓到本地缓存。
数据源是可配置的（ccfddl 的 YAML / paper-deadlines 的 JSON），插件本身不内置任何日期，也不会凭记忆编日期。`

/**
 * @param {any} ctx cordis 上下文
 * @param {Record<string, unknown>} rawConfig cordis.patch.yml 传入的 config
 * @param {(definition: any) => any} defineTool 宿主提供的 defineTool
 */
export function createCcf(ctx, rawConfig = {}, defineTool) {
  const config = normalizeConfig(rawConfig)
  const dataDir = config.dataDir ? resolve(String(config.dataDir)) : defaultDataDir()
  const logger = ctx?.logger
  // CCF 官方名单（随插件发布，运行时按需读一次就缓存住）。三态：ok / missing / corrupt。
  const catalogPath = config.catalogPath ? resolve(String(config.catalogPath)) : undefined
  const catalogState = inspectCatalog(catalogPath)
  const catalog = catalogState.catalog
  const catalogInfo = { ...catalogSummary(catalog), state: catalogState.state, path: catalogState.path, error: catalogState.error }
  /** 一行说清名单的状态（status / 更新失败回执共用）。 */
  const catalogLine = () => {
    if (catalogInfo.state === 'ok') {
      return `${catalogInfo.conferences} 个 CCF 会议（${catalogInfo.byRank['CCF-A']}A/${catalogInfo.byRank['CCF-B']}B/${catalogInfo.byRank['CCF-C']}C，${catalogInfo.areas} 个方向，抓取于 ${catalogInfo.fetchedAt ?? '未知'}）`
    }
    if (catalogInfo.state === 'missing') {
      return `没找到名单文件 ${catalogInfo.path}（插件自带 data/ccf-catalog.json；可以设 catalogPath 指到你自己的名单）`
    }
    return `名单文件 ${catalogInfo.path} 读不出来（${catalogInfo.error}）：面板只能列 CCFDDL 收过的会，「待补」也数不出来。重新下载一份，或用 catalogPath 指到别的名单。`
  }

  // ---- system-prompt 需要一个同步读取的缓存视图 --------------------------
  let cacheView = { path: cachePathOf(dataDir), mtimeMs: -1, value: null, state: 'missing', error: '' }
  const currentCache = (force = false) => {
    const path = cachePathOf(dataDir)
    let stat
    try {
      stat = statSync(path)
    } catch (error) {
      const state = error?.code === 'ENOENT' ? 'missing' : 'unreadable'
      cacheView = { path, mtimeMs: -1, value: null, state, error: state === 'missing' ? '' : String(error?.message ?? error) }
      return null
    }
    if (!force && stat.mtimeMs === cacheView.mtimeMs && cacheView.path === path) return cacheView.value
    let raw
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      cacheView = { path, mtimeMs: stat.mtimeMs, value: null, state: 'unreadable', error: String(error?.message ?? error) }
      return null
    }
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      cacheView = { path, mtimeMs: stat.mtimeMs, value: null, state: 'corrupt', error: `JSON 解析失败：${error?.message ?? error}` }
      return null
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
      cacheView = { path, mtimeMs: stat.mtimeMs, value: null, state: 'corrupt', error: '结构不对：缺少 records 数组' }
      return null
    }
    cacheView = { path, mtimeMs: stat.mtimeMs, value: parsed, state: 'ok', error: '' }
    return parsed
  }
  /**
   * 数据目录本身是不是就有问题：指到了一个普通文件、或者指向一个不存在且建不出来的路径。
   * 这时候"缓存文件读不出来（JSON 解析失败）"是误诊——真正的问题是 dataDir 配错了。
   */
  const dataDirProblem = () => {
    try {
      const stat = statSync(dataDir)
      if (!stat.isDirectory()) {
        return `数据目录 ${dataDir} 不是一个目录（它是一个${
          stat.isFile() ? '文件' : '特殊路径'
        }）。检查配置里的 dataDir：插件要在那里放 cache.json。`
      }
      return ''
    } catch (error) {
      if (error?.code === 'ENOENT') return ''
      return `数据目录 ${dataDir} 打不开：${String(error?.message ?? error)}。检查权限或改配置里的 dataDir。`
    }
  }

    const cacheStatus = () => ({ state: cacheView.state, error: cacheView.error, path: cacheView.path })

  // 缓存坏了的时候，"还没有数据"是不准确的：文件还在，只是读不出来。
  const cacheHint = () => {
    const status = cacheStatus()
    if (status.state === 'corrupt') return `缓存文件读不出来（${status.error}）：文件在 ${status.path}。原文件没有被覆盖，可以先备份，再跑 \`/ccf sync\` 重建。`
    if (status.state === 'unreadable') return `缓存文件打不开（${status.error}）：文件在 ${status.path}。检查数据目录权限，或把配置里的 dataDir 指到别处。`
    return ''
  }

  const acquire = (serviceName, use) => {
    const service = ctx?.get?.(serviceName)
    if (service) {
      use(service)
      return
    }
    let handled = false
    ctx?.on?.('internal/service', (ready) => {
      if (handled || ready !== serviceName) return
      const found = ctx?.get?.(serviceName)
      if (!found) return
      handled = true
      use(found)
    })
  }

  const asArray = (value, transform) => {
    if (value === undefined || value === null || value === '') return null
    const list = Array.isArray(value) ? value : String(value).split(',')
    const mapped = list.map((item) => transform(String(item).trim())).filter(Boolean)
    return mapped.length > 0 ? mapped : null
  }

  const doSync = async (signal) => {
    const result = await syncSources({
      sources: config.sources ?? undefined,
      dataDir,
      timeoutMs: config.timeoutMs,
      signal,
      logger,
    })
    currentCache(true)
    return result
  }

  /**
   * 展示/查询用的派生记录：用户采信过的来源会生效，缓存里的主记录保持不动。
   * 「按会议系列记住的选择」也在这里生效（`meta.preferredByVenue`）。
   */
  const viewRecords = (cache) => dedupeVenueYear(applyPreferredAll(cache?.records, cache?.meta?.preferredByVenue ?? null))
  // 用户标过「不是这个会」的记录：每个覆盖度调用都要带上，否则命令行与面板口径会分叉
  // 用户对记录的两种裁决 + 每条记录自己的「采信来源」，全部收在这一个入口里。
  // 以前每加一个 meta 字段就要在 status / list / venue / 面板四处各记得传一次，漏一处就是口径分叉（N81/N84）。
  const marksOf = (cache) => ({
    ignoredKeys: new Set((cache?.meta?.ignoredKeys ?? []).filter(Boolean)),
    confirmedKeys: new Set((cache?.meta?.confirmedKeys ?? []).filter(Boolean)),
  })

  /**
   * 改一条记录的「采信来源」（`source` 传空表示恢复默认来源）。
   *
   * 只写 `preferredSource` 这一个字段：`deadline` 等主值不覆盖，下轮同步/挖掘照旧合并，
   * 用户随时能点回默认。同时记到 `meta.preferredByVenue`：同一个会每年都会冲突一次，
   * 记在系列上，明年新一届自动沿用，不用再点。
   */
  const doPrefer = async ({ key, source, remember = true } = {}) => {
    const wanted = String(key ?? '').trim()
    if (!wanted) return { ok: false, note: '需要会议 key，例如 cvpr|2027。' }
    const cache = await loadCache(dataDir)
    const records = Array.isArray(cache?.records) ? cache.records.slice() : []
    const index = records.findIndex((record) => record?.key === wanted)
    if (index < 0) return { ok: false, note: `缓存里没有 ${wanted}。` }
    const record = { ...records[index] }
    const sourceName = String(source ?? '').trim()
    const meta = cache?.meta && typeof cache.meta === 'object' ? { ...cache.meta } : {}
    const venue = venueKey(record.venue ?? record.name ?? '')
    const byVenue = meta.preferredByVenue && typeof meta.preferredByVenue === 'object'
      ? { ...meta.preferredByVenue }
      : {}
    if (!sourceName) {
      delete record.preferredSource
      if (venue) delete byVenue[venue]
    } else {
      const alternatives = Array.isArray(record.alternatives) ? record.alternatives : []
      if (!alternatives.some((item) => item?.source === sourceName)) {
        return { ok: false, note: `这个会没有 ${sourceName} 给的另一种说法。` }
      }
      record.preferredSource = sourceName
      if (venue && remember !== false) byVenue[venue] = sourceName
    }
    if (Object.keys(byVenue).length > 0) meta.preferredByVenue = byVenue
    else delete meta.preferredByVenue
    records[index] = record
    await saveCache(dataDir, { ...cache, records, meta })
    currentCache(true)
    return {
      ok: true,
      key: wanted,
      source: sourceName,
      venue,
      remembered: Boolean(venue && sourceName && remember !== false),
    }
  }

  /**
   * 一次把「这批冲突的会」统一采信某个来源。
   *
   * 真机上 26 条来源冲突，一条条 `/ccf prefer <会> <来源>` 是 26 次回车；
   * 这里只处理**确实有该来源另一种说法**的记录，没有的不动并如实报数，
   * 被「不是这个会」否掉的、卫星会也不动（它们在默认视图里本来就看不到）。
   */
  const doPreferConflicts = async ({ source, undo = false } = {}) => {
    const sourceName = String(source ?? '').trim()
    if (!sourceName) return { ok: false, note: '需要来源名，例如 /ccf prefer ccfddl-api --conflicts。' }
    const cache = await loadCache(dataDir)
    const records = Array.isArray(cache?.records) ? cache.records : []
    if (records.length === 0) return { ok: false, note: '还没有缓存数据，先跑 /ccf sync。' }
    const meta = cache?.meta && typeof cache.meta === 'object' ? { ...cache.meta } : {}
    const marks = marksOf(cache)
    const cov = catalogCoverage(records, catalog, { now: Date.now(), ...marks })
    const satelliteKeys = new Set((cov?.satellites ?? []).map((row) => row?.key).filter(Boolean))
    const targets = records.filter((record) => record?.key &&
      !marks.ignoredKeys.has(record.key) &&
      !satelliteKeys.has(record.key) &&
      isBigConflict(record))
    const targetKeys = new Set(targets.map((record) => record.key))
    const byVenue = meta.preferredByVenue && typeof meta.preferredByVenue === 'object' ? { ...meta.preferredByVenue } : {}
    let changed = 0
    let skipped = 0
    const updated = records.map((record) => {
      if (!targetKeys.has(record?.key)) return record
      const venue = venueKey(record.venue ?? record.name ?? '')
      if (undo) {
        if (record.preferredSource !== sourceName) return record
        const copy = { ...record }
        delete copy.preferredSource
        if (venue) delete byVenue[venue]
        changed += 1
        return copy
      }
      const alternatives = Array.isArray(record.alternatives) ? record.alternatives : []
      if (!alternatives.some((item) => item?.source === sourceName)) {
        skipped += 1
        return record
      }
      changed += 1
      if (venue) byVenue[venue] = sourceName
      return { ...record, preferredSource: sourceName }
    })
    if (Object.keys(byVenue).length > 0) meta.preferredByVenue = byVenue
    else delete meta.preferredByVenue
    await saveCache(dataDir, { ...cache, records: updated, meta })
    currentCache(true)
    return { ok: true, source: sourceName, conflicts: targets.length, changed, skipped }
  }

  /**
   * 把一个会标成「不是这个会」：它的记录不再参与任何会的统计（算名单外），
   * 同简称的两个会（SEC / USENIX Security、FSE 两个会）就能各归各位。
   * 只写 cache.meta.ignoredKeys，不动数据本身——想反悔就 /ccf ignore <名字> --undo。
   */
  /** 把用户说的"会名/key"解析成缓存里真实存在的 key：先精确 key，再精确会议名，最后包含匹配。 */
  const resolveRecordKey = (records, wanted) => {
    if (wanted.includes('|')) return records.some((record) => record?.key === wanted) ? wanted : ''
    const needle = normalizeVenue(wanted)
    const exact = records.find((record) => normalizeVenue(record?.venue ?? record?.name ?? '') === needle)
    const loose = exact ?? records.find((record) => normalizeVenue(record?.venue ?? record?.name ?? '').includes(needle))
    return loose?.key ?? ''
  }

  /**
   * 写一条"裁决"进 cache.meta：ignoredKeys（不是这个会）与 confirmedKeys（就是这个会）
   * 原来是两个各写一遍的函数，缺一处就出现口径分叉（N81 / N84 连犯两次）。
   * field 只允许这两个字段名，读回用 marksOf()，两边同一个来源。
   */
  const MARK_FIELDS = {
    ignoredKeys: {
      label: '不是这个会',
      done: (key) => `已把 ${key} 标成「不是这个会」：它不再算进任何会的覆盖度，也不再占用「待补」的名额。撤销用 /ccf ignore ${key} --undo。`,
      undone: (key) => `已取消标记 ${key}：它重新参与覆盖度统计。`,
      example: '/ccf ignore SEC',
    },
    confirmedKeys: {
      label: '就是这个会',
      done: (key) => `已确认 ${key} 就是名单里那个会：不再提示「建议核对」。撤销用 /ccf confirm ${key} --undo。`,
      undone: (key) => `已取消「就是它」的确认 ${key}：它会重新出现在「建议核对」里。`,
      example: '/ccf confirm SEC',
    },
  }

  const writeMark = async (field, { key, undo = false } = {}) => {
    const spec = MARK_FIELDS[field]
    if (!spec) throw new Error(`未知标记字段：${field}`)
    const wanted = String(key ?? '').trim()
    if (!wanted) return { ok: false, note: `需要会议 key 或会议名，例如 ${spec.example}，也可以写 key（形如 "sec|2026"）。` }
    const cache = await loadCache(dataDir)
    const records = Array.isArray(cache?.records) ? cache.records : []
    const meta = cache?.meta && typeof cache.meta === 'object' ? { ...cache.meta } : {}
    const current = Array.isArray(meta[field]) ? meta[field].slice() : []

    const resolved = resolveRecordKey(records, wanted)
    if (!resolved) {
      return { ok: false, note: `缓存里没有「${wanted}」这个会的记录。先用 /ccf list --search ${wanted} 看看数据里叫什么。` }
    }

    const next = undo ? current.filter((item) => item !== resolved) : Array.from(new Set([...current, resolved]))
    if (next.length > 0) meta[field] = next
    else delete meta[field]
    await saveCache(dataDir, { ...cache, meta })
    currentCache(true)

    const cov = catalog ? catalogCoverage(cache.records, catalog, { now: Date.now(), ...marksOf({ ...cache, meta }) }) : null
    const out = { ok: true, key: resolved, total: next.length, counts: cov?.counts ?? null }
    out[field === 'ignoredKeys' ? 'ignored' : 'confirmed'] = !undo
    out.note = undo ? spec.undone(resolved) : spec.done(resolved)
    return out
  }

  const doIgnore = (options = {}) => writeMark('ignoredKeys', options)
  const doConfirm = (options = {}) => writeMark('confirmedKeys', options)

  const ensureCache = async (refresh, signal) => {
    if (refresh) return doSync(signal)
    const existing = currentCache(false)
    if (existing && existing.records.length > 0) return { cache: existing, report: '', ok: true }
    return doSync(signal)
  }

  /** 跑一次「模型挖掘」更新（懒：只补缺信息的会）。 */
  // 同一时间只允许一轮补数据：面板上连点两下、或者两个窗口同时点，都会把缓存写乱。
  let updateInFlight = null
  let updateStartedAt = 0
  // 拿锁是异步的：两次点击可能都还没拿到锁就都通过了 updateInFlight 检查，
  // 所以从进门到 assign updateInFlight 之间也要有个同步标记挡着。
  let updateStarting = false

  /** 正在跑的补数据进度（没有在跑时是 null）：面板拿它显示"正在补 3/6：CVPR"。 */
  let updateProgress = null

  const doUpdate = async (options = {}) => {
    if (!catalog) return { ok: false, mined: [], failed: [], byArea: [], note: `无法按名单挖掘：${catalogLine()}` }
    if (updateInFlight || updateStarting) {
      const seconds = Math.max(1, Math.round((Date.now() - updateStartedAt) / 1000))
      return {
        ok: false,
        busy: true,
        mined: [],
        failed: [],
        byArea: [],
        note: `上一轮补数据还在跑（已 ${seconds} 秒）${updateProgress?.current ? `，正在补 ${updateProgress.current}` : ''}，等它结束再点。`,
      }
    }
    // 同一台机器上可能开着两个 DSH 窗口：内存里的 updateInFlight 拦不住另一个进程。
    updateStarting = true
    const lock = await acquireUpdateLock()
    if (!lock.ok) {
      updateStarting = false
      return { ok: false, busy: true, mined: [], failed: [], byArea: [], note: lock.note }
    }
    updateStartedAt = Date.now()
    updateProgress = { startedAt: Date.now(), total: null, done: 0, current: '', ok: 0, failed: 0 }
    const onProgress = (event) => {
      if (!updateProgress) return
      if (Number.isFinite(event?.total) && event.total > 0) updateProgress.total = event.total
      if (Number.isFinite(event?.index)) updateProgress.index = event.index
      if (event?.phase === 'start') {
        updateProgress.current = event.venue ?? ''
      }
      if (event?.phase === 'done') {
        updateProgress.done = Number(event.index) || updateProgress.done
        if (event.ok) updateProgress.ok += 1
        else updateProgress.failed += 1
        updateProgress.last = event.ok ? `${event.venue} 补到` : `${event.venue} 没补到（${event.reason ?? '原因未知'}）`
      }
    }
    updateInFlight = runUpdate({
      ctx,
      config: { ...config, catalog },
      dataDir,
      currentCache,
      doSync,
      saveCache: async (cache) => {
        // 一轮补数据要几十秒。期间别的窗口可能刚跑完 /ccf sync，缓存里多了几条；
        // 直接拿开跑时的快照覆盖，会把人家刚同步到的会丢掉。
        let payload = cache
        try {
          const latest = await loadCache(dataDir)
          if (latest && Array.isArray(latest.records) && Array.isArray(cache?.records)) {
            const merged = mergeKeepingNewlyAdded(cache.records, latest.records)
            if (merged.length !== cache.records.length) {
              payload = { ...cache, records: merged }
              logger?.info?.(`dsh-ccf: 补数据期间缓存多了 ${merged.length - cache.records.length} 条（别处刚同步的），已并入`)
            }
          }
        } catch (error) {
          logger?.warn?.(`dsh-ccf: 读旧缓存做合并失败 —— ${error?.message ?? error}`)
        }
        try {
          await saveCache(dataDir, payload)
        } catch (error) {
          // 挖到的数据写不进去，跟"没挖到"是两件事：说清楚，别让用户以为模型死了。
          throw new Error(describeWriteFailure(error, dataDir))
        }
      },
      limit: options.limit,
      force: options.force === true,
      focus: options.focus ?? null,
      area: options.area ?? null,
      scope: options.scope ?? null,
      signal: options.signal,
      logger,
      onProgress,
    })
    updateStarting = false
    try {
      const result = await updateInFlight
      currentCache(true)
      return result
    } finally {
      updateInFlight = null
      updateStarting = false
      updateStartedAt = 0
      updateProgress = null
      await releaseUpdateLock()
    }
  }

  /**
   * 跨进程的"正在补数据"锁：锁文件放在 dataDir 里，超过 10 分钟当成失效（进程被杀/断电）。
   * 同一台机器上开着两个 DSH 窗口时，第二个窗口点「补数据」应该被告知，而不是一起挖、互相覆盖。
   */
  const UPDATE_LOCK_FILE = 'update.lock'
  const UPDATE_LOCK_STALE_MS = 10 * 60 * 1000

  const acquireUpdateLock = async () => {
    const file = join(dataDir, UPDATE_LOCK_FILE)
    try {
      await mkdir(dataDir, { recursive: true })
      const handle = await open(file, 'wx')
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
      await handle.close()
      return { ok: true }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // 锁文件本身写不了（权限/目录是文件）：别因为锁挡住补数据，让它去撞真正的写盘错误。
        return { ok: true }
      }
      let owner = null
      try {
        owner = JSON.parse(await readFileAsync(file, 'utf8'))
      } catch {
        owner = null
      }
      const at = Number(owner?.at) || 0
      if (at && Date.now() - at < UPDATE_LOCK_STALE_MS) {
        const seconds = Math.max(1, Math.round((Date.now() - at) / 1000))
        return {
          ok: false,
          note: `另一个窗口的补数据还在跑（已 ${seconds} 秒），等它结束再点。锁文件：${file}`,
        }
      }
      // 超时的锁（进程被强杀/断电留下的）直接接管，不能把功能永久卡死
      try {
        await writeFile(file, JSON.stringify({ pid: process.pid, at: Date.now() }))
      } catch {
        // 接管失败就算了，让它继续往真正的路径上撞
      }
      return { ok: true }
    }
  }

  const releaseUpdateLock = async () => {
    const file = join(dataDir, UPDATE_LOCK_FILE)
    try {
      const owner = JSON.parse(await readFileAsync(file, 'utf8'))
      // 只删自己的锁：万一锁已经被别人接管，删了会误伤
      if (Number(owner?.pid) !== process.pid) return
      await unlink(file)
    } catch {
      // 锁不在 / 读不了：都不影响结果
    }
  }

  /** 进度快照（面板用；已完成时返回 null）。 */
  const progress = () => (updateProgress ? { ...updateProgress } : null)

  /** prompt 里的"数据状态"一行：还有多少会缺数据、上次什么时候更新的、要不要模型。 */
  // 系统提示里那几行截稿，得和 ccf_deadlines / 面板同一套过滤：
  // 卫星会（CVPR Workshops 之类）与用户标过「不是这个会」的记录都不该出现在"未来 30 天有几个"里，
  // 否则最显眼的那句话说的就是 workshop 的日期。
  const promptCacheOf = (cache) => {
    if (!cache || !Array.isArray(cache.records)) return cache
    const marks = marksOf(cache)
    let records = viewRecords(cache).filter((row) => !marks.ignoredKeys.has(row?.key))
    if (catalog) {
      const coverage = catalogCoverage(records, catalog, { now: Date.now(), ...marks })
      const satelliteKeys = new Set((coverage.satellites ?? []).map((row) => row?.key).filter(Boolean))
      records = records.filter((row) => !satelliteKeys.has(row?.key))
    }
    return { ...cache, records }
  }

  const updateNote = (cache) => {
    if (config.prompt === false) return ''
    const meta = cache?.meta && typeof cache.meta === 'object' ? cache.meta : {}
    const records = Array.isArray(cache?.records) ? cache.records : []
    // 与面板同一个口径：362 个会里，有未来截稿的 / 只有往届的 / 一条记录都没有的。
    const coverage = catalog ? catalogCoverage(records, catalog, { now: Date.now(), ...marksOf(cache) }) : null
    const parts = []
    if (coverage && coverage.counts.total > 0) {
      const { total, future, past, never } = coverage.counts
      parts.push(`名单 ${total} 个会：${future} 个有未来截稿${past > 0 ? `，${past} 个只有往届日期` : ''}${never > 0 ? `，${never} 个从未抓到` : ''}`)
    } else if (Number.isFinite(meta.pending) && meta.pending > 0) {
      parts.push(`名单里还有 ${meta.pending} 个会没有截稿时间（需要模型挖掘）`)
    }
    if (Number.isFinite(meta.lastUpdateAt)) parts.push(`上次更新 ${formatInZone(meta.lastUpdateAt, config.timezone)}，模型新挖到 ${meta.lastUpdateMined ?? 0} 个`)
    if (!isModelAvailable(ctx)) parts.push('当前没有可用模型，新会议只能用回退数据')
    if (parts.length === 0) return ''
    const line = `数据状态：${parts.join('；')}。桌面端右侧有「📅 会议」面板（点开即列表，可按方向/等级筛、可导出日历）。手动补数据用 \`/ccf update\`（按类：\`--scope past|never\`；按方向：\`--area 人工智能\`）。`
    return meta.fallback ? `${line}\n${ATTRIBUTION.text}` : line
  }

  const buildList = (cache, args, extra = {}) => {
    const now = extra.now ?? Date.now()
    const windowDays = Number.isFinite(args?.days) && args.days > 0 ? Number(args.days) : config.windowDays
    const ranks = asArray(args?.rank, (value) => value.toUpperCase())
    const areas = asArray(args?.area, (value) => value)
    const search = args?.search ? String(args.search).toLowerCase() : null
    const catalogConfs = catalogConferences(catalog)
    // 「有数据」= 还有未来截稿；「待补」= 只有往届日期，或一条记录都没有。
    // 统计口径统一走 catalog.js 的 catalogCoverage（与面板、系统提示同一个函数）。
    const cov = catalogConfs.length > 0 ? catalogCoverage(cache.records, catalog, { now, ...marksOf(cache) }) : null
    const pendingRows = cov ? cov.pending : []

    // 方向过滤有两套词表：记录里 `area` 是上游英文子类（AI/ML、CV…），名单里是中文大类
    // （「人工智能」「计算机图形学」…）。用户/agent 说"人工智能"时，先按名单把它解析成
    // 一批会议，再按会议名过滤，否则一条也筛不出来。
    const areaNeedles = areas ? areas.filter((needle) => String(needle || '').trim()) : null
    const catalogAreaAbbrs = areaNeedles && catalogConfs.length > 0
      ? new Set(catalogConfs
        .filter((item) => areaNeedles.some((needle) => String(item.area || '').includes(needle)))
        .map((item) => item.abbr))
      : null
    const resolvedByCatalog = Boolean(catalogAreaAbbrs && catalogAreaAbbrs.size > 0)

    if (args?.pending === true) {
      const filtered = pendingRows.filter((item) => {
        if (ranks && ranks.indexOf(item.rank) === -1) return false
        if (areaNeedles && !areaNeedles.some((needle) => String(item.area || '').includes(needle))) return false
        if (!search) return true
        return `${item.abbr} ${item.fullName}`.toLowerCase().indexOf(search) !== -1
      })
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Number(args.limit)) : filtered.length
      const shown = filtered.slice(0, limit)
      const lines = shown.map((item) => `- ${item.abbr} · ${item.rank} · ${item.area}${item.fullName ? ` · ${item.fullName}` : ''}`)
      const more = filtered.length > shown.length ? `\n…还有 ${filtered.length - shown.length} 个（加 limit 或收窄过滤条件）` : ''
      const report = filtered.length === 0
        ? `名单里的会都已有截稿数据（名单共 ${catalogConfs.length} 个会议）。`
        : `名单里还没有截稿数据的会（${filtered.length} 个，共 ${catalogConfs.length} 个会议）：\n${lines.join('\n')}${more}\n\n补数据：\`/ccf update --area <方向>\` 批量补一个方向，\`/ccf update --focus <简称>\` 补单个会，\`/ccf update --scope past|never\` 只补「只有往届日期」或「从未抓到」的；面板「待补」视图里也有「补往届 / 补从未 / 补这个会」三个按钮。`
      return {
        report,
        data: {
          ok: true,
          pending: true,
          count: filtered.length,
          catalogConferences: catalogConfs.length,
          rows: shown.map((item) => ({ venue: item.abbr, name: item.abbr, fullName: item.fullName, rank: item.rank, area: item.area, deadline: null })),
        },
      }
    }

    const sourceRecords = viewRecords(cache)
    const satelliteKeys = new Set((cov?.satellites ?? []).map((row) => row?.key).filter(Boolean))
    const wantSatellites = args?.includeSatellites === true
    // 默认只列名单里的主会：Workshop / 地区分会场的截稿混进来会制造假紧急（"CVPR 3 月截稿了"其实是 workshop）
    const satelliteRows = sourceRecords.filter((row) => satelliteKeys.has(row?.key))
    const queryRecords = wantSatellites ? sourceRecords : sourceRecords.filter((row) => !satelliteKeys.has(row?.key))
    // 同一套筛选跑两遍：一遍列主会，一遍单数卫星会。限了等级/方向/关键词之后，
    // 尾部那句「另有 N 个」必须等于「打开开关会多出几条」，否则又是一次空头承诺。
    const runQuery = (records, { applyLimit = true } = {}) => {
      const result = queryDeadlinesWithMeta(records, {
        now,
        windowDays,
        ranks,
        areas: resolvedByCatalog ? null : areas,
        search: args?.search ?? null,
        // 按名单解析方向时得先取全量再过滤，否则 limit 会先把别的方向的会截断掉
        limit: !applyLimit ? null : resolvedByCatalog ? null : Number.isFinite(args?.limit) ? Number(args.limit) : null,
        includePast: args?.includePast === true,
      })
      let list = result.rows
      let total = result.matched
      if (resolvedByCatalog) {
        list = list.filter((row) => catalogConfs.some((conf) => catalogAreaAbbrs.has(conf.abbr) && sameVenue(row.venue ?? row.name, conf)))
        total = list.length
        if (applyLimit && Number.isFinite(args?.limit) && args.limit > 0) list = list.slice(0, Number(args.limit))
      }
      // limit 截断时报告要自己说出来（"365 天内只有 8 个"这种假象就是这么来的）
      return { rows: list, matched: total }
    }
    const query = runQuery(queryRecords)
    let rows = query.rows
    let matched = query.matched
    // 两个来源说法打架的记录：命令侧此前只有面板能看见，工具/命令里它们和普通记录长得一模一样
    const conflictAll = queryRecords.filter((row) => isBigConflict(row))
    const conflictKeys = new Set(conflictAll.map((row) => row?.key).filter(Boolean))
    // 只数"窗口/筛选条件下真的会列出来"的那几条，和面板那个「不一致 N」同口径
    const conflictInWindow = runQuery(conflictAll, { applyLimit: false }).rows.length
    // 冲突里有多少条用户已经裁决过（采信了某个来源）：数量不变，但"还有几条等你决定"要说清
    const conflictDecided = conflictAll.filter((row) => typeof row?.preferredSource === 'string' && row.preferredSource).length
    const onlyConflicts = args?.conflictsOnly === true
    if (onlyConflicts) {
      rows = rows.filter((row) => conflictKeys.has(row?.key))
      matched = conflictInWindow
    }
    // 只数"打开开关会真的多出来"的那几条：同样的等级/方向/关键词/窗口，且不受 limit 影响
    const satelliteInWindow = wantSatellites ? 0 : runQuery(satelliteRows, { applyLimit: false }).rows.length
    // 展示用方向优先取名单里的中文大类：记录里的 `area` 是上游的子类代码或旧标签，
    // 直接印出来会出现「S&P · 高性能计算」这种自相矛盾的行。
    rows = rows.map((row) => {
      if (catalogConfs.length === 0) return row
      const hit = catalogConfs.find((conf) => sameVenue(row.venue ?? row.name, conf))
      return hit && hit.area ? { ...row, area: hit.area } : row
    })
    if (wantSatellites && satelliteKeys.size > 0) {
      rows = rows.map((row) => (satelliteKeys.has(row?.key) ? { ...row, satellite: true } : row))
    }
    // 行上打标：只靠详情里的「来源冲突」一行，读清单的人根本不知道这两个日期不是唯一说法
    if (conflictKeys.size > 0) {
      rows = rows.map((row) => (conflictKeys.has(row?.key) ? { ...row, conflict: true } : row))
    }
    const base = formatList(rows, { now, windowDays, timeZone: config.timezone, matched })
    // 说清覆盖度：免得把"窗口里只有 20 条"当成"CCF 只有 20 个会"；
    // 待补再拆成「只有往届日期」和「从未抓到」，这样读者知道下一步该补哪种。
    const coverage = cov
      ? `\n\n名单共 ${cov.counts.total} 个会议：${cov.counts.future} 个有未来截稿，${cov.counts.pending} 个待补${cov.counts.past > 0 || cov.counts.never > 0 ? `（其中 ${cov.counts.past} 个只有往届日期、${cov.counts.never} 个从未抓到）` : ''}${cov.counts.pending > 0 ? '（要名单用 pending=true）' : ''}。` +
        // 名单外的会不在 362 里，但列表里确实有它们的卡片 —— 不说清楚，读者会以为数字错了。
        (cov.counts.outside > 0
          ? `\n另有 ${cov.counts.outsideVenues ?? cov.counts.outside} 个名单外的会（CCFDDL 收录、CCF 名单未收；共 ${cov.counts.outside} 条记录，其中 ${cov.counts.outsideFuture} 条还有未来截稿），不计入这 ${cov.counts.total} 个。`
          : '') +
        (!wantSatellites && satelliteInWindow > 0
          ? `\n另有 ${satelliteInWindow} 个卫星会（Workshop / 地区分会场）没有列进来：加 includeSatellites: true 或 /ccf list --satellites 一起看（它们不计入主会统计）。`
          : '') +
        (!onlyConflicts && conflictInWindow > 0
          ? `\n其中 ${conflictInWindow} 条两个来源的截稿说法不一致（差一天以上才算）${conflictDecided > 0 ? `，你已经采信过其中 ${conflictDecided} 条` : ''}：加 conflictsOnly: true 或 /ccf list --conflicts 只看这些。`
          : '')
      : ''
    const report = base + coverage
    return {
      report,
      data: {
        ok: true,
        count: rows.length,
        // 匹配总数与"这次藏了几条"：模型读到 count 与 matched 不同时，
        // 才知道是 limit 截断，而不是"CCF 一年只有这么几个会"。
        matched,
        hidden: Math.max(0, matched - rows.length),
        windowDays,
        updatedAt: cache.updatedAt ?? null,
        catalogConferences: catalogConfs.length,
        withData: cov ? cov.counts.future : 0,
        conflicts: conflictInWindow,
        pending: pendingRows.length,
        pendingPast: cov ? cov.counts.past : 0,
        pendingNever: cov ? cov.counts.never : 0,
        rows: rows.map((row) => ({
          venue: row.venue,
          year: row.year,
          name: row.name,
          rank: row.rank,
          area: row.area,
          ...(row.conflict === true ? { conflict: true } : {}),
          // 文本里标了「卫星会」，结构化的 rows 也得标：模型读的是 data，不是 report
          ...(row.satellite === true ? { satellite: true } : {}),
          // 已经裁决过（采信某个来源）的冲突：文本行会写「按 X 显示」，data 里一样要有
          ...(typeof row.preferredSource === 'string' && row.preferredSource ? { preferredSource: row.preferredSource } : {}),
          deadline: Number.isFinite(row.deadline) ? new Date(row.deadline).toISOString() : null,
          deadlineLocal: Number.isFinite(row.deadline) ? formatInZone(row.deadline, config.timezone) : null,
          countdown: Number.isFinite(row.deadline) ? countdownText(row.deadline - now) : null,
          link: row.link,
        })),
      },
    }
  }

  // ---- 1. 模型工具 -------------------------------------------------------
  const deadlinesTool = defineTool({
    name: 'ccf_deadlines',
    description:
      '查 CCF 会议的截稿时间（按天窗口、CCF 等级、方向、关键词过滤），返回按时间排序的清单与倒计时。回答"最近有什么会要截稿""XX 方向投哪个会"之前调用它，不要凭记忆报日期。',
    parameters: DEADLINE_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
          data: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.report ?? '') }],
    },
    async execute(args, exec) {
      const ensured = await ensureCache(args?.refresh === true, exec?.signal)
      const cache = ensured.cache
      if (!cache || cache.records.length === 0) {
        return { ok: false, report: `${cacheHint() || NO_DATA_HINT}\n\n同步结果：\n${ensured.report}`, data: { ok: false, rows: [] } }
      }
      const built = buildList(cache, args ?? {})
      const head = ensured.report && args?.refresh === true ? `${ensured.report}\n\n` : ''
      return { ok: true, report: head + built.report, data: built.data }
    },
  })

  const venueTool = defineTool({
    name: 'ccf_venue',
    description:
      '查某个会议（CVPR / ICLR / NeurIPS / KDD…）的全部已知年份截稿、摘要截止、通知时间、会期地点与官网。想知道"这个会下一届什么时候截稿"时用它。',
    parameters: VENUE_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
          data: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.report ?? '') }],
    },
    async execute(args, exec) {
      const query = String(args?.venue ?? '').trim()
      if (!query) return { ok: false, report: '需要会议名，例如 venue: "CVPR"。', data: { ok: false, rows: [] } }
      const ensured = await ensureCache(args?.refresh === true, exec?.signal)
      const cache = ensured.cache
      if (!cache || cache.records.length === 0) {
        return { ok: false, report: `${cacheHint() || NO_DATA_HINT}\n\n同步结果：\n${ensured.report}`, data: { ok: false, rows: [] } }
      }
      const rows = queryVenue(viewRecords(cache), query)
      // 名单匹配要用「记录里的正式简称」而不是用户输入的别名：用户搜 NIPS，命中的是 NeurIPS，
      // 拿 NIPS 去查名单会查不到（CCF 名单里写的是 NeurIPS），于是把一个在名单里的会误标成名单外。
      const seriesName = rows[0]?.venue ?? query
      // findInCatalog 返回数组（简称完全相同 > 全称包含 > 简称包含），这里只要最靠前的那个。
      const named = findInCatalog(catalog, seriesName)
      const listed = named[0] ?? null
      // 名单里有简称相同的两个会（实测 FSE：软工 CCF-A 与安全 CCF-B）：说清数据属于哪一个，
      // 否则读者会以为「同一个会两个等级」。
      const sameAbbr = listed
        ? catalogConferences(catalog).filter((conference) => normalizeVenue(conference.abbr) === normalizeVenue(listed.abbr))
        : []
      let report
      if (rows.length > 0) {
        // 等级/方向是两套权威：记录来自 CCFDDL，名单来自 CCF。名单里没有这个会时要说清楚，
        // 否则读者会拿它跟「名单 362 个」对不上（ICLR 就是典型：数据里是 CCF-A，名单里没有）。
        report = formatVenue(rows, { timeZone: config.timezone })
        if (!listed) {
          report += `\n名单说明：这个会不在 CCF 名单（${catalogInfo.conferences} 个）里，上面的等级/方向来自 CCFDDL；按等级筛选与「待补」统计都不含它。`
        } else if (rows[0]?.rank && listed.rank && rows[0].rank !== listed.rank) {
          report += `\n名单说明：CCF 名单把它列为 ${listed.rank}（${listed.area}），上面显示的是 CCFDDL 的说法。`
        }
        if (sameAbbr.length > 1) {
          const owner = pickByFullName(rows[0], sameAbbr) ?? listed
          const others = sameAbbr
            .filter((conference) => conference !== owner)
            .map((conference) => `${conference.rank}（${conference.area}）${conference.fullName}`)
            .join('；')
          report += `\n名单说明：名单里有 ${sameAbbr.length} 个简称都是「${listed.abbr}」的会，数据里这条更接近 ${owner.rank}（${owner.area}）；另一个是 ${others}。`
        }
      } else if (listed) {
        report = `名单里有「${listed.abbr} · ${listed.fullName}」（${listed.rank} · ${listed.area}），但还没有截稿数据。\n用 /ccf update --focus ${listed.abbr} 让模型去它官网挖一次，或在面板「待补」视图里点「补这个会」。`
      } else {
        report = `既不在 CCF 名单（${catalogInfo.conferences} 个）里，数据里也没有 "${query}"。\n名单外的会收不进「待补」，也不会被按名单挖掘；CCFDDL 只收主要会议，小会/新会要等社区数据或直接看官网。`
      }
      // 卫星会（Workshop / 地区分会场）不计入主会统计，但读者查主会时常常想知道它什么时候截。
      const satellites = relatedSatellites(viewRecords(cache), seriesName)
      if (satellites.length > 0) {
        const described = satellites
          .slice(0, 3)
          .map((row) => {
            const when = Number.isFinite(row?.deadline) ? formatInZoneSafe(row.deadline, config.timezone) : ''
            return `${row?.name ?? row?.venue ?? '?'}${when ? `（截稿 ${when}）` : '（还没有截稿数据）'}`
          })
          .join('；')
        report += `\n卫星会：数据里另有 ${described}。它们不算进「${rows[0]?.venue ?? query}」的截稿与「待补」统计（Workshop / 地区分会场另算）。`
      }
      return {
        ok: rows.length > 0,
        report,
        data: {
          ok: rows.length > 0,
          count: rows.length,
          rows: rows.map((row) => ({
            year: row.year,
            rank: row.rank,
            area: row.area,
            deadline: Number.isFinite(row.deadline) ? new Date(row.deadline).toISOString() : null,
            // 工具说明里写了"摘要截止、通知时间"，data 里就得有——只有 report 有人类看得懂，
            // 模型只读 data 的话会以为这些字段不存在。
            abstractDeadline: Number.isFinite(row.abstractDeadline) ? new Date(row.abstractDeadline).toISOString() : null,
            notification: Number.isFinite(row.notification) ? new Date(row.notification).toISOString() : null,
            rebuttal: Number.isFinite(row.rebuttal) ? new Date(row.rebuttal).toISOString() : null,
            ...(row.conflict === true ? { conflict: true } : {}),
            link: row.link,
          })),
        },
      }
    },
  })

  // ---- 更新工具：模型搜官网 + 抽时间点（懒更新） --------------------------
  const updateTool = defineTool({
    name: 'ccf_update',
    description:
      '更新 CCF 会议数据：按 CCF 官方名单，用模型搜索会议官网并抽取截稿/摘要截止/审稿决定/rebuttal/会期/地点。懒更新——只补名单里还没有截稿时间的会，每轮默认最多 6 个。没有可用模型时回退到 ccfddl 数据并在 report 里注明来源与致谢。回答"某会议今年什么时候截稿但本地查不到"时用它。',
    parameters: UPDATE_PARAMETERS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
          data: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.report ?? '') }],
    },
    async execute(args, exec) {
      const result = await doUpdate({
        limit: Number.isFinite(args?.limit) ? Number(args.limit) : undefined,
        force: args?.force === true,
        focus: args?.focus ? String(args.focus) : null,
        area: args?.area ? String(args.area) : null,
        scope: args?.scope === 'past' || args?.scope === 'never' ? args.scope : null,
        signal: exec?.signal,
      })
      return {
        ok: result.ok !== false,
        report: result.note,
        data: {
          ok: result.ok !== false,
          model: result.model === true,
          fallback: result.fallback === true,
          pending: result.pending ?? null,
          mined: result.mined ?? [],
          failed: result.failed ?? [],
          byArea: result.byArea ?? [],
          attribution: result.attribution ?? '',
        },
      }
    },
  })

  // ---- 2. 人用命令 -------------------------------------------------------
  const command = {
    name: 'ccf',
    description:
      'CCF 会议截稿：按名单用模型更新数据（可 --area 按方向补）、查最近截稿、查单个会议。用法：/ccf update [--limit 6] [--force] [--focus CV] [--area 人工智能] | /ccf sync | /ccf list [天数] [--rank CCF-A] [--area CV] [--search neur] | /ccf venue CVPR | /ccf status | /ccf config',
    input: { hint: 'update [--limit n] [--force] [--focus X] [--area 人工智能] | prefer <名字> [来源] | sync | list [days] [--rank CCF-A] [--area CV] | venue <name> | prefer | ignore | status | config' },
    recordInput: false,
    async handler(invocation) {
      const raw = String(invocation?.rawInput ?? '').trim()
      if (raw === '' || raw === 'help' || raw === '--help' || raw === '-h') {
        return { kind: 'success', text: `${USAGE}\n\n当前版本 ${VERSION}` }
      }
      const [rawSub, ...rest] = raw.split(/\s+/).filter(Boolean)
      // USAGE 里一直写着 /ccf pending，但之前没实现：它等价于 list --pending
      const sub = rawSub === 'pending' ? 'list' : rawSub
      if (rawSub === 'pending') rest.push('--pending')

      if (sub === 'ignore') {
        const undoTokens = rest.filter((token) => token === '--undo' || token === '-u')
        const nameQuery = rest.filter((token) => !token.startsWith('--') && token !== '-u').join(' ').trim()
        if (!nameQuery) {
          return { kind: 'error', text: '用法：/ccf ignore <会议名或 key> [--undo]\n    例：/ccf ignore SEC    /ccf ignore "sec|2026" --undo' }
        }
        const result = await doIgnore({ key: nameQuery, undo: undoTokens.length > 0 })
        return { kind: result.ok ? 'success' : 'error', text: result.note }
      }

      if (sub === 'confirm') {
        const undoTokens = rest.filter((token) => token === '--undo' || token === '-u')
        const nameQuery = rest.filter((token) => !token.startsWith('--') && token !== '-u').join(' ').trim()
        if (!nameQuery) {
          return { kind: 'error', text: '用法：/ccf confirm <会议名或 key> [--undo]' }
        }
        const result = await doConfirm({ key: nameQuery, undo: undoTokens.length > 0 })
        return { kind: result.ok ? 'success' : 'error', text: result.note }
      }

      if (sub === 'marks') {
        const cache = currentCache(false)
        const meta = cache?.meta && typeof cache.meta === 'object' ? cache.meta : {}
        const ignored = Array.isArray(meta.ignoredKeys) ? meta.ignoredKeys : []
        const confirmed = Array.isArray(meta.confirmedKeys) ? meta.confirmedKeys : []
        const nameOf = (key) => {
          const record = (cache?.records ?? []).find((row) => row?.key === key)
          if (!record) return key
          const label = record.venue || record.name || key
          return record.year ? `${label} ${record.year}` : String(label)
        }
        const onlyIgnored = rest.includes('--ignored')
        const onlyConfirmed = rest.includes('--confirmed')
        if (ignored.length === 0 && confirmed.length === 0) {
          return { kind: 'success', text: '还没有任何标记。面板上「建议核对」的卡片展开后可以选「就是这个会」/「不是这个会」，命令是 /ccf confirm <名字> 与 /ccf ignore <名字>。' }
        }
        const lines = [`标记：${ignored.length} 个「不是这个会」，${confirmed.length} 个「就是这个会」`]
        if (ignored.length > 0 && !onlyConfirmed) {
          lines.push('', '不是这个会（撤销：/ccf ignore <名字> --undo）：')
          for (const key of ignored) lines.push(`  - ${nameOf(key)}`)
        }
        if (confirmed.length > 0 && !onlyIgnored) {
          lines.push('', '就是这个会（撤销：/ccf confirm <名字> --undo）：')
          for (const key of confirmed) lines.push(`  - ${nameOf(key)}`)
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      if (sub === 'sync') {
        const result = await doSync(invocation?.signal)
        return { kind: result.ok ? 'success' : 'error', text: result.report }
      }

      if (sub === 'update') {
        const flags = parseFlags(rest)
        const focusIndex = rest.findIndex((token) => token === '--focus')
        const focus = focusIndex >= 0 && rest[focusIndex + 1] ? rest[focusIndex + 1] : null
        const areaIndex = rest.findIndex((token) => token === '--area')
        const area = areaIndex >= 0 && rest[areaIndex + 1] ? rest[areaIndex + 1] : null
        const scopeIndex = rest.findIndex((token) => token === '--scope')
        const scopeRaw = scopeIndex >= 0 && rest[scopeIndex + 1] ? String(rest[scopeIndex + 1]).toLowerCase() : null
        const scope = scopeRaw === 'past' || scopeRaw === 'never' ? scopeRaw : null
        if (scopeRaw && scope === null) return { kind: 'error', text: `--scope 只接受 past 或 never（收到 "${scopeRaw}"）。` }
        const result = await doUpdate({
          limit: Number.isFinite(flags.limit) ? flags.limit : undefined,
          force: rest.includes('--force'),
          focus,
          area,
          scope,
          signal: invocation?.signal,
        })
        return { kind: result.ok === false ? 'error' : 'success', text: result.note }
      }

      if (sub === 'status') {
        const cache = currentCache(false)
        const status = cacheStatus()
        const dirProblem = dataDirProblem()
        if (!cache || cache.records.length === 0) {
          // 缓存坏了 ≠ 还没有数据：磁盘上那份文件还在，用户需要知道该修还是该重建。
          // 目录本身指错了，先说这个：不然会误诊成"缓存 JSON 坏了"
          if (dirProblem) return { kind: 'error', text: `版本：dsh-ccf v${VERSION}\n${dirProblem}` }
          if (status.state === 'corrupt') {
            return { kind: 'error', text: `版本：dsh-ccf v${VERSION}\n缓存文件读不出来：${status.error}\n文件：${status.path}\n原文件没有被动过，可以先备份再跑 /ccf sync 重建（重建会覆盖它），或手动修好 JSON 后 /ccf status 再看。` }
          }
          if (status.state === 'unreadable') {
            return { kind: 'error', text: `版本：dsh-ccf v${VERSION}\n缓存文件打不开：${status.error}\n文件：${status.path}\n检查一下数据目录的权限，或把配置里的 dataDir 指到别处。` }
          }
          return { kind: 'success', text: `版本：dsh-ccf v${VERSION}\n还没有缓存。\n数据目录：${dataDir}\n名单：${catalogLine()}\n先跑 /ccf sync（几秒，走 CCFDDL 接口）或 /ccf update（有模型时补得更全）。` }
        }
        const now = Date.now()
        const updatedAt = toInstant(cache.updatedAt)
  const age = updatedAt === null ? '未知' : countdownText(now - updatedAt)
        const soon = queryDeadlines(viewRecords(cache), { now, windowDays: 14, limit: 5 })
        const meta = cache.meta && typeof cache.meta === 'object' ? cache.meta : {}
        const ignoredCount = Array.isArray(meta.ignoredKeys) ? meta.ignoredKeys.length : 0
        const confirmedCount = Array.isArray(meta.confirmedKeys) ? meta.confirmedKeys.length : 0
        const minedCount = cache.records.filter((record) => record.source === 'model').length
        const preferredCount = cache.records.filter((record) => typeof record.preferredSource === 'string' && record.preferredSource).length
        // 覆盖度跟面板/工具走同一个函数：`meta.pending` 是上一轮挖掘留下的旧数字，
        // 拿它跟面板的 250 并排会互相打脸（曾出现 status 说 56、面板说 250）。
        const cov = catalog ? catalogCoverage(cache.records, catalog, { now, ...marksOf(cache) }) : null
        const pendingLine = cov
          ? `覆盖：${cov.counts.future} 个有未来截稿，${cov.counts.pending} 个待补（其中 ${cov.counts.past} 个只有往届日期、${cov.counts.never} 个从未抓到；名单共 ${cov.counts.total} 个会${cov.counts.outside > 0 ? `；另有 ${cov.counts.outsideVenues ?? cov.counts.outside} 个名单外的会（${cov.counts.outside} 条记录）` : ''}）`
          : `待补：${Number.isFinite(meta.pending) ? meta.pending : '未知'} 个会还没有截稿时间`
        // 来源冲突：与面板同一个口径（默认视图里看得见的那几条），不数被否掉的和卫星会
        const hiddenForConflicts = new Set([
          ...marksOf(cache).ignoredKeys,
          ...(cov?.satellites ?? []).map((row) => row?.key).filter(Boolean),
        ])
        const conflictRows = cache.records.filter((record) => isBigConflict(record) && !hiddenForConflicts.has(record?.key))
        const decidedRows = conflictRows.filter((record) => typeof record?.preferredSource === 'string' && record.preferredSource)
        // 同一个会两个系列名（S&P / IEEE S&P）在缓存里是两条，列表只显示一条：
        // 数字对不上时得说清"这 404 条里有 1 条是同一个会"，否则用户以为丢数据了。
        const dedupedCount = dedupeVenueYear(cache.records).length
        const mergedCount = cache.records.length - dedupedCount
        const lines = [
          `版本：dsh-ccf v${VERSION}`,
          `数据：${cache.records.length} 条会议（其中模型挖掘 ${minedCount} 条），数据时间 ${updatedAt === null ? '未知' : formatInZone(updatedAt, config.timezone)}（${age}${updatedAt === null ? '' : '前'}）`,
          ...(mergedCount > 0
            ? [`去重：${mergedCount} 条记录与另一条指同一个会的同一年（如 S&P / IEEE S&P），列表按 ${dedupedCount} 个会显示`]
            : []),
          `缓存：${cachePathOf(dataDir)}`,
          `名单：${catalogLine()}`,
          pendingLine,
          ...(cov && cov.counts.satellites > 0
            ? [`卫星会：${cov.counts.satelliteVenues ?? cov.counts.satellites} 个 Workshop / 地区分会场（共 ${cov.counts.satellites} 条记录；CCFDDL 收了、名单里只有主会），它们不计入任何会的截稿。`]
            : []),
          ...(cov && cov.counts.weakMatches > 0
            ? [`待核对：${cov.counts.weakMatches} 条记录的全称与名单对不上（同简称可能是两个不同的会，如 SEC / FSE），面板上这些卡片会标「建议核对」。`]
            : []),
          ...(ignoredCount + confirmedCount > 0
            ? [`标记：${ignoredCount} 个「不是这个会」、${confirmedCount} 个「就是这个会」（清单 /ccf marks）`]
            : []),
          ...(conflictRows.length > 0
            ? [`来源：${conflictRows.length} 条两个源给的截稿差一天以上${decidedRows.length > 0 ? `（其中 ${decidedRows.length} 条你已经采信了某个来源）` : ''}（/ccf list --conflicts 只看这些，/ccf prefer <来源> --conflicts 可一次采信；日期不是唯一说法，别当定论转述）`]
            : []),
          `采信：${preferredCount} 个会按你选的来源显示（默认显示首选来源）`,
          `模型：${isModelAvailable(ctx) ? '可用' : '不可用（只能回退到 ccfddl）'}`,
          `窗口：默认 ${config.windowDays} 天，prompt 注入 ${config.leadDays} 天`,
          '面板：桌面端右侧「📅 会议」标签（点开即列表；没显示就重启一次 DSH）',
        ]
        if (Array.isArray(cache.reports) && cache.reports.length > 0) {
          lines.push('上次同步：')
          for (const report of cache.reports) {
            lines.push(report.ok ? `  - ${report.id}：${report.count} 条` : `  - ${report.id}：失败 —— ${report.error}`)
          }
          // 两个源各报各的条数，加起来不等于缓存条数（同一个会以 ccfddl 为主，另一源进 alternatives）。
          // 不说清的话 379 + 71 = 450 对不上 404，看着像数据丢了。
          const reportedTotal = cache.reports.reduce((sum, report) => sum + (report.ok && Number.isFinite(report.count) ? report.count : 0), 0)
          if (cache.reports.length > 1 && reportedTotal > 0 && reportedTotal !== cache.records.length) {
            lines.push(`  （两个源各报各的条数，合并后缓存里是 ${cache.records.length} 条：同一个会以首选来源为主，另一源的日期进「来源冲突」的比较）`)
          }
        }
        lines.push(soon.length > 0 ? `14 天内 ${soon.length} 个截稿（见 /ccf list 14）` : '14 天内没有截稿')
        return { kind: 'success', text: lines.join('\n') }
      }

      if (sub === 'config') {
        const lines = [
          'dsh-ccf 生效配置',
          `  数据目录：${dataDir}${dataDirProblem() ? `（有问题：${dataDirProblem()}）` : ''}`,
          `  默认窗口：${config.windowDays} 天`,
          `  prompt 注入窗口：${config.leadDays} 天（最多 ${config.maxPromptItems} 条）`,
          `  时区：${config.timezone}`,
          `  默认等级：${config.ranks ? config.ranks.join('/') : '全部'}`,
          `  默认方向：${config.areas ? config.areas.join('/') : '全部'}`,
          `  超时：${Math.round(config.timeoutMs / 1000)}s`,
          `  名单文件：${catalogInfo.state === 'ok' ? `${catalogInfo.conferences} 个会议 / ${catalogInfo.areas} 个方向` : catalogLine()}`,
          `  懒更新：每轮最多 ${config.maxVenuesPerRun} 个会，${config.refreshDays} 天后算过期`,
          `  自动更新：${config.autoUpdate === false ? '关闭' : `每 ${config.autoUpdateDays} 天`}`,
          '数据源（按顺序；第一个取不到才用下一个）：',
        ]
        // 这里原来写死了 paper-deadlines 的旧默认值，跟 sync 实际用的 DEFAULT_SOURCES 不一致，
        // 结果 /ccf config 里看不到真正的第一数据源（CCFDDL 接口）。
        const sources = config.sources ?? DEFAULT_SOURCES
        for (const source of sources) {
          lines.push(`  - ${source.id ?? '?'}  ${source.type ?? 'json'}  ${source.url ?? source.dir ?? ''}`)
        }
        lines.push('改配置：在 profile 的 cordis.patch.yml 里给 ccf 插件加 config。')
        return { kind: 'success', text: lines.join('\n') }
      }

      if (sub === 'venue') {
        const query = rest.filter((token) => !token.startsWith('--')).join(' ').trim()
        const ensured = await ensureCache(rest.includes('--refresh'), invocation?.signal)
        const cache = ensured.cache
        if (!cache || cache.records.length === 0) {
          return { kind: 'error', text: `${cacheHint() || NO_DATA_HINT}\n\n${ensured.report}` }
        }
        const rows = queryVenue(viewRecords(cache), query)
        let text = formatVenue(rows, { timeZone: config.timezone })
        const satellites = relatedSatellites(viewRecords(cache), rows[0]?.venue ?? query)
        if (satellites.length > 0) {
          const described = satellites
            .slice(0, 3)
            .map((row) => {
              const when = Number.isFinite(row?.deadline) ? formatInZoneSafe(row.deadline, config.timezone) : ''
              return `${row?.name ?? row?.venue ?? '?'}${when ? `（截稿 ${when}）` : ''}`
            })
            .join('；')
          text += `\n卫星会：数据里另有 ${described}（不计入主会统计）。`
        }
        return { kind: 'success', text }
      }

      if (sub === 'list') {
        const flags = parseFlags(rest)
        const ensured = await ensureCache(flags.refresh, invocation?.signal)
        const cache = ensured.cache ?? { records: [] }
        if (!flags.pending && (!cache || cache.records.length === 0)) {
          return { kind: 'error', text: `${cacheHint() || NO_DATA_HINT}\n\n${ensured.report}` }
        }
        const args = {
          days: flags.days,
          rank: flags.rank,
          area: flags.area,
          search: flags.search,
          limit: flags.limit,
          includePast: flags.includePast,
          includeSatellites: flags.satellites,
          conflictsOnly: flags.conflicts,
          pending: flags.pending,
        }
        const built = buildList(cache, args)
        const staleNote = cache.updatedAt
          ? `数据同步于 ${formatInZone(cache.updatedAt, config.timezone)}（${countdownText(Date.now() - (toInstant(cache.updatedAt) ?? Date.now()))}前）`
          : '数据同步时间未知'
        return { kind: 'success', text: `${built.report}\n\n${staleNote}${ensured.report ? ` · ${ensured.report.split('\n')[0]}` : ''}` }
      }

      if (sub === 'prefer') {
        const ensured = await ensureCache(false, invocation?.signal)
        const cache = ensured.cache
        if (!cache || cache.records.length === 0) {
          return { kind: 'error', text: `${NO_DATA_HINT}先跑 /ccf sync，再决定采信哪个来源。` }
        }
        const tokens = rest.filter((token) => !token.startsWith('--'))
        const reset = rest.includes('--reset')
        const bulk = rest.includes('--conflicts')
        const undo = rest.includes('--undo')
        const source = tokens.length > 1 ? tokens[tokens.length - 1] : ''
        const query = (tokens.length > 1 ? tokens.slice(0, -1) : tokens).join(' ').trim()
        if (bulk) {
          // 26 条来源冲突一条条点太碎：一次把「这批会都采信 X」做完
          const bulkSource = tokens.length >= 1 ? tokens[tokens.length - 1] : ''
          if (!bulkSource) return { kind: 'error', text: '用法：/ccf prefer <来源> --conflicts（把这些冲突的会统一采信这个来源）；撤销用 /ccf prefer <来源> --conflicts --undo。' }
          const result = await doPreferConflicts({ source: bulkSource, undo })
          if (result.ok !== true) return { kind: 'error', text: result.note }
          if (undo) {
            return { kind: 'success', text: `已撤销 ${result.changed} 个会对 ${result.source} 的采信，它们回到默认来源。还有 ${result.conflicts} 条来源冲突没处理（/ccf list --conflicts 看）。` }
          }
          const skipped = result.skipped > 0 ? `\n另有 ${result.skipped} 个会里 ${result.source} 没有给出日期，跳过（它们仍是冲突状态）。` : ''
          return { kind: 'success', text: `已把 ${result.changed} 个会统一采信 ${result.source}（共 ${result.conflicts} 条来源冲突）。${skipped}\n想撤回：/ccf prefer ${result.source} --conflicts --undo；想只改一个：/ccf prefer <会议名> <来源>。` }
        }
        if (!query) return { kind: 'error', text: '用法：/ccf prefer <会议名> [来源]。不带来源=看当前采信；--reset=恢复默认。' }
        const hits = queryVenue(cache.records, query)
        if (hits.length === 0) return { kind: 'error', text: `数据里没有 "${query}"。` }
        const head = hits[0]
        const alternatives = Array.isArray(head.alternatives) ? head.alternatives : []
        if (source || reset) {
          const result = await doPrefer({ key: head.key, source: reset ? '' : source })
          if (result.ok !== true) return { kind: 'error', text: result.note }
          // 改完重新读一次派生视图，回复里说的是改完之后的样子。
          const fresh = currentCache(true)
          const after = queryVenue(viewRecords(fresh), query)[0] ?? head
          const state = after.preferredSource ? `你采信的 ${after.preferredSource}` : `首选来源 ${after.source}`
          const remembered = result.remembered
            ? `\n已记到这个会（${result.venue}）的系列上：明年新一届自动沿用，不用再点。恢复默认也会一并清掉这条记忆。`
            : ''
          return { kind: 'success', text: `${after.name ?? after.venue}（${after.key}）现在按 ${state} 显示，截稿 ${after.deadline ? formatInZone(after.deadline, config.timezone) : '未知'}。${remembered}` }
        }
        const said = alternatives.map((item) => `${item.source} ${item.deadline ? formatInZone(item.deadline, config.timezone) : '（无日期）'}`)
        if (said.length === 0) {
          return { kind: 'success', text: `${head.name ?? head.venue} 只有一个来源（${head.source ?? '未知'}），没有可选的另一种说法。` }
        }
        return {
          kind: 'success',
          text: `${head.name ?? head.venue}（${head.key}）当前按 ${head.preferredSource ? `你采信的 ${head.preferredSource}` : `首选来源 ${head.source}`} 显示，截稿 ${head.deadline ? formatInZone(head.deadline, config.timezone) : '未知'}。\n另一种说法：${said.join(' / ')}\n要改：/ccf prefer ${head.venue ?? query} <来源>；要恢复：/ccf prefer ${head.venue ?? query} --reset。`,
        }
      }

      return { kind: 'error', text: `未知子命令 "${sub}"。\n\n${USAGE}` }
    },
  }

  // ---- 3. system-prompt 摘要（动态：每次装配重新读缓存） -------------------
  if (config.prompt !== false) {
    acquire('systemPrompt', (registry) => {
      registry.section({
        name: 'dsh-ccf',
        order: POLICY_ORDER,
        text: () => {
          const cache = currentCache(false)
          const body = promptText(promptCacheOf(cache), {
            leadDays: config.leadDays,
            maxPromptItems: config.maxPromptItems,
            promptSoonDays: config.promptSoonDays,
            timeZone: config.timezone,
            staleHours: config.staleHours,
          })
          const note = updateNote(cache)
          return [body, note].filter(Boolean).join('\n\n')
        },
      })
    })
  }

  acquire('tools', (registry) => {
    registry.register(deadlinesTool)
    registry.register(venueTool)
    registry.register(updateTool)
  })
  acquire('commands', (registry) => registry.register(command))

  // ---- 4. 桌面端侧边栏：给客户端一条读缓存的 HTTP 路由 --------------------
  const routeDisposers = []
  acquire('webServer', (server) => {
    try {
      for (const route of createUiRoutes({ currentCache, cacheStatus, doSync, runUpdate: doUpdate, prefer: doPrefer, ignore: doIgnore, confirm: doConfirm, config, dataDir, catalog, catalogInfo, version: VERSION, modelReady: isModelAvailable(ctx), progress })) {
        const dispose = server.register(route)
        if (typeof dispose === 'function') routeDisposers.push(dispose)
      }
      logger?.info?.(`dsh-ccf: 面板路由已注册（${ROUTE_PREFIX}/records）`)
    } catch (error) {
      logger?.warn?.(`dsh-ccf: 面板路由注册失败 —— ${String(error?.message ?? error)}`)
    }
  })

  // ---- 5. 每周自动更新（懒：只补缺数据的会，要有模型才跑） -----------------
  const AUTO_TICK_MS = 30 * 60 * 1000
  let autoTimer = null
  async function autoUpdate() {
    try {
      if (!isModelAvailable(ctx)) return
      const cache = currentCache(false)
      const last = Number(cache?.meta?.lastAutoUpdateAt ?? 0)
      if (Number.isFinite(last) && Date.now() - last < config.autoUpdateDays * 24 * 60 * 60 * 1000) return
      logger?.info?.('dsh-ccf: 每周自动更新开始')
      const result = await doUpdate({ limit: config.maxVenuesPerRun, force: false })
      const latest = await loadCache(dataDir)
      if (latest && typeof latest === 'object') {
        latest.meta = { ...(latest.meta && typeof latest.meta === 'object' ? latest.meta : {}), lastAutoUpdateAt: Date.now(), lastAutoUpdateNote: result.note }
        await saveCache(dataDir, latest)
        currentCache(true)
      }
      logger?.info?.(`dsh-ccf: 每周自动更新完成 —— ${String(result.note ?? '').split('\n')[0]}`)
    } catch (error) {
      logger?.warn?.(`dsh-ccf: 每周自动更新失败 —— ${String(error?.message ?? error)}`)
    }
  }
  if (config.autoUpdate !== false) {
    autoTimer = setInterval(() => {
      void autoUpdate()
    }, AUTO_TICK_MS)
    autoTimer.unref?.()
  }

  if (typeof ctx?.on === 'function') {
    ctx.on('dispose', () => {
      if (autoTimer) clearInterval(autoTimer)
      for (const dispose of routeDisposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* 已释放 */
        }
      }
    })
  }

  logger?.info?.(`dsh-ccf: ready (dataDir=${dataDir}, window=${config.windowDays}d, prompt=${config.prompt !== false}, catalog=${catalogInfo.conferences})`)

  return { config, dataDir, tool: deadlinesTool, venueTool, updateTool, command, currentCache, doSync, doUpdate, doPrefer, preferConflicts: doPreferConflicts, doIgnore, doConfirm, progress, catalog, catalogInfo, planUpdate: (options = {}) => planUpdate({ catalog, records: currentCache(false)?.records ?? [], refreshDays: config.refreshDays, limit: config.maxVenuesPerRun, ...options }) }
}

/** 解析 `/ccf list` 的旗标：天数位置参数 + `--rank/--area/--search/--limit/--past/--pending/--refresh`。 */
export function parseFlags(tokens) {
  const flags = { days: null, rank: null, area: null, search: null, limit: null, includePast: false, pending: false, satellites: false, conflicts: false, refresh: false }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) {
      const number = Number(token)
      if (Number.isFinite(number) && number > 0 && flags.days === null) flags.days = number
      continue
    }
    const name = token.slice(2)
    const value = tokens[index + 1] && !tokens[index + 1].startsWith('--') ? tokens[index + 1] : null
    if (name === 'rank' && value) {
      flags.rank = value
      index += 1
    } else if (name === 'area' && value) {
      flags.area = value
      index += 1
    } else if (name === 'search' && value) {
      flags.search = value
      index += 1
    } else if (name === 'limit' && value) {
      flags.limit = Number(value)
      index += 1
    } else if (name === 'past') {
      flags.includePast = true
    } else if (name === 'satellites') {
      flags.satellites = true
    } else if (name === 'conflicts') {
      flags.conflicts = true
    } else if (name === 'pending') {
      flags.pending = true
    } else if (name === 'refresh') {
      flags.refresh = true
    }
  }
  return flags
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = { ...DEFAULTS, ...source }
  for (const key of ['windowDays', 'leadDays', 'maxPromptItems', 'timeoutMs', 'staleHours', 'refreshDays', 'maxVenuesPerRun', 'autoUpdateDays']) {
    const value = Number(config[key])
    config[key] = Number.isFinite(value) && value > 0 ? value : DEFAULTS[key]
  }
  config.maxPromptItems = Math.floor(config.maxPromptItems)
  config.refreshDays = Math.floor(config.refreshDays)
  config.maxVenuesPerRun = Math.floor(config.maxVenuesPerRun)
  config.ranks = Array.isArray(config.ranks) && config.ranks.length > 0 ? config.ranks.map(String) : null
  config.areas = Array.isArray(config.areas) && config.areas.length > 0 ? config.areas.map(String) : null
  if (!Array.isArray(config.sources) || config.sources.length === 0) config.sources = null
  if (typeof config.timezone !== 'string' || !config.timezone.trim()) config.timezone = systemTimeZone(DEFAULTS.timezone)
  return config
}
