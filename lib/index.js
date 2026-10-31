/**
 * dsh-ccf · 插件入口
 *
 * DSH 的 cordis 插件就是一个"带构造函数"的类；bundle patch 里的 row
 * 用包名指向它，config 走 cordis.patch.yml。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

import { createCcf } from './create.js'

export { createCcf, DEADLINE_PARAMETERS, VENUE_PARAMETERS, POLICY_ORDER, parseFlags } from './create.js'
export {
  DEFAULTS,
  DEFAULT_SOURCES,
  countdownText,
  dedupeRecords,
  formatInZone,
  formatList,
  formatRow,
  formatVenue,
  normalizeCcfddlVenue,
  normalizeJsonRecord,
  parseInstant,
  promptText,
  queryDeadlines,
  queryVenue,
  tzOffsetMinutes,
  venueOf,
  yearOf,
  zonedToInstant,
} from './core.js'
export { loadCache, readTar, recordsFromCcfddlYaml, recordsFromJson, syncSources } from './sync.js'
export { parseYaml } from './yaml.js'

export const name = 'dsh-ccf'

export default class CcfPlugin {
  /**
   * @param {any} ctx cordis 上下文
   * @param {Record<string, unknown>} config 由 cordis.patch.yml 的 row.config 注入
   */
  constructor(ctx, config = {}) {
    this.ccf = createCcf(ctx, config, defineTool)
  }
}
