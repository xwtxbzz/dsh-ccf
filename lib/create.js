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
import { join, resolve } from 'node:path'

import {
  DEFAULTS,
  countdownText,
  formatInZone,
  formatList,
  formatVenue,
  promptText,
  queryDeadlines,
  queryVenue,
} from './core.js'
import { cachePathOf, defaultDataDir, loadCache, syncSources } from './sync.js'

/** system-prompt 段位：100–199 为工具引导。 */
export const POLICY_ORDER = 150

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

  // ---- system-prompt 需要一个同步读取的缓存视图 --------------------------
  let cacheView = { path: cachePathOf(dataDir), mtimeMs: -1, value: null }
  const currentCache = (force = false) => {
    const path = cachePathOf(dataDir)
    try {
      const stat = statSync(path)
      if (!force && stat.mtimeMs === cacheView.mtimeMs && cacheView.path === path) return cacheView.value
      const value = JSON.parse(readFileSync(path, 'utf8'))
      const normalized = value && Array.isArray(value.records) ? value : null
      cacheView = { path, mtimeMs: stat.mtimeMs, value: normalized }
      return normalized
    } catch {
      cacheView = { path, mtimeMs: -1, value: null }
      return null
    }
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

  const ensureCache = async (refresh, signal) => {
    if (refresh) return doSync(signal)
    const existing = currentCache(false)
    if (existing && existing.records.length > 0) return { cache: existing, report: '', ok: true }
    return doSync(signal)
  }

  const buildList = (cache, args, extra = {}) => {
    const now = extra.now ?? Date.now()
    const windowDays = Number.isFinite(args?.days) && args.days > 0 ? Number(args.days) : config.windowDays
    const rows = queryDeadlines(cache.records, {
      now,
      windowDays,
      ranks: asArray(args?.rank, (value) => value.toUpperCase()),
      areas: asArray(args?.area, (value) => value),
      search: args?.search ?? null,
      limit: Number.isFinite(args?.limit) ? Number(args.limit) : null,
      includePast: args?.includePast === true,
    })
    const report = formatList(rows, { now, windowDays, timeZone: config.timezone })
    return {
      report,
      data: {
        ok: true,
        count: rows.length,
        windowDays,
        updatedAt: cache.updatedAt ?? null,
        rows: rows.map((row) => ({
          venue: row.venue,
          year: row.year,
          name: row.name,
          rank: row.rank,
          area: row.area,
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
        return { ok: false, report: `${NO_DATA_HINT}\n\n同步结果：\n${ensured.report}`, data: { ok: false, rows: [] } }
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
        return { ok: false, report: `${NO_DATA_HINT}\n\n同步结果：\n${ensured.report}`, data: { ok: false, rows: [] } }
      }
      const rows = queryVenue(cache.records, query)
      const report = rows.length === 0
        ? `数据里没有 "${query}"。先 /ccf list 看看有什么，或 /ccf sync 更新数据。`
        : formatVenue(rows, { timeZone: config.timezone })
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
            notification: Number.isFinite(row.notification) ? new Date(row.notification).toISOString() : null,
            link: row.link,
          })),
        },
      }
    },
  })

  // ---- 2. 人用命令 -------------------------------------------------------
  const command = {
    name: 'ccf',
    description:
      'CCF 会议截稿：同步数据、查最近截稿、查单个会议。用法：/ccf sync | /ccf list [天数] [--rank CCF-A] [--area CV] [--search neur] | /ccf venue CVPR | /ccf status | /ccf config',
    input: { hint: 'sync | list [days] [--rank CCF-A] [--area CV] | venue <name> | status | config' },
    recordInput: false,
    async handler(invocation) {
      const raw = String(invocation?.rawInput ?? '').trim()
      const [sub = 'list', ...rest] = raw.split(/\s+/).filter(Boolean)

      if (sub === 'sync') {
        const result = await doSync(invocation?.signal)
        return { kind: result.ok ? 'success' : 'error', text: result.report }
      }

      if (sub === 'status') {
        const cache = currentCache(false)
        if (!cache || cache.records.length === 0) {
          return { kind: 'success', text: `还没有缓存。\n数据目录：${dataDir}\n先跑 /ccf sync。` }
        }
        const now = Date.now()
        const age = cache.updatedAt ? countdownText(now - cache.updatedAt) : '未知'
        const soon = queryDeadlines(cache.records, { now, windowDays: 14, limit: 5 })
        const lines = [
          `数据：${cache.records.length} 条会议，同步于 ${cache.updatedAt ? formatInZone(cache.updatedAt, config.timezone) : '未知'}（${age}${cache.updatedAt ? '前' : ''}）`,
          `缓存：${cachePathOf(dataDir)}`,
          `窗口：默认 ${config.windowDays} 天，prompt 注入 ${config.leadDays} 天`,
        ]
        if (Array.isArray(cache.reports) && cache.reports.length > 0) {
          lines.push('上次同步：')
          for (const report of cache.reports) {
            lines.push(report.ok ? `  - ${report.id}：${report.count} 条` : `  - ${report.id}：失败 —— ${report.error}`)
          }
        }
        lines.push(soon.length > 0 ? `14 天内 ${soon.length} 个截稿（见 /ccf list 14）` : '14 天内没有截稿')
        return { kind: 'success', text: lines.join('\n') }
      }

      if (sub === 'config') {
        const lines = [
          'dsh-ccf 生效配置',
          `  数据目录：${dataDir}`,
          `  默认窗口：${config.windowDays} 天`,
          `  prompt 注入窗口：${config.leadDays} 天（最多 ${config.maxPromptItems} 条）`,
          `  时区：${config.timezone}`,
          `  默认等级：${config.ranks ? config.ranks.join('/') : '全部'}`,
          `  默认方向：${config.areas ? config.areas.join('/') : '全部'}`,
          `  超时：${Math.round(config.timeoutMs / 1000)}s`,
          '数据源（按顺序，先到先用）：',
        ]
        const sources = config.sources ?? [{ id: 'paper-deadlines', type: 'json', url: 'https://yzyhhhstudy.github.io/paper-deadlines/data.json' }]
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
          return { kind: 'error', text: `${NO_DATA_HINT}\n\n${ensured.report}` }
        }
        const rows = queryVenue(cache.records, query)
        return { kind: 'success', text: formatVenue(rows, { timeZone: config.timezone }) }
      }

      if (sub === 'list') {
        const flags = parseFlags(rest)
        const ensured = await ensureCache(flags.refresh, invocation?.signal)
        const cache = ensured.cache
        if (!cache || cache.records.length === 0) {
          return { kind: 'error', text: `${NO_DATA_HINT}\n\n${ensured.report}` }
        }
        const args = {
          days: flags.days,
          rank: flags.rank,
          area: flags.area,
          search: flags.search,
          limit: flags.limit,
          includePast: flags.includePast,
        }
        const built = buildList(cache, args)
        const staleNote = cache.updatedAt
          ? `数据同步于 ${formatInZone(cache.updatedAt, config.timezone)}（${countdownText(Date.now() - cache.updatedAt)}前）`
          : '数据同步时间未知'
        return { kind: 'success', text: `${built.report}\n\n${staleNote}${ensured.report ? ` · ${ensured.report.split('\n')[0]}` : ''}` }
      }

      return { kind: 'error', text: `未知子命令 "${sub}" —— 用 sync | list [days] [--rank CCF-A] [--area CV] | venue <name> | status | config` }
    },
  }

  // ---- 3. system-prompt 摘要（动态：每次装配重新读缓存） -------------------
  if (config.prompt !== false) {
    acquire('systemPrompt', (registry) => {
      registry.section({
        name: 'dsh-ccf',
        order: POLICY_ORDER,
        text: () => promptText(currentCache(false), {
          leadDays: config.leadDays,
          maxPromptItems: config.maxPromptItems,
          timeZone: config.timezone,
          staleHours: config.staleHours,
        }),
      })
    })
  }

  acquire('tools', (registry) => {
    registry.register(deadlinesTool)
    registry.register(venueTool)
  })
  acquire('commands', (registry) => registry.register(command))

  logger?.info?.(`dsh-ccf: ready (dataDir=${dataDir}, window=${config.windowDays}d, prompt=${config.prompt !== false})`)

  return { config, dataDir, tool: deadlinesTool, venueTool, command, currentCache, doSync }
}

/** 解析 `/ccf list` 的旗标：天数位置参数 + `--rank/--area/--search/--limit/--past/--refresh`。 */
export function parseFlags(tokens) {
  const flags = { days: null, rank: null, area: null, search: null, limit: null, includePast: false, refresh: false }
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
    } else if (name === 'refresh') {
      flags.refresh = true
    }
  }
  return flags
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = { ...DEFAULTS, ...source }
  for (const key of ['windowDays', 'leadDays', 'maxPromptItems', 'timeoutMs', 'staleHours']) {
    const value = Number(config[key])
    config[key] = Number.isFinite(value) && value > 0 ? value : DEFAULTS[key]
  }
  config.maxPromptItems = Math.floor(config.maxPromptItems)
  config.ranks = Array.isArray(config.ranks) && config.ranks.length > 0 ? config.ranks.map(String) : null
  config.areas = Array.isArray(config.areas) && config.areas.length > 0 ? config.areas.map(String) : null
  if (!Array.isArray(config.sources) || config.sources.length === 0) config.sources = null
  if (typeof config.timezone !== 'string' || !config.timezone.trim()) config.timezone = DEFAULTS.timezone
  return config
}
