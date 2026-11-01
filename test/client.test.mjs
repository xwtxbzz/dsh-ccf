/**
 * 客户端产物的单元测试：把 `client/client.js` 当浏览器脚本执行（喂一个假的
 * `window.__ModuleLoader__`），检查注册接线与纯函数。
 *
 * 组件本身用到 React hooks，这里不做真实渲染 —— 渲染与样式由桌面端实测，
 * 但"注册到哪个槽、id 是什么、行怎么算出来"这些能测的都测了。
 */
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..', 'client', 'client.js')

let injected = null
const registrations = []

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children, key: props && props.key }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
}

const storage = new Map()
const windowStub = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  },
  setInterval: () => 0,
  clearInterval: () => {},
  __ModuleLoader__: {
    load(spec) {
      this.spec = spec
      this.exports = spec.factory((name) => {
        if (name === 'react') return fakeReact
        throw new Error(`unexpected require: ${name}`)
      })
    },
  },
}

globalThis.window = windowStub
await import(pathToFileURL(bundle).href)

const api = windowStub.__ModuleLoader__.exports

const { buildRows } = api

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('导出日历的调用方要把面板的时区传进去（接线测试）', async () => {
  // buildIcs 本身尊重 timeZone（下面那条用例守着），但真正会漏的是"没人传"：
  // 面板按 payload.timezone 显示时间，导出却用浏览器本地时区——两处对不上，
  // 用户会以为导错了。这条读源码，守的就是那一行调用。
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(bundle, 'utf8')
  assert.match(source, /buildIcs\(shownRows, \{ now, timeZone,/, '导出日历时必须带上 timeZone')
})

test('bundle declares the module id and exposes apply/inject', () => {
  assert.equal(windowStub.__ModuleLoader__.spec.id, 'dsh-ccf')
  assert.equal(typeof api.apply, 'function')
  assert.deepEqual(api.inject, ['slots'])
})

test('apply registers one entry on shell.overlay', () => {
  const ctx = {
    slots: {
      inject: (name, callback) => {
        injected = name
        callback()
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  api.apply(ctx)
  assert.equal(injected, 'shell.overlay')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'shell.overlay')
  assert.equal(registrations[0].options.id, 'dsh-ccf-panel')
  assert.equal(typeof registrations[0].component, 'function')
  const element = registrations[0].component()
  assert.equal(typeof element.type, 'function')
})

test('route constants match the host routes', () => {
  assert.equal(api.ROUTE_RECORDS, '/dsh-ccf/api/v1/records')
  assert.equal(api.ROUTE_SYNC, '/dsh-ccf/api/v1/sync')
  assert.equal(api.ROUTE_UPDATE, '/dsh-ccf/api/v1/update')
  assert.equal(api.SLOT, 'shell.overlay')
})

test('sourceLine distinguishes mined data, fallback data and unknown', () => {
  assert.match(api.sourceLine({ source: 'model', minedAt: '2026-10-31T00:00:00.000Z' }, 'Asia/Shanghai'), /模型挖掘/)
  assert.match(api.sourceLine({ source: 'paper-deadlines', minedAt: null }, 'Asia/Shanghai'), /回退数据/)
  assert.match(api.sourceLine({ source: '', minedAt: null }, 'Asia/Shanghai'), /来源未知/)
})

test('formatInstant renders in the given time zone', () => {
  assert.equal(api.formatInstant('2026-11-20T07:59:59.000Z', 'Asia/Shanghai'), '2026-11-20 15:59')
  assert.equal(api.formatInstant('2026-11-20T07:59:59.000Z', 'UTC'), '2026-11-20 07:59')
  assert.equal(api.formatInstant(null, 'UTC'), '—')
})

test('sourceZoneLine prints the official zone wording (AoE / UTC-12)', () => {
  // CVPR 2027 在 CCFDDL 里是 AoE 11-16 23:59，本地（上海）看到的是 11-17 07:59 —— 差一天正是要说明的地方
  assert.equal(api.sourceZoneLine({ timezone: 'AoE', deadline: '2026-11-17T11:59:59.000Z' }), 'AOE 2026-11-16 23:59')
  assert.equal(api.sourceZoneLine({ timezone: 'UTC-12:00', deadline: '2026-11-17T11:59:59.000Z' }), 'UTC-12:00 2026-11-16 23:59')
  assert.equal(api.sourceZoneLine({ timezone: 'UTC+05:30', deadline: '2026-11-20T07:59:59.000Z' }), 'UTC+05:30 2026-11-20 13:29')
  assert.equal(api.sourceZoneLine({ timezone: 'America/Los_Angeles', deadline: '2026-11-20T07:59:59.000Z' }), 'AMERICA/LOS_ANGELES 2026-11-19 23:59')
  assert.equal(api.sourceZoneLine({ timezone: '', deadline: '2026-11-20T07:59:59.000Z' }), '')
  assert.equal(api.sourceZoneLine({ timezone: 'AoE', deadline: null }), '')
})

test('historyLine renders previous editions and stays empty without them', () => {
  assert.equal(api.historyLine({ history: ['2026: 2026-11-14', '2025: 2025-11-13'] }), '2026: 2026-11-14 / 2025: 2025-11-13')
  assert.equal(api.historyLine({ history: [] }), '')
  assert.equal(api.historyLine({}), '')
})

test('mergePins unions without duplicating or reordering', () => {
  assert.deepEqual(api.mergePins(['cvpr|2027'], ['cvpr|2027', 'kdd|2027', '  ']), ['cvpr|2027', 'kdd|2027'])
  assert.deepEqual(api.mergePins([], ['a', 'b']), ['a', 'b'])
  assert.deepEqual(api.mergePins(null, null), [])
})

test('seenStamp records the deadlines the reader has already seen', () => {
  const stamp = api.seenStamp([
    { key: 'cvpr|2027', deadline: '2026-11-17T11:59:59.000Z' },
    { key: 'kdd|2027', deadline: null },
    { deadline: '2026-11-20T00:00:00.000Z' },
  ])
  assert.deepEqual(Object.keys(stamp), ['cvpr|2027'])
  assert.equal(stamp['cvpr|2027'], Date.parse('2026-11-17T11:59:59.000Z'))
})

test('freshRows flags new venues and changed deadlines only', () => {
  const seen = { 'cvpr|2027': Date.parse('2026-11-17T11:59:59.000Z'), 'icassp|2027': Date.parse('2026-12-01T00:00:00.000Z') }
  const fresh = api.freshRows([
    { key: 'cvpr|2027', deadline: '2026-11-17T11:59:59.000Z' },
    { key: 'icassp|2027', deadline: '2026-12-03T00:00:00.000Z' },
    { key: 'stoc|2027', deadline: '2026-11-04T11:59:59.000Z' },
    { key: 'kdd|2027', deadline: null }
  ], seen)
  assert.deepEqual(fresh.map((row) => row.key), ['icassp|2027', 'stoc|2027'])
  assert.equal(api.freshRows([{ key: 'cvpr|2027', deadline: '2026-11-17T11:59:59.000Z' }], {}).length, 1)
})

test('conflictLine surfaces the other source and stays empty without a conflict', () => {
  const record = {
    alternatives: [
      { source: 'ccfddl-api', deadline: '2026-11-14T07:59:59.000Z' },
      { source: 'paper-deadlines', deadline: null },
    ],
  }
  const text = api.conflictLine(record, 'Asia/Shanghai')
  assert.match(text, /^另一来源：ccfddl-api 2026-11-14 15:59/)
  assert.match(text, /paper-deadlines/)
  assert.equal(api.conflictLine({ alternatives: [] }), '')
  assert.equal(api.conflictLine({}), '')
})

test('countdownLabel covers future and past', () => {
  const now = Date.parse('2026-10-31T00:00:00Z')
  const target = now + ((13 * 24 + 9) * 3600000) + 5 * 60000
  assert.equal(api.countdownLabel(target, now), '还剩 13 天 9 小时')
  assert.equal(api.countdownLabel(now - ((2 * 24 + 3) * 3600000), now), '已过 2 天 3 小时')
  assert.equal(api.countdownLabel(null, now), '')
})

const NOW = Date.parse('2026-10-31T00:00:00Z')
const iso = (daysFromNow) => new Date(NOW + daysFromNow * 86400000).toISOString()
const PAYLOAD = {
  ok: true,
  schema: 'dsh-ccf/panel/v1',
  now: new Date(NOW).toISOString(),
  timezone: 'Asia/Shanghai',
  updatedAt: new Date(NOW - 3600000).toISOString(),
  count: 4,
  records: [
    { key: 'aaai|2027', venue: 'AAAI', year: 2027, name: 'AAAI 2027', rank: 'CCF-A', area: 'AI/ML', deadline: iso(10), notification: iso(70), rebuttal: null, cameraReady: null, confDate: '2027-02', place: 'Vancouver', link: 'https://aaai.org', aliases: ['AAAI'] },
    { key: 'cvpr|2027', venue: 'CVPR', year: 2027, name: 'CVPR 2027', rank: 'CCF-A', area: 'CV', deadline: iso(-5), notification: null, rebuttal: null, cameraReady: null, confDate: '2027-06', place: 'Honolulu', link: '', aliases: [] },
    { key: 'iclr|2027', venue: 'ICLR', year: 2027, name: 'ICLR 2027', rank: 'CCF-A', area: 'AI/ML', deadline: iso(200), notification: null, rebuttal: null, cameraReady: null, confDate: '2027-04', place: 'Singapore', link: '', aliases: ['ICLR'] },
    { key: 'kdd|2027', venue: 'KDD', year: 2027, name: 'KDD 2027', rank: 'CCF-A', area: 'Data Mining', deadline: null, notification: null, rebuttal: null, cameraReady: null, confDate: '2027-08', place: '', link: '', aliases: [] },
  ],
}

test('buildRows keeps the near window, drops the far one, sorts by deadline', () => {
  const rows = api.buildRows(PAYLOAD, { now: NOW, days: 120, keepUndated: false })
  assert.deepEqual(rows.map((row) => row.record.venue), ['AAAI'])
  assert.equal(rows[0].daysLeft, 10)
})

test('buildRows puts undated records last when asked to keep them', () => {
  const rows = api.buildRows(PAYLOAD, { now: NOW, days: 120 })
  assert.deepEqual(rows.map((row) => row.record.venue), ['AAAI', 'KDD'])
  assert.equal(rows[1].deadline, null)
})

test('buildRows filters by rank, area and search', () => {
  assert.deepEqual(api.buildRows(PAYLOAD, { now: NOW, days: 365, ranks: ['CCF-B'] }).length, 0)
  assert.deepEqual(api.buildRows(PAYLOAD, { now: NOW, days: 365, areas: ['CV'], includePast: true }).map((row) => row.record.venue), ['CVPR'])
  const searched = api.buildRows(PAYLOAD, { now: NOW, days: 365, search: 'iclr', keepUndated: false })
  assert.deepEqual(searched.map((row) => row.record.venue), ['ICLR'])
})

test('buildRows excludes passed deadlines unless includePast', () => {
  const fresh = api.buildRows(PAYLOAD, { now: NOW, days: 365, keepUndated: false })
  assert.deepEqual(fresh.map((row) => row.record.venue), ['AAAI', 'ICLR'])
  const withPast = api.buildRows(PAYLOAD, { now: NOW, days: 365, includePast: true, keepUndated: false })
  assert.deepEqual(withPast.map((row) => row.record.venue), ['CVPR', 'AAAI', 'ICLR'])
})

test('isStale follows updatedAt', () => {
  assert.equal(api.isStale(PAYLOAD, NOW, 24), false)
  assert.equal(api.isStale({ updatedAt: null }, NOW, 24), true)
  assert.equal(api.isStale({ updatedAt: new Date(NOW - 30 * 3600000).toISOString() }, NOW, 24), true)
})

test('isNew flags records mined within a day', () => {
  assert.equal(api.isNew({ minedAt: new Date(Date.now() - 3600000).toISOString() }), true)
  assert.equal(api.isNew({ minedAt: new Date(Date.now() - 3 * 86400000).toISOString() }), false)
  assert.equal(api.isNew({ minedAt: null }), false)
  assert.equal(api.isNew({}), false)
})

test('rankWeight orders CCF-A before non-CCF', () => {
  assert.ok(api.rankWeight('CCF-A') < api.rankWeight('CCF-B'))
  assert.ok(api.rankWeight('CCF-C') < api.rankWeight(''))
})

test('buildRows merges list-only conferences as pending rows', () => {
  const payload = {
    ...PAYLOAD,
    counts: { records: 4, conferences: 6, pending: 2, withDeadline: 3 },
    pending: [
      { key: 'pending|SIGKDD|CCF-A', abbr: 'SIGKDD', fullName: 'ACM SIGKDD Conference', rank: 'CCF-A', area: 'AI/ML', pending: true },
      { key: 'pending|ECAI|CCF-B', abbr: 'ECAI', fullName: 'European Conference on AI', rank: 'CCF-B', area: 'AI/ML', pending: true },
    ],
  }
  const rows = api.buildRows(payload, { now: NOW, days: 120, keepUndated: false })
  assert.deepEqual(rows.map((row) => row.record.venue), ['AAAI', 'SIGKDD', 'ECAI'])
  assert.equal(rows[1].record.pending, true)
  assert.equal(rows[1].deadline, null)

  const dataOnly = api.buildRows(payload, { now: NOW, days: 120, keepUndated: false, withoutPending: true })
  assert.deepEqual(dataOnly.map((row) => row.record.venue), ['AAAI'])

  const pendingOnly = api.buildRows(payload, { now: NOW, onlyPending: true })
  assert.deepEqual(pendingOnly.map((row) => row.record.venue), ['SIGKDD', 'ECAI'])

  const searched = api.buildRows(payload, { now: NOW, days: 120, search: 'sigkdd' })
  assert.deepEqual(searched.map((row) => row.record.venue), ['SIGKDD'])
})

test('urgentRows keeps only the next seven days', () => {
  const payload = {
    now: new Date(NOW).toISOString(),
    records: [
      { key: 'AAAI|2027', venue: 'AAAI', rank: 'CCF-A', deadline: new Date(NOW + 3 * 86400000).toISOString() },
      { key: 'ICML|2027', venue: 'ICML', rank: 'CCF-A', deadline: new Date(NOW + 30 * 86400000).toISOString() },
      { key: 'OLD|2026', venue: 'OLD', rank: 'CCF-B', deadline: new Date(NOW - 2 * 86400000).toISOString() },
    ],
    pending: [],
  }
  const urgent = api.urgentRows(payload, NOW, 7)
  assert.deepEqual(urgent.map((row) => row.record.venue), ['AAAI'])
})

test('updateSummary describes the last mining run', () => {
  assert.equal(api.updateSummary(null), '')
  assert.equal(api.updateSummary({}), '')
  const text = api.updateSummary({ lastUpdateAt: new Date(NOW).toISOString(), lastUpdateMined: 3, lastUpdateFailed: 2 })
  assert.match(text, /成功 3/)
  assert.match(text, /失败 2/)
})

test('versionLabel is empty when the host runs an old module', () => {
  assert.equal(api.versionLabel({ version: '0.4.1' }), 'dsh-ccf v0.4.1')
  assert.equal(api.versionLabel({}), '')
  assert.equal(api.versionLabel(null), '')
})

test('versionLabel says so when the disk has a newer version than the running module', () => {
  // 面板上不写这句，用户看到"界面没变化"只会以为改动没做进去。
  const stale = api.versionLabel({ version: '0.62.0', versionDisk: '0.64.0', versionStale: true })
  assert.equal(stale, 'dsh-ccf v0.62.0（磁盘上已是 v0.64.0：重启桌面端生效）')
  // 标记为 false 或没给磁盘版本时，仍然只印版本号。
  assert.equal(api.versionLabel({ version: '0.62.0', versionDisk: '0.64.0' }), 'dsh-ccf v0.62.0')
  assert.equal(api.versionLabel({ version: '0.62.0', versionStale: true, versionDisk: '' }), 'dsh-ccf v0.62.0')
})

test('progressLabel only speaks when the host says a run is in flight', () => {
  assert.equal(api.progressLabel(null), '')
  assert.equal(api.progressLabel({ busy: false }), '')
  const started = api.progressLabel({ busy: true, elapsedMs: 42000, total: null, index: null, ok: 0, failed: 0 })
  assert.match(started, /正在补数据/)
  assert.match(started, /42 秒/)
  const detailed = api.progressLabel({ busy: true, elapsedMs: 61000, total: 6, index: 3, current: 'CVPR', ok: 2, failed: 1 })
  assert.match(detailed, /正在补数据 3\/6：CVPR/)
  assert.match(detailed, /61 秒/)
  assert.match(detailed, /已补到 2 个，没补到 1 个/)
})

test('buildRows keeps pinned conferences regardless of window and past deadlines', () => {
  // CVPR 已过截稿、ICLR 在 200 天后，都在默认窗口之外；关注后必须还在，且排最前。
  const pinned = api.buildRows(PAYLOAD, { now: NOW, days: 120, pins: ['cvpr|2027', 'iclr|2027'], keepUndated: false })
  assert.deepEqual(pinned.map((row) => row.record.venue), ['CVPR', 'ICLR', 'AAAI'])
  assert.deepEqual(pinned.map((row) => row.pinned), [true, true, false])

  // 没关注时行为不变
  const plain = api.buildRows(PAYLOAD, { now: NOW, days: 120, pins: [], keepUndated: false })
  assert.deepEqual(plain.map((row) => row.record.venue), ['AAAI'])
})

test('onlyPinned narrows the list to the starred conferences', () => {
  const rows = api.buildRows(PAYLOAD, { now: NOW, days: 120, pins: ['cvpr|2027'], keepUndated: false, withoutPending: true, onlyPinned: true })
  assert.deepEqual(rows.map((row) => row.record.venue), ['CVPR'])
  // 关注列表为空时，「关注」视图就是空列表，不会退回成全部
  assert.deepEqual(api.buildRows(PAYLOAD, { now: NOW, pins: [], onlyPinned: true }), [])
})

test('togglePin adds, removes and never duplicates', () => {
  const first = api.togglePin([], 'aaai|2027')
  assert.deepEqual(first, ['aaai|2027'])
  const second = api.togglePin(first, 'cvpr|2027')
  assert.deepEqual(second.sort(), ['aaai|2027', 'cvpr|2027'])
  const third = api.togglePin(second, 'aaai|2027')
  assert.deepEqual(third, ['cvpr|2027'])
  assert.deepEqual(api.togglePin(third, ''), ['cvpr|2027'])
})

test('readPins tolerates missing or broken localStorage', () => {
  assert.deepEqual(api.readPins(), [])
})

test('buildRows search also matches place, direction and year', () => {
  const payload = {
    now: new Date(NOW).toISOString(),
    records: [
      { key: 'cvpr|2027', venue: 'CVPR', rank: 'CCF-A', area: 'CV', areaGroup: '人工智能', place: 'Honolulu, USA', year: 2027, deadline: new Date(NOW + 10 * 86400000).toISOString() },
      { key: 'icse|2027', venue: 'ICSE', rank: 'CCF-A', area: 'SE', areaGroup: '软件工程/系统软件/程序设计语言', place: 'Dublin', year: 2027, deadline: new Date(NOW + 20 * 86400000).toISOString() },
    ],
    pending: [],
  }
  const byPlace = api.buildRows(payload, { now: NOW, days: 120, search: 'honolulu' })
  assert.deepEqual(byPlace.map((row) => row.record.venue), ['CVPR'])
  const byArea = api.buildRows(payload, { now: NOW, days: 120, search: '软件工程' })
  assert.deepEqual(byArea.map((row) => row.record.venue), ['ICSE'])
})

test('buildIcs writes one all-day-ish event per deadline and skips past ones', () => {
  const text = api.buildIcs(
    [
      { key: 'cvpr|2027', record: { key: 'cvpr|2027', venue: 'CVPR', name: 'CVPR', year: 2027, rank: 'CCF-A', areaGroup: '人工智能', place: 'Honolulu, USA', deadline: new Date(NOW + 10 * 86400000).toISOString(), notification: new Date(NOW + 40 * 86400000).toISOString(), link: 'https://cvpr.thecvf.com' }, deadline: NOW + 10 * 86400000, notification: NOW + 40 * 86400000 },
      { key: 'old|2026', record: { key: 'old|2026', venue: 'OLD', year: 2026, deadline: new Date(NOW - 86400000).toISOString() }, deadline: NOW - 86400000, notification: null },
      { key: 'pending|FAST|CCF-A', record: { key: 'pending|FAST|CCF-A', venue: 'FAST', pending: true }, deadline: null, notification: null },
    ],
    { now: NOW, calendarName: 'CCF 会议截稿' },
  )
  assert.match(text, /^BEGIN:VCALENDAR/)
  assert.match(text, /VERSION:2\.0/)
  assert.match(text, /X-WR-CALNAME:CCF 会议截稿/)
  assert.match(text, /SUMMARY:CVPR 2027 截稿/)
  assert.match(text, /SUMMARY:CVPR 2027 审稿决定/)
  assert.match(text, /UID:cvpr\|2027-截稿@dsh-ccf/)
  assert.match(text, /DTSTART:2026111\dT/)
  assert.match(text, /URL:https:\/\/cvpr\.thecvf\.com/)
  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 2, '过期与待补的会不该进日历')
  assert.match(text, /END:VCALENDAR\r\n$/)
})

test('buildIcs adds a reminder and never repeats the year in the title', () => {
  const text = api.buildIcs(
    [{ key: 'cvpr|2027', record: { key: 'cvpr|2027', name: 'CVPR 2027', venue: 'CVPR', year: 2027, place: 'Honolulu', deadline: new Date(NOW + 5 * 86400000).toISOString() }, deadline: NOW + 5 * 86400000 }],
    { now: NOW },
  )
  assert.match(text, /SUMMARY:CVPR 2027 截稿/)
  assert.doesNotMatch(text, /CVPR 2027 2027/)
  assert.match(text, /BEGIN:VALARM\r\nTRIGGER:-P1D\r\nACTION:DISPLAY/)
  assert.match(text, /END:VALARM\r\nEND:VEVENT/)
})

test('buildIcs 把「另一个来源的说法」写进日历，别让导出来的日期看着像个定论', () => {
  const text = api.buildIcs(
    [
      {
        key: 'acl|2027',
        record: {
          key: 'acl|2027', venue: 'ACL', name: 'ACL 2027', year: 2027, rank: 'CCF-A',
          deadline: new Date(NOW + 10 * 86400000).toISOString(),
          alternatives: [{ source: 'paper-deadlines', deadline: NOW + 20 * 86400000 }],
        },
        deadline: NOW + 10 * 86400000,
        notification: null,
      },
      {
        key: 'cvpr|2027',
        record: { key: 'cvpr|2027', venue: 'CVPR', name: 'CVPR 2027', year: 2027, deadline: new Date(NOW + 12 * 86400000).toISOString() },
        deadline: NOW + 12 * 86400000,
        notification: null,
      },
    ],
    { now: NOW, timeZone: 'Asia/Shanghai' },
  )
  const flat = text.replace(/\r\n /g, '')
  assert.match(flat, /另一个来源的说法：paper-deadlines/, '冲突的会在日历描述里要留一句')
  assert.match(flat, /本条目用的是首选来源的日期/, '要说明这条用的是哪个')
  const cvprEvent = flat.slice(flat.indexOf('UID:cvpr|2027-截稿@dsh-ccf'))
  assert.doesNotMatch(cvprEvent.slice(0, 600), /另一个来源的说法/, '没冲突的会不该多这一句')
  // 描述里的时间要跟面板同一个时区：面板按 payload.timezone 显示，
  // 描述跟着浏览器本地时区走的话，两处时间对不上，用户会以为导错了。
  // （这一段只证明 buildIcs 尊重传入的 timeZone；"调用方真的传了"由下面那条接线测试守。）
  const utc = api.buildIcs(
    [{ key: 'acl|2027', record: { key: 'acl|2027', venue: 'ACL', name: 'ACL 2027', year: 2027, deadline: new Date(NOW + 10 * 86400000).toISOString(), alternatives: [{ source: 'paper-deadlines', deadline: NOW + 20 * 86400000 }] }, deadline: NOW + 10 * 86400000, notification: null }],
    { now: NOW, timeZone: 'UTC' },
  ).replace(/\r\n /g, '')
  assert.match(utc, /paper-deadlines \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '描述里的时间要按传入的时区渲染')
  const beijing = api.buildIcs(
    [{ key: 'acl|2027', record: { key: 'acl|2027', venue: 'ACL', name: 'ACL 2027', year: 2027, deadline: new Date(NOW + 10 * 86400000).toISOString(), alternatives: [{ source: 'paper-deadlines', deadline: NOW + 20 * 86400000 }] }, deadline: NOW + 10 * 86400000, notification: null }],
    { now: NOW, timeZone: 'Asia/Shanghai' },
  ).replace(/\r\n /g, '')
  assert.notEqual(
    utc.match(/另一个来源的说法：paper-deadlines ([^）]+)/)[1],
    beijing.match(/另一个来源的说法：paper-deadlines ([^）]+)/)[1],
    '换了时区，描述里的时间就该跟着变',
  )
})

test('foldLine keeps every ICS line inside the 75-byte limit', () => {
  const long = `DESCRIPTION:${'很长的会议全称'.repeat(12)}`
  const folded = api.foldLine(long)
  assert.ok(folded.includes('\r\n '), '超长行必须折行，续行以空格开头')
  for (const line of folded.split('\r\n')) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `折行后仍有超长行：${line.length}`)
  }
  assert.equal(api.foldLine('SUMMARY:short'), 'SUMMARY:short')
})

test('clipboardText renders a tab separated list for the current view', () => {
  const text = api.clipboardText(
    [
      { key: 'cvpr|2027', record: { key: 'cvpr|2027', venue: 'CVPR', name: 'CVPR', year: 2027, rank: 'CCF-A', areaGroup: '人工智能', place: 'Honolulu, USA' }, deadline: Date.parse('2026-11-17T11:59:59Z'), notification: null },
      { key: 'pending|FAST|CCF-A', record: { key: 'pending|FAST|CCF-A', venue: 'FAST', pending: true }, deadline: null, notification: null },
    ],
    'Asia/Shanghai',
  )
  const lines = text.split('\n')
  assert.equal(lines[0], '会议\t等级\t方向\t截稿\t审稿决定\t地点')
  assert.equal(lines[1], 'CVPR 2027\tCCF-A\t人工智能\t2026-11-17 19:59\t—\tHonolulu, USA')
  assert.match(lines[2], /^FAST\t\t\t待补\t—/)
})

test('clipboardText 把「另一个来源的说法」注在表下面', () => {
  const text = api.clipboardText(
    [
      {
        key: 'acl|2027',
        record: {
          key: 'acl|2027', venue: 'ACL', name: 'ACL 2027', year: 2027, rank: 'CCF-A',
          alternatives: [{ source: 'paper-deadlines', deadline: Date.parse('2026-11-27T11:59:59Z') }],
        },
        deadline: Date.parse('2026-11-17T11:59:59Z'),
        notification: null,
      },
    ],
    'Asia/Shanghai',
  )
  const lines = text.split('\n')
  assert.equal(lines[0], '会议\t等级\t方向\t截稿\t审稿决定\t地点', '表头仍在第一行，方便整段粘贴')
  // name 里已经有年份时不能再拼一次（真实数据的 name 就是「ACL 2027」）
  assert.equal(lines[1], 'ACL 2027\tCCF-A\t\t2026-11-17 19:59\t—\t', '名字里已有年份就别写两遍')
  assert.match(text, /注：ACL 2027 的截稿有两个说法——表里写的是 2026-11-17 19:59，另有 paper-deadlines 2026-11-27 19:59/)
  // 没有冲突时不该凭空多出一行注
  const quiet = api.clipboardText([{ key: 'cvpr|2027', record: { key: 'cvpr|2027', venue: 'CVPR', name: 'CVPR', year: 2027 }, deadline: Date.parse('2026-11-17T11:59:59Z'), notification: null }], 'Asia/Shanghai')
  assert.doesNotMatch(quiet, /注：/)
})

// 在假 React 元素树里找第一个文字等于 label 的按钮（children 里可能是数组）。
const findButton = (element, label) => {
  if (Array.isArray(element)) {
    for (const child of element) {
      const hit = findButton(child, label)
      if (hit) return hit
    }
    return null
  }
  if (!element || typeof element !== 'object') return null
  if (element.type === 'button' && (element.children || []).join('') === label) return element
  return findButton(element.children || [], label)
}

test('alternativesView lists the other source and offers to adopt it', () => {
  const calls = []
  const record = {
    key: 'cvpr|2027',
    venue: 'CVPR',
    year: 2027,
    alternatives: [{ source: 'paper-deadlines', deadline: '2026-11-14T07:59:59.000Z' }],
  }
  const node = api.alternativesView(record, 'Asia/Shanghai', (key, source) => calls.push([key, source]))
  const text = JSON.stringify(node)
  assert.match(text, /paper-deadlines/)
  assert.match(text, /2026-11-14 15:59/)
  assert.match(text, /采信/)
  // 没有另一种说法时什么都不画
  assert.equal(api.alternativesView({ key: 'x', alternatives: [] }, 'Asia/Shanghai', () => {}), null)
  // 点了「采信」会把 key 与来源交给上层
  const button = findButton(node, '采信')
  button.props.onClick({ stopPropagation: () => {} })
  assert.deepEqual(calls, [['cvpr|2027', 'paper-deadlines']])
})

const { describeFailure } = api

test('describeFailure 把原始异常翻成能照做的一句话', () => {
  // 旧模块：路由没挂上，返回的是 SPA 首页
  assert.match(describeFailure({ status: 200, text: '<!doctype html><html></html>' }), /重启/)
  assert.match(describeFailure({ status: 404 }), /路由不存在/)
  assert.match(describeFailure({ status: 403 }), /回环/)
  assert.match(describeFailure({ status: 500, text: '{"ok":false,"error":"boom"}' }), /HTTP 500/)
  // 网络层失败：fetch 抛 TypeError
  assert.match(describeFailure({ failure: Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' }), text: '' }), /连不上本地服务/)
  // 兜底：不认识的消息也别吞掉
  assert.match(describeFailure({ failure: new Error('weird'), text: '' }), /weird/)
})

const { sourcesWarning } = api

test('sourcesWarning 点名没拉到的源，全成功时保持安静', () => {
  assert.equal(sourcesWarning(null), '')
  assert.equal(sourcesWarning({}), '')
  assert.equal(sourcesWarning({ sources: [] }), '')
  assert.equal(sourcesWarning({ sources: [{ id: 'a', ok: true }] }), '')
  assert.equal(
    sourcesWarning({ sources: [{ id: 'ccfddl-api', ok: true }, { id: 'paper-deadlines', ok: false }] }),
    '1/2 个源没拉到（paper-deadlines）',
  )
})

test('buildRows onlyMarked 只留裁决过的记录（标了不是这个会 / 确认了就是这个会）', () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const payload = {
    count: 3,
    records: [
      { key: 'a|2027', venue: 'CVPR', name: 'CVPR 2027', deadline: new Date(now + 20 * 86400e3).toISOString() },
      { key: 'b|2027', venue: 'SEC', name: 'SEC 2027', deadline: new Date(now + 30 * 86400e3).toISOString(), ignored: true },
      { key: 'c|2027', venue: 'IJCB', name: 'IJCB 2027', deadline: new Date(now + 40 * 86400e3).toISOString(), confirmed: true },
    ],
  }
  const marked = buildRows(payload, { now, days: 120, onlyMarked: true, withoutPending: true })
  assert.deepEqual(marked.map((row) => row.record.venue), ['SEC', 'IJCB'], '只留标了/确认过的')
  const all = buildRows(payload, { now, days: 120, withoutPending: true })
  assert.equal(all.length, 3, '不看这个开关时三条都在')
})

test('buildRows onlyConflicts 只留两个源说法不一致的记录', () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const payload = {
    count: 3,
    records: [
      { key: 'a|2027', venue: 'CVPR', name: 'CVPR 2027', deadline: new Date(now + 20 * 86400e3).toISOString() },
      { key: 'b|2027', venue: 'ICLR', name: 'ICLR 2027', deadline: new Date(now + 30 * 86400e3).toISOString(), conflict: true },
      { key: 'c|2027', venue: 'IJCB', name: 'IJCB 2027', deadline: new Date(now + 40 * 86400e3).toISOString(), conflict: false },
    ],
  }
  const only = buildRows(payload, { now, days: 120, onlyConflicts: true, withoutPending: true })
  assert.deepEqual(only.map((row) => row.record.venue), ['ICLR'], '只留标了冲突的那条')
  const all = buildRows(payload, { now, days: 120, withoutPending: true })
  assert.equal(all.length, 3, '不开这个视图时三条都在')
})

test('buildRows 默认不列卫星会，includeSatellites 才列（已裁决视图照样看得到）', () => {
  const now = Date.parse('2026-11-01T00:00:00Z')
  const payload = {
    count: 2,
    records: [
      { key: 'cvpr|2027', venue: 'CVPR', name: 'CVPR 2027', deadline: new Date(now + 20 * 86400e3).toISOString() },
      {
        key: 'cvpr workshops|2027', venue: 'CVPR Workshops', name: 'CVPR Workshops 2027',
        deadline: new Date(now + 5 * 86400e3).toISOString(), satellite: true,
      },
    ],
  }
  const plain = buildRows(payload, { now, days: 120, withoutPending: true })
  assert.deepEqual(plain.map((row) => row.record.venue), ['CVPR'], '卫星会默认不混进主会列表')
  const withSat = buildRows(payload, { now, days: 120, withoutPending: true, includeSatellites: true })
  assert.deepEqual(withSat.map((row) => row.record.venue), ['CVPR Workshops', 'CVPR'], '打开开关才列，按截稿先后排')
  // 「已裁决」视图是用户主动去找自己标过的会，卫星会也标过，就别再藏
  const marked = buildRows(
    { count: 1, records: [{ ...payload.records[1], ignored: true }] },
    { now, days: 120, withoutPending: true, onlyMarked: true },
  )
  assert.deepEqual(marked.map((row) => row.record.venue), ['CVPR Workshops'], '已裁决视图仍能看到卫星会')
})

for (const [name, fn] of tests) {
  await fn()
  console.log(`  ✓ ${name}`)
}
console.log(`client: ${tests.length} passed`)
