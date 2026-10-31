/**
 * 纯逻辑层测试：时区、归一化、查询、渲染、prompt 注入。
 *
 * 运行：node test/core.test.mjs
 */
import assert from 'node:assert/strict'

import {
  countdownText,
  dedupeRecords,
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
} from '../lib/core.js'

let passed = 0
const test = (name, fn) => {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

// 固定的"现在"：2026-10-31 12:00 UTC
const NOW = Date.parse('2026-10-31T12:00:00Z')

const jsonRecord = (overrides = {}) => normalizeJsonRecord({
  name: 'CVPR 2027',
  fullName: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition',
  area: 'CV',
  rank: 'CCF-A',
  core: 'A*',
  abstractDeadline: '2026-11-06T23:59:59-08:00',
  deadline: '2026-11-13T23:59:59-08:00',
  notification: '2027-01-22',
  confDate: '2027-06',
  place: 'TBD',
  link: 'https://cvpr.thecvf.com',
  history: ['2026-11-14', '2025-11-15'],
  acceptRate: '~23%',
  h5: 300,
  ...overrides,
})

console.log('core.test')

test('时区偏移：AoE / UTC / IANA', () => {
  assert.equal(tzOffsetMinutes('AoE', NOW), -12 * 60)
  assert.equal(tzOffsetMinutes('UTC', NOW), 0)
  // 10-31 是美西夏令时（PDT, UTC-7）；01-15 是 PST（UTC-8）
  assert.equal(tzOffsetMinutes('America/Los_Angeles', NOW), -7 * 60)
  assert.equal(tzOffsetMinutes('America/Los_Angeles', Date.parse('2027-01-15T12:00:00Z')), -8 * 60)
  assert.equal(tzOffsetMinutes('Asia/Shanghai', NOW), 8 * 60)
})

test('墙面时间 → 绝对时刻（AoE 与 DST 两侧）', () => {
  // AoE 的 2026-11-13 23:59:59 = UTC 2026-11-14 11:59:59
  const aoe = zonedToInstant({ year: 2026, month: 11, day: 13, hour: 23, minute: 59, second: 59 }, 'AoE')
  assert.equal(new Date(aoe).toISOString(), '2026-11-14T11:59:59.000Z')
  const pst = zonedToInstant({ year: 2027, month: 1, day: 15, hour: 23, minute: 59, second: 59 }, 'America/Los_Angeles')
  assert.equal(new Date(pst).toISOString(), '2027-01-16T07:59:59.000Z')
})

test('parseInstant：显式偏移 / 无偏移按给定时区 / 只有日期', () => {
  assert.equal(
    new Date(parseInstant('2026-11-13T23:59:59-08:00')).toISOString(),
    '2026-11-14T07:59:59.000Z',
  )
  assert.equal(
    new Date(parseInstant('2026-11-13 23:59:59', 'AoE')).toISOString(),
    '2026-11-14T11:59:59.000Z',
  )
  assert.equal(
    new Date(parseInstant('2027-01-15', 'UTC')).toISOString(),
    '2027-01-15T23:59:59.000Z',
  )
  assert.equal(parseInstant(''), null)
  assert.equal(parseInstant(undefined), null)
  assert.equal(parseInstant('not-a-date'), null)
})

test('倒计时文本', () => {
  assert.equal(countdownText(13 * DAY + 9 * HOUR), '13 天 9 小时')
  assert.equal(countdownText(2 * DAY), '2 天')
  assert.equal(countdownText(42 * 60_000), '42 分钟')
  assert.equal(countdownText(-2 * DAY - 3 * HOUR), '已过 2 天 3 小时')
  assert.equal(countdownText(0.5 * 60_000), '不到 1 分钟')
})

test('名字工具：年份与干净会议名', () => {
  assert.equal(yearOf('CVPR 2027'), 2027)
  assert.equal(yearOf('IJCV'), null)
  assert.equal(venueOf('KDD 2027 (Cycle 1)'), 'KDD')
  assert.equal(venueOf('AAAI 2027'), 'AAAI')
  assert.equal(venueOf('USENIX ATC 2027'), 'USENIX ATC')
})

test('归一化 JSON 记录', () => {
  const record = jsonRecord()
  assert.equal(record.venue, 'CVPR')
  assert.equal(record.year, 2027)
  assert.equal(record.rank, 'CCF-A')
  assert.equal(record.area, 'CV')
  assert.equal(record.key, 'cvpr|2027')
  assert.equal(new Date(record.deadline).toISOString(), '2026-11-14T07:59:59.000Z')
  assert.equal(record.verified, false)
})

test('归一化 ccfddl venue → 每个年份一条', () => {
  const doc = {
    title: 'ICASSP',
    description: 'IEEE ICASSP',
    sub: 'SP',
    rank: 'B',
    confs: [
      {
        year: 2027,
        link: 'https://2027.ieeeicassp.org/',
        timeline: [{ abstract_deadline: '2026-09-02 23:59:59', deadline: '2026-09-09 23:59:59' }],
        timezone: 'AoE',
        date: 'May 2027',
        place: 'TBD',
      },
      { year: 2028, timeline: [{ deadline: '2027-09-09 23:59:59' }], timezone: 'AoE' },
    ],
  }
  const records = normalizeCcfddlVenue(doc, 'ccfddl-dir')
  assert.equal(records.length, 2)
  assert.equal(records[0].venue, 'ICASSP')
  assert.equal(records[0].rank, 'CCF-B')
  assert.equal(records[0].area, '网络与信息安全')
  assert.equal(records[0].source, 'ccfddl-dir')
  assert.equal(new Date(records[0].deadline).toISOString(), '2026-09-10T11:59:59.000Z')
  assert.equal(records[1].year, 2028)
  // 只有 deadline 没有 abstract 时不能凭空造摘要截止
  assert.equal(records[1].abstractDeadline, null)
})

test('去重：同 venue+year 先到者优先，缺字段由后者补', () => {
  const first = jsonRecord({ place: '' })
  const second = jsonRecord({ place: 'Nashville', link: 'https://other.example' })
  const merged = dedupeRecords([first, second])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].place, 'Nashville')
  assert.equal(merged[0].link, 'https://cvpr.thecvf.com', '先到者的非空字段不被覆盖')
})

test('查询：窗口、等级、方向、关键词、过去', () => {
  const records = [
    jsonRecord(),
    jsonRecord({ name: 'ICLR 2027', area: 'AI/ML', rank: 'CCF-A', deadline: '2026-11-01T23:59:59-12:00', link: 'https://iclr.cc' }),
    jsonRecord({ name: 'KDD 2027', area: 'Data Mining', rank: 'CCF-A', deadline: '2027-02-05T23:59:59-12:00' }),
    jsonRecord({ name: 'ICASSP 2027', area: 'Speech', rank: 'CCF-B', deadline: '2026-09-10T23:59:59-12:00' }),
  ]
  const soon = queryDeadlines(records, { now: NOW, windowDays: 30 })
  assert.deepEqual(soon.map((row) => row.venue), ['ICLR', 'CVPR'], '按时间升序，且窗口外的不进')
  assert.ok(soon[0].deltaMs < 2 * DAY)

  const onlyA = queryDeadlines(records, { now: NOW, windowDays: 200, ranks: ['CCF-A'] })
  assert.deepEqual(onlyA.map((row) => row.venue), ['ICLR', 'CVPR', 'KDD'])

  const onlyCV = queryDeadlines(records, { now: NOW, windowDays: 200, areas: ['cv'] })
  assert.deepEqual(onlyCV.map((row) => row.venue), ['CVPR'])

  const searched = queryDeadlines(records, { now: NOW, windowDays: 200, search: 'iclr' })
  assert.deepEqual(searched.map((row) => row.venue), ['ICLR'])

  const past = queryDeadlines(records, { now: NOW, windowDays: 30, includePast: true, pastDays: 60 })
  assert.deepEqual(past.map((row) => row.venue), ['ICASSP', 'ICLR', 'CVPR'], '过去的也能捞出来')

  const limited = queryDeadlines(records, { now: NOW, windowDays: 200, limit: 2 })
  assert.equal(limited.length, 2)
})

test('查询单个会议（名字模糊匹配）', () => {
  const records = [jsonRecord(), jsonRecord({ name: 'CVPR Workshops 2027', deadline: '2026-12-01T23:59:59-12:00' })]
  const rows = queryVenue(records, 'cvpr')
  assert.equal(rows.length, 1, '精确命中 CVPR 时不再混入 CVPR Workshops')
  assert.equal(rows[0].venue, 'CVPR')
  const workshops = queryVenue(records, 'workshops')
  assert.equal(workshops.length, 1, '没有精确命中时退回模糊匹配')
  assert.equal(workshops[0].venue, 'CVPR Workshops')
  assert.equal(queryVenue(records, 'cvpr 2027').length, 1)
  assert.equal(queryVenue(records, 'nope').length, 0)
})

test('渲染：列表、行、详情', () => {
  const records = [jsonRecord()]
  const rows = queryDeadlines(records, { now: NOW, windowDays: 30 })
  const line = formatRow(rows[0], { now: NOW })
  assert.match(line, /CVPR 2027 · CCF-A · CV · 2026-11-14 15:59/)
  assert.match(line, /13 天/)

  const list = formatList(rows, { now: NOW, windowDays: 30 })
  assert.match(list, /未来 30 天内 1 个截稿/)
  assert.match(list, /摘要 /)
  assert.match(list, /通知 /)
  assert.match(list, /https:\/\/cvpr\.thecvf\.com/)

  const empty = formatList([], { now: NOW, windowDays: 30 })
  assert.match(empty, /没有匹配的会议截稿/)

  const detail = formatVenue(records, { now: NOW })
  assert.match(detail, /CVPR 2027 · CCF-A · CV/)
  assert.match(detail, /录用率：~23%/)
  assert.match(detail, /往届截稿/)

  assert.match(formatVenue([], {}), /没有找到这个会议/)
})

test('prompt 注入：无数据/过期不注入，有数据只给窗口内的', () => {
  assert.equal(promptText(null, { now: NOW }), '')
  assert.equal(promptText({ records: [], updatedAt: NOW }, { now: NOW }), '')

  const records = [
    jsonRecord(),
    jsonRecord({ name: 'KDD 2027', deadline: '2027-02-05T23:59:59-12:00', area: 'Data Mining' }),
  ]
  const fresh = promptText({ records, updatedAt: NOW - HOUR }, { now: NOW, leadDays: 30 })
  assert.match(fresh, /## 会议截稿（dsh-ccf）/)
  assert.match(fresh, /CVPR 2027/)
  assert.doesNotMatch(fresh, /KDD 2027/, '30 天窗口外的会议不进 prompt')

  const stale = promptText({ records, updatedAt: NOW - 30 * DAY }, { now: NOW, staleHours: 168 })
  assert.equal(stale, '', '数据过旧就不注入，避免模型引用过期日期')
})

test('prompt 注入遵守条数上限', () => {
  const records = Array.from({ length: 5 }, (_, index) => jsonRecord({
    name: `CONF${index} 2027`,
    deadline: `2026-11-${String(10 + index).padStart(2, '0')}T23:59:59-12:00`,
  }))
  const text = promptText({ records, updatedAt: NOW }, { now: NOW, leadDays: 60, maxPromptItems: 3 })
  const bullets = text.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(bullets.length, 3)
})

console.log(`\n${passed} passed`)
