/**
 * dsh-ccf · 同步层
 *
 * 把上游数据抓下来、归一化、合并、写本地缓存。支持三种源：
 *   - json：一次请求拿到全量 JSON（默认，paper-deadlines 的 data.json）
 *   - ccfddl-dir：本地已 clone 的 ccfddl 仓库的 conferences/ 目录（离线可用）
 *   - ccfddl-tar：ccfddl 的 GitHub 归档包（一次请求，内部自行解 tar.gz）
 *
 * 缓存是纯 JSON，放 dataDir（默认 ~/.dsh/ccf），刷新失败时保留旧数据并如实标注。
 */
import { createGunzip } from 'node:zlib'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  DEFAULTS,
  DEFAULT_SOURCES,
  dedupeRecords,
  normalizeCcfddlVenue,
  normalizeJsonRecord,
} from './core.js'
import { parseYaml } from './yaml.js'

export const CACHE_FILE = 'cache.json'
export const CACHE_SCHEMA = 'dsh-ccf/cache/v1'

/** 默认缓存目录。 */
export function defaultDataDir() {
  return join(homedir(), '.dsh', 'ccf')
}

export function cachePathOf(dataDir) {
  return join(resolve(String(dataDir || defaultDataDir())), CACHE_FILE)
}

/** 读缓存；不存在或损坏都返回 null（调用方据此提示先 sync）。 */
export async function loadCache(dataDir) {
  const file = cachePathOf(dataDir)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!parsed || !Array.isArray(parsed.records)) return null
    return parsed
  } catch {
    return null
  }
}

export async function saveCache(dataDir, cache) {
  const file = cachePathOf(dataDir)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
  return file
}

/** 统一的取文本（带超时、带 UA、把网络错误压成可读消息）。 */
export async function fetchText(url, { timeoutMs = DEFAULTS.timeoutMs, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-ccf/0.1 (+https://github.com/xwtxbzz)' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    return await response.text()
  } catch (error) {
    const code = error?.cause?.code
    const detail = code ? `${code}: ${error.message}` : error?.message ?? String(error)
    throw new Error(`${url} 取不到：${detail}`)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** 从 JSON 源归一化。兼容裸数组、`{conferences:[...]}`、`{data:[...]}`。 */
export function recordsFromJson(text, sourceId) {
  const parsed = JSON.parse(text)
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.conferences)
      ? parsed.conferences
      : Array.isArray(parsed?.data)
        ? parsed.data
        : Array.isArray(parsed?.plugins)
          ? []
          : null
  if (!list) throw new Error('JSON 里没有会议数组（期望顶层数组或 conferences/data 字段）')
  // 连截稿时间都没有的记录留着只会污染查询（"截稿未知"），直接丢掉
  return list
    .map((raw) => normalizeJsonRecord(raw, sourceId))
    .filter((record) => record && (Number.isFinite(record.deadline) || Number.isFinite(record.abstractDeadline)))
}

/**
 * 极简 tar 读取器：返回 [{name, body}]。
 * GitHub 的归档包是 ustar + 一条 pax_global_header，这里跳过 pax 条目。
 */
export function readTar(buffer) {
  const entries = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    const nameField = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (!nameField) break
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeField || '0', 8) || 0
    const typeFlag = String.fromCharCode(header[156] || 0)
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const name = prefix ? `${prefix}/${nameField}` : nameField
    const bodyStart = offset + 512
    const body = buffer.subarray(bodyStart, bodyStart + size)
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') entries.push({ name, body })
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  return entries
}

const gzipMagic = (buffer) => buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b

/** 把 ccfddl 的 venue YAML 文本归一化成记录。 */
export function recordsFromCcfddlYaml(text, sourceId = 'ccfddl') {
  const doc = parseYaml(text)
  const docs = Array.isArray(doc) ? doc : [doc]
  const records = []
  for (const item of docs) records.push(...normalizeCcfddlVenue(item, sourceId))
  return records
}

/** 从本地 ccfddl 目录（含 conferences/*.yml）读记录。 */
export async function recordsFromCcfddlDir(dir, sourceId = 'ccfddl-dir') {
  const base = resolve(String(dir))
  const candidates = [join(base, 'conferences'), base]
  let files = []
  let root = ''
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const listing = await readdir(candidate, { withFileTypes: true })
    const ymls = listing.filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    if (ymls.length > 0) {
      files = ymls.map((entry) => entry.name)
      root = candidate
      break
    }
  }
  if (files.length === 0) throw new Error(`${base} 下没有找到 conferences/*.yml`)
  const records = []
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8')
    records.push(...recordsFromCcfddlYaml(text, sourceId))
  }
  return records
}

/** 从 ccfddl 的 tar.gz 归档读记录（一次请求）。 */
export async function recordsFromCcfddlTar(url, { timeoutMs, signal } = {}) {
  const response = await fetchWithTimeout(url, { timeoutMs, signal })
  const raw = Buffer.from(await response.arrayBuffer())
  const buffer = gzipMagic(raw) ? await gunzip(raw) : raw
  const entries = readTar(buffer).filter((entry) => /conferences\/[^/]+\.ya?ml$/i.test(entry.name))
  if (entries.length === 0) throw new Error('归档里没有 conferences/*.yml')
  const records = []
  for (const entry of entries) records.push(...recordsFromCcfddlYaml(entry.body.toString('utf8'), 'ccfddl-tar'))
  return records
}

async function fetchWithTimeout(url, { timeoutMs = 60000, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-ccf/0.1 (+https://github.com/xwtxbzz)' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    return response
  } catch (error) {
    const code = error?.cause?.code
    throw new Error(`${url} 取不到：${code ? `${code}: ` : ''}${error?.message ?? error}`)
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function gunzip(buffer) {
  return new Promise((resolvePromise, reject) => {
    const stream = createGunzip()
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(Buffer.concat(chunks)))
    stream.end(buffer)
  })
}

/**
 * 同步所有源。
 * @param {{sources?:Array<any>, dataDir?:string, timeoutMs?:number, signal?:AbortSignal,
 *          logger?:any, now?:number}} [options]
 * @returns {Promise<{cache:any, report:string, ok:boolean}>}
 */
export async function syncSources(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const dataDir = options.dataDir || defaultDataDir()
  const sources = Array.isArray(options.sources) && options.sources.length > 0
    ? options.sources
    : DEFAULT_SOURCES.map((source) => ({ ...source }))
  const previous = await loadCache(dataDir)

  const collected = []
  const reports = []
  for (const source of sources) {
    const id = String(source?.id ?? source?.type ?? 'source')
    try {
      let records = []
      if (source.type === 'json' || (!source.type && source.url)) {
        records = recordsFromJson(await fetchText(source.url, { timeoutMs: options.timeoutMs, signal: options.signal }), id)
      } else if (source.type === 'ccfddl-dir' || (!source.type && source.dir)) {
        records = await recordsFromCcfddlDir(source.dir, id)
      } else if (source.type === 'ccfddl-tar' || source.tar) {
        records = await recordsFromCcfddlTar(source.tar ?? source.url, { timeoutMs: source.timeoutMs, signal: options.signal })
      } else {
        throw new Error('未知的源类型（要 json / ccfddl-dir / ccfddl-tar）')
      }
      collected.push(...records)
      reports.push({ id, ok: true, count: records.length })
      options.logger?.info?.(`dsh-ccf: 源 ${id} 拿到 ${records.length} 条`)
    } catch (error) {
      reports.push({ id, ok: false, count: 0, error: String(error?.message ?? error) })
      options.logger?.warn?.(`dsh-ccf: 源 ${id} 失败 —— ${error?.message ?? error}`)
    }
  }

  const merged = dedupeRecords(collected)
  const ok = merged.length > 0
  const cache = ok
    ? { schema: CACHE_SCHEMA, updatedAt: now, reports, records: merged }
    : previous && Array.isArray(previous.records) && previous.records.length > 0
      // 全部源都失败时保留旧缓存，但把这次失败记进去，避免假装新鲜
      ? { ...previous, reports, lastAttemptAt: now, lastError: reports.map((report) => `${report.id}: ${report.error}`).join('; ') }
      : { schema: CACHE_SCHEMA, updatedAt: null, reports, records: [] }

  await saveCache(dataDir, cache)

  const lines = [ok ? `✅ 同步完成：${merged.length} 条会议` : '❌ 同步失败，没有任何源返回数据']
  for (const report of reports) {
    lines.push(report.ok
      ? `  - ${report.id}：${report.count} 条`
      : `  - ${report.id}：失败 —— ${report.error}`)
  }
  if (!ok && previous?.records?.length) {
    lines.push(`（保留上次缓存 ${previous.records.length} 条，同步于 ${new Date(previous.updatedAt).toISOString()}，注意可能已过期）`)
  }
  if (ok) lines.push(`缓存：${cachePathOf(dataDir)}`)
  return { cache, report: lines.join('\n'), ok }
}
