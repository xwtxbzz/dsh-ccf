/**
 * 装配层测试：工具、命令、prompt 段（用替身 defineTool + 替身 ctx，不联网）。
 *
 * 运行：node test/plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCcf, parseFlags } from '../lib/create.js'
import { loadCache, saveCache } from '../lib/sync.js'

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const fakeDefineTool = (definition) => definition
const DAY = 24 * 60 * 60 * 1000

function fakeContext() {
  const registered = { tools: [], commands: [], sections: [] }
  return {
    registered,
    ctx: {
      logger: { info() {}, warn() {}, error() {} },
      services: {
        tools: { register: (tool) => registered.tools.push(tool) },
        commands: { register: (command) => registered.commands.push(command) },
        systemPrompt: { section: (section) => registered.sections.push(section) },
      },
      get(name) { return this.services[name] },
      on() { return () => {} },
    },
  }
}

const NOW = Date.now()

const sampleRecords = [
  {
    key: 'cvpr|2027', venue: 'CVPR', year: 2027, name: 'CVPR 2027',
    fullName: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition',
    rank: 'CCF-A', area: 'CV', core: 'A*',
    abstractDeadline: NOW + 6 * 86400e3, deadline: NOW + 13 * 86400e3, notification: NOW + 80 * 86400e3,
    confDate: '2027-06', place: 'TBD', link: 'https://cvpr.thecvf.com', submitLink: '',
    aliases: [], acceptRate: '~23%', h5: 300, history: ['2026-11-14'], verified: false, source: 'paper-deadlines',
  },
  {
    key: 'icassp|2027', venue: 'ICASSP', year: 2027, name: 'ICASSP 2027', fullName: 'IEEE ICASSP',
    rank: 'CCF-B', area: 'Speech', core: '', abstractDeadline: null, deadline: NOW + 40 * 86400e3,
    notification: null, confDate: '2027-05', place: 'TBD', link: 'https://2027.ieeeicassp.org', submitLink: '',
    aliases: [], acceptRate: '', h5: null, history: [], verified: false, source: 'paper-deadlines',
  },
  {
    key: 'kdd|2027', venue: 'KDD', year: 2027, name: 'KDD 2027 (Cycle 1)', fullName: 'ACM SIGKDD',
    rank: 'CCF-A', area: 'Data Mining', core: '', abstractDeadline: null, deadline: NOW + 120 * 86400e3,
    notification: null, confDate: '2027-08', place: 'TBD', link: 'https://kdd.org', submitLink: '',
    aliases: ['SIGKDD'], acceptRate: '', h5: null, history: [], verified: false, source: 'paper-deadlines',
  },
]

const seeded = async (overrides = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ccf-plugin-'))
  await mkdir(dir, { recursive: true })
  const records = Array.isArray(overrides.records) ? overrides.records : sampleRecords
  await writeFile(join(dir, 'cache.json'), JSON.stringify({
    schema: 'dsh-ccf/cache/v1',
    updatedAt: overrides.updatedAt ?? NOW - 3600e3,
    reports: overrides.reports ?? [{ id: 'paper-deadlines', ok: true, count: records.length }],
    // 上一轮挖掘留下的旧数字：status 不该拿它当准数（曾经 status 说 56、面板说 250）。
    meta: overrides.meta ?? { pending: 999 },
    records,
  }), 'utf8')
  return dir
}

console.log('plugin.test')

await test('注册 3 个工具 / 1 个命令 / 1 段 prompt', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)
    assert.equal(registered.tools.length, 3)
    assert.deepEqual(registered.tools.map((tool) => tool.name), ['ccf_deadlines', 'ccf_venue', 'ccf_update'])
    assert.equal(registered.commands.length, 1)
    assert.equal(registered.commands[0].name, 'ccf')
    assert.equal(registered.sections.length, 1)
    assert.equal(registered.sections[0].name, 'dsh-ccf')
    assert.equal(registered.sections[0].order, 150)
    assert.equal(typeof registered.sections[0].text, 'function', 'prompt 段必须是动态 provider')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('ccf_deadlines：默认窗口 120 天、按时间排序', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)
    const tool = registered.tools.find((item) => item.name === 'ccf_deadlines')
    const value = await tool.execute({})
    assert.equal(value.ok, true)
    assert.match(value.report, /CVPR 2027/)
    assert.match(value.report, /ICASSP 2027/)
    assert.match(value.report, /KDD 2027/)
    assert.equal(value.data.rows[0].venue, 'CVPR', '最近的排前面')
    assert.equal(value.data.rows.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('ccf_deadlines：天数/等级/方向/关键词过滤', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)
    const tool = registered.tools.find((item) => item.name === 'ccf_deadlines')

    const short = await tool.execute({ days: 20 })
    assert.deepEqual(short.data.rows.map((row) => row.venue), ['CVPR'])

    const aOnly = await tool.execute({ rank: 'CCF-A' })
    assert.deepEqual(aOnly.data.rows.map((row) => row.venue), ['CVPR', 'KDD'])

    const speech = await tool.execute({ area: 'Speech' })
    assert.deepEqual(speech.data.rows.map((row) => row.venue), ['ICASSP'])

    const searched = await tool.execute({ search: 'sigkdd' })
    assert.deepEqual(searched.data.rows.map((row) => row.venue), ['KDD'], '别名也能搜到')

    const past = await tool.execute({ days: 120, includePast: true })
    assert.equal(past.data.rows.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('ccf_venue：命中与未命中', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)
    const tool = registered.tools.find((item) => item.name === 'ccf_venue')

    const hit = await tool.execute({ venue: 'cvpr' })
    assert.equal(hit.ok, true)
    assert.match(hit.report, /CVPR 2027 · CCF-A/)
    assert.match(hit.report, /https:\/\/cvpr\.thecvf\.com/)
    // 工具说明里承诺了"摘要截止、通知时间、rebuttal"，data 里就得有这些键，
    // 哪怕上游没给（那也要是 null，而不是让模型以为字段不存在）
    for (const field of ['abstractDeadline', 'notification', 'rebuttal']) {
      assert.ok(Object.hasOwn(hit.data.rows[0], field), `ccf_venue 的 data 里要有 ${field}`)
    }
    assert.equal(Object.hasOwn(hit.data.rows[0], 'cameraReady'), false, 'CR 时间已去掉，data 里不该再有这个键')
    // 只有 report 里有名字时，模型读到多行 data 就分不清哪行是哪个会
    assert.equal(hit.data.rows[0].venue, 'CVPR', 'data 的行要说明是哪个会')
    assert.equal(hit.data.rows[0].name, 'CVPR 2027', 'data 的行要有会名')
    assert.ok(Array.isArray(hit.data.satellites), 'data 要给卫星会数组（没有就是空数组）')

    const missing = await tool.execute({ venue: 'NIPS' })
    assert.equal(missing.ok, false)
    assert.match(missing.report, /既不在 CCF 名单/)

    const empty = await tool.execute({})
    assert.equal(empty.ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('ccf_venue：名单外 / 名单里但没数据 / 两套等级说法，都要讲清楚', async () => {
  const dir = await seeded()
  try {
    // 再塞一条名单里没有的会（ICLR 就是这种：数据里有、CCF 名单里没有）
    const cachePath = join(dir, 'cache.json')
    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
    cache.records.push({
      key: 'iclr|2027', venue: 'ICLR', year: 2027, name: 'ICLR 2027',
      fullName: 'International Conference on Learning Representations',
      rank: 'CCF-A', area: 'AI/ML', core: 'A*', abstractDeadline: null,
      deadline: NOW + 30 * 86400e3, notification: null, confDate: '2027-04',
      place: 'Singapore', link: 'https://iclr.cc', submitLink: '',
      aliases: [], acceptRate: '', h5: null, history: [], timezone: 'AoE',
      verified: false, source: 'ccfddl-api',
    })
    cache.records.push({
      key: 'neurips|2026', venue: 'NeurIPS', year: 2026, name: 'NeurIPS 2026',
      fullName: 'Conference on Neural Information Processing Systems',
      rank: 'CCF-A', area: 'AI/ML', core: 'A*', abstractDeadline: null,
      deadline: NOW - 100 * 86400e3, notification: null, confDate: '2026-12',
      place: 'Sydney', link: 'https://neurips.cc', submitLink: '',
      aliases: ['NIPS'], acceptRate: '', h5: null, history: [], timezone: 'UTC+00:00',
      verified: false, source: 'ccfddl-api',
    })
    await writeFile(cachePath, JSON.stringify(cache), 'utf8')
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)
    const tool = registered.tools.find((item) => item.name === 'ccf_venue')

    const unknown = await tool.execute({ venue: 'FOOBAR' })
    assert.equal(unknown.ok, false)
    assert.match(unknown.report, /既不在 CCF 名单/)
    assert.match(unknown.report, /名单外的会收不进「待补」/)

    const pending = await tool.execute({ venue: 'STOC' })
    assert.equal(pending.ok, false)
    assert.match(pending.report, /名单里有「STOC/)
    assert.match(pending.report, /--focus STOC/)

    const outside = await tool.execute({ venue: 'ICLR' })
    assert.equal(outside.ok, true)
    assert.match(outside.report, /这个会不在 CCF 名单/)
    assert.match(outside.report, /来自 CCFDDL/)

    // 别名不算名单外：搜 NIPS 命中 NeurIPS，而 CCF 名单里写的就是 NeurIPS。
    const alias = await tool.execute({ venue: 'NIPS' })
    assert.equal(alias.ok, true)
    assert.match(alias.report, /NeurIPS 2026/)
    assert.doesNotMatch(alias.report, /不在 CCF 名单/)

    // 名单里有两个都叫 FSE 的会（软工 CCF-A / 安全 CCF-B）：要说清数据属于哪一个，
    // 否则读者会以为"同一个会两个等级"。
    {
      const cache = JSON.parse(await readFile(cachePath, 'utf8'))
      cache.records.push({
        key: 'fse|2027', venue: 'FSE', year: 2027, name: 'FSE 2027',
        fullName: 'Fast Software Encryption',
        rank: 'CCF-B', area: 'SC', core: 'A', abstractDeadline: null,
        deadline: NOW + 60 * 86400e3, notification: null, confDate: '2027-05',
        place: 'Maastricht', link: 'https://fse.iacr.org/2027/', submitLink: '',
        aliases: [], acceptRate: '', h5: null, history: [], timezone: 'UTC-12:00',
        verified: false, source: 'ccfddl-api',
      })
      await writeFile(cachePath, JSON.stringify(cache), 'utf8')
      const dual = await tool.execute({ venue: 'FSE' })
      assert.equal(dual.ok, true)
      assert.match(dual.report, /FSE 2027/, '要能查到这条记录')
      assert.match(dual.report, /2 个简称都是「FSE」的会/, '两个同简称的会要说出来')
      assert.match(dual.report, /更接近 CCF-B/, '要说清数据属于哪一个')
      assert.match(dual.report, /CCF-A/, '另一个会也要点名')
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('没有缓存：自动尝试同步，失败也如实说明而不是编日期', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ccf-empty-'))
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, {
      dataDir: dir,
      timeoutMs: 2000,
      sources: [{ id: 'dead', type: 'json', url: 'http://127.0.0.1:9/data.json' }],
    }, fakeDefineTool)
    const tool = registered.tools.find((item) => item.name === 'ccf_deadlines')
    const value = await tool.execute({})
    assert.equal(value.ok, false)
    assert.match(value.report, /还没有会议数据/)
    assert.match(value.report, /同步失败|取不到/)
    assert.equal(value.data.rows.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('同一时间只跑一轮补数据：第二次立刻回 busy，不排第二轮', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ccf-busy-'))
  try {
    const { ctx } = fakeContext()
    const ccf = createCcf(ctx, {
      dataDir: dir,
      timeoutMs: 500,
      // 没有源 → 回退同步会立刻失败，测试不依赖网络，也不拖时间。
      sources: [],
      autoUpdate: false,
    }, fakeDefineTool)
    const first = ccf.doUpdate({ limit: 1 })
    const second = await ccf.doUpdate({ limit: 1 })
    assert.equal(second.busy, true)
    assert.match(second.note, /还在跑/)
    await first.catch(() => {})
    // 跑完之后可以再来一轮（不再是 busy）。
    const third = await ccf.doUpdate({ limit: 1 }).catch(() => ({ busy: false }))
    assert.notEqual(third.busy, true)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('/ccf status 与 /ccf config', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir, leadDays: 45 }, fakeDefineTool)
    const command = registered.commands[0]

    const status = await command.handler({ rawInput: 'status' })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /缓存里 3 条记录/, '缓存里是记录数，别写成「3 条会议」——会议是按会算的')
    assert.match(status.text, /去重后 3 个会/, '记录数与会数分开写')
    assert.match(status.text, /paper-deadlines：3 条/)
    assert.match(status.text, /「📅 会议」标签/, 'status 要告诉人面板在哪')
    // 覆盖度跟面板同源：旧的 meta.pending(999) 不该出现在 status 里。
    assert.match(status.text, /覆盖：\d+ 个有未来截稿，\d+ 个待补/)
    assert.match(status.text, /名单共 362 个会/)
    assert.doesNotMatch(status.text, /999/)

    const empty = await createCcf(fakeContext().ctx, { dataDir: join(dir, 'nope') }, fakeDefineTool)
    assert.ok(empty)

    const config = await command.handler({ rawInput: 'config' })
    assert.equal(config.kind, 'success')
    assert.match(config.text, /默认窗口：120 天/)
    assert.match(config.text, /prompt 注入窗口：45 天/)
    // 时区跟着这台机器走（CI 是 UTC、海外服务器是别的），不能断言写死的北京时间。
    const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    assert.ok(config.text.includes(`时区：${machineZone}`), `config 的时区应该是本机的（${machineZone}）`)
    // config 必须列出真正在用的第一数据源（CCFDDL 接口），而不是写死的旧默认值。
    assert.match(config.text, /ccfddl-api/)
    assert.match(config.text, /allconf\.json/)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('/ccf status：磁盘上的版本比进程新时要说"重启桌面端才会生效"', async () => {
  // 真机上撞到过：进程里跑的是 0.62.0，磁盘已经 0.63.1，而界面上只印「v0.62.0」，
  // 用户完全不知道"改了没生效"是因为没重启。这条提示就是为此存在的。
  const dir = await seeded()
  try {
    const stale = fakeContext()
    createCcf(stale.ctx, {
      dataDir: dir,
      versionState: () => ({ running: '0.62.0', disk: '0.64.0', stale: true }),
    }, fakeDefineTool)
    const text = (await stale.registered.commands[0].handler({ rawInput: 'status' })).text
    assert.match(text, /磁盘上已是 v0\.64\.0：重启桌面端才会生效/)

    const fresh = fakeContext()
    createCcf(fresh.ctx, { dataDir: dir }, fakeDefineTool)
    const plain = (await fresh.registered.commands[0].handler({ rawInput: 'status' })).text
    assert.doesNotMatch(plain, /磁盘上已是/, '版本一致时不该出现这句提示')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('/ccf status 会把"名单外的会"单独说出来', async () => {
  // 真实缓存里差不多少 68 张卡是这种：CCFDDL 收了、CCF 名单没收（CoRL / EACL / CICAI…）。
  // 它们既不算"有数据"也不算"待补"，用户拿 有数据+待补 对 362 就会差几个数。
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ccf-outside-'))
  try {
    await writeFile(join(dir, 'cache.json'), JSON.stringify({
      schema: 'dsh-ccf/cache/v1',
      updatedAt: NOW,
      reports: [{ id: 'ccfddl-api', ok: true, count: 2 }],
      records: [
        sampleRecords[0],
        { key: 'corl|2026', venue: 'CoRL', year: 2026, name: 'CoRL 2026', rank: 'Non-CCF', source: 'ccfddl-api', deadline: NOW + 10 * 86400e3 },
      ],
    }), 'utf8')
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)

    const status = await registered.commands[0].handler({ rawInput: 'status' })
    assert.match(status.text, /另有 1 个名单外的会/)

    const list = await registered.commands[0].handler({ rawInput: 'list 60' })
    assert.match(list.text, /另有 1 个名单外的会（CCFDDL 收录、CCF 名单未收/)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('/ccf list：位置参数天数 + 旗标', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir }, fakeDefineTool)
    const command = registered.commands[0]

    const list = await command.handler({ rawInput: 'list 20' })
    assert.equal(list.kind, 'success')
    assert.match(list.text, /CVPR 2027/)
    assert.doesNotMatch(list.text, /ICASSP/)
    assert.match(list.text, /数据同步于/)

    const filtered = await command.handler({ rawInput: 'list 200 --rank CCF-A --search kdd' })
    assert.match(filtered.text, /KDD 2027/)
    assert.doesNotMatch(filtered.text, /ICASSP/)

    const bare = await command.handler({ rawInput: '' })
    assert.equal(bare.kind, 'success', '空输入等价于 list')

    const unknown = await command.handler({ rawInput: 'whatever' })
    assert.equal(unknown.kind, 'error')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('ccf_venue：主会旁边说清卫星会（workshop / 地区分会场）另算', async () => {
  const dir = await seeded({
    records: [
      {
        key: 'siggraph|2027', venue: 'SIGGRAPH', year: 2027, name: 'SIGGRAPH 2027',
        fullName: 'ACM SIGGRAPH Annual Conference', rank: 'CCF-A', area: '计算机图形学与多媒体',
        deadline: NOW + 30 * DAY, notification: null, abstractDeadline: null, confDate: '2027-08',
        place: 'Los Angeles', link: '', source: 'ccfddl-api',
      },
      {
        key: 'acm siggraph asia|2026', venue: 'ACM SIGGRAPH ASIA', year: 2026, name: 'ACM SIGGRAPH ASIA 2026',
        fullName: 'ACM SIGGRAPH Annual Conference in Asia', rank: 'CCF-A', area: '计算机图形学与多媒体',
        deadline: NOW + 10 * DAY, notification: null, abstractDeadline: null, confDate: '2026-12',
        place: 'Tokyo', link: '', source: 'ccfddl-api',
      },
    ],
  })
  const { ctx } = fakeContext(dir)
  const ccf = createCcf(ctx, { dataDir: dir, autoUpdate: false }, fakeDefineTool)
  const out = await ccf.venueTool.execute({ venue: 'SIGGRAPH' }, { signal: undefined })
  assert.match(out.report, /SIGGRAPH 2027/, '主会照常给')
  assert.match(out.report, /卫星会：数据里另有 ACM SIGGRAPH ASIA 2026/, '要点出卫星会')
  assert.match(out.report, /不计入|另算/, '要说明它不算主会')
  // report 里写了「卫星会：数据里另有 …」，data 里也得有：模型只读 data 时，
  // 否则会以为这个系列只收了一个会，把地区版的截稿当成主会的。
  assert.equal(out.data.satellites.length, 1, '卫星会要给进 data')
  assert.equal(out.data.satellites[0].name, 'ACM SIGGRAPH ASIA 2026')
  assert.ok(Object.hasOwn(out.data.satellites[0], 'deadline'), '卫星会也要带截稿时间')
})

await test('ccf_deadlines / /ccf list：默认不混卫星会，加 --satellites 才列并打标', async () => {
  const dir = await seeded({
    records: [
      {
        key: 'cvpr|2027', venue: 'CVPR', year: 2027, name: 'CVPR 2027',
        fullName: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition', rank: 'CCF-A',
        area: '人工智能', deadline: NOW + 20 * DAY, notification: null, abstractDeadline: null,
        confDate: '2027-06', place: 'Honolulu', link: '', source: 'ccfddl-api',
      },
      {
        key: 'cvpr workshops|2027', venue: 'CVPR Workshops', year: 2027, name: 'CVPR Workshops 2027',
        fullName: 'CVPR 2027 Workshops (paper submission, varies by workshop)', rank: 'Non-CCF',
        area: '人工智能', deadline: NOW + 5 * DAY, notification: null, abstractDeadline: null,
        confDate: '2027-06', place: 'Honolulu', link: '', source: 'ccfddl-api',
      },
    ],
  })
  const { ctx } = fakeContext(dir)
  const ccf = createCcf(ctx, { dataDir: dir, autoUpdate: false }, fakeDefineTool)
  const plain = await ccf.tool.execute({ days: 120 }, { signal: undefined })
  assert.match(plain.report, /CVPR 2027/, '主会要列')
  assert.ok(!/CVPR Workshops 2027 · /.test(plain.report), '默认不混 workshop')
  assert.match(plain.report, /另有 1 个卫星会/, '要告诉读者有卫星会没列进来')
  const withSat = await ccf.tool.execute({ days: 120, includeSatellites: true }, { signal: undefined })
  assert.match(withSat.report, /CVPR Workshops 2027 · 卫星会/, '显式列出时要打标')
  // 模型读的是 data.rows，不是 report：文本标了，结构化数据也得标
  const satRow = withSat.data.rows.find((row) => row.venue === 'CVPR Workshops')
  assert.equal(satRow?.satellite, true, 'data.rows 里也要标卫星会')
  assert.equal(withSat.data.rows.find((row) => row.venue === 'CVPR')?.satellite, undefined, '主会不带这个字段')
  assert.ok(!Object.hasOwn(plain.data.rows[0] ?? {}, 'satellite'), '默认视图里根本没有卫星会这一行')
  const cmd = await ccf.command.handler({ rawInput: 'list --satellites', signal: undefined })
  assert.match(cmd.text, /CVPR Workshops 2027 · 卫星会/, '命令行同一个开关')
  // 限了等级之后，那句「另有 N 个」不能还算上被等级滤掉的 workshop：打开开关也不会多出它
  const byRank = await ccf.tool.execute({ days: 120, rank: 'CCF-A' }, { signal: undefined })
  assert.ok(!/另有 \d+ 个卫星会/.test(byRank.report), '等级筛掉的那个卫星会不能算进「另有 N 个」')
  // 关键词筛掉之后也一样：列表里没有这个会，就别在末尾说"另有卫星会"
  const bySearch = await ccf.tool.execute({ days: 120, search: 'NeurIPS' }, { signal: undefined })
  assert.ok(!/另有 \d+ 个卫星会/.test(bySearch.report), '搜别的会时不能顺带说「另有卫星会」')
})

await test('来源冲突：清单里标出来、--conflicts 只列冲突、status 报个数', async () => {
  const dir = await seeded({
    records: [
      {
        key: 'iclr|2027', venue: 'ICLR', year: 2027, name: 'ICLR 2027',
        fullName: 'International Conference on Learning Representations', rank: 'CCF-A',
        area: '人工智能', deadline: NOW + 10 * DAY, notification: null, abstractDeadline: null,
        confDate: '2027-04', place: 'Singapore', link: '', source: 'model',
        // 另一个源说 10 天后的截稿其实是 20 天后：差 10 天，远超一天
        alternatives: [{ source: 'paper-deadlines', deadline: NOW + 20 * DAY }],
      },
      {
        key: 'cvpr|2027', venue: 'CVPR', year: 2027, name: 'CVPR 2027',
        fullName: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition', rank: 'CCF-A',
        area: '人工智能', deadline: NOW + 30 * DAY, notification: null, abstractDeadline: null,
        confDate: '2027-06', place: 'Honolulu', link: '', source: 'ccfddl-api',
      },
    ],
  })
  const { ctx } = fakeContext(dir)
  const ccf = createCcf(ctx, { dataDir: dir, autoUpdate: false }, fakeDefineTool)
  const all = await ccf.tool.execute({ days: 120 }, { signal: undefined })
  assert.match(all.report, /ICLR 2027 · 来源冲突/, '两个源打架的会要在行上标出来')
  assert.match(all.report, /其中 1 条两个来源的截稿说法不一致/, '要点名有几条，还给出只看这些的入口')
  assert.match(all.report, /CVPR 2027/, '不冲突的照常列')
  const only = await ccf.tool.execute({ days: 120, conflictsOnly: true }, { signal: undefined })
  assert.match(only.report, /ICLR 2027/, '--conflicts 里要有它')
  assert.ok(!/CVPR 2027/.test(only.report), '不冲突的不能被列进来')
  assert.equal(only.data.conflicts, 1, 'data 里也报个数')
  assert.equal(only.data.rows.find((row) => row.venue === 'ICLR')?.conflict, true, '这一行带标')
  assert.equal(only.data.rows.find((row) => row.venue === 'CVPR')?.conflict, undefined, '那一行不带标')
  assert.ok(!Object.hasOwn(all.data.rows.find((row) => row.venue === 'CVPR') ?? {}, 'conflict'), '不带标的行干脆不带这个字段（undefined 不是合法 JSON）')
  const cmd = await ccf.command.handler({ rawInput: 'list --conflicts', signal: undefined })
  assert.match(cmd.text, /ICLR 2027/, '命令行同一个开关')
  assert.ok(!/CVPR 2027/.test(cmd.text), '命令行也只列冲突的')
  const status = await ccf.command.handler({ rawInput: 'status', signal: undefined })
  assert.match(status.text, /来源：1 条两个源给的截稿差一天以上/, 'status 要说出来，别让日期像定论')
})

await test('/ccf prefer <来源> --conflicts：一次采信全部冲突，--undo 撤回', async () => {
  const dir = await seeded({
    records: [
      {
        key: 'iclr|2027', venue: 'ICLR', year: 2027, name: 'ICLR 2027',
        fullName: 'International Conference on Learning Representations', rank: 'CCF-A',
        area: '人工智能', deadline: NOW + 10 * DAY, notification: null, abstractDeadline: null,
        confDate: '2027-04', place: 'Singapore', link: '', source: 'model',
        alternatives: [{ source: 'paper-deadlines', deadline: NOW + 20 * DAY }],
      },
      {
        key: 'aaai|2027', venue: 'AAAI', year: 2027, name: 'AAAI 2027',
        fullName: 'AAAI Conference on Artificial Intelligence', rank: 'CCF-A',
        area: '人工智能', deadline: NOW + 12 * DAY, notification: null, abstractDeadline: null,
        confDate: '2027-01', place: 'Philadelphia', link: '', source: 'model',
        alternatives: [{ source: 'ccfddl-api', deadline: NOW + 2 * DAY }],
      },
    ],
  })
  const { ctx } = fakeContext(dir)
  const ccf = createCcf(ctx, { dataDir: dir, autoUpdate: false }, fakeDefineTool)
  // ICLR 的另一种说法来自 paper-deadlines，AAAI 的来自 ccfddl-api：
  // 统一采信 paper-deadlines 只能改 ICLR，另一个要如实报"跳过"
  const bulk = await ccf.command.handler({ rawInput: 'prefer paper-deadlines --conflicts', signal: undefined })
  assert.match(bulk.text, /已把 1 个会统一采信 paper-deadlines/, '只改真的有两种说法的那个会')
  assert.match(bulk.text, /另有 1 个会里 paper-deadlines 没有给出日期，跳过/, '没有这个来源的要报数，不能假装成功')
  const after = await ccf.command.handler({ rawInput: 'prefer ICLR', signal: undefined })
  assert.match(after.text, /你采信的 paper-deadlines/, 'ICLR 现在按 paper-deadlines 显示')
  // 裁决过的冲突要看得出来：清单行带「按 X 显示」，报告还要说清有几条已经决定过
  const decided = await ccf.tool.execute({ days: 120 }, { signal: undefined })
  assert.match(decided.report, /ICLR 2027 · 来源冲突 · 按 paper-deadlines 显示/, '行上要标"这条已经按哪个源显示"')
  assert.match(decided.report, /你已经采信过其中 1 条/, '报告里要点出已裁决的条数')
  assert.equal(decided.data.rows.find((row) => row.venue === 'ICLR')?.preferredSource, 'paper-deadlines', 'data 里同样带着采信来源')
  const statusAfter = await ccf.command.handler({ rawInput: 'status', signal: undefined })
  assert.match(statusAfter.text, /其中 1 条你已经采信了某个来源/, 'status 也要说清还有几条没决定')
  const undo = await ccf.command.handler({ rawInput: 'prefer paper-deadlines --conflicts --undo', signal: undefined })
  assert.match(undo.text, /已撤销 1 个会/, '能整体撤回')
  const back = await ccf.command.handler({ rawInput: 'prefer ICLR', signal: undefined })
  assert.ok(!/你采信的 paper-deadlines/.test(back.text), '撤回后回到默认来源')
  const noSource = await ccf.command.handler({ rawInput: 'prefer --conflicts', signal: undefined })
  assert.match(noSource.text, /用法：\/ccf prefer <来源> --conflicts/, '不给来源要说清楚用法')
})

await test('同一个会两个名字（S&P / IEEE S&P）只显示一条，status 说清去重', async () => {
  const dir = await seeded({
    records: [
      {
        key: 'sp|2027', venue: 'S&P', year: 2027, name: 'S&P 2027',
        fullName: 'IEEE Symposium on Security and Privacy', rank: 'CCF-A',
        area: '安全', deadline: NOW + 10 * DAY, notification: null, abstractDeadline: null,
        confDate: '2027-05', place: '', link: '', source: 'ccfddl-api',
      },
      {
        key: 'ieee sp|2027', venue: 'IEEE S&P', year: 2027, name: 'IEEE S&P 2027',
        fullName: 'IEEE Symposium on Security and Privacy', rank: 'CCF-A',
        area: '安全', deadline: NOW + 10 * DAY, notification: null, abstractDeadline: null,
        confDate: '2027-05', place: 'Montreal', link: 'https://sp2027.ieee-security.org', source: 'ccfddl-api',
      },
    ],
  })
  const { ctx } = fakeContext(dir)
  const ccf = createCcf(ctx, { dataDir: dir, autoUpdate: false }, fakeDefineTool)
  const listed = await ccf.tool.execute({ days: 120 }, { signal: undefined })
  const mentions = (listed.report.match(/S&P 2027/g) ?? []).length
  assert.equal(mentions, 1, '同一个会同年只该出现一次')
  assert.match(listed.report, /IEEE S&P 2027/, '留信息更全的那条')
  assert.equal(listed.data.rows.length, 1, '结构化的 rows 也只给一条')
  const status = await ccf.command.handler({ rawInput: 'status', signal: undefined })
  assert.match(status.text, /去重：1 条记录与另一条指同一个会的同一年/, '要让数字对得上，别让人以为丢了数据')
})

await test('/ccf status：两个源报的条数加起来对不上缓存时要说清', async () => {
  const dir = await seeded({
    reports: [
      { id: 'ccfddl-api', ok: true, count: 3 },
      { id: 'paper-deadlines', ok: true, count: 2 },
    ],
  })
  const { ctx } = fakeContext(dir)
  const ccf = createCcf(ctx, { dataDir: dir, autoUpdate: false }, fakeDefineTool)
  const status = await ccf.command.handler({ rawInput: 'status', signal: undefined })
  assert.match(status.text, /- ccfddl-api：3 条/, '每个源各报各的')
  assert.match(status.text, /- paper-deadlines：2 条/)
  assert.match(status.text, /合并后缓存里是 \d+ 条/, '450 对不上 404 时得解释，不解释就像丢了数据')

  // 只有一个源（或数字正好相等）时不啰嗦
  const singleDir = await seeded({ records: sampleRecords })
  const single = createCcf(fakeContext(singleDir).ctx, { dataDir: singleDir, autoUpdate: false }, fakeDefineTool)
  const singleStatus = await single.command.handler({ rawInput: 'status', signal: undefined })
  assert.doesNotMatch(singleStatus.text, /合并后缓存里是/, '一个源时不该出现这句')
})

await test('/ccf venue 与 /ccf sync（离线失败）', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, {
      dataDir: dir,
      timeoutMs: 2000,
      sources: [{ id: 'dead', type: 'json', url: 'http://127.0.0.1:9/data.json' }],
    }, fakeDefineTool)
    const command = registered.commands[0]

    const venue = await command.handler({ rawInput: 'venue cvpr' })
    assert.equal(venue.kind, 'success')
    assert.match(venue.text, /CVPR 2027/)

    const sync = await command.handler({ rawInput: 'sync' })
    assert.equal(sync.kind, 'error')
    assert.match(sync.text, /同步失败|取不到/)
    assert.match(sync.text, /保留上次缓存 3 条/)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('prompt 段：卫星会与「不是这个会」的记录不进截稿清单', async () => {
  const now = Date.now()
  const day = 86400e3
  const records = [
    { key: 'cvpr|2027', venue: 'CVPR', year: 2027, name: 'CVPR 2027', rank: 'CCF-A', area: '人工智能', deadline: now + 20 * day, timezone: 'UTC-12:00', source: 'ccfddl-api' },
    // workshop 的截稿比主会还近：不过滤的话最显眼那句就变成"CVPR 5 天要交"
    { key: 'cvpr-workshops|2027', venue: 'CVPR Workshops', year: 2027, name: 'CVPR Workshops 2027', deadline: now + 5 * day, timezone: 'UTC-12:00', source: 'ccfddl-api' },
    { key: 'sec|2026', venue: 'SEC', year: 2026, name: 'SEC 2026', deadline: now + 6 * day, timezone: 'UTC-12:00', source: 'ccfddl-api' },
  ]
  const dir = await seeded({ records, meta: { ignoredKeys: ['sec|2026'] } })
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir, leadDays: 30 }, fakeDefineTool)
    const text = registered.sections[0].text({})
    assert.doesNotMatch(text, /CVPR Workshops 2027/, '卫星会不该进 prompt 的截稿清单')
    assert.doesNotMatch(text, /SEC 2026/, '标过「不是这个会」的记录也不该进')
    assert.match(text, /未来 30 天内共 1 个截稿/, '剩下的正确个数要跟着过滤后的清单走')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})


await test('prompt 段：动态读缓存，窗口内才注入', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir, leadDays: 30 }, fakeDefineTool)
    const section = registered.sections[0]
    const text = section.text({})
    assert.match(text, /## 会议截稿（dsh-ccf）/)
    assert.match(text, /CVPR 2027/)
    assert.doesNotMatch(text, /ICASSP 2027/, '40 天后截稿的不进 30 天窗口')
    // 装完插件的人常常只看到工具，不知道右侧还有面板：数据状态里要说一句。
    assert.match(text, /「📅 会议」面板/)

    // 换一个没有缓存的目录 → 不注入
    const other = createCcf(fakeContext().ctx, { dataDir: join(dir, 'empty') }, fakeDefineTool)
    assert.equal(other.currentCache(false), null)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('parseFlags：天数、等级、方向、搜索、上限、past、pending、refresh', async () => {
  assert.deepEqual(parseFlags(['30', '--rank', 'CCF-A']), {
    days: 30, rank: 'CCF-A', area: null, search: null, limit: null, includePast: false, pending: false, satellites: false, conflicts: false, refresh: false,
  })
  assert.deepEqual(parseFlags(['--area', 'CV,NLP', '--limit', '5', '--past', '--refresh']), {
    days: null, rank: null, area: 'CV,NLP', search: null, limit: 5, includePast: true, pending: false, satellites: false, conflicts: false, refresh: true,
  })
  assert.deepEqual(parseFlags(['--pending', '--rank', 'CCF-A']), {
    days: null, rank: 'CCF-A', area: null, search: null, limit: null, includePast: false, pending: true, satellites: false, conflicts: false, refresh: false,
  })
  assert.deepEqual(parseFlags([]), {
    days: null, rank: null, area: null, search: null, limit: null, includePast: false, pending: false, satellites: false, conflicts: false, refresh: false,
  })
})

await test('采信会记到会议系列上：明年新一届不用再点，恢复默认一起清掉', async () => {
  const dir = await seeded()
  try {
    const { ctx } = fakeContext()
    const plugin = createCcf(ctx, { dataDir: dir }, fakeDefineTool)

    // 给这一届造一个"另一个来源"的说法
    const cache = plugin.currentCache(true)
    const records = cache.records.map((record) => (record.key === 'cvpr|2027'
      ? {
        ...record,
        alternatives: [{ source: 'ccfddl-api', deadline: record.deadline + 3 * 86400e3, notification: null }],
      }
      : record))
    await writeFile(join(dir, 'cache.json'), JSON.stringify({ ...cache, records }), 'utf8')
    plugin.currentCache(true)

    const result = await plugin.doPrefer({ key: 'cvpr|2027', source: 'ccfddl-api' })
    assert.equal(result.ok, true)
    assert.equal(result.remembered, true)
    assert.equal(result.venue, 'cvpr')

    const saved = JSON.parse(await readFile(join(dir, 'cache.json'), 'utf8'))
    assert.deepEqual(saved.meta.preferredByVenue, { cvpr: 'ccfddl-api' })
    assert.equal(saved.records.find((row) => row.key === 'cvpr|2027').preferredSource, 'ccfddl-api')

    // 新一届（明年）没有自己的偏好 → 自动沿用系列记忆
    const nextEdition = {
      ...saved.records.find((row) => row.key === 'cvpr|2027'),
      key: 'cvpr|2028',
      year: 2028,
      name: 'CVPR 2028',
      preferredSource: undefined,
    }
    delete nextEdition.preferredSource
    const view = plugin.doPrefer && (await import('../lib/core.js')).applyPreferredAll([nextEdition], saved.meta.preferredByVenue)
    assert.equal(view[0].preferred, true)
    assert.equal(view[0].preferredInherited, true)

    // 恢复默认：记录上的偏好与系列记忆一起清掉
    const reset = await plugin.doPrefer({ key: 'cvpr|2027', source: '' })
    assert.equal(reset.ok, true)
    assert.equal(reset.remembered, false)
    const after = JSON.parse(await readFile(join(dir, 'cache.json'), 'utf8'))
    assert.equal(after.meta.preferredByVenue, undefined)
    assert.equal(after.records.find((row) => row.key === 'cvpr|2027').preferredSource, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('/ccf confirm：核对过「就是这个会」就不该再提示，撤销能回来', async () => {
  const ctx = fakeContext()
  const dir = await seeded()
  const plugin = createCcf(ctx, { dataDir: dir, autoUpdate: false, prompt: false, sources: [] }, fakeDefineTool)

  // 夹具里 ICASSP 的全称「IEEE ICASSP」与名单措辞对不上 → 被标「建议核对」
  const before = await plugin.command.handler({ rawInput: 'status' })
  assert.match(before.text, /待核对：1 条/, before.text)

  const ok = await plugin.command.handler({ rawInput: 'confirm icassp|2027' })
  assert.equal(ok.kind, 'success', ok.text)
  assert.match(ok.text, /就是名单里那个会/)
  assert.deepEqual((await loadCache(dir)).meta.confirmedKeys, ['icassp|2027'])

  const after = await plugin.command.handler({ rawInput: 'status' })
  assert.doesNotMatch(after.text, /待核对：1 条/, after.text)
  // 但它仍然算这个会的数据（确认不是"删掉"）
  assert.match(after.text, /覆盖：3 个有未来截稿/, after.text)

  const undo = await plugin.command.handler({ rawInput: 'confirm icassp|2027 --undo' })
  assert.equal(undo.kind, 'success', undo.text)
  assert.equal((await loadCache(dir)).meta.confirmedKeys, undefined)

  const back = await plugin.command.handler({ rawInput: 'status' })
  assert.match(back.text, /待核对：1 条/, back.text)
})

await test('/ccf marks：我做过哪些裁决，一次看清，也能只挑一类', async () => {
  const ctx = fakeContext()
  const dir = await seeded()
  const cache = await loadCache(dir)
  cache.meta = { ...(cache.meta ?? {}), ignoredKeys: ['cvpr|2027'], confirmedKeys: ['icassp|2027'] }
  await saveCache(dir, cache)
  const plugin = createCcf(ctx, { dataDir: dir, autoUpdate: false, prompt: false, sources: [] }, fakeDefineTool)

  const all = await plugin.command.handler({ rawInput: 'marks' })
  assert.equal(all.kind, 'success', all.text)
  assert.match(all.text, /1 个「不是这个会」，1 个「就是这个会」/)
  assert.match(all.text, /- CVPR 2027/)
  assert.match(all.text, /- ICASSP 2027/)
  assert.match(all.text, /--undo/)

  const onlyConfirmed = await plugin.command.handler({ rawInput: 'marks --confirmed' })
  assert.match(onlyConfirmed.text, /就是这个会/)
  assert.doesNotMatch(onlyConfirmed.text, /- CVPR 2027/, '只看确认的一类时不该出现被标记的那些')

  const status = await plugin.command.handler({ rawInput: 'status' })
  assert.match(status.text, /标记：1 个「不是这个会」、1 个「就是这个会」/, status.text)
})

await test('/ccf marks 在没有任何标记时给出去哪里标的指引', async () => {
  const ctx = fakeContext()
  const dir = await seeded()
  const plugin = createCcf(ctx, { dataDir: dir, autoUpdate: false, prompt: false, sources: [] }, fakeDefineTool)
  const out = await plugin.command.handler({ rawInput: 'marks' })
  assert.equal(out.kind, 'success', out.text)
  assert.match(out.text, /还没有任何标记/)
  assert.match(out.text, /\/ccf confirm/)
})

await test('/ccf review：待核对的不只是个数，还要能给下一步', async () => {
  const dir = await seeded({
    records: [
      {
        key: 'sec|2027', venue: 'SEC', year: 2027, name: 'SEC 2027',
        // 全称与名单里那个 SEC 明显不是一个会：应该进「待核对」
        fullName: 'Symposium on Something Entirely Different', rank: 'CCF-A', area: 'SC',
        deadline: NOW + 30 * 86400e3, notification: null, abstractDeadline: null,
        confDate: '2027-10', place: 'TBD', link: '', source: 'ccfddl-api',
      },
    ],
  })
  try {
    const plugin = createCcf(fakeContext().ctx, { dataDir: dir, autoUpdate: false, prompt: false, sources: [] }, fakeDefineTool)
    const open = await plugin.command.handler({ rawInput: 'review' })
    assert.equal(open.kind, 'success', open.text)
    assert.match(open.text, /待核对：1 条记录/, '要说清有几条在等裁决')
    assert.match(open.text, /SEC 2027/, '要点名是哪条记录')
    assert.match(open.text, /\/ccf confirm SEC/, '要给出"对"的下一步命令')
    assert.match(open.text, /\/ccf ignore SEC/, '要给出"不对"的下一步命令')

    // 裁决过的会不该再出现在待核对里（否则这个清单永远清不掉）
    const agreed = await plugin.command.handler({ rawInput: 'confirm SEC' })
    assert.equal(agreed.kind, 'success', agreed.text)
    const after = await plugin.command.handler({ rawInput: 'review' })
    assert.match(after.text, /没有需要核对的记录/, '确认过之后就该从待核对里消失')
    assert.doesNotMatch(after.text, /\/ccf confirm SEC/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('/ccf pending 是 list --pending 的别名', async () => {
  const ctx = fakeContext()
  const dir = await seeded()
  const plugin = createCcf(ctx, { dataDir: dir, autoUpdate: false, prompt: false, sources: [] }, fakeDefineTool)
  const pending = await plugin.command.handler({ rawInput: 'pending' })
  const listed = await plugin.command.handler({ rawInput: 'list --pending' })
  assert.equal(pending.kind, 'success', pending.text)
  assert.match(pending.text, /名单里还没有截稿数据的会/, '要真的走 --pending 分支')
  assert.equal(pending.text.split('\n')[0], listed.text.split('\n')[0], '两种写法第一行一致')
})

await test('/ccf pending：跟「比较日期」的旗标一起用时要说明用不上，而不是静默给空列表', async () => {
  const dir = await seeded()
  try {
    const plugin = createCcf(fakeContext().ctx, { dataDir: dir, autoUpdate: false, prompt: false, sources: [] }, fakeDefineTool)
    for (const rawInput of ['list --pending --conflicts', 'list --pending --past', 'list --pending --satellites']) {
      const result = await plugin.command.handler({ rawInput })
      assert.equal(result.kind, 'success', result.text)
      assert.match(result.text, /「--pending」列的是名单里还没有截稿数据的会/, `${rawInput} 要说明这几个条件在这条路径上用不上`)
      assert.match(result.text, /用不上。去掉这个条件再试/, `${rawInput} 要给出下一步`)
      assert.doesNotMatch(result.text, /名单里还没有截稿数据的会（\d+ 个/, `${rawInput} 不该假装筛选生效了`)
    }
    // 不带这些旗标时，仍然正常列出待补的会
    const plain = await plugin.command.handler({ rawInput: 'list --pending' })
    assert.match(plain.text, /名单里还没有截稿数据的会/, '正常路径不受影响')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('/ccf ignore：标成「不是这个会」的记录不再算进覆盖度，能撤销', async () => {
  const dir = await seeded()
  try {
    const { ctx } = fakeContext()
    const plugin = createCcf(ctx, { dataDir: dir, autoUpdate: false, prompt: false }, fakeDefineTool)

    const missing = await plugin.command.handler({ rawInput: 'ignore' })
    assert.equal(missing.kind, 'error')
    assert.match(missing.text, /用法：\/ccf ignore/)

    const marked = await plugin.command.handler({ rawInput: 'ignore CVPR' })
    assert.equal(marked.kind, 'success', marked.text)
    assert.match(marked.text, /已把 cvpr\|2027 标成「不是这个会」/)
    const saved = await loadCache(dir)
    assert.deepEqual(saved.meta?.ignoredKeys, ['cvpr|2027'])

    const unknown = await plugin.command.handler({ rawInput: 'ignore FOOBAR' })
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /缓存里没有「FOOBAR」/)

    const undo = await plugin.command.handler({ rawInput: 'ignore cvpr|2027 --undo' })
    assert.equal(undo.kind, 'success', undo.text)
    const restored = await loadCache(dir)
    assert.equal(restored.meta?.ignoredKeys ?? null, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

await test('进度快照：没在跑时是 null，跑完也回到 null', async () => {
  const dir = await seeded()
  try {
    const { ctx } = fakeContext()
    const plugin = createCcf(ctx, { dataDir: dir, autoUpdate: false }, fakeDefineTool)
    assert.equal(plugin.progress(), null)
    // 这个假 ctx 没有模型 → runUpdate 立刻走回退，进度不会残留
    await plugin.doUpdate({ limit: 1 })
    assert.equal(plugin.progress(), null)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('/ccf status：缓存文件坏了就说"坏了"，不说"还没有数据"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccf-status-corrupt-'))
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'cache.json'), '{"schema":"dsh-ccf/cache/v1","records":[{"venue":"CVPR"', 'utf8')
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir, autoUpdate: false, prompt: false }, fakeDefineTool)
    const result = await registered.commands[0].handler({ rawInput: 'status' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /缓存文件读不出来/)
    assert.match(result.text, /cache\.json/)
    assert.doesNotMatch(result.text, /还没有缓存/)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
await test('/ccf sync：缓存写不进去时回错误，并把原因说出来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccf-sync-fail-'))
  try {
    const file = join(dir, 'not-a-dir')
    await writeFile(file, 'x', 'utf8')
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: file, autoUpdate: false, prompt: false, sources: [] }, fakeDefineTool)
    const result = await registered.commands[0].handler({ rawInput: 'sync' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /缓存写不进去/)
    assert.match(result.text, /不是一个目录/)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
await test('/ccf config：默认时区是这台机器的，不是写死的北京', async () => {
  const dir = await seeded()
  try {
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: dir, autoUpdate: false, prompt: false }, fakeDefineTool)
    const config = await registered.commands[0].handler({ rawInput: 'config' })
    assert.equal(config.kind, 'success')
    const system = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    assert.ok(config.text.includes(system), `config 应该写本机时区 ${system}`)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
await test('/ccf status：数据目录指到文件时说"目录不是目录"，别误诊成 JSON 坏了', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccf-dir-file-'))
  try {
    const file = join(dir, 'not-a-dir')
    await writeFile(file, 'x', 'utf8')
    const { ctx, registered } = fakeContext()
    createCcf(ctx, { dataDir: file, autoUpdate: false, prompt: false }, fakeDefineTool)
    const result = await registered.commands[0].handler({ rawInput: 'status' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /不是一个目录/)
    assert.doesNotMatch(result.text, /JSON 解析失败/)

    const config = await registered.commands[0].handler({ rawInput: 'config' })
    assert.equal(config.kind, 'success')
    assert.match(config.text, /有问题/)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('跨进程锁：另一个窗口在补数据时，这一轮直接说"在跑"，并且不删别人的锁', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccf-lock-'))
  try {
    await writeFile(join(dir, 'cache.json'), JSON.stringify({ schema: 'dsh-ccf/cache/v1', records: [] }), 'utf8')
    // 别的进程刚写的锁（新鲜，10 分钟内）
    await writeFile(join(dir, 'update.lock'), JSON.stringify({ pid: 999999, at: Date.now() - 3000 }), 'utf8')
    const { ctx } = fakeContext()
    const plugin = createCcf(ctx, { dataDir: dir, autoUpdate: false, prompt: false, sources: [] }, fakeDefineTool)
    const result = await plugin.doUpdate({ limit: 1 })
    assert.equal(result.ok, false)
    assert.equal(result.busy, true)
    assert.match(result.note, /还在跑/)
    // 别人的锁必须原样留着
    const still = JSON.parse(await readFile(join(dir, 'update.lock'), 'utf8'))
    assert.equal(still.pid, 999999)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

await test('跨进程锁：过期的锁可以接管', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccf-lock-stale-'))
  try {
    await writeFile(join(dir, 'cache.json'), JSON.stringify({ schema: 'dsh-ccf/cache/v1', records: [] }), 'utf8')
    // 一小时前的锁：进程可能被强杀了，不能永久卡住
    await writeFile(join(dir, 'update.lock'), JSON.stringify({ pid: 999999, at: Date.now() - 3600e3 }), 'utf8')
    const { ctx } = fakeContext()
    const plugin = createCcf(ctx, { dataDir: dir, autoUpdate: false, prompt: false, sources: [] }, fakeDefineTool)
    const result = await plugin.doUpdate({ limit: 1 })
    assert.equal(result.busy, undefined, '过期锁不该拦住补数据')
    assert.ok(result.note, '还是要有回执')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
await test('名单文件缺失/坏掉时，status 与 update 都要说出来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ccf-cat-state-'))
  try {
    await writeFile(join(dir, 'cache.json'), JSON.stringify({
      schema: 'dsh-ccf/cache/v1',
      updatedAt: new Date(Date.now() - 3600e3).toISOString(),
      records: [],
    }), 'utf8')
    const missingPath = join(dir, 'nope.json')
    const { ctx: ctx1 } = fakeContext()
    const p1 = createCcf(ctx1, { dataDir: dir, catalogPath: missingPath, autoUpdate: false, prompt: false, sources: [] }, fakeDefineTool)
    const s1 = await p1.command.handler({ rawInput: 'status' })
    assert.match(s1.text, /没找到名单文件/)
    assert.match(s1.text, /nope\.json/)
    // 不能装作"名单在、只是没数据"
    assert.doesNotMatch(s1.text, /名单：未找到 data\/ccf-catalog\.json/)
    const u1 = await p1.doUpdate({ limit: 1 })
    assert.equal(u1.ok, false)
    assert.match(u1.note, /无法按名单挖掘/)
    assert.match(u1.note, /没找到名单文件/)

    const badPath = join(dir, 'bad.json')
    await writeFile(badPath, '{"schema":"dsh-ccf/catalog/v1","areas":[{"area":"', 'utf8')
    const { ctx: ctx2 } = fakeContext()
    const p2 = createCcf(ctx2, { dataDir: dir, catalogPath: badPath, autoUpdate: false, prompt: false, sources: [] }, fakeDefineTool)
    const s2 = await p2.command.handler({ rawInput: 'status' })
    assert.match(s2.text, /读不出来/)
    assert.match(s2.text, /JSON 解析失败/)
    const c2 = await p2.command.handler({ rawInput: 'config' })
    assert.match(c2.text, /名单文件：/)
    assert.match(c2.text, /读不出来/)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

console.log(`\n${passed} passed`)
