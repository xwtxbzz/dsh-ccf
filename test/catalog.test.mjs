// CCF 官方名单（data/ccf-catalog.json）的加载、统计与匹配。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync as writeSync, rmSync } from 'node:fs'
import { tmpdir as osTmp } from 'node:os'
import { join as joinPath } from 'node:path'
import { catalogConferences, catalogCoverage, catalogSummary, findInCatalog, inspectCatalog, isSatelliteRecord, loadCatalog, matchVenue, normalizeVenue, pickByFullName, relatedSatellites } from '../lib/catalog.js'

const catalog = loadCatalog()
assert.ok(catalog, '名单文件应该能读到')
assert.equal(catalog.schema, 'dsh-ccf/catalog/v1')
assert.match(catalog.sourceUrl, /ccf\.org\.cn/)
assert.ok(Array.isArray(catalog.areas) && catalog.areas.length === 10, '应有 10 个方向')

const conferences = catalogConferences(catalog)
assert.ok(conferences.length > 300, `会议数量应超过 300，实际 ${conferences.length}`)

const byAbbr = new Map(conferences.map((item) => [item.abbr.toUpperCase(), item]))
for (const [abbr, rank] of [['CVPR', 'CCF-A'], ['ICSE', 'CCF-A'], ['STOC', 'CCF-A'], ['SOSP', 'CCF-A']]) {
  const item = byAbbr.get(abbr)
  assert.ok(item, `${abbr} 应在名单里`)
  assert.equal(item.rank, rank, `${abbr} 应是 ${rank}`)
  assert.ok(item.area.length > 0, `${abbr} 应有方向`)
  assert.ok(item.fullName.length > 0, `${abbr} 应有全称`)
}

// CCF 官方简称是 SIGKDD
assert.ok(byAbbr.has('SIGKDD'), 'KDD 在官方名单里的简称是 SIGKDD')

// 同一个简称可以属于不同方向/等级（FSE：软工 A + 安全 B）
const fse = conferences.filter((item) => item.abbr === 'FSE')
assert.ok(fse.length >= 2, 'FSE 应有多条')
assert.ok(new Set(fse.map((item) => item.rank)).size >= 2, 'FSE 的两条等级应不同')

// 统计
const summary = catalogSummary(catalog)
assert.equal(summary.ok, true)
assert.equal(summary.conferences, conferences.length)
assert.equal(summary.byRank['CCF-A'] + summary.byRank['CCF-B'] + summary.byRank['CCF-C'], conferences.length)
assert.ok(summary.byRank['CCF-A'] > 0 && summary.byRank['CCF-B'] > 0 && summary.byRank['CCF-C'] > 0)

// 查找：简称精确 > 全称包含
assert.equal(findInCatalog(catalog, 'cvpr')[0].abbr, 'CVPR')
assert.equal(findInCatalog(catalog, 'CVPR 2027')[0].abbr, 'CVPR', '带年份也能命中')
assert.ok(findInCatalog(catalog, 'Neural Information Processing').some((item) => item.abbr === 'NeurIPS'))
assert.deepEqual(findInCatalog(catalog, '这不是一个会议'), [])
assert.equal(normalizeVenue('CVPR 2027 (CCF-A)'), 'cvpr')

// 缺文件时返回 null，不抛
assert.equal(loadCatalog('D:/doctor/definitely-not-here.json'), null)

// ---- 匹配与覆盖度：面板、/ccf status、系统提示必须用同一套算法 -----------------
const mini = {
  areas: [
    { area: '人工智能', conferences: { A: [{ abbr: 'CVPR', fullName: 'IEEE/CVF CVPR', dblp: '' }, { abbr: 'SIGKDD', fullName: 'ACM SIGKDD', dblp: '' }], B: [{ abbr: 'ECAI', fullName: 'European Conference on AI', dblp: '' }] } },
    { area: '计算机科学理论', conferences: { A: [{ abbr: 'STOC', fullName: 'ACM STOC', dblp: '' }] } },
    { area: '网络与信息安全', conferences: { A: [{ abbr: 'S&P', fullName: 'IEEE S&P', dblp: '' }] } },
  ],
}
const now = Date.parse('2026-10-31T00:00:00Z')
const records = [
  { venue: 'CVPR', deadline: now + 5 * 86400000 },          // 有未来截稿
  { venue: 'KDD', deadline: now + 40 * 86400000 },          // 惯例名 KDD → 名单 SIGKDD
  { venue: 'STOC', deadline: now - 30 * 86400000 },         // 只有往届
  // ECAI、S&P 没有记录
]
const cov = catalogCoverage(records, mini, { now })
assert.equal(cov.counts.total, 5)
assert.equal(cov.counts.future, 2, 'CVPR 与 SIGKDD 都应有未来截稿')
assert.equal(cov.counts.past, 1, 'STOC 只有往届')
assert.equal(cov.counts.never, 2, 'ECAI、S&P 一条记录都没有')
assert.equal(cov.counts.pending, 3)
assert.deepEqual(cov.past.map((item) => item.abbr), ['STOC'])
assert.deepEqual(cov.never.map((item) => item.abbr).sort(), ['ECAI', 'S&P'])
// matchVenue 不做双向包含
assert.equal(matchVenue('SPAA', { abbr: 'S&P' }), false)
assert.equal(matchVenue('CVPR Workshops', { abbr: 'CVPR' }), true)

// 名单外的会（CCFDDL 收了、CCF 名单没收）：既不算"有数据"，也不算"待补"，
// 但卡片确实在列表里 —— 单独数出来，否则读者拿 有数据+待补 对不上 362。
{
  const withOutside = [
    ...records,
    { venue: 'CoRL', deadline: now + 9 * 86400000 },   // 名单外，还有未来截稿
    { venue: 'CICAI', deadline: now - 9 * 86400000 },  // 名单外，日期已过
  ]
  const cov2 = catalogCoverage(withOutside, mini, { now })
  assert.equal(cov2.counts.outside, 2, '两个名单外的会')
  assert.equal(cov2.counts.outsideFuture, 1, '其中只有一个还有未来截稿')
  assert.equal(cov2.counts.future, 2, '名单外的会不该被算进"有未来截稿"')
  assert.equal(cov2.counts.pending, 3, '也不该被算进"待补"')
  assert.equal(cov2.counts.future + cov2.counts.pending, cov2.counts.total, '362 这套账仍自洽')
}

// 「个会」和「条记录」是两回事：CoRL 收了 2026 / 2027 两条，但只有一个会。
// 界面上说的是"个会"，数字就得按会去重，否则一个会会被报成两个。
{
  const multiYear = [
    ...records,
    { venue: 'CoRL', year: 2026, deadline: now + 9 * 86400000 },
    { venue: 'CoRL', year: 2027, deadline: now + 400 * 86400000 },
    { venue: 'CICAI', year: 2026, deadline: now - 9 * 86400000 },
  ]
  const cov3 = catalogCoverage(multiYear, mini, { now })
  assert.equal(cov3.counts.outside, 3, '三条记录')
  assert.equal(cov3.counts.outsideVenues, 2, '但只有两个会')
  assert.equal(cov3.counts.outsideFuture, 2, '其中两条还有未来截稿')
}

// 名单里同简称的两个会：一份数据只能算给其中一个，否则两个会同时"有数据"
{
  const dual = {
    areas: [
      { area: '网络与信息安全', conferences: { B: [{ abbr: 'FSE', fullName: 'Fast Software Encryption', dblp: '' }] } },
      { area: '软件工程/系统软件/程序设计语言', conferences: { A: [{ abbr: 'FSE', fullName: 'ACM International Conference on the Foundations of Software Engineering', dblp: '' }] } },
      // asia 后缀：MMAsia 是独立会，不能被 ACM MM 的数据喂饱
      { area: '计算机图形学与多媒体', conferences: { A: [{ abbr: 'ACM MM', fullName: 'ACM International Conference on Multimedia', dblp: '' }], C: [{ abbr: 'MMAsia', fullName: 'ACM Multimedia Asia', dblp: '' }] } },
    ],
  }
  const rows = [
    { venue: 'FSE', fullName: 'Fast Software Encryption', deadline: now + 10 * 86400000 },
    { venue: 'MMAsia', fullName: 'ACM Multimedia Asia', deadline: now + 20 * 86400000 },
  ]
  const cover = catalogCoverage(rows, dual, { now })
  assert.equal(cover.counts.total, 4)
  assert.equal(cover.counts.future, 2, '只有真正对应的两个会算有数据')
  assert.equal(cover.counts.never, 2, '软工 FSE 与 ACM MM 仍应待补')
  assert.deepEqual(cover.future.map((item) => item.area).sort(), ['网络与信息安全', '计算机图形学与多媒体'])
  // 归属判定：全称完全一致的胜出
  const candidates = catalogConferences(dual).filter((conference) => matchVenue('FSE', conference))
  assert.equal(candidates.length, 2, '两个 FSE 都应被简称匹配到')
  assert.equal(pickByFullName(rows[0], candidates).area, '网络与信息安全')
}

// 简称撞车但全称毫无关系：宁可不认领，把数据算"名单外"，也不塞给别的会
{
  const ambiguous = {
    areas: [
      { area: '网络与信息安全', conferences: { A: [{ abbr: 'USENIX Security', fullName: 'USENIX Security Symposium', dblp: '' }] } },
      { area: '网络与信息安全', conferences: { C: [{ abbr: 'SEC', fullName: 'IFIP International Information Security Conference', dblp: '' }] } },
    ],
  }
  const edge = [{ venue: 'SEC', key: 'sec|2026', fullName: 'ACM/IEEE Symposium on Edge Computing', deadline: now + 3 * 86400000 }]
  const cover = catalogCoverage(edge, ambiguous, { now })
  // 只有一个同简称候选时仍然认领（不然会把真数据的措辞差异当成"名单外"），
  // 但全称一个字都对不上必须记一笔，让界面能提示核对。
  assert.equal(cover.counts.weakMatches, 1, '边缘计算的 SEC 要标"全称对不上，建议核对"')
  assert.equal(cover.weakMatches[0].abbr, 'SEC')
  assert.equal(cover.counts.outside, 0)
  // 反过来：真的 USENIX Security 记录要被认领
  const real = [{ venue: 'USENIX Security', fullName: 'USENIX Security Symposium', deadline: now + 3 * 86400000 }]
  const cov2 = catalogCoverage(real, ambiguous, { now })
  assert.equal(cov2.counts.future, 1)
  assert.equal(cov2.future[0].abbr, 'USENIX Security', '应归给 USENIX Security 而不是 SEC')
}

// 名单读不出来时不能装作"没有名单"：三种状态要分开，否则面板/状态会静默显示 0 个会
{
  const dir = mkdtempSync(joinPath(osTmp(), 'ccf-cat-'))
  const ok = inspectCatalog()
  assert.equal(ok.state, 'ok', '自带名单应能读')
  assert.ok(ok.catalog, '自带名单应有内容')
  assert.equal(ok.error, '', '读成功时没有错误')

  const missing = inspectCatalog(joinPath(dir, 'nope.json'))
  assert.equal(missing.state, 'missing')
  assert.equal(missing.catalog, null)
  assert.match(missing.path, /nope\.json$/)

  writeSync(joinPath(dir, 'bad.json'), '{"schema":"dsh-ccf/catalog/v1","areas":[{"area":"', 'utf8')
  const corrupt = inspectCatalog(joinPath(dir, 'bad.json'))
  assert.equal(corrupt.state, 'corrupt')
  assert.match(corrupt.error, /JSON 解析失败/)

  writeSync(joinPath(dir, 'noareas.json'), JSON.stringify({ schema: 'dsh-ccf/catalog/v1' }), 'utf8')
  const odd = inspectCatalog(joinPath(dir, 'noareas.json'))
  assert.equal(odd.state, 'corrupt')
  assert.match(odd.error, /缺少 areas/)

  // loadCatalog 的老语义不变：读不到一律 null
  assert.equal(loadCatalog(joinPath(dir, 'nope.json')), null)
  rmSync(dir, { recursive: true, force: true })
}

// 用户标过「不是这个会」的记录：不喂任何会，覆盖度里算名单外
{
  const mini = {
    areas: [{ area: '人工智能', journals: { A: [], B: [], C: [] }, conferences: { A: [{ abbr: 'CVPR', fullName: 'IEEE/CVF CVPR' }, { abbr: 'USENIX Security', fullName: 'USENIX Security Symposium' }], B: [], C: [] } }],
  }
  const now = Date.parse('2026-11-01T00:00:00Z')
  const records = [
    { key: 'cvpr|2027', venue: 'CVPR', deadline: now + 10 * 86400e3 },
    { key: 'secret|2026', venue: 'USENIX Security', deadline: now + 20 * 86400e3 },
  ]
  const plain = catalogCoverage(records, mini, { now })
  assert.equal(plain.counts.future, 2, '两条都先算成有数据')
  assert.equal(plain.counts.outside, 0, '两条都对得上名单')
  const ignored = catalogCoverage(records, mini, { now, ignoredKeys: new Set(['secret|2026']) })
  assert.equal(ignored.counts.future, 1, '标过的那条不再算进任何会')
  assert.equal(ignored.counts.outside, 1, '算名单外')
  assert.equal(ignored.counts.pending, 1, '它不再占用待补名额')
}

const confirmedRun = catalogCoverage([
  { key: 'sec|2026', venue: 'SEC', name: 'SEC 2026', deadline: Date.now() + 86400e3 },
], null, {
  now: Date.now(),
  conferences: [{ abbr: 'SEC', fullName: 'USENIX Security Symposium', rank: 'CCF-A', area: '网络与信息安全' }],
  confirmedKeys: new Set(['sec|2026']),
})
assert.equal(confirmedRun.counts.weakMatches, 0, '确认过的记录不再提示核对')
assert.equal(confirmedRun.counts.future, 1, '但它仍然算这个会的数据')

// 卫星会（workshop / 地区分会场）单独一类：不喂主会，也不再提示「建议核对」
{
  const satCatalog = {
    areas: [
      {
        area: '计算机图形学与多媒体',
        conferences: {
          A: [{ abbr: 'SIGGRAPH', fullName: 'ACM Special Interest Group on Computer Graphics', publisher: 'ACM', dblp: 'http://dblp/siggraph' }],
          B: [],
          C: [],
        },
      },
    ],
  }
  const satConferences = catalogConferences(satCatalog)
  const mainRow = {
    key: 'siggraph|2027', venue: 'SIGGRAPH', year: 2027, name: 'SIGGRAPH 2027',
    fullName: 'ACM SIGGRAPH Annual Conference', rank: 'CCF-A', area: '计算机图形学与多媒体',
    deadline: Date.now() + 30 * 86400000,
  }
  const asiaRow = {
    key: 'acm siggraph asia|2026', venue: 'ACM SIGGRAPH ASIA', year: 2026, name: 'ACM SIGGRAPH ASIA 2026',
    fullName: 'ACM SIGGRAPH Annual Conference in Asia', rank: 'CCF-A', area: '计算机图形学与多媒体',
    deadline: Date.now() + 10 * 86400000,
  }
  const workshopRow = {
    key: 'cvpr workshops|2027', venue: 'CVPR Workshops', year: 2027, name: 'CVPR Workshops 2027',
    fullName: 'CVPR 2027 Workshops (paper submission, varies by workshop)', rank: 'CCF-A', area: '人工智能',
    deadline: Date.now() + 5 * 86400000,
  }
  assert.equal(isSatelliteRecord(asiaRow, satConferences[0]), true, '地区版是卫星会')
  assert.equal(isSatelliteRecord(workshopRow, satConferences[0]), true, 'workshop 是卫星会')
  assert.equal(isSatelliteRecord(mainRow, satConferences[0]), false, '主会自己不是卫星会')
  const satCov = catalogCoverage([mainRow, asiaRow, workshopRow], satCatalog, { now: Date.now(), conferences: satConferences })
  assert.equal(satCov.counts.satellites, 2, '两条卫星会都要数出来')
  // 卫星会单独一档，不能再算进「名单外」，否则两块数字互相包含、加起来超过记录数
  assert.equal(satCov.counts.outside, 0, '有归属会的卫星会不算名单外')
  // 卫星会本身不进「建议核对」；主会那条因为名单全称措辞不同，仍会被标成待核对（这是既有行为）
  assert.equal(satCov.counts.weakMatches, 1, '卫星会不该再提示「建议核对」')
  assert.ok(!satCov.weakMatches.some((item) => item.key.includes('workshops') || /asia/i.test(item.venue)), '标出来的只能是主会那条')
  assert.equal(satCov.counts.future, 1, '主会仍算有数据，且只由主会自己那条喂')
  const ownWorkshop = { abbr: 'WOW', fullName: 'ACM Workshop on Something', publisher: 'ACM', dblp: '' }
  assert.equal(isSatelliteRecord({ fullName: 'ACM Workshop on Something' }, ownWorkshop), false, '名单里的 workshop 会是正经会议')
}

{
  const rows = [
    { key: 'siggraph|2027', venue: 'SIGGRAPH', name: 'SIGGRAPH 2027', fullName: 'ACM SIGGRAPH Annual Conference' },
    { key: 'acm siggraph asia|2026', venue: 'ACM SIGGRAPH ASIA', name: 'ACM SIGGRAPH ASIA 2026', fullName: 'ACM SIGGRAPH Annual Conference in Asia' },
    { key: 'cvpr workshops|2027', venue: 'CVPR Workshops', name: 'CVPR Workshops 2027', fullName: 'CVPR 2027 Workshops' },
  ]
  const sig = relatedSatellites(rows, 'SIGGRAPH')
  assert.equal(sig.length, 1, '查 SIGGRAPH 只该带出它自己的地区版')
  assert.equal(sig[0].key, 'acm siggraph asia|2026')
  assert.equal(relatedSatellites(rows, 'CVPR').length, 1, 'CVPR Workshops 是 CVPR 的卫星会')
  assert.equal(relatedSatellites(rows, 'ICML').length, 0, '没有卫星会时返回空数组')
}

console.log('catalog.test: 全部通过')
