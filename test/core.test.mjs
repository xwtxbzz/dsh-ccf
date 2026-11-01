/**
 * 纯逻辑层测试：时区、归一化、查询、渲染、prompt 注入。
 *
 * 运行：node test/core.test.mjs
 */
import assert from 'node:assert/strict'

import {
  applyPreferred, applyPreferredAll, countdownText, dedupeRecords, formatInZone, formatInZoneSafe, formatList, formatRow, formatVenue,
  mergeKeepingNewlyAdded, normalizeCcfddlApi, normalizeCcfddlVenue, normalizeJsonRecord, officialZoneText, parseInstant, promptText,
  queryDeadlines, queryDeadlinesWithMeta, queryVenue, resolveTimeZone, systemTimeZone, toInstant, tzOffsetMinutes, venueKey, venueOf, yearOf, zonedToInstant,
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

test('去重：两个源给了不同截稿时留下另一种说法，而不是默默丢弃', () => {
  const first = jsonRecord({ deadline: '2026-11-20T23:59:59-12:00' })
  const second = { ...jsonRecord({ deadline: '2026-11-14T23:59:59-12:00' }), source: 'ccfddl-api' }
  const merged = dedupeRecords([first, second])
  assert.equal(merged.length, 1)
  // 主记录仍用先到者的时间
  assert.equal(new Date(merged[0].deadline).toISOString(), '2026-11-21T11:59:59.000Z')
  assert.equal(merged[0].alternatives.length, 1)
  assert.equal(merged[0].alternatives[0].source, 'ccfddl-api')
  assert.equal(new Date(merged[0].alternatives[0].deadline).toISOString(), '2026-11-15T11:59:59.000Z')

  // 时间一致时不记冲突
  const third = jsonRecord({ source: 'paper-deadlines', deadline: '2026-11-20T23:59:59-12:00' })
  const quiet = dedupeRecords([jsonRecord({ deadline: '2026-11-20T23:59:59-12:00' }), third])
  assert.equal(quiet[0].alternatives, undefined)

  // formatVenue 把另一说法写进人读的文本
  const text = formatVenue(merged, { now: NOW })
  assert.match(text, /来源不一致：ccfddl-api \d{4}-\d{2}-\d{2}/)
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

  // limit 截断时要把"一共匹配多少"带回来，并且列表标题得说出来 ——
  // 否则读者会以为"365 天内只有 8 个会"。
  const meta = queryDeadlinesWithMeta(records, { now: NOW, windowDays: 200, limit: 2 })
  assert.equal(meta.rows.length, 2)
  assert.equal(meta.matched, 3)
  assert.equal(meta.hidden, 1)
  const truncated = formatList(meta.rows, { now: NOW, windowDays: 200, matched: meta.matched })
  assert.match(truncated, /共 3 个截稿/)
  assert.match(truncated, /列出前 2 个/)
  assert.match(truncated, /limit/)
  // 没截断时不要多嘴
  const whole = queryDeadlinesWithMeta(records, { now: NOW, windowDays: 200 })
  assert.equal(whole.hidden, 0)
  assert.doesNotMatch(formatList(whole.rows, { now: NOW, windowDays: 200, matched: whole.matched }), /列出前/)
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

test('prompt 注入：两个源打架的会要标出来，别当定论转述', () => {
  const records = [
    jsonRecord(),
    {
      ...jsonRecord({ name: 'AAAI 2027', deadline: '2026-11-05T23:59:59-12:00' }),
      alternatives: [{ source: 'paper-deadlines', deadline: Date.parse('2026-11-15T23:59:59-12:00') }],
    },
  ]
  const text = promptText({ records, updatedAt: NOW }, { now: NOW, leadDays: 60, promptSoonDays: 60 })
  assert.match(text, /AAAI 2027 · 来源冲突/, '注入的那一行要带标记')
  assert.match(text, /标了「来源冲突」的 1 个会/, '还要说清这意味着什么')
  assert.ok(!/CVPR 2027 · 来源冲突/.test(text), '不冲突的会不能被误标')
  // 近期没有急事时只留一行摘要：那一行也得带上"来源冲突"，否则模型只看到最近那个日期
  const brief = promptText({ records, updatedAt: NOW }, { now: NOW, leadDays: 60, promptSoonDays: 7 })
  assert.match(brief, /来源冲突/, '摘要行也要说明这个日期不是唯一说法')
})

test('prompt 注入遵守条数上限', () => {
  const records = Array.from({ length: 5 }, (_, index) => jsonRecord({
    name: `CONF${index} 2027`,
    deadline: `2026-11-${String(10 + index).padStart(2, '0')}T23:59:59-12:00`,
  }))
  const text = promptText({ records, updatedAt: NOW }, { now: NOW, leadDays: 60, maxPromptItems: 3, promptSoonDays: 60 })
  const bullets = text.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(bullets.length, 3)
  // 被 limit 截断时不能把 3 说成总数：模型会把这句话当真话转述给用户
  assert.match(text, /共 5 个截稿/, '要说清真实总数')
  assert.match(text, /列出前 3 个/, '也要说清这里只列了几条')
})

test('CCFDDL 接口：UTC-12 偏移与多轮取最近一轮', () => {
  const doc = {
    conferences: [
      {
        title: 'CVPR',
        description: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition',
        sub: 'AI',
        rank: { ccf: 'A', core: 'A*' },
        confs: [
          {
            year: 2026,
            timezone: 'UTC-12',
            timeline: [{ abstract_deadline: '2025-11-07 23:59:59', deadline: '2025-11-13 23:59:59' }],
            date: 'June 5-7, 2026',
            place: 'Denver',
          },
          {
            year: 2027,
            timezone: 'UTC-12',
            timeline: [{
              abstract_deadline: '2026-11-10 23:59:59',
              deadline: '2026-11-16 23:59:59',
              rebuttal_deadline: '2027-02-01 23:59:59',
              decision_deadline: '2027-02-25 23:59:59',
            }],
            date: 'June 20-25, 2027',
            place: 'Seattle, WA, United States',
          },
        ],
      },
    ],
  }
  const [record] = normalizeCcfddlApi(doc, 'ccfddl-api', { now: NOW })
  assert.equal(record.venue, 'CVPR')
  assert.equal(record.year, 2027, '保留还没过截稿的那一届')
  assert.equal(record.rank, 'CCF-A')
  assert.equal(record.area, '人工智能')
  // 2026-11-16 23:59:59 @ UTC-12 = 2026-11-17T11:59:59Z
  assert.equal(new Date(record.deadline).toISOString(), '2026-11-17T11:59:59.000Z')
  assert.equal(new Date(record.rebuttal).toISOString(), '2027-02-02T11:59:59.000Z')
  assert.equal(new Date(record.notification).toISOString(), '2027-02-26T11:59:59.000Z')
  assert.equal(record.source, 'ccfddl-api')
  // 往届截稿也收下来：面板展开详情里要显示"这个会往年什么时候截"
  assert.deepEqual(record.history, ['2026: 2025-11-13'], '应带上往届（2026 届按 UTC-12 是 11-13）')
  assert.equal(record.timezone, 'UTC-12:00', '原始时区要留着（归一成带分钟的偏移），面板才能印官方口径')
})

test('CCFDDL 接口：rank N 记成 Non-CCF、PT 当美国太平洋时间', () => {
  const doc = [
    {
      title: 'CVC',
      sub: 'AI',
      rank: { ccf: 'N' },
      confs: [{ year: 2027, timezone: 'PT', timeline: [{ deadline: '2026-11-02 23:59:59' }] }],
    },
  ]
  const [record] = normalizeCcfddlApi(doc, 'ccfddl-api', { now: NOW })
  assert.equal(record.rank, 'Non-CCF')
  // 2026-11-02 在美国已过夏令时（11-01 结束），按 PST = UTC-8
  assert.equal(new Date(record.deadline).toISOString(), '2026-11-03T07:59:59.000Z')
})

test('CCFDDL 接口：sub=SC 是安全方向，不是高性能计算', () => {
  const doc = [
    {
      title: 'S&P',
      sub: 'SC',
      rank: { ccf: 'A' },
      confs: [{ year: 2027, timezone: 'AoE', timeline: [{ deadline: '2026-11-18 23:59:59' }] }],
    },
  ]
  const [record] = normalizeCcfddlApi(doc, 'ccfddl-api', { now: NOW })
  assert.equal(record.area, '网络与信息安全')
})

test('时区写法归一：AoE / UTC±H / 别名', () => {
  assert.equal(resolveTimeZone('AoE'), 'AoE')
  assert.equal(resolveTimeZone('UTC-12'), 'UTC-12:00')
  assert.equal(resolveTimeZone('UTC+8'), 'UTC+08:00')
  assert.equal(resolveTimeZone('PT'), 'America/Los_Angeles')
  assert.equal(tzOffsetMinutes('UTC-12:00', NOW), -720)
  assert.equal(tzOffsetMinutes('UTC+05:30', NOW), 330)
})

test('采信另一来源：显示跟着用户选的走，但缓存里的主记录不动', () => {
  const record = {
    key: 'cvpr|2027',
    venue: 'CVPR',
    year: 2027,
    source: 'ccfddl-api',
    deadline: Date.parse('2026-11-17T11:59:59Z'),
    notification: Date.parse('2027-02-26T11:59:59Z'),
    alternatives: [{ source: 'paper-deadlines', deadline: Date.parse('2026-11-14T07:59:59Z'), notification: null }],
  }
  // 没采信时原样返回
  assert.equal(applyPreferred(record), record)
  // 采信 paper-deadlines 之后：显示值换成它，原来的首选变成"另一种说法"
  const preferred = applyPreferred({ ...record, preferredSource: 'paper-deadlines' })
  assert.equal(preferred.deadline, Date.parse('2026-11-14T07:59:59Z'))
  assert.equal(preferred.source, 'paper-deadlines')
  assert.equal(preferred.preferred, true)
  assert.equal(preferred.alternatives.length, 1)
  assert.equal(preferred.alternatives[0].source, 'ccfddl-api')
  assert.equal(preferred.alternatives[0].deadline, record.deadline)
  // 原对象没被改：派生视图不应该污染缓存
  assert.equal(record.deadline, Date.parse('2026-11-17T11:59:59Z'))
  // 指定的来源不存在时退回原样
  assert.equal(applyPreferred({ ...record, preferredSource: 'nowhere' }).deadline, record.deadline)
  // 批量版保持顺序
  assert.deepEqual(applyPreferredAll([record]).map((row) => row.key), ['cvpr|2027'])
  assert.deepEqual(applyPreferredAll(null), [])
})

test('采信记得住会：去年点过一次，今年新一届自动沿用', () => {
  // 同一个会的不同写法要落到同一个键上
  assert.equal(venueKey('CVPR 2027'), 'cvpr')
  assert.equal(venueKey('IEEE/CVF CVPR'), 'cvpr')
  assert.equal(venueKey('cvpr'), 'cvpr')
  assert.equal(venueKey('KDD 2027 (Cycle 1)'), 'kdd')
  assert.equal(venueKey(''), '')

  const nextEdition = {
    key: 'cvpr|2028',
    venue: 'CVPR',
    year: 2028,
    source: 'ccfddl-api',
    deadline: Date.parse('2027-11-16T11:59:59Z'),
    alternatives: [{ source: 'paper-deadlines', deadline: Date.parse('2027-11-13T07:59:59Z'), notification: null }],
  }
  const venuePrefs = { cvpr: 'paper-deadlines' }
  const inherited = applyPreferred(nextEdition, venuePrefs)
  assert.equal(inherited.deadline, Date.parse('2027-11-13T07:59:59Z'))
  assert.equal(inherited.preferred, true)
  assert.equal(inherited.preferredInherited, true)
  assert.equal(inherited.preferredSource, 'paper-deadlines')
  // 缓存里的对象没被改
  assert.equal(nextEdition.deadline, Date.parse('2027-11-16T11:59:59Z'))

  // 这条记录自己点过的话，以它自己的为准
  const explicit = applyPreferred({
    ...nextEdition,
    preferredSource: 'paper-deadlines',
  }, { cvpr: 'ccfddl-api' })
  assert.equal(explicit.source, 'paper-deadlines')
  assert.equal(explicit.preferredInherited, false)

  // 记忆里指向一个不存在的来源时，安静地退回默认
  assert.equal(applyPreferred(nextEdition, { cvpr: 'nowhere' }).deadline, nextEdition.deadline)
  // 批量版透传记忆
  assert.equal(applyPreferredAll([nextEdition], venuePrefs)[0].preferred, true)
})


test('官方口径：UTC-12:00 这种固定偏移也要能格式化到分钟', () => {
  const instant = Date.parse('2026-11-17T11:59:59Z')
  assert.equal(formatInZoneSafe(instant, 'UTC-12:00'), '2026-11-16 23:59')
  // IANA 时区仍走 Intl
  assert.match(formatInZoneSafe(instant, 'Asia/Shanghai'), /^2026-11-17 19:59$/)
})

test('会议详情里写明官方时区口径，读者不用自己换算', () => {
  const record = {
    key: 'cvpr|2027', venue: 'CVPR', year: 2027, name: 'CVPR 2027',
    deadline: Date.parse('2026-11-17T11:59:59Z'), abstractDeadline: null,
    notification: null, history: [], timezone: 'UTC-12:00',
  }
  assert.equal(officialZoneText(record), 'UTC-12:00：截稿 2026-11-16 23:59')
  const text = formatVenue([record])
  assert.match(text, /^  - 2027: 截稿 /m)
  assert.match(text, /官方口径 UTC-12:00：截稿 2026-11-16 23:59/)
  // 没有时区信息时安静地不写
  assert.equal(officialZoneText({ ...record, timezone: '' }), null)
})

test('官方口径：AoE 这种"时区名"不能让整次查询炸掉（回归）', () => {
  const instant = Date.parse('2026-11-17T11:59:59Z')
  // AoE 不是 IANA 时区名，Intl 会抛 RangeError；换算路径必须兜住它。
  assert.equal(formatInZoneSafe(instant, 'AoE'), '2026-11-16 23:59')
  assert.equal(formatInZoneSafe(instant, 'aoe'), '2026-11-16 23:59')
  assert.equal(officialZoneText({ timezone: 'AoE', deadline: instant }), 'AoE：截稿 2026-11-16 23:59')
  const record = { key: 'x|2027', venue: 'X', name: 'X 2027', year: 2027, rank: 'CCF-A', area: 'AI', deadline: instant, timezone: 'AoE' }
  assert.match(formatVenue([record]), /官方口径 AoE：截稿 2026-11-16 23:59/)
})

test('默认时区跟着这台机器走（换台电脑不该还是北京时间）', async () => {
  const zone = systemTimeZone('Asia/Shanghai')
  assert.equal(typeof zone, 'string')
  assert.ok(zone.length > 0)
  // 本机装不出时区信息时才回退
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone
  assert.equal(zone, system || 'Asia/Shanghai')
  assert.equal(systemTimeZone('UTC'), Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
})
test('合并时别把别的窗口刚同步到的会丢掉', async () => {
  const mine = [{ key: 'cvpr|2027', venue: 'CVPR' }]
  const latest = [
    { key: 'cvpr|2027', venue: 'CVPR', deadline: 1 },
    { key: 'iclr|2027', venue: 'ICLR' },
  ]
  const merged = mergeKeepingNewlyAdded(mine, latest)
  assert.equal(merged.length, 2)
  // 自己这一轮的记录仍然是那条（不被旧值覆盖）
  assert.equal(merged[0], mine[0])
  assert.equal(merged[1].key, 'iclr|2027')
  // 没有新增时返回原数组本身（不做无谓拷贝）
  assert.equal(mergeKeepingNewlyAdded(mine, mine), mine)
  // next 为空时，latest 整份都要保下来
  assert.equal(mergeKeepingNewlyAdded(null, latest).length, 2)
})

test('toInstant 接受 ISO 字符串：缓存里写的是字符串也别显示成空时间', async () => {
  const iso = '2026-11-01T02:18:00.000Z'
  assert.equal(toInstant(iso), Date.parse(iso))
  assert.equal(toInstant(new Date(iso)), Date.parse(iso))
  assert.equal(toInstant(Number.NaN), null)
  assert.equal(toInstant(null), null)
  assert.equal(toInstant(''), null)
  // 原来这里返回空字符串，句子就变成"数据时间 （前）"
  assert.equal(formatInZone(iso, 'UTC'), '2026-11-01 02:18')
  assert.equal(formatInZoneSafe(iso, 'Asia/Shanghai'), '2026-11-01 10:18')
  assert.equal(formatInZone(null, 'UTC'), '')
})
test('模型挖到的记录在详情里写清出处', () => {
  const base = {
    key: 'cvpr|2027', venue: 'CVPR', year: 2027, name: 'CVPR 2027', rank: 'CCF-A', area: 'CV',
    abstractDeadline: null, deadline: NOW + 10 * DAY, notification: null, confDate: '2027-06',
    place: 'Honolulu', link: 'https://cvpr.thecvf.com', submitLink: '', aliases: [], history: [],
  }
  const mined = formatVenue([{
    ...base, source: 'model', minedAt: NOW,
    minedFrom: ['https://cvpr.thecvf.com/Conferences/2027/Dates', 'https://cvpr.thecvf.com/'],
  }], { now: NOW, timeZone: 'Asia/Shanghai' })
  assert.match(mined, /挖自：https:\/\/cvpr\.thecvf\.com\/Conferences\/2027\/Dates/, '要写出挖自哪一页')
  // 权威源没有这行：不要把 CCFDDL 的数据说成"模型挖的"
  const authority = formatVenue([{ ...base, source: 'ccfddl-api' }], { now: NOW, timeZone: 'Asia/Shanghai' })
  assert.doesNotMatch(authority, /挖自：/)
})

test('prompt 默认只列 3 条：每轮都注入，条数要有闸', () => {
  const records = Array.from({ length: 10 }, (_, index) => jsonRecord({
    name: `CONF${index} 2027`,
    deadline: `2026-11-${String(10 + index).padStart(2, '0')}T23:59:59-12:00`,
  }))
  const text = promptText({ records, updatedAt: NOW }, { now: NOW, leadDays: 60, promptSoonDays: 60 })
  const bullets = text.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(bullets.length, 3, '默认只列 3 条')
  assert.match(text, /共 10 个截稿/, '总数照实说')
  assert.ok(text.length < 500, `注入文本要短（当前 ${text.length} 字符）`)
})

test('近期没有截稿时，注入退化成一行（省 token 但不失明）', () => {
  const records = [
    jsonRecord({ name: 'FAR 2027', deadline: '2026-12-20T23:59:59-12:00' }),
    jsonRecord({ name: 'FAR2 2027', deadline: '2026-12-25T23:59:59-12:00' }),
  ]
  const text = promptText({ records, updatedAt: NOW }, { now: NOW, leadDays: 60, promptSoonDays: 7 })
  const lines = text.split('\n')
  assert.equal(lines.length, 2, '只有标题 + 一行摘要')
  assert.match(lines[1], /近期|7 天内没有要交的/, '要说清近期没有截稿')
  assert.match(lines[1], /共 2 个截稿/)
  assert.doesNotMatch(text, /^- /m, '不列条目')
  assert.ok(text.length < 200, `一行摘要要短（当前 ${text.length} 字符）`)

  // 反过来：7 天内有截稿就照常列条目
  const soon = [jsonRecord({ name: 'SOON 2027', deadline: '2026-11-03T23:59:59-12:00' })]
  const near = promptText({ records: soon, updatedAt: NOW }, { now: NOW, leadDays: 60, promptSoonDays: 7 })
  assert.match(near, /^- SOON 2027/m, '临近截稿要逐条列出来')
})

test('formatRow 把 Workshop / 地区分会场标成「卫星会」', () => {
  const row = { name: 'CVPR Workshops 2027', rank: 'Non-CCF', area: '人工智能', deadline: Date.parse('2027-03-20T11:59:59Z'), satellite: true }
  const text = formatRow(row, { now: Date.parse('2026-11-01T00:00:00Z'), timeZone: 'UTC' })
  assert.match(text, /CVPR Workshops 2027 · 卫星会 · Non-CCF/)
  const plain = formatRow({ ...row, satellite: false }, { now: Date.parse('2026-11-01T00:00:00Z'), timeZone: 'UTC' })
  assert.ok(!plain.includes('卫星会'), '普通会议不加这个标')
})

console.log(`\n${passed} passed`)
