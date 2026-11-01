/**
 * 面板真实渲染测试：jsdom + React 19，把 `client/client.js` 当浏览器脚本加载，
 * 点开侧边栏、等数据回来，然后在 DOM 里断言卡片内容。
 *
 * 这条测的是「用户真的能看见什么」：tab → 面板 → 卡片 → 六个时间字段。
 * 依赖 devDependencies（react / react-dom / jsdom），只在本地跑：
 *   npm i --no-save react@19 react-dom@19 jsdom@25
 *   node test/panel.render.test.mjs
 */
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = join(here, '..', 'client', 'client.js')

const NOW = Date.parse('2026-10-31T00:00:00Z')
const iso = (days) => new Date(NOW + days * 86400000).toISOString()
const PAYLOAD = {
  ok: true,
  schema: 'dsh-ccf/panel/v1',
  now: new Date(NOW).toISOString(),
  timezone: 'Asia/Shanghai',
  updatedAt: new Date(NOW - 3600000).toISOString(),
  count: 2,
  counts: {
    records: 2,
    conferences: 362,
    withFuture: 1,
    pending: 360,
    pendingPast: 0,
    pendingNever: 360,
    // CCFDDL 收了、CCF 名单没收的会：卡片在列表里，但不进 362 的账
    outside: 2,
    outsideFuture: 1,
    conflicts: 0,
  },
  meta: { catalogState: 'corrupt', catalogError: 'JSON 解析失败：Unterminated', modelReady: true },
  records: [
    {
      key: 'cvpr|2027', venue: 'CVPR', year: 2027, name: 'CVPR 2027', fullName: 'IEEE/CVF CVPR',
      rank: 'CCF-A', area: 'CV', abstractDeadline: null, deadline: iso(20), notification: iso(80),
      rebuttal: null, cameraReady: null, confDate: '2027-06', place: 'Honolulu, USA',
      link: 'https://cvpr.thecvf.com', submitLink: '', acceptRate: '', h5: null, aliases: [], source: 'paper-deadlines',
      timezone: 'UTC-12:00',
    },
    {
      key: 'iclr|2027', venue: 'ICLR', year: 2027, name: 'ICLR 2027', fullName: 'ICLR',
      rank: 'CCF-A', area: 'AI/ML', abstractDeadline: null, deadline: iso(120), notification: iso(200),
      rebuttal: null, cameraReady: null, confDate: '2027-04', place: 'Singapore',
      link: '', submitLink: '', acceptRate: '', h5: null, aliases: [], source: 'model', minedAt: new Date(NOW - 7200000).toISOString(),
      minedFrom: ['https://iclr.cc/Conferences/2027/Dates'],
      weakMatch: true,
    },
  ],
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:52023/',
  pretendToBeVisual: true,
})

globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.localStorage = dom.window.localStorage
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let fetched = []
globalThis.fetch = async (url, init) => {
  fetched.push([String(url), init && init.method ? init.method : 'GET', init && init.body ? String(init.body) : ''])
  return { ok: true, status: 200, text: async () => JSON.stringify(PAYLOAD) }
}

const spec = {}
dom.window.__ModuleLoader__ = {
  load(s) {
    spec.spec = s
    spec.exports = s.factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require: ${name}`)
    })
  },
}

await import(pathToFileURL(bundle).href)
const api = spec.exports

const registrations = []
api.apply({
  slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
})

const root = createRoot(document.getElementById('root'))
const element = registrations[0].component()

const { act } = React
await act(async () => {
  root.render(element)
})

assert.match(document.body.textContent, /会议/, '折叠态应该有一个「会议」标签页')

const tab = document.querySelector('button[title="CCF 会议截稿"]')
assert.ok(tab, '应该找得到标签页按钮')

await act(async () => {
  tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})

// 等 effect 里的 fetch + setState 落地
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})

const text = document.body.textContent
console.log('--- 面板文本 ---')
console.log(text.replace(/\s+/g, ' ').slice(0, 600))
console.log('--- 请求 ---', JSON.stringify(fetched))

assert.ok(fetched.some(([url]) => url === '/dsh-ccf/api/v1/records'), '应该请求了宿主路由')
assert.match(text, /CVPR 2027/)
assert.match(text, /截稿/)
assert.match(text, /审稿决定/)
assert.match(text, /rebuttal/)
assert.match(text, /开会/)
assert.match(text, /地点/)
assert.match(text, /Honolulu/)
assert.doesNotMatch(text, /\bCR\b/, 'CR 时间已经去掉了，不该再出现在面板上')
assert.match(text, /上游未提供/, 'rebuttal 没有数据时必须如实标注')
assert.match(text, /名单文件读不出来/, '名单坏了要在面板上说，而不是悄悄显示 0 个会')
assert.match(text, /2026-11-20 08:00/, '截稿时间按 Asia/Shanghai 渲染（00:00Z → 08:00）')

const cards = document.querySelectorAll('section > div > div')
assert.ok(cards.length >= 2, `至少两张卡片，实际 ${cards.length}`)

// 关注（★）：点一下星号 → 出现「关注 1」视图入口，点了只剩这一个会
const pin = document.querySelector('button[title="关注：无论窗口与截稿时间，都留在列表最上面"]')
assert.ok(pin, '有日期的卡片上应该有关注按钮')
await act(async () => {
  pin.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
assert.match(document.body.textContent, /关注 1/, '关注之后工具栏要出现「关注 1」')
const pinsTab = [...document.querySelectorAll('button')].find((node) => node.textContent && node.textContent.startsWith('关注 1'))
assert.ok(pinsTab, '找得到「关注」视图按钮')
await act(async () => {
  pinsTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
const pinnedText = document.body.textContent
assert.match(pinnedText, /关注视图/, '状态行要说明当前是关注视图')
assert.ok(!/ICLR 2027/.test(pinnedText), '关注视图里不该出现没关注的会')

// 回到全部视图，展开一条"模型挖到的"记录：日期不对时必须能当场重挖
const allTab = [...document.querySelectorAll('button')].find((node) => node.textContent && node.textContent.startsWith('全部'))
assert.ok(allTab, '找得到「全部」视图按钮')
await act(async () => {
  allTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
const iclrTitle = [...document.querySelectorAll('strong')].find((node) => node.textContent === 'ICLR 2027')
assert.ok(iclrTitle, '找得到 ICLR 卡片')
await act(async () => {
  iclrTitle.parentElement.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
const remine = [...document.querySelectorAll('button')].find((node) => node.textContent === '重挖这个会')
assert.ok(remine, '模型挖到的记录要能重挖')
assert.match(document.body.textContent, /挖自/, '模型挖到的记录要写出处，用户才能核对')
await act(async () => {
  remine.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
const updateCall = fetched.find(([url, method]) => url === '/dsh-ccf/api/v1/update' && method === 'POST')
assert.ok(updateCall, '应该发了一次 POST /update')
assert.match(updateCall[2] || '', /"focus":"ICLR"/, '重挖时要带上会议名')

// 官方口径：截稿值悬停能看到官网那个时区的时间
const zoned = [...document.querySelectorAll('[title]')].find((node) => String(node.getAttribute('title')).includes('UTC-12:00'))
assert.ok(zoned, '截稿值上要有官方口径的悬停说明')
assert.match(zoned.getAttribute('title'), /UTC-12:00 2026-11-19 12:00/, '悬停要写清官网口径的日期')

// 重置筛选：改过天数之后必须有一键回到默认的出口
const daysSelect = document.querySelector('select')
assert.ok(daysSelect, '有天数下拉')
await act(async () => {
  daysSelect.value = '30'
  daysSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
})
const reset = [...document.querySelectorAll('button')].find((node) => node.textContent === '重置筛选')
assert.ok(reset, '改过筛选后要出现「重置筛选」')
await act(async () => {
  reset.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
const resetGone = [...document.querySelectorAll('button')].find((node) => node.textContent === '重置筛选')
assert.ok(!resetGone, '点了重置之后按钮应该消失（说明回到默认）')
const daysBack = document.querySelector('select')
assert.equal(daysBack.value, '120', '天数要回到 120')

// 名单外的会：卡片在列表里，但不算进 362 的账 —— 状态行必须单独说一句
assert.match(document.body.textContent, /名单外 2 个会/, '状态行要说出名单外还有几个会')



// 键盘：卡片标题行能聚焦、Enter 能展开；面板打开时焦点进面板，Esc 收起后焦点回到标签
const row = [...document.querySelectorAll('[role="button"][aria-expanded]')].find((node) => /CVPR 2027/.test(node.textContent))
assert.ok(row, '卡片标题行应该是可聚焦的 role=button')
assert.equal(row.getAttribute('tabindex'), '0', '卡片标题行要能 Tab 到')
await act(async () => {
  row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})
assert.match(document.body.textContent, /别名/, '按 Enter 应该等于点击（展开详情）')

await act(async () => {
  window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const tabBack = document.querySelector('button[title="CCF 会议截稿"]')
assert.ok(tabBack, 'Esc 之后应该回到收起态标签')
assert.equal(document.activeElement, tabBack, '收起后焦点要回到标签，不能丢到 body 上')

await act(async () => {
  tabBack.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
assert.equal(document.activeElement.getAttribute('role'), 'dialog', '打开面板后焦点应该进面板')


// 核对「建议核对」的卡片：展开后要能直接给结论，点了要真的发请求
await act(async () => {
  document.querySelector('button[title="CCF 会议截稿"]') || null
})
const tabMark = document.querySelector('button[title="CCF 会议截稿"]')
if (tabMark && document.querySelector('[role="dialog"]') === null) {
  await act(async () => {
    tabMark.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

const iclrRow = [...document.querySelectorAll('[role="button"]')].find((node) => node.textContent.includes('ICLR'))
assert.ok(iclrRow, '要能找到 ICLR 卡片')
if (iclrRow.getAttribute('aria-expanded') !== 'true') {
  await act(async () => {
    iclrRow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}
const confirmButton = [...document.querySelectorAll('button')].find((node) => node.textContent === '就是这个会')
assert.ok(confirmButton, '「建议核对」的卡片要给出「就是这个会」')
const ignoreButton = [...document.querySelectorAll('button')].find((node) => node.textContent === '不是这个会')
assert.ok(ignoreButton, '也要给出「不是这个会」')

await act(async () => {
  confirmButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const confirmCall = fetched.find(([url]) => url.includes('/confirm'))
assert.ok(confirmCall, '点「就是这个会」要发 POST /confirm')
assert.equal(confirmCall[1], 'POST')
assert.match(String(confirmCall[2]), /\"mark\":\"confirm\"/)
await act(async () => {
  root.unmount()
})


// 旧模块 / 非 JSON 响应：读者要看到"重启 DSH"，而不是 JSON 语法错误；并且要能点「重试」恢复
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<!doctype html><html><body><div>app</div></body></html>' })
const root2 = createRoot(document.getElementById('root'))
await act(async () => {
  root2.render(registrations[0].component())
})
const tab2 = document.querySelector('button[title="CCF 会议截稿"]')
if (tab2) {
  await act(async () => {
    tab2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const failureText = document.body.textContent
assert.match(failureText, /重启/, '返回 HTML 时要提示重启桌面端')
assert.ok(!/Unexpected token/.test(failureText), '不要把 JSON 解析异常原样丢给读者')
const retry = [...document.querySelectorAll('button')].find((node) => node.textContent === '重试')
assert.ok(retry, '出错时要给一个「重试」按钮')

// 换回正常响应，点「重试」应该恢复
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(PAYLOAD) })
await act(async () => {
  retry.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
assert.match(document.body.textContent, /CVPR 2027/, '重试之后要恢复数据')
await act(async () => {
  root2.unmount()
})

// 缓存坏了：面板要说"读不出来、点同步重建"，而不是一张空表。
globalThis.fetch = async (url) => {
  if (String(url).includes('/records') || String(url).includes('/sync')) {
    const broken = JSON.parse(JSON.stringify(PAYLOAD))
    broken.count = 0
    broken.records = []
    broken.pending = []
    broken.meta = {
      ...broken.meta,
      cacheState: 'corrupt',
      cacheError: 'JSON 解析失败：Unexpected end of JSON input',
      cachePath: 'C:\\Users\\x\\.dsh\\ccf\\cache.json',
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(broken) }
  }
  return { ok: true, status: 200, text: async () => '{"ok":true}' }
}
// 从收起态开始（前面几段把开合状态存进过 localStorage）
dom.window.localStorage.removeItem('dsh-ccf:panel-open')
const root3 = createRoot(document.getElementById('root'))
await act(async () => {
  root3.render(registrations[0].component())
})
const tab3 = document.querySelector('button[title="CCF 会议截稿"]')
if (tab3) {
  await act(async () => {
    tab3.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const corruptText = document.body.textContent
assert.match(corruptText, /缓存文件读不出来/, '缓存坏了必须明说，而不是显示成空面板')
assert.match(corruptText, /重建/, '要告诉用户点「同步」重建')
await act(async () => {
  root3.unmount()
})
// 「已裁决」视图：标记过的会单独一屏，没标的不混进来。
const marked = JSON.parse(JSON.stringify(PAYLOAD))
marked.meta = { ...marked.meta, catalogState: 'ok', marks: { ignored: 1, confirmed: 1 } }
marked.records[0] = { ...marked.records[0], ignored: false, confirmed: false }
marked.records[1] = { ...marked.records[1], confirmed: true, weakMatch: false }
marked.records.push({
  key: 'sec|2026', venue: 'SEC', year: 2026, name: 'ACM/IEEE SEC 2026', fullName: 'ACM/IEEE Symposium on Edge Computing',
  rank: 'CCF-A', area: '网络与信息安全', abstractDeadline: null, deadline: iso(40), notification: null,
  rebuttal: null, cameraReady: null, confDate: '2026-12', place: 'Rome, Italy',
  link: '', submitLink: '', acceptRate: '', h5: null, aliases: [], source: 'model',
  minedAt: new Date(NOW - 7000000).toISOString(), minedFrom: ['https://sec2026.example.org/'],
  weakMatch: true, ignored: true, confirmed: false,
})
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(marked) })
dom.window.localStorage.removeItem('dsh-ccf:panel-open')
const root4 = createRoot(document.getElementById('root'))
await act(async () => {
  root4.render(registrations[0].component())
})
const tab4 = document.querySelector('button[title="CCF 会议截稿"]')
if (tab4) {
  await act(async () => {
    tab4.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const marksChip = [...document.querySelectorAll('[role="button"], button')].find((node) => /已裁决\s*2/.test(node.textContent || ''))
assert.ok(marksChip, '有标记时工具栏要出现「已裁决 N」入口')
await act(async () => {
  marksChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const marksText = document.body.textContent
assert.match(marksText, /ICLR 2027/, '确认过的会要在「已裁决」里')
assert.match(marksText, /SEC 2026/, '标过「不是这个会」的也要在「已裁决」里')
assert.ok(!/CVPR 2027/.test(marksText), '没裁决过的会不该混进「已裁决」视图')
await act(async () => {
  root4.unmount()
})

// 状态行会报「N 条来源不一致」，那就得点得进去看是哪几条：工具栏给「不一致 N」入口，点进去只剩冲突的那条。
const conflictPayload = JSON.parse(JSON.stringify(PAYLOAD))
conflictPayload.counts = { ...conflictPayload.counts, conflicts: 1 }
conflictPayload.records = [
  { ...PAYLOAD.records[0] },
  {
    ...PAYLOAD.records[1],
    conflict: true,
    // 另一种说法来自 paper-deadlines：批量采信的候选就该是它
    alternatives: [{ source: 'paper-deadlines', deadline: PAYLOAD.records[1].deadline }],
  },
]
const bulkCalls = []
// 宿主会真的改缓存：这里让桩跟着请求改一下返回的面板数据，
// 否则"点完批量采信之后要出现撤销入口"这条永远测不到（不会自我反射的桩最容易假通过）。
globalThis.fetch = async (url, init) => {
  bulkCalls.push({ url: String(url), init })
  let body = {}
  try { body = JSON.parse(String(init?.body ?? '{}')) } catch { body = {} }
  if (String(url).includes('/prefer') && body.batch === true) {
    conflictPayload.records[1] = { ...conflictPayload.records[1] }
    if (body.undo === true) delete conflictPayload.records[1].preferredSource
    else conflictPayload.records[1].preferredSource = body.source
    // 真实宿主会重算 counts：桩也得跟着算，否则"采信后状态行说几条已采信"测不到
    conflictPayload.counts = { ...conflictPayload.counts, conflictsDecided: body.undo === true ? 0 : 1 }
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(conflictPayload) }
}
dom.window.localStorage.removeItem('dsh-ccf:panel-open')
const root4b = createRoot(document.getElementById('root'))
await act(async () => {
  root4b.render(registrations[0].component())
})
const tab4b = document.querySelector('button[title="CCF 会议截稿"]')
if (tab4b) {
  await act(async () => {
    tab4b.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const conflictChip = [...document.querySelectorAll('[role="button"], button')].find((node) => /不一致\s*1/.test(node.textContent || ''))
assert.ok(conflictChip, '有来源不一致时要出现「不一致 N」入口')
await act(async () => {
  conflictChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const conflictText = document.body.textContent
assert.match(conflictText, /ICLR 2027/, '冲突的那条要能在「不一致」视图里找到')
assert.ok(!/CVPR 2027/.test(conflictText), '不冲突的会不该混进「不一致」视图')
// 还没决定时说「N 条来源不一致」就够了，别凭空加"已采信 0 条"
assert.doesNotMatch(conflictText, /条已采信/, '没采信过就别提这件事')
// 26 条冲突逐张卡片点太碎：这张视图里要能一句「这些冲突统一采信 X」
assert.match(conflictText, /这些冲突统一采信：/, '冲突视图要给批量入口')
const bulkChip = [...document.querySelectorAll('button')].find((node) => /paper-deadlines\s*1/.test(node.textContent || ''))
assert.ok(bulkChip, '按另一种说法的来源给出候选，并写清有几个会')
await act(async () => {
  bulkChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const bulkPost = bulkCalls.find((call) => call.url.includes('/prefer') && /"batch":true/.test(String(call.init?.body ?? '')))
assert.ok(bulkPost, '点批量采信要发 {batch:true, source} 给 /prefer')
assert.match(String(bulkPost.init?.body ?? ''), /"source":"paper-deadlines"/)
// 批量点错了得能整体撤回：界面要给「撤销 <来源> N」，且真的发 undo:true
const afterBulkText = document.body.textContent
assert.match(afterBulkText, /已采信：/, '采信之后要把"当前采信了谁"摆出来')
// 采信不减少"说法不一致"的条数（事实没变），但状态行要说清其中几条已经决定过了
assert.match(afterBulkText, /1 条来源不一致（1 条已采信）/, '状态行要区分"还没决定"和"已经采信过"')
// 采信之后，收起状态的行也要写「按 paper-deadlines」：命令行行尾有这句，
// 面板只在展开后写的话，收起状态下看不出这个日期是你选的还是插件自己选的。
assert.match(afterBulkText, /按 paper-deadlines/, '采信过的行要标出按哪个来源显示')
const undoBulk = [...document.querySelectorAll('button')].find((node) => /撤销\s*paper-deadlines\s*1/.test(node.textContent || ''))
assert.ok(undoBulk, '批量采信要有对应的撤销入口（命令侧有 --undo，界面不该没有）')
await act(async () => {
  undoBulk.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const undoPost = bulkCalls.find((call) => call.url.includes('/prefer') && /"undo":true/.test(String(call.init?.body ?? '')))
assert.ok(undoPost, '点撤销要发 {batch:true, source, undo:true}')
assert.match(String(undoPost.init?.body ?? ''), /"source":"paper-deadlines"/)
await act(async () => {
  root4b.unmount()
})

// 卫星会（workshop / 地区分会场）：说明白它不算主会，而且不给「就是这个会」这种错误选项。
const satPayload = JSON.parse(JSON.stringify(PAYLOAD))
satPayload.meta = { ...satPayload.meta, catalogState: 'ok' }
satPayload.records = [
  {
    key: 'acm siggraph asia|2026', venue: 'ACM SIGGRAPH ASIA', year: 2026, name: 'ACM SIGGRAPH ASIA 2026',
    fullName: 'ACM SIGGRAPH Annual Conference in Asia', rank: 'CCF-A', area: '计算机图形学与多媒体',
    abstractDeadline: null, deadline: iso(30), notification: null, rebuttal: null, cameraReady: null,
    confDate: '2026-12', place: 'Tokyo', link: '', submitLink: '', acceptRate: '', h5: null,
    aliases: [], source: 'ccfddl-api', satellite: true, weakMatch: false,
  },
]
satPayload.count = 1
satPayload.counts = { ...satPayload.counts, records: 1, withFuture: 1, pending: 361, satellites: 1 }
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(satPayload) })
dom.window.localStorage.removeItem('dsh-ccf:panel-open')
dom.window.localStorage.removeItem('dsh-ccf:satellites')
const root5 = createRoot(document.getElementById('root'))
await act(async () => {
  root5.render(registrations[0].component())
})
const tab5 = document.querySelector('button[title="CCF 会议截稿"]')
if (tab5) {
  await act(async () => {
    tab5.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
// 默认视图里卫星会不出现：卡片列表为空，但工具栏要有「卫星会 1」这个入口，状态行要说清有几个没显示。
assert.ok(
  ![...document.querySelectorAll('[role="button"][aria-expanded]')].length,
  '默认不该把卫星会混进主会列表',
)
const satChip = [...document.querySelectorAll('button')].find((node) => /^卫星会\s*1$/.test(node.textContent.trim()))
assert.ok(satChip, '要有一个「卫星会 1」的开关')
assert.match(document.body.textContent, /另有 1 个卫星会未显示/, '状态行要说清有几个卫星会没显示')
await act(async () => {
  satChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const header = [...document.querySelectorAll('[role="button"][aria-expanded]')][0]
assert.ok(header, '打开开关后卫星会也要有一张卡片')
// 收起状态就要能看出这是 workshop：命令行每行都写「卫星会」，
// 面板只在展开后写的话，打开开关后两种行长得一模一样。
assert.match(header.textContent, /卫星会/, '收起状态的行上也要标「卫星会」')
await act(async () => {
  header.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const satText = document.body.textContent
assert.match(satText, /卫星会/, '卫星会要有一句说明')
assert.match(satText, /不计入名单里那个主会/, '要说清它不计入主会')
const buttons = [...document.querySelectorAll('button')].map((node) => node.textContent)
assert.ok(!buttons.includes('就是这个会'), '卫星会不该给「就是这个会」这种会把人引错的选择')
// 但「其实是主会」要给：判定只看名字，名字会骗人，得留一条改回来的路。
const satMain = [...document.querySelectorAll('button')].find((node) => node.textContent === '其实是主会')
assert.ok(satMain, '卫星会要能标「其实是主会」')
// 但「不是这个会」要给：workshop 数据也可能是错的，卡片不能是死的
const satIgnore = [...document.querySelectorAll('button')].find((node) => node.textContent === '不是这个会')
assert.ok(satIgnore, '卫星会也要能标「不是这个会」')
const satPosts = []
globalThis.fetch = async (url, init) => {
  if (init && init.method === 'POST') satPosts.push([url, String(init.body)])
  return { ok: true, status: 200, text: async () => JSON.stringify(satPayload) }
}
await act(async () => {
  satMain.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
const satMainMark = satPosts.find(([url]) => String(url).includes('/confirm'))
assert.ok(satMainMark, '点卫星会的「其实是主会」要发 POST /confirm')
assert.match(satMainMark[1], /"mark":"confirm"/, '发出去的结论是 confirm')
satPosts.length = 0
await act(async () => {
  satIgnore.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
const satMark = satPosts.find(([url]) => String(url).includes('/confirm'))
assert.ok(satMark, '点卫星会的「不是这个会」要发 POST /confirm')
assert.match(satMark[1], /"mark":"ignore"/, '发出去的结论是 ignore')
await act(async () => {
  root5.unmount()
})

// 窗口外的卫星会不该算进「另有 N 个」：统计里它有，但当前视图本来就不该出现它。
const farPayload = JSON.parse(JSON.stringify(satPayload))
farPayload.records = [{ ...satPayload.records[0], deadline: iso(400), confDate: '2028-01' }]
farPayload.counts = { ...satPayload.counts, satellites: 1 }
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(farPayload) })
dom.window.localStorage.removeItem('dsh-ccf:panel-open')
dom.window.localStorage.removeItem('dsh-ccf:satellites')
const root6 = createRoot(document.getElementById('root'))
await act(async () => {
  root6.render(registrations[0].component())
})
const tab6 = document.querySelector('button[title="CCF 会议截稿"]')
if (tab6) {
  await act(async () => {
    tab6.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const farText = document.body.textContent
assert.ok(!/卫星会\s*1/.test(farText), '窗口外的卫星会不该给出「卫星会 1」这个开关')
assert.ok(!/另有 \d+ 个卫星会未显示/.test(farText), '窗口外的卫星会不该说成"未显示"')
await act(async () => {
  root6.unmount()
})

// 同一个卫星会收了两届（SIGGRAPH Asia 2026 / 2027）：开关与「另有 N 个」都写「个会」，
// 就不能把两条记录数成两个会。
const pairPayload = JSON.parse(JSON.stringify(satPayload))
pairPayload.records = [
  { ...satPayload.records[0], key: 'siggraph-asia|2026', name: 'ACM SIGGRAPH ASIA 2026', venue: 'ACM SIGGRAPH ASIA', year: 2026 },
  { ...satPayload.records[0], key: 'siggraph-asia|2027', name: 'SIGGRAPH Asia 2027', venue: 'SIGGRAPH Asia', year: 2027 },
]
pairPayload.counts = { ...satPayload.counts, satellites: 2 }
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(pairPayload) })
dom.window.localStorage.removeItem('dsh-ccf:panel-open')
dom.window.localStorage.removeItem('dsh-ccf:satellites')
const pairRoot = createRoot(document.getElementById('root'))
await act(async () => {
  pairRoot.render(registrations[0].component())
})
const pairTab = document.querySelector('button[title="CCF 会议截稿"]')
if (pairTab) {
  await act(async () => {
    pairTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const pairText = document.body.textContent
assert.ok(/卫星会\s*1/.test(pairText), '两届同一个卫星会只能算一个会（开关写「卫星会 1」）')
assert.ok(!/卫星会\s*2/.test(pairText), '不能把两条记录数成两个会')
assert.match(pairText, /另有 1 个卫星会未显示/, '「另有 N 个」也要按会去重')
await act(async () => {
  pairRoot.unmount()
})

// 已经打开开关、但当前视图里一个卫星会都没有时，开关必须还在——否则关不掉，切到别的视图又混进来。
dom.window.localStorage.setItem('dsh-ccf:satellites', '1')
globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(farPayload) })
const root7 = createRoot(document.getElementById('root'))
await act(async () => {
  root7.render(registrations[0].component())
})
const tab7 = document.querySelector('button[title="CCF 会议截稿"]')
if (tab7) {
  await act(async () => {
    tab7.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
})
const onChip = [...document.querySelectorAll('button')].find((node) => node.textContent.trim() === '卫星会')
assert.ok(onChip, '开关已经打开时，即使这个视图没有卫星会也要留着它')
assert.equal(onChip.getAttribute('aria-pressed'), 'true', '留着的开关要显示"已打开"')
await act(async () => {
  onChip.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
assert.equal(dom.window.localStorage.getItem('dsh-ccf:satellites'), '0', '点一下要能关掉')
await act(async () => {
  root7.unmount()
})

console.log('PANEL RENDER OK')
