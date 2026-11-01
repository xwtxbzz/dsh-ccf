/**
 * dsh-ccf · 桌面端右侧面板（客户端产物）
 *
 * 宿主（DSH 0.1.0-rc.6）没有"右侧列"可注入：`sidebar`/`conversation`/`details` 三个槽
 * 都被官方 UI 占着。所以这里挂在 `shell.overlay` —— 一个列表型、默认点击穿透的整框浮层
 * （`shell.overlay` 的注释原文：*The layer itself is click-through — entries opt back into
 * pointer events*）。我们只在自己的卡片上恢复指针事件，不会挡住底下的应用。
 *
 * 数据来自宿主路由 `/dsh-ccf/api/v1/records`（见 lib/ui.js），浏览器里相对路径即可；
 * 这里不碰文件系统，也不需要任何打包器：`require('react')` 由宿主注入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ccf',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const ROUTE_RECORDS = '/dsh-ccf/api/v1/records'
    const ROUTE_SYNC = '/dsh-ccf/api/v1/sync'
    const ROUTE_UPDATE = '/dsh-ccf/api/v1/update'
  const ROUTE_PREFER = '/dsh-ccf/api/v1/prefer'
const ROUTE_CONFIRM = '/dsh-ccf/api/v1/confirm'
    const SLOT = 'shell.overlay'
    const STORAGE_KEY = 'dsh-ccf:panel-open'
    const PANEL_WIDTH = 388
    const STORAGE_WIDTH = 'dsh-ccf:panel-width'
    const STORAGE_PINS = 'dsh-ccf:pins'
    const STORAGE_SEEN = 'dsh-ccf:seen'
    const DAY = 86400000

    const UI = {
      colors: {
        line: 'rgba(127,127,127,0.28)',
        lineSoft: 'rgba(127,127,127,0.16)',
        muted: 'rgba(127,127,127,0.95)',
        warn: '#c2410c',
        hot: '#b91c1c',
        ok: '#0f766e',
      },
    }

    // ---------------------------------------------------------------- 纯函数
    /** ISO → 毫秒；空值/非法值 → null。 */
    function parseMs(value) {
      if (!value) return null
      const ms = Date.parse(String(value))
      return Number.isFinite(ms) ? ms : null
    }

    /** 毫秒/ISO → `YYYY-MM-DD HH:mm`（按时区）；缺失 → `—`。 */
    function formatInstant(value, timeZone) {
      const ms = typeof value === 'number' ? value : parseMs(value)
      if (!Number.isFinite(ms)) return '—'
      try {
        return new Intl.DateTimeFormat('sv-SE', {
          timeZone: timeZone || undefined,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(ms))
      } catch {
        return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
      }
    }

    /** 倒计时文案：`还剩 13 天 9 小时` / `已过 2 天`。 */
    function countdownLabel(target, now) {
      const ms = typeof target === 'number' ? target : parseMs(target)
      if (!Number.isFinite(ms)) return ''
      const diff = ms - (Number.isFinite(now) ? now : Date.now())
      const abs = Math.abs(diff)
      const days = Math.floor(abs / DAY)
      const hours = Math.floor((abs % DAY) / 3600000)
      const minutes = Math.floor((abs % 3600000) / 60000)
      const span = days > 0 ? `${days} 天 ${hours} 小时` : hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`
      return diff >= 0 ? `还剩 ${span}` : `已过 ${span}`
    }

    /** 排序用：CCF-A 在前，非 CCF 在后。 */
    function rankWeight(rank) {
      return { 'CCF-A': 0, 'CCF-B': 1, 'CCF-C': 2 }[rank] ?? 3
    }

    /**
     * 面板行：过滤 + 排序 + 计算倒计时。
     *
     * @param {any} payload `/dsh-ccf/api/v1/records` 的响应体
     * @param {{ now?: number, days?: number, ranks?: string[]|null, areas?: string[]|null, search?: string, includePast?: boolean, keepUndated?: boolean }} [options]
     */
    function buildRows(payload, options) {
      const opts = options || {}
      const now = Number.isFinite(opts.now) ? opts.now : parseMs(payload && payload.now) ?? Date.now()
      const days = Number.isFinite(opts.days) ? opts.days : 120
      const ranks = Array.isArray(opts.ranks) && opts.ranks.length > 0 ? opts.ranks : null
      const areas = Array.isArray(opts.areas) && opts.areas.length > 0 ? opts.areas : null
      const search = String(opts.search || '').trim().toLowerCase()
      const includePast = opts.includePast === true
      const keepUndated = opts.keepUndated !== false
      const withPending = opts.withPending !== false
      const onlyPending = opts.onlyPending === true
      const pins = new Set((Array.isArray(opts.pins) ? opts.pins : []).map((key) => String(key || '')).filter(Boolean))
      // 「只看关注」：关注的会本来就不受窗口限制，这里只是把"没关注的"滤掉。
      const onlyPinned = opts.onlyPinned === true
      // 只看"我裁决过的"（标了不是这个会，或确认了就是这个会）：命令侧有 /ccf marks，面板也要有入口
      const onlyMarked = opts.onlyMarked === true
      // 默认不列卫星会（Workshop / 地区分会场）：它们不算主会的截稿，混进来会制造假紧急
      const includeSatellites = opts.includeSatellites === true
      // 只看两个源说法不一致的（状态行会报「N 条来源不一致」，那就得点得进去看是哪几条）
      const onlyConflicts = opts.onlyConflicts === true
      const horizon = now + days * DAY
      const rows = []

      const isPinned = (record) => Boolean(record && record.key && pins.has(String(record.key)))

      const matches = (record) => {
        if (ranks && ranks.indexOf(record.rank) === -1) return false
        if (areas && areas.indexOf(record.areaGroup || record.area) === -1) return false
        if (!search) return true
        const haystack = [record.venue, record.name, record.fullName, record.abbr, record.place, record.areaGroup, record.year]
          .concat(Array.isArray(record.aliases) ? record.aliases : [])
          .map((value) => String(value === undefined || value === null ? '' : value).toLowerCase())
        return haystack.some((value) => value.indexOf(search) !== -1)
      }

      for (const record of onlyPending ? [] : (payload && payload.records) || []) {
        if (!record) continue
        if (!matches(record)) continue

        // 关注的会一直显示：既不因窗口把它筛掉，也不因截稿已过而消失。
        const pinned = isPinned(record)
        if (onlyPinned && !pinned) continue
        if (onlyMarked && record.ignored !== true && record.confirmed !== true) continue
        if (onlyConflicts && record.conflict !== true) continue
        if (!includeSatellites && record.satellite === true && !onlyMarked) continue
        const deadline = parseMs(record.deadline)
        if (deadline === null) {
          if (keepUndated || pinned) {
            const row = rowOf(record, null, now)
            row.pinned = pinned
            rows.push(row)
          }
          continue
        }
        if (!pinned) {
          if (deadline < now && !includePast) continue
          if (deadline > horizon) continue
        }
        const row = rowOf(record, deadline, now)
        row.pinned = pinned
        rows.push(row)
      }

      if (withPending && !opts.withoutPending) {
        for (const entry of (payload && payload.pending) || []) {
          if (!entry) continue
          if (!matches(entry)) continue
          const row = rowOf({ key: entry.key, venue: entry.abbr, name: entry.abbr, fullName: entry.fullName, rank: entry.rank, area: entry.area, pending: true }, null, now)
          row.pinned = false
          rows.push(row)
        }
      }

      rows.sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
        if (left.deadline === null && right.deadline === null) {
          const pendingDelta = (left.record.pending ? 1 : 0) - (right.record.pending ? 1 : 0)
          if (pendingDelta !== 0) return pendingDelta
          return rankWeight(left.record.rank) - rankWeight(right.record.rank) || String(left.record.name).localeCompare(String(right.record.name))
        }
        if (left.deadline === null) return 1
        if (right.deadline === null) return -1
        return left.deadline - right.deadline
      })
      return rows
    }

    function rowOf(record, deadline, now) {
      return {
        key: record.key || `${record.venue}-${record.year}`,
        record,
        deadline,
        notification: parseMs(record.notification),
        rebuttal: parseMs(record.rebuttal),
        daysLeft: deadline === null ? null : Math.round((deadline - now) / DAY),
      }
    }

    /** 缓存是否算陈旧（默认 24h）。 */
    function isStale(payload, now, staleHours) {
      const updated = parseMs(payload && payload.updatedAt)
      if (!Number.isFinite(updated)) return true
      const limit = (Number.isFinite(staleHours) ? staleHours : 24) * 3600000
      return (Number.isFinite(now) ? now : Date.now()) - updated > limit
    }

    /** 最近 N 天内截稿的会（按时间升序）：面板顶部的"紧急"横幅用它。 */
    function urgentRows(payload, now, withinDays) {
      const at = Number.isFinite(now) ? now : Date.now()
      const within = Number.isFinite(withinDays) ? withinDays : 7
      return buildRows(payload, { now: at, days: within, keepUndated: false, withoutPending: true })
    }

    /** RFC 5545 文本转义。 */
    function icsEscape(text) {
      return String(text === undefined || text === null ? '' : text)
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r?\n/g, '\\n')
    }

    /** 毫秒 → `20261117T115959Z`（ICS 用 UTC，写真实时刻，不写本地钟）。 */
    function icsStamp(ms) {
      const iso = new Date(ms).toISOString()
      return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
    }

    /**
     * 把当前视图导成日历（ICS）：每个会一条「截稿」，有审稿决定时间的再加一条。
     * 只导有日期且未过期的会——把已经过去的截稿塞进日历只会让人误删提醒。
     *
     * @param {any[]} rows `buildRows` 的结果
     * @param {{ now?: number, calendarName?: string, timeZone?: string }} [options]
     * @returns {string} ICS 文本
     */
    /**
     * RFC 5545 要求单行不超过 75 字节（UTF-8），超出要折行、续行以空格开头。
     * 中文一行 20 多个字就到 75 字节了，不折行有些日历（Outlook 老版本、部分手机端）会直接拒收。
     */
    function foldLine(line, limit = 73) {
      const text = String(line ?? '')
      const encoder = new TextEncoder()
      if (encoder.encode(text).length <= limit) return text
      const parts = []
      let current = ''
      let bytes = 0
      for (const char of text) {
        const size = encoder.encode(char).length
        if (bytes + size > limit) {
          parts.push(current)
          current = ''
          bytes = 0
        }
        current += char
        bytes += size
      }
      if (current) parts.push(current)
      return parts.map((part, index) => (index === 0 ? part : ` ${part}`)).join('\r\n')
    }

    function buildIcs(rows, options) {
      const opts = options || {}
      const now = Number.isFinite(opts.now) ? opts.now : Date.now()
      const stamp = icsStamp(now)
      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//dsh-ccf//CCF deadlines//ZH',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${icsEscape(opts.calendarName || 'CCF 会议截稿')}`,
      ]
      const events = []
      for (const row of Array.isArray(rows) ? rows : []) {
        const record = row && row.record
        if (!record || record.pending) continue
        const key = String(row.key || record.key || record.venue || 'conference')
        const title = `${record.name || record.venue || '会议'}${record.year && !String(record.name ?? '').includes(String(record.year)) ? ` ${record.year}` : ''}`
        const meta = [record.rank, record.areaGroup || record.area, record.place].filter(Boolean).join(' · ')
        // 日期有两个说法时，日历里也得留一句：导进日历就是为了照着它安排时间，
        // 只写首选来源的那个日期，等于把"可能不准"这件事悄悄抹掉。
        const alt = (Array.isArray(record.alternatives) ? record.alternatives : [])
          .filter((item) => item && Number.isFinite(item.deadline))
          .slice(0, 2)
          .map((item) => `${item.source || '另一来源'} ${formatInstant(item.deadline, opts.timeZone)}`)
          .join('；')
        const push = (kind, at) => {
          if (!Number.isFinite(at) || at < now) return
          events.push(
            'BEGIN:VEVENT',
            `UID:${icsEscape(`${key}-${kind}`)}@dsh-ccf`,
            `DTSTAMP:${stamp}`,
            `DTSTART:${icsStamp(at)}`,
            `DTEND:${icsStamp(at + 3600000)}`,
            `SUMMARY:${icsEscape(`${title} ${kind}`)}`,
            `DESCRIPTION:${icsEscape([meta, alt ? `另一个来源的说法：${alt}（本条目用的是首选来源的日期）` : '', record.link].filter(Boolean).join('\n'))}`,
            record.link ? `URL:${icsEscape(record.link)}` : '',
            // 导进日历本来就是为了被提醒：提前一天弹一次。
            'BEGIN:VALARM',
            'TRIGGER:-P1D',
            'ACTION:DISPLAY',
            `DESCRIPTION:${icsEscape(`${title} ${kind} 就在明天`)}`,
            'END:VALARM',
            'END:VEVENT',
          )
        }
        push('截稿', parseMs(record.deadline))
        push('审稿决定', parseMs(record.notification))
      }
      if (events.length > 0) lines.push(...events)
      lines.push('END:VCALENDAR')
      return `${lines.map((line) => foldLine(line)).join('\r\n')}\r\n`
    }

    /** 当前视图的纯文本清单（贴进周报/邮件用，制表符分隔）。 */
    function clipboardText(rows, timeZone) {
      const tz = timeZone || 'Asia/Shanghai'
      const head = ['会议', '等级', '方向', '截稿', '审稿决定', '地点'].join('\t')
      const list = Array.isArray(rows) ? rows : []
      // 名单里的 name 常常已经带年份（CVPR 2027），再拼一次就成「CVPR 2027 2027」。
      const nameOf = (record) => {
        const base = String(record.name || record.venue || '').trim()
        return record.year && !base.includes(String(record.year)) ? `${base} ${record.year}` : base
      }
      const body = list.map((row) => {
        const record = row && row.record ? row.record : {}
        const deadline = row && row.deadline
        const notification = row && row.notification
        return [
          nameOf(record),
          record.rank || '',
          record.areaGroup || record.area || '',
          deadline ? formatInstant(deadline, tz) : (record.pending ? '待补' : '—'),
          notification ? formatInstant(notification, tz) : '—',
          record.place || '',
        ].join('\t')
      })
      // 表格是给人复制去汇报的：日期有两个说法时单独注一行，
      // 不然贴出去的「截稿 11-20」看着就像唯一答案。
      const notes = []
      for (const row of list) {
        const record = row && row.record ? row.record : null
        if (!record) continue
        const alts = (Array.isArray(record.alternatives) ? record.alternatives : [])
          .filter((item) => item && Number.isFinite(item.deadline))
          .slice(0, 2)
        if (alts.length === 0) continue
        const shown = Number.isFinite(row.deadline) ? formatInstant(row.deadline, tz) : '未知'
        const said = alts.map((item) => `${item.source || '另一来源'} ${formatInstant(item.deadline, tz)}`).join('；')
        notes.push(`注：${nameOf(record)} 的截稿有两个说法——表里写的是 ${shown}，另有 ${said}`)
      }
      return [head, ...body, ...(notes.length > 0 ? ['', ...notes] : [])].join('\n')
    }


    /** 上一次"补数据"的结果；没跑过 → 空串。 */
    function updateSummary(meta) {
      if (!meta || !parseMs(meta.lastUpdateAt)) return ''
      const mined = Number.isFinite(meta.lastUpdateMined) ? meta.lastUpdateMined : 0
      const failed = Number.isFinite(meta.lastUpdateFailed) ? meta.lastUpdateFailed : 0
      return `上次补数据：成功 ${mined} 个 / 失败 ${failed} 个`
    }

    /** 版本标签：宿主端没回版本时返回空串（说明跑的是旧模块）。 */
    function versionLabel(payload) {
      const version = payload && typeof payload.version === 'string' ? payload.version : ''
      if (!version) return ''
      // 磁盘上已经换了新版本、进程还停在旧模块：把这件事直接印在版本号后面，
      // 否则用户改完代码看不出「界面没变」是因为没重启。
      if (payload && payload.versionStale === true && typeof payload.versionDisk === 'string' && payload.versionDisk) {
        return `dsh-ccf v${version}（磁盘上已是 v${payload.versionDisk}：重启桌面端生效）`
      }
      return `dsh-ccf v${version}`
    }

    /**
     * 补数据的实时进度：`正在补数据 3/6：CVPR · 42 秒（本轮已补到 2 个，没补到 0 个）`。
     *
     * 只有宿主端明确说在跑时才返回非空——没在跑的时候不能凭空编一句"正在补数据"。
     */
    function progressLabel(progress, fallbackElapsedMs) {
      if (!progress || progress.busy !== true) return ''
      const total = Number.isFinite(progress.total) && progress.total > 0 ? progress.total : null
      const index = Number.isFinite(progress.index) ? progress.index : null
      const step = total && index ? ` ${index}/${total}` : total ? ` ${progress.done || 0}/${total}` : ''
      const who = typeof progress.current === 'string' && progress.current ? `：${progress.current}` : ''
      const elapsedMs = Number.isFinite(progress.elapsedMs) ? progress.elapsedMs : fallbackElapsedMs
      const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs / 1000)) : 0
      const ok = Number.isFinite(progress.ok) ? progress.ok : 0
      const failed = Number.isFinite(progress.failed) ? progress.failed : 0
      const tail = ok + failed > 0 ? `（本轮已补到 ${ok} 个，没补到 ${failed} 个）` : ''
      return `正在补数据${step}${who} · ${seconds} 秒${tail}`
    }

    // ---------------------------------------------------------------- 样式
    const wrapStyle = { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 2147482000 }

    const tabStyle = {
      position: 'fixed',
      right: '0',
      top: '46%',
      transform: 'translateY(-50%)',
      pointerEvents: 'auto',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '2px',
      padding: '10px 7px',
      border: `1px solid ${UI.colors.line}`,
      borderRight: 'none',
      borderRadius: '12px 0 0 12px',
      background: 'Canvas',
      color: 'CanvasText',
      cursor: 'pointer',
      boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
      font: '11px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif',
    }

    const panelStyle = {
      position: 'fixed',
      top: '56px',
      right: '0',
      bottom: '14px',
      width: `${PANEL_WIDTH}px`,
      maxWidth: '94vw',
      display: 'flex',
      flexDirection: 'column',
      pointerEvents: 'auto',
      background: 'Canvas',
      color: 'CanvasText',
      border: `1px solid ${UI.colors.line}`,
      borderRight: 'none',
      borderRadius: '14px 0 0 14px',
      boxShadow: '-10px 0 40px rgba(0,0,0,0.22)',
      font: '12px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif',
      overflow: 'hidden',
    }

    const headStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '10px 12px',
      borderBottom: `1px solid ${UI.colors.line}`,
    }

    const iconButton = {
      marginLeft: 'auto',
      border: `1px solid ${UI.colors.line}`,
      background: 'transparent',
      color: 'inherit',
      borderRadius: '8px',
      padding: '2px 8px',
      cursor: 'pointer',
      font: 'inherit',
    }

    const chipStyle = (active) => ({
      border: `1px solid ${active ? 'transparent' : UI.colors.line}`,
      background: active ? 'rgba(37,99,235,0.16)' : 'transparent',
      color: 'inherit',
      borderRadius: '999px',
      padding: '1px 9px',
      cursor: 'pointer',
      font: 'inherit',
    })

    const cardStyle = {
      padding: '9px 12px',
      borderBottom: `1px solid ${UI.colors.lineSoft}`,
    }

    const gridStyle = {
      display: 'grid',
      gridTemplateColumns: '66px 1fr',
      columnGap: '8px',
      rowGap: '1px',
      marginTop: '4px',
    }

    const labelStyle = { color: UI.colors.muted, whiteSpace: 'nowrap' }
    const valueStyle = { wordBreak: 'break-word' }

    const bannerStyle = {
      display: 'flex',
      alignItems: 'baseline',
      gap: '6px',
      padding: '6px 12px',
      borderBottom: `1px solid ${UI.colors.lineSoft}`,
      background: 'rgba(185,28,28,0.08)',
      color: UI.colors.hot,
      fontSize: '11px',
    }

    const noticeStyle = {
      display: 'flex',
      gap: '8px',
      alignItems: 'flex-start',
      padding: '6px 12px',
      borderBottom: `1px solid ${UI.colors.lineSoft}`,
      background: 'rgba(37,99,235,0.08)',
      fontSize: '11px',
    }

    const footerStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '5px 12px',
      borderTop: `1px solid ${UI.colors.lineSoft}`,
      color: UI.colors.muted,
      fontSize: '10px',
    }

    const detailGrid = {
      display: 'grid',
      gridTemplateColumns: '66px 1fr',
      columnGap: '8px',
      rowGap: '1px',
      marginTop: '4px',
      paddingTop: '4px',
      borderTop: `1px dashed ${UI.colors.lineSoft}`,
    }

    const dragHandle = {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      width: '4px',
      cursor: 'col-resize',
      background: 'transparent',
    }

    const markButton = { font: 'inherit', fontSize: '11px', padding: '2px 8px', borderRadius: '8px', border: '1px solid ' + UI.colors.line, background: 'transparent', color: UI.colors.muted, cursor: 'pointer' }
const chipNew = {
      border: '1px solid ' + UI.colors.hot,
      color: UI.colors.hot,
      borderRadius: '6px',
      padding: '0 4px',
      fontSize: '9px',
      lineHeight: '14px',
    }

    // ---------------------------------------------------------------- 组件
    function readOpen() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) === '1'
      } catch {
        return false
      }
    }

    function writeOpen(open) {
      try {
        window.localStorage.setItem(STORAGE_KEY, open ? '1' : '0')
      } catch {
        /* 隐私模式下 localStorage 会抛，忽略 */
      }
    }

    function readWidth() {
      try {
        const stored = Number(window.localStorage.getItem(STORAGE_WIDTH))
        return Number.isFinite(stored) && stored >= 300 && stored <= 720 ? stored : PANEL_WIDTH
      } catch {
        return PANEL_WIDTH
      }
    }

    function writeWidth(width) {
      try {
        window.localStorage.setItem(STORAGE_WIDTH, String(width))
      } catch {
        /* 隐私模式下 localStorage 会抛，忽略 */
      }
    }

    /** 关注的会议（纯客户端，存 localStorage；按记录的 key 精确匹配）。 */
    function readPins() {
      try {
        const raw = window.localStorage.getItem(STORAGE_PINS)
        const parsed = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? parsed.map((key) => String(key || '')).filter(Boolean) : []
      } catch {
        return []
      }
    }

    function writePins(pins) {
      try {
        const unique = Array.from(new Set((Array.isArray(pins) ? pins : []).map((key) => String(key || '')).filter(Boolean)))
        window.localStorage.setItem(STORAGE_PINS, JSON.stringify(unique))
      } catch {
        /* 隐私模式下 localStorage 会抛，忽略 */
      }
    }

    function togglePin(pins, key) {
      const next = new Set((Array.isArray(pins) ? pins : []).map(String))
      const target = String(key || '')
      if (!target) return Array.from(next)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return Array.from(next)
    }

    /** 最近一天内被模型挖到的记录：卡片上打「新」，让"刚补到的"一眼可见。 */
    function isNew(record, withinMs) {
      const minedAt = parseMs(record && record.minedAt)
      if (minedAt === null) return false
      return Date.now() - minedAt <= (Number.isFinite(withinMs) ? withinMs : DAY)
    }

    function Line(props) {
      const { label, value, hint, tone, title } = props
      return [
        h('span', { key: 'l', style: labelStyle }, label),
        h('span', { key: 'v', title: title || undefined, style: { ...valueStyle, color: tone || 'inherit' } }, value, hint ? h('span', { style: { color: UI.colors.muted } }, ` · ${hint}`) : null),
      ]
    }

    /** 一张会议卡片：截稿 / 摘要 / 审稿决定 / rebuttal / 开会 / 地点；点标题展开详情。 */
    /**
     * 两个来源说法不一样时，把另一种说法和「采信」按钮摆出来。
     *
     * 不替用户判断谁对：插件只负责把两边的日期都写出来，选哪边由读者决定，
     * 而且随时能点回默认。
     */
    function alternativesView(record, timeZone, onPrefer) {
      const alternatives = Array.isArray(record.alternatives) ? record.alternatives : []
      if (alternatives.length === 0) return null
      const chooser = typeof onPrefer === 'function'
      return h('div', { style: { gridColumn: '1 / -1', marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '2px' } },
        h('div', { style: { color: UI.colors.muted, fontSize: '10px' } },
          record.preferredSource
            ? `当前采信：${record.preferredSource}${record.preferredInherited ? '（沿用你给这个会设的来源，新一届自动生效）' : '（不是插件默认的首选来源）'}`
            : '下面另一种说法来自另一个数据源；觉得它更对就点「采信」'),
        alternatives.map((item) => h('div', { key: item.source, style: { display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '11px' } },
          h('span', { style: { color: UI.colors.muted } }, `${item.source}：${formatInstant(parseMs(item.deadline), timeZone)}`),
          chooser
            ? h('button', {
              onClick: (event) => {
                event.stopPropagation()
                onPrefer(record.key, item.source)
              },
              title: `按 ${item.source} 给的日期显示`,
              style: { ...iconButton, marginLeft: '0', padding: '0 6px', fontSize: '10px' },
            }, '采信')
            : null,
        )),
        record.preferredSource && chooser
          ? h('button', {
            onClick: (event) => {
              event.stopPropagation()
              onPrefer(record.key, '')
            },
            style: { ...iconButton, marginLeft: '0', padding: '0 6px', fontSize: '10px', alignSelf: 'flex-start' },
          }, '恢复默认')
          : null,
      )
    }

    function Card(props) {
      const { row, timeZone, expanded, onToggle, onPin, onMine, onPrefer, onMark } = props
      const record = row.record
      const pending = record.pending === true
      const pinned = row.pinned === true
      const passed = Number.isFinite(row.deadline) && row.deadline < Date.now()
      const tone = Number.isFinite(row.deadline) && row.deadline - Date.now() <= 7 * DAY ? UI.colors.hot : passed ? UI.colors.muted : 'inherit'
      const title = pending ? record.venue : `${record.venue || record.name}${record.year ? ` ${record.year}` : ''}`
      const aliases = Array.isArray(record.aliases) ? record.aliases.filter(Boolean) : []
      const details = [
        ['别名', aliases.length > 0 ? aliases.join(' / ') : '—'],
        ['录用率', record.acceptRate ? String(record.acceptRate) : '—'],
        ['h5', Number.isFinite(record.h5) ? String(record.h5) : '—'],
        ['核心', record.core || '—'],
      ]
      // 官方口径与往届截稿：跟官网对照时间、判断"今年会不会提前"都靠这两行。
      const official = sourceZoneLine(record)
      if (official) details.push(['官方口径', official])
      const history = historyLine(record)
      if (history) details.push(['往届截稿', history])
      const conflict = conflictLine(record, timeZone)
      if (conflict) details.push(['来源冲突', conflict])
      // 模型挖到的日期，出处是它当时读的网页：想核对就点回去（这也是"别信模型"的兜底）
      // 认领了但全称对不上：多半是同简称的另一个会（SEC = 边缘计算 vs 信息安全），值得核对
      if (record.satellite === true) details.push(['卫星会', 'Workshop / 地区分会场：数据是真的，但它不计入名单里那个主会的截稿'])
      if (record.weakMatch === true) details.push(['建议核对', '这条记录的全称和名单里同名会不一致，可能是另一个会（同简称）'])
      // 核对完要能给出结论，否则「建议核对」会永远挂在那里。两种结论都只写 meta，不动数据。
      // 卫星会也要给「不是这个会」：workshop 数据也可能是错的（或落到了错的系列上），
      // 不然这张卡片是死的，用户只能去命令行才发现有这个动作。
      if ((record.weakMatch === true && record.satellite !== true) || record.satellite === true || record.confirmed === true || record.ignored === true) {
        let marks
        if (record.ignored === true) {
          marks = [h('button', { key: 'undo-ignore', style: markButton, onClick: (event) => { event.stopPropagation(); onMark(record.key, 'ignore', true) }, title: '撤销「不是这个会」：它重新参与覆盖度统计' }, '撤销「不是这个会」')]
        } else if (record.confirmed === true) {
          marks = [h('button', { key: 'undo-confirm', style: markButton, onClick: (event) => { event.stopPropagation(); onMark(record.key, 'confirm', true) }, title: '取消「就是这个会」的确认' }, '取消确认')]
        } else {
          marks = []
          // 「就是这个会」只对主会开放：点了等于承认 workshop 是主会，正是要避免的那个错
          if (record.satellite !== true) {
            marks.push(h('button', { key: 'confirm', style: markButton, onClick: (event) => { event.stopPropagation(); onMark(record.key, 'confirm', false) }, title: '确认这条就是名单里那个会，不再提示核对' }, '就是这个会'))
          }
          marks.push(h('button', { key: 'ignore', style: markButton, onClick: (event) => { event.stopPropagation(); onMark(record.key, 'ignore', false) }, title: record.satellite === true ? '这条 workshop / 地区分会场不该出现（比如落到了错的系列上）：标了就不再计入卫星会统计' : '标成「不是这个会」：不再算进任何会的覆盖度' }, '不是这个会'))
        }
        details.push(['核对结论', h('div', { key: 'marks', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, marks)])
      }
      const minedFrom = Array.isArray(record.minedFrom) ? record.minedFrom.filter(Boolean) : []
      if (record.source === 'model' && minedFrom.length > 0) {
        details.push(['挖自', minedFrom.slice(0, 2).join(' ；')])
      }
      return h('div', { style: pending ? { ...cardStyle, opacity: 0.72 } : cardStyle },
        h('div', {
          style: { display: 'flex', alignItems: 'baseline', gap: '6px', cursor: pending ? 'default' : 'pointer' },
          onClick: pending ? undefined : onToggle,
          // 键盘用户没法"点一下 div"：给它焦点位，并让 Enter / 空格等于点击。
          tabIndex: pending ? undefined : 0,
          onKeyDown: pending
            ? undefined
            : (event) => {
              if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
              event.preventDefault()
              onToggle()
            },
          role: pending ? undefined : 'button',
          'aria-expanded': pending ? undefined : expanded ? 'true' : 'false',
          title: pending ? '名单里有，还没挖到时间点' : expanded ? '收起详情' : '展开详情',
        },
          h('strong', { style: { fontSize: '13px' } }, title),
          record.rank ? h('span', { style: { color: UI.colors.muted } }, record.rank) : null,
          record.area ? h('span', { style: { color: UI.colors.muted } }, `· ${record.area}`) : null,
          !pending && isNew(record) ? h('span', { style: { marginLeft: 'auto', ...chipNew } }, '新') : null,
          !pending && record.conflict
            ? h('span', { style: { marginLeft: !pending && isNew(record) ? '4px' : 'auto', color: UI.colors.warn, fontSize: '10px', border: `1px solid ${UI.colors.warn}`, borderRadius: '6px', padding: '0 3px' }, title: conflictLine(record, timeZone) }, '来源不一致')
            : null,
          pending ? h('span', { style: { marginLeft: !pending && isNew(record) ? '6px' : 'auto', color: UI.colors.muted } }, '待补') : null,
          !pending && record.link ? h('a', { href: record.link, target: '_blank', rel: 'noreferrer', onClick: (event) => event.stopPropagation(), style: { marginLeft: 'auto', color: 'inherit', opacity: 0.75, textDecoration: 'none' } }, '官网 ↗') : null,
          pending || typeof onPin !== 'function'
            ? null
            : h('button', {
              key: 'pin',
              onClick: (event) => {
                event.stopPropagation()
                onPin(record.key)
              },
              title: pinned ? '取消关注' : '关注：无论窗口与截稿时间，都留在列表最上面',
              'aria-label': pinned ? '取消关注' : '关注这个会',
              'aria-pressed': pinned ? 'true' : 'false',
              style: { marginLeft: record.link ? '2px' : 'auto', border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 2px', font: 'inherit', fontSize: '13px', color: pinned ? UI.colors.warn : UI.colors.muted },
            }, pinned ? '★' : '☆'),
          pending ? null : h('span', { style: { color: UI.colors.muted, fontSize: '10px' } }, expanded ? '▾' : '▸'),
        ),
        record.fullName ? h('div', { style: { color: UI.colors.muted, fontSize: '11px' } }, record.fullName) : null,
        pending ? null : h('div', { style: { color: UI.colors.muted, fontSize: '10px' } }, sourceLine(record, timeZone)),
        // 名单外的会：数据是真的，只是 CCF 名单里没有它 —— 说清楚，免得读者以为列表在凑数。
        !pending && record.outside
          ? h('div', { style: { color: UI.colors.muted, fontSize: '10px' } },
            '不在 CCF 名单里（CCFDDL 收录），不算在 362 个会内。',
            typeof onMine === 'function'
              ? h('button', {
                onClick: (event) => { event.stopPropagation(); onMine(record.venue || record.name) },
                title: `用模型再搜一次「${record.venue || record.name}」的官网`,
                style: { ...iconButton, marginLeft: '6px', padding: '0 6px' },
              }, '补这个会')
              : null,
          )
          : null,
        pending
          ? h('div', { style: { marginTop: '2px', color: UI.colors.muted } },
            '名单里有，还没挖到时间点。',
            typeof onMine === 'function'
              ? h('button', {
                onClick: () => onMine(record.venue || record.name),
                title: `用模型搜「${record.venue || record.name}」的官网补这一个会`,
                style: { ...iconButton, marginLeft: '6px', padding: '0 6px' },
              }, '补这个会')
              : null,
            record.dblp
              ? h('a', { href: record.dblp, target: '_blank', rel: 'noreferrer', style: { marginLeft: '6px', color: 'inherit' } }, 'DBLP ↗')
              : null,
          )
          : h('div', { style: gridStyle },
            h(Line, { label: '截稿', value: formatInstant(row.deadline, timeZone), hint: row.deadline === null ? '' : countdownLabel(row.deadline, Date.now()), tone, title: sourceZoneLine(record) || undefined }),
            h(Line, { label: '摘要截止', value: formatInstant(parseMs(record.abstractDeadline), timeZone), tone: UI.colors.muted }),
            h(Line, { label: '审稿决定', value: formatInstant(row.notification, timeZone), hint: row.notification && row.notification >= Date.now() ? countdownLabel(row.notification, Date.now()) : '' }),
            h(Line, { label: 'rebuttal', value: formatInstant(row.rebuttal, timeZone), hint: row.rebuttal ? countdownLabel(row.rebuttal, Date.now()) : '上游未提供' }),
            h(Line, { label: '开会', value: record.confDate || '—' }),
            h(Line, { label: '地点', value: record.place || '—' }),
          ),
        !pending && expanded
          ? h('div', { style: detailGrid },
            details.map(([label, value]) => h(Line, { key: label, label, value })),
            record.submitLink
              ? h('div', { style: { gridColumn: '1 / -1', marginTop: '2px' } },
                h('a', { href: record.submitLink, target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } }, '投稿入口 ↗'))
              : null,
            alternativesView(record, timeZone, onPrefer),
            // 模型挖错了日期时，唯一的纠错路径是"再挖一次"：这里给它一个按钮，
            // 而不是让人去改 cache.json。
            typeof onMine === 'function' && record.source === 'model'
              ? h('div', { style: { gridColumn: '1 / -1', marginTop: '2px' } },
                h('button', {
                  onClick: (event) => {
                    event.stopPropagation()
                    onMine(record.venue || record.name)
                  },
                  title: '这条是模型挖到的：日期看起来不对就再搜一次它的官网',
                  style: { ...iconButton, marginLeft: '0', border: `1px solid ${UI.colors.line}`, borderRadius: '8px', padding: '2px 8px', fontSize: '11px' },
                }, '重挖这个会'),
              )
              : null,
          )
          : null,
      )
    }

    function Toolbar(props) {
      const { days, onDays, rank, onRank, mode, onMode, search, onSearch, loading, onRefresh, onSync, onUpdate, areas, area, onArea, counts, modelReady, onCopy, onIcs, onUpdateScope, onPinAll, onClearPins, pinCount = 0, onReset, showSatellites, onSatellites, satelliteCount = 0 } = props
      const ranks = ['all', 'CCF-A', 'CCF-B', 'CCF-C']
      const totals = counts && typeof counts === 'object' ? counts : {}
      const modeCount = { all: totals.conferences, data: Number.isFinite(totals.withFuture) ? totals.withFuture : totals.withDeadline, pending: totals.pending, pins: pinCount, marks: Number.isFinite(totals.marks) ? totals.marks : 0, conflicts: Number.isFinite(totals.conflicts) ? totals.conflicts : 0 }
      const modeLabel = (value, label) => (Number.isFinite(modeCount[value]) ? `${label} ${modeCount[value]}` : label)
      // 「关注」只在真的关注过会之后才出现：没关注时多一个空视图只是噪音。
      const modes = [['all', '全部'], ['data', '有数据'], ['pending', '待补']]
      if (pinCount > 0) modes.push(['pins', '关注'])
      // 裁决过的记录（标了不是这个会 / 确认了就是这个会）：有才出现，没有时不占位置
      const markedCount = Number.isFinite(totals.marks) ? totals.marks : 0
      if (markedCount > 0) modes.push(['marks', '已裁决'])
      // 状态行报了「N 条来源不一致」，这里给个入口：点进去只剩这几条，才找得到是哪几条
      const conflictCount = Number.isFinite(totals.conflicts) ? totals.conflicts : 0
      const conflictDecided = Number.isFinite(totals.conflictsDecided) ? totals.conflictsDecided : 0
      if (conflictCount > 0) modes.push(['conflicts', '不一致'])
      const conflictTitle = conflictCount === 0
        ? ''
        : conflictDecided > 0
          ? `${conflictCount} 条的两个来源说法不同，其中 ${conflictDecided} 条你已经采信了某个来源，还有 ${conflictCount - conflictDecided} 条没决定`
          : `${conflictCount} 条的两个来源给的截稿差了一天以上，点进去可以逐个或整批采信`
      const canMine = modelReady !== false
      const areaOptions = [].concat([h('option', { key: '', value: '' }, '全方向')], (areas || []).map((name) => h('option', { key: name, value: name }, name)))
      return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', padding: '8px 12px', borderBottom: `1px solid ${UI.colors.lineSoft}` } },
        h('input', {
          value: search,
          onChange: (event) => onSearch(event.target.value),
          placeholder: '搜会议名/地点/方向…',
          style: { flex: '1 1 120px', minWidth: '90px', padding: '3px 8px', border: `1px solid ${UI.colors.line}`, borderRadius: '8px', background: 'transparent', color: 'inherit', font: 'inherit' },
        }),
        modes.map(([value, label]) => h('button', { key: value, onClick: () => onMode(value), title: value === 'conflicts' ? conflictTitle : undefined, style: chipStyle(mode === value) }, modeLabel(value, label))),
        // 卫星会（Workshop / 地区分会场）默认不列：有的话给个开关，标题里说清它们不算主会。
        // 已经打开时即使这个视图里一个都没有，也要留着开关——否则关不掉，下一屏它们又混进来了。
        // 「已裁决」视图本来就不过滤卫星会，那里放开关只是空按钮，不显示。
        (satelliteCount > 0 || showSatellites === true) && mode !== 'marks'
          ? h('button', {
            key: 'satellites',
            onClick: () => onSatellites(!showSatellites),
            title: showSatellites
              ? `当前视图里有 ${satelliteCount} 个 Workshop / 地区分会场，正列在主会旁边。点一下收起来。`
              : `把 ${satelliteCount} 个 Workshop / 地区分会场也列进来。它们不算进主会的截稿与「待补」统计。`,
            'aria-pressed': showSatellites ? 'true' : 'false',
            style: chipStyle(showSatellites === true),
          }, satelliteCount > 0 ? `卫星会 ${satelliteCount}` : '卫星会')
          : null,
        // 试过搜索/等级/方向之后，总得有个一键回到默认的出口。
        search || rank !== 'all' || area || days !== 120
          ? h('button', {
            key: 'reset',
            onClick: () => onReset && onReset(),
            title: '清空搜索、等级、方向，并把天数恢复成 120 天',
            style: { ...chipStyle(false), color: UI.colors.muted },
          }, '重置筛选')
          : null,
        mode === 'pending' && typeof onUpdateScope === 'function'
          ? [
            ['past', `补往届 ${Number.isFinite(totals.pendingPast) ? totals.pendingPast : '?'}`],
            ['never', `补从未 ${Number.isFinite(totals.pendingNever) ? totals.pendingNever : '?'}`],
          ].map(([scope, text]) => h('button', {
            key: `scope-${scope}`,
            onClick: () => onUpdateScope(scope),
            disabled: loading || !canMine,
            title: scope === 'past' ? '只补「缓存里只有往届日期」的会：它们的下一届日期还没抓到' : '只补「一条记录都没有」的会：名单里有、从没抓到过',
            style: { ...iconButton, marginLeft: '0', opacity: canMine ? 1 : 0.5 },
          }, text))
          : null,
        h('select', {
          value: String(days),
          onChange: (event) => onDays(Number(event.target.value)),
          disabled: mode === 'pending',
          title: mode === 'pending' ? '「待补」列的是名单里还没有日期的会，没有截稿可筛，所以天数在这里不起作用' : '只看这个窗口内有截稿的会（待补的会不受窗口限制）',
          style: { padding: '3px 4px', border: `1px solid ${UI.colors.line}`, borderRadius: '8px', background: 'transparent', color: 'inherit', font: 'inherit', opacity: mode === 'pending' ? 0.4 : 1 },
        }, [30, 60, 120, 240, 365].map((value) => h('option', { key: value, value: String(value) }, `${value} 天`))),
        ranks.map((value) => h('button', { key: value, onClick: () => onRank(value), style: chipStyle(rank === value) }, value === 'all' ? '全档' : value.replace('CCF-', ''))),
        h('select', {
          value: area,
          onChange: (event) => onArea(event.target.value),
          title: '只看这个方向（CCF 名单的十个方向）',
          style: { maxWidth: '132px', padding: '3px 4px', border: `1px solid ${UI.colors.line}`, borderRadius: '8px', background: 'transparent', color: 'inherit', font: 'inherit' },
        }, areaOptions),
        h('button', { onClick: onRefresh, disabled: loading, style: iconButton, title: '重新读取本机缓存', 'aria-label': '刷新' }, loading ? '…' : '刷新'),
        h('button', {
          onClick: onUpdate,
          disabled: loading || !canMine,
          style: { ...iconButton, marginLeft: '0', opacity: canMine ? 1 : 0.5 },
          title: canMine ? '用模型逐个搜会议官网补数据：一轮只补几个，需要几十秒' : '当前没有可用模型：先用「同步」从 CCFDDL 接口取数据',
          'aria-label': '补数据（模型）',
        }, '补数据'),
        h('button', { onClick: onSync, disabled: loading, style: { ...iconButton, marginLeft: '0' }, title: '从 CCFDDL 官方接口同步全部会议（几秒，不需要模型）', 'aria-label': '同步（接口）' }, '同步'),
        h('button', { onClick: onCopy, disabled: loading, style: { ...iconButton, marginLeft: '0' }, title: '把当前视图复制成制表符清单（贴进周报/邮件）', 'aria-label': '复制清单' }, '复制'),
        h('button', { onClick: onIcs, disabled: loading, style: { ...iconButton, marginLeft: '0' }, title: '把当前视图导出为日历文件（.ics，可导入系统日历）', 'aria-label': '导出日历' }, '日历'),
        typeof onPinAll === 'function'
          ? h('button', { onClick: onPinAll, disabled: loading, style: { ...iconButton, marginLeft: '0' }, title: '把当前视图里的会全部关注（已经关注的不会重复）', 'aria-label': '关注当前视图' }, '全关注')
          : null,
        typeof onClearPins === 'function' && pinCount > 0
          ? h('button', { onClick: onClearPins, disabled: loading, style: { ...iconButton, marginLeft: '0' }, title: `清空关注（当前 ${pinCount} 个）`, 'aria-label': '清空关注' }, `清关注 ${pinCount}`)
          : null,
      )
    }

    function CcfPanel() {
      const [open, setOpen] = React.useState(readOpen)
      const [payload, setPayload] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [days, setDays] = React.useState(120)
      const [rank, setRank] = React.useState('all')
      const [mode, setMode] = React.useState('data')
      const [search, setSearch] = React.useState('')
      const [area, setArea] = React.useState('')
      const [width, setWidth] = React.useState(readWidth)
      const [pins, setPins] = React.useState(readPins)
      const [showSatellites, setShowSatellites] = React.useState(() => {
        try { return window.localStorage.getItem('dsh-ccf:satellites') === '1' } catch { return false }
      })
      const [seen, setSeen] = React.useState(readSeen)
      const [busy, setBusy] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      const busySince = React.useRef(0)
      const [expanded, setExpanded] = React.useState({})
      const [showSources, setShowSources] = React.useState(false)
      const autoSynced = React.useRef(false)
      // 打开面板把焦点移进去（否则键盘/读屏用户的焦点掉到 body 上），收起时还回标签。
      const panelRef = React.useRef(null)
      const tabRef = React.useRef(null)
      const wasOpen = React.useRef(false)
      // 正在跑「补数据」时用：POST 要等整轮结束才回，中途靠轮询 /records 拿进度。
      const mining = React.useRef(false)

      const load = React.useCallback(async (path, init, flash) => {
        setLoading(true)
        setError(null)
        busySince.current = Date.now()
        setBusy(flash ? String(flash) : '处理中…')
        const probe = { status: null, text: '' }
        try {
          const response = await fetch(path, init)
          probe.status = response.status
          // 先拿文本再自己解析：路由没挂上时返回的是一段 HTML，直接 response.json() 只会抛
          // "Unexpected token '<'"，那是给开发者看的，不是给读者看的。
          probe.text = typeof response.text === 'function' ? await response.text() : ''
          let body = null
          try {
            body = probe.text ? JSON.parse(probe.text) : null
          } catch {
            body = null
          }
          // 409 = 上一轮补数据还在跑：不是错误，是"等一会儿"，用提示条说清楚。
          // 这里刻意不动 payload：没有旧数据时让面板照常走空态，而不是拿一个没有 records 的 body 去渲染。
          if (response.status === 409 && body && body.busy) {
            setNotice(typeof body.note === 'string' && body.note ? body.note : '上一轮补数据还没跑完，等它结束再点。')
            return
          }
          if (!response.ok || !body || body.ok === false) {
            const said = body && typeof body.error === 'string' && body.error ? body.error : ''
            throw new Error(said || describeFailure({ status: response.status, text: probe.text }))
          }
          setPayload(body)
          const said = typeof body.note === 'string' && body.note ? body.note : typeof body.report === 'string' ? body.report : ''
          if (flash) setNotice(said || flash)
        } catch (failure) {
          setError(describeFailure({ status: probe.status, text: probe.text, failure }))
        } finally {
          setLoading(false)
          setBusy(null)
        }
      }, [])

      // 打开时读缓存；每 5 分钟刷一次（只是读本机文件，很便宜）。
      React.useEffect(() => {
        if (!open) return undefined
        if (!payload) load(ROUTE_RECORDS)
        const timer = window.setInterval(() => load(ROUTE_RECORDS), 300000)
        return () => window.clearInterval(timer)
      }, [open, payload, load])

      // 补数据期间每 2.5 秒读一次进度：否则几分钟里用户只看到一个不动的秒表，
      // 不知道是在补第几个会、卡住了还是在慢慢跑。
      React.useEffect(() => {
        if (!open) return undefined
        const timer = window.setInterval(() => {
          const busy = mining.current || Boolean(payload && payload.meta && payload.meta.updateProgress && payload.meta.updateProgress.busy)
          if (busy) load(ROUTE_RECORDS)
        }, 2500)
        return () => window.clearInterval(timer)
      }, [open, payload, load])

      // 首次打开若没有数据、或数据超过 6 小时没更新，自动拉一次接口数据：
      // 新用户不该为了"看到东西"先学会区分「补数据」和「同步」。
      React.useEffect(() => {
        if (!open || !payload || loading || autoSynced.current) return
        const empty = !Array.isArray(payload.records) || payload.records.length === 0
        if (!empty && !isStale(payload, Date.now(), 6)) return
        autoSynced.current = true
        load(ROUTE_SYNC, { method: 'POST' }, '首次打开，正在自动同步 CCFDDL 数据…')
      }, [open, payload, loading, load])

      // ESC 收起。
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            setOpen(false)
            writeOpen(false)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      // 长任务读秒：补数据要跑几十秒，不能让按钮看起来像卡死。
      React.useEffect(() => {
        if (!busy) return undefined
        const timer = window.setInterval(() => setTick((value) => value + 1), 1000)
        return () => window.clearInterval(timer)
      }, [busy])

      // 宽度拖拽：左边缘把手，松手后写进 localStorage。
      const startDrag = (event) => {
        event.preventDefault()
        const startX = event.clientX
        const startWidth = width
        const onMove = (move) => {
          setWidth(Math.min(720, Math.max(300, startWidth + (startX - move.clientX))))
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          setWidth((value) => {
            writeWidth(value)
            return value
          })
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      }

      const toggle = (next) => {
        setOpen(next)
        writeOpen(next)
      }

      const pin = (key) => {
        setPins((previous) => {
          const next = togglePin(previous, key)
          writePins(next)
          return next
        })
      }

      const pinAll = () => {
        // 只关注当前视图里"真的有数据"的会：待补的会没有时间点，钉住也没意义。
        const keys = shownRows.filter((row) => row.record && row.record.pending !== true).map((row) => row.record.key)
        const next = mergePins(pins, keys)
        setPins(next)
        writePins(next)
        setNotice(next.length === pins.length ? '当前视图里的会都已经关注了。' : `已关注当前视图里的 ${next.length - pins.length} 个会（共 ${next.length} 个）。`)
      }

      const clearPins = () => {
        setPins([])
        writePins([])
        setNotice('已清空关注列表。')
      }

      const now = Date.now()
      const timeZone = payload && payload.timezone ? payload.timezone : undefined
      // 宿主端说正在补数据时，状态行优先显示真实进度（第几个、在补谁、多少秒）。
      const live = payload && payload.meta ? progressLabel(payload.meta.updateProgress) : ''
      const filters = { now, days, ranks: rank === 'all' ? null : [rank], search, pins, includeSatellites: showSatellites }
      const viewOpts = mode === 'pending'
        ? { ...filters, onlyPending: true }
        : mode === 'data'
          ? { ...filters, withoutPending: true }
          : mode === 'pins'
            ? { ...filters, withoutPending: true, onlyPinned: true }
            : mode === 'marks'
              ? { ...filters, withoutPending: true, onlyMarked: true }
              : mode === 'conflicts'
                ? { ...filters, withoutPending: true, onlyConflicts: true }
                : filters
      const rows = payload ? buildRows(payload, viewOpts) : []
      // 同一个视图再算一遍「带卫星会」的样子：差出来的就是被藏起来的，窗口外的不该算进这个数
      const satelliteRows = payload ? buildRows(payload, { ...viewOpts, includeSatellites: true }) : []
      const areaOf = (row) => String((row.record && (row.record.areaGroup || row.record.area)) || '')
      const byArea = (list) => (area ? list.filter((row) => areaOf(row) === area) : list)
      // 面板上写"个会"的数字都要按会去重：ACM SIGGRAPH ASIA 2026 与 SIGGRAPH Asia 2027 是同一个会。
      // 只剥厂商前缀（与宿主 lib/catalog.js 的 coreName 同口径），不猜别名。
      const venueKeyOf = (row) => {
        const record = (row && row.record) || row || {}
        const tokens = String(record.venue ?? record.name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
        while (tokens.length > 1 && ['acm', 'ieee', 'usenix', 'sig', 'the', 'cvf'].includes(tokens[0])) tokens.shift()
        return tokens.join('')
      }
      const venueCountOf = (list) => new Set(list.map(venueKeyOf).filter(Boolean)).size
      const shownRows = byArea(rows)
      const shownSatellites = byArea(satelliteRows)
      const areaNames = payload && payload.catalog && Array.isArray(payload.catalog.areaNames) ? payload.catalog.areaNames : []
      const upcoming = payload ? buildRows(payload, { ...filters, withoutPending: true, keepUndated: false }).length : 0
      const counts = payload && payload.counts ? payload.counts : null
      // 已裁决数在 meta.marks 里（计数不读全量记录），Toolbar 用 counts.marks 显示
      const marksCounts = counts && payload && payload.meta && payload.meta.marks
        ? { ...counts, marks: payload.meta.marks.ignored + payload.meta.marks.confirmed }
        : counts
      const catalogTotal = counts && Number.isFinite(counts.conferences) && counts.conferences > 0 ? counts.conferences : (payload && payload.count) || 0
      const urgent = payload ? urgentRows(payload, now, 7) : []
      const nearest = urgent.length > 0 ? urgent[0] : null
      const summary = payload ? updateSummary(payload.meta) : ''
      const pinnedRows = payload ? buildRows(payload, { now, days, pins, withoutPending: true, keepUndated: false }) : []
      const nextPinned = pinnedRows.find((row) => Number.isFinite(row.deadline)) || null
      const modelReady = payload && payload.meta ? payload.meta.modelReady !== false : true
      // 卫星会默认不列：数字对不上的时候得说得出为什么（"列表 131 条，统计 133 个"这种）
      // 只数「当前视图里真的被藏起来的」，窗口外的卫星会本来就不该出现，算进去等于吓人
      // 而且这句写的是"个会"：SIGGRAPH Asia 2026/2027 是一个会的两条记录，不能数成两个
      const satelliteHidden = showSatellites ? 0 : Math.max(0, venueCountOf(shownSatellites) - venueCountOf(shownRows))

      // 冲突视图里列表上方的「统一采信」候选：按另一种说法的来源数一遍；
      // 同时数一遍「当前已经采信了谁」，否则批量点错了没有回头路（命令侧有 --undo，界面也该有）。
      const bulkSources = (() => {
        if (!payload || mode !== 'conflicts') return { alternatives: [], preferred: [] }
        const tally = new Map()
        const chosen = new Map()
        for (const row of shownRows) {
          const record = row.record ?? row
          for (const item of Array.isArray(record.alternatives) ? record.alternatives : []) {
            const name = typeof item?.source === 'string' ? item.source : ''
            if (name) tally.set(name, (tally.get(name) ?? 0) + 1)
          }
          const preferred = typeof record.preferredSource === 'string' ? record.preferredSource : ''
          if (preferred) chosen.set(preferred, (chosen.get(preferred) ?? 0) + 1)
        }
        const rank = (left, right) => right[1] - left[1]
        return { alternatives: [...tally.entries()].sort(rank), preferred: [...chosen.entries()].sort(rank) }
      })()

      // 「复制」：把当前视图贴成制表符清单，进周报/邮件不用手抄。
      const copyList = async () => {
        const text = clipboardText(shownRows, timeZone)
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('no-clipboard')
          await navigator.clipboard.writeText(text)
          setNotice(`已复制 ${shownRows.length} 条到剪贴板`)
        } catch {
          setNotice('这个环境不允许写剪贴板，可以改用「日历」导出，或直接选中文字复制')
        }
      }

      // 「日历」：当前视图导成 .ics，导入后每个会是一条截稿提醒（有审稿决定的再加一条）。
      const exportIcs = () => {
        try {
          const text = buildIcs(shownRows, { now, timeZone, calendarName: 'CCF 会议截稿' })
          const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `ccf-deadlines-${new Date(now).toISOString().slice(0, 10)}.ics`
          document.body.appendChild(link)
          link.click()
          link.remove()
          window.setTimeout(() => URL.revokeObjectURL(url), 1000)
          const events = text.split('BEGIN:VEVENT').length - 1
          setNotice(events > 0 ? `已导出 ${events} 条到日历文件，导入后就是提醒` : '当前视图里没有可导出的日期（待补/已过期的不导）')
        } catch (err) {
          setNotice(`导出日历失败：${err && err.message ? err.message : err}`)
        }
      }

      // 「补这个会」/「按类补」：都走 POST /update 的 JSON body（focus / scope）。
      // POST 要等整轮跑完才回，所以跑的同时每 2.5 秒读一次 /records 拿进度（见下面的轮询 effect）。
      const mine = (body, flash) => {
        mining.current = true
        return load(ROUTE_UPDATE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }, flash).finally(() => {
          mining.current = false
        })
      }
      const mineOne = (name) => mine({ focus: name, limit: 1 }, `正在补 ${name}：搜它的官网…`)
      const updateScope = (scope) => mine({ scope, limit: 2 }, scope === 'past' ? '正在补「只有往届日期」的会：每次 2 个（省模型开销），可以再点…' : '正在补「从未抓到」的会：每次 2 个（省模型开销），可以再点…')
      // 采信另一来源：只写缓存里的 preferredSource，主记录不动，所以点错了还能点回来。
      // 核对结论只写 meta.confirmedKeys / meta.ignoredKeys，数据本身一行都不动。
      const mark = (key, mode, undo) => load(ROUTE_CONFIRM, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, mark: mode, undo: undo === true }),
      }, mode === 'ignore' ? '正在标成「不是这个会」…' : '正在记下核对结论…')

      const prefer = (key, source) => load(ROUTE_PREFER, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, source }),
      }, source ? `正在按 ${source} 的说法显示…` : '正在恢复默认来源…')

      // 冲突视图里的批量采信：26 条冲突逐张卡片点太碎，这里按来源一次性说清。
      // `undo` 走同一路接口的 `{ batch:true, source, undo:true }`：点错了能整体撤回。
      const preferAll = (source, undo = false) => load(ROUTE_PREFER, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batch: true, source, undo: undo === true }),
      }, undo ? `正在恢复 ${source} 那批会的默认来源…` : `正在把这些冲突统一按 ${source} 显示…`)

      // 打开看过一次就把"已知的截稿"记下来；收起时若又冒出新截稿（或时间被改），
      // 标签上亮一个小红点——不用展开也知道"值得看一眼了"。
      React.useEffect(() => {
        if (!open || !payload) return
        const stamp = seenStamp(payload.records)
        if (JSON.stringify(stamp) === JSON.stringify(seen)) return
        writeSeen(stamp)
        setSeen(stamp)
      }, [open, payload, seen])

      React.useEffect(() => {
        if (open) {
          wasOpen.current = true
          const node = panelRef.current
          if (node && typeof node.focus === 'function') node.focus()
          return
        }
        // 只在"刚刚还开着"的时候还焦点，避免首次挂载就抢走用户正在打字的焦点。
        if (wasOpen.current) {
          wasOpen.current = false
          const node = tabRef.current
          if (node && typeof node.focus === 'function') node.focus()
        }
      }, [open])

      // 源告警：某个源这次没拉到、或上次同步整个失败，都得说出来，否则读者以为数据是完整的。
      // 缓存本身坏了（JSON 被改坏 / 结构不对）比"源没拉到"更严重：数据其实还在磁盘上，只是读不出来。
      const cacheAlert = payload && payload.meta && payload.meta.cacheState === 'corrupt'
        ? `缓存文件读不出来（${payload.meta.cacheError || '格式不对'}）：点「同步」重建；原文件仍在 ${payload.meta.cachePath || '数据目录'}`
        : ''
      // 名单是"待补/按等级筛"的地基：读不出来时，面板上的数字会悄悄变成 0，必须说出来。
      const catalogAlert = payload && payload.meta && (payload.meta.catalogState === 'corrupt' || payload.meta.catalogState === 'missing')
        ? (payload.meta.catalogState === 'missing'
          ? 'CCF 名单文件没找到：面板只能列 CCFDDL 收过的会，「待补」空着。检查 data/ccf-catalog.json 或 catalogPath。'
          : 'CCF 名单文件读不出来：面板只能列 CCFDDL 收过的会，「待补」空着。重新下载一份名单，或用 catalogPath 指到别的文件。')
        : ''
      // 几件事可能同时坏：全部说出来，别让后一条把前一条盖掉
      const sourceAlerts = [
        catalogAlert,
        cacheAlert,
        payload && payload.meta ? sourcesWarning(payload.meta) : '',
        payload && payload.meta && payload.meta.lastError
          ? `上次同步失败：${payload.meta.lastAttemptAt ? formatInstant(payload.meta.lastAttemptAt, timeZone) : '时间未知'}`
          : '',
      ].filter(Boolean)
      const sourceAlert = sourceAlerts.join('；')
      const sourceAlertTitle = payload && payload.meta
        ? [sourceAlert, payload.meta.cacheError ? `缓存错误：${payload.meta.cacheError}` : '', payload.meta.lastError ? `错误：${payload.meta.lastError}` : ''].filter(Boolean).join('\n')
        : ''
      const unseen = open || !payload ? [] : freshRows(payload.records, seen)

      if (!open) {
        return h('div', { style: wrapStyle },
          h('button', {
            style: tabStyle,
            ref: tabRef,
            onClick: () => toggle(true),
            title: 'CCF 会议截稿',
            'aria-label': urgent.length > 0 ? `CCF 会议截稿：7 天内 ${urgent.length} 个截稿，展开面板` : 'CCF 会议截稿，展开面板',
          },
            h('span', { fontSize: '14px' }, '📅'),
            h('span', null, '会议'),
            error ? h('span', { style: { color: UI.colors.hot }, title: `面板读取失败：${error}`, 'aria-label': '面板读取失败' }, '⚠') : null,
            unseen.length > 0
              ? h('span', { style: { color: UI.colors.hot, fontSize: '10px' }, title: `${unseen.length} 个会的截稿有更新，展开看` }, '新')
              : null,
            pins.length > 0 && nextPinned
              ? h('span', { style: { color: UI.colors.warn } }, `★${pins.length} ${nextPinned.record.venue || nextPinned.record.name} ${countdownLabel(nextPinned.deadline, now)}`)
              : pins.length > 0
                ? h('span', { style: { color: UI.colors.warn } }, `★${pins.length}`)
                : null,
            urgent.length > 0
              ? h('span', { style: { color: UI.colors.hot } }, String(urgent.length))
              : upcoming > 0 ? h('span', { style: { color: UI.colors.muted } }, String(upcoming)) : null,
          ),
        )
      }

      return h('div', { style: wrapStyle },
        h('section', {
          style: { ...panelStyle, width: `${width}px`, outline: 'none' },
          role: 'dialog',
          'aria-label': 'CCF 会议截稿',
          tabIndex: -1,
          ref: panelRef,
        },
          h('div', { style: dragHandle, onMouseDown: startDrag, role: 'separator', 'aria-orientation': 'vertical', title: '拖动调整宽度' }),
          h('div', { style: headStyle },
            h('strong', null, '会议截稿'),
            payload
              ? h('span', { style: { color: UI.colors.muted }, title: counts && Number.isFinite(counts.pendingPast) ? `待补里：${counts.pendingPast} 个只有往届日期、${counts.pendingNever} 个从未抓到${counts && counts.outside > 0 ? `；名单外：CCFDDL 收了、CCF 名单没收的 ${counts.outside} 个会（不计入 362）` : ''}` : undefined }, counts && Number.isFinite(counts.pending)
                ? `名单 ${catalogTotal} 个 · 有数据 ${Number.isFinite(counts.withFuture) ? counts.withFuture : counts.withDeadline} · 待补 ${counts.pending}`
                : `${payload.count} 个会议`)
              : null,
            h('button', { style: iconButton, onClick: () => toggle(false), title: '收起（Esc）', 'aria-label': '收起面板' }, '收起 ›'),
          ),
          urgent.length > 0
            ? h('div', { style: bannerStyle },
              h('span', null, `7 天内 ${urgent.length} 个截稿`),
              nearest
                ? h('span', null, `· 最紧：${nearest.record.venue || nearest.record.name}${nearest.record.year ? ` ${nearest.record.year}` : ''} ${countdownLabel(nearest.deadline, now)}`)
                : null,
            )
            : null,
          h(Toolbar, {
            days, onDays: setDays, rank, onRank: setRank, mode, onMode: setMode, search, onSearch: setSearch, loading,
            areas: areaNames, area, onArea: setArea,
            counts: marksCounts, modelReady,
            showSatellites,
            satelliteCount: venueCountOf(shownSatellites),
            onSatellites: (next) => {
              setShowSatellites(next)
              try { window.localStorage.setItem('dsh-ccf:satellites', next ? '1' : '0') } catch (error) { /* 存不了就只在本次生效 */ }
            },
            onCopy: copyList,
            onIcs: exportIcs,
            onUpdateScope: updateScope,
            onPinAll: pinAll,
            onClearPins: clearPins,
            onReset: () => {
              setSearch('')
              setRank('all')
              setArea('')
              setDays(120)
            },
            pinCount: pins.length,
            onRefresh: () => load(ROUTE_RECORDS),
            onUpdate: () => mine({}, '正在补数据：模型逐个搜会议官网，一轮只补几个，需要几十秒…'),
            onSync: () => load(ROUTE_SYNC, { method: 'POST' }, '正在从 CCFDDL 接口同步…'),
          }),
          h('div', {
            style: { padding: '4px 12px', color: sourceAlert ? UI.colors.hot : UI.colors.muted, fontSize: '11px', borderBottom: `1px solid ${UI.colors.lineSoft}` },
            title: sourceAlertTitle || undefined,
            role: sourceAlert ? 'status' : undefined,
          },
            `${sourceAlert ? `⚠ ${sourceAlert} · ` : ''}${live
              || (busy
                ? `${busy} 已 ${Math.max(0, Math.round((Date.now() - busySince.current) / 1000))} 秒`
                : payload
                  ? `${payload.updatedAt ? `${formatInstant(payload.updatedAt, timeZone)} 更新` : '未同步'}${isStale(payload, Date.now(), 6) ? '（已过期，建议同步）' : ''}${area ? ` · 方向 ${area}` : ''}${pins.length > 0 ? ` · 关注 ${pins.length}` : ''} · 当前 ${shownRows.length} 条${mode === 'all' ? `（窗口内 ${upcoming} 条 + 待补）` : ` · ${mode === 'pending' ? '待补视图' : mode === 'pins' ? '关注视图' : mode === 'marks' ? '已裁决视图' : mode === 'conflicts' ? '来源不一致' : '有数据视图'}`}${summary ? ` · ${summary}` : ''}${counts && counts.conflicts > 0 ? ` · ${counts.conflicts} 条来源不一致${Number.isFinite(counts.conflictsDecided) && counts.conflictsDecided > 0 ? `（${counts.conflictsDecided} 条已采信）` : ''}` : ''}${counts && counts.outside > 0 ? ` · 名单外 ${Number.isFinite(counts.outsideVenues) ? counts.outsideVenues : counts.outside} 个会` : ''}
              ${payload && payload.meta && payload.meta.marks && (payload.meta.marks.ignored + payload.meta.marks.confirmed) > 0 ? ` · 已裁决 ${payload.meta.marks.ignored + payload.meta.marks.confirmed}` : ''}${satelliteHidden > 0 ? ` · 另有 ${satelliteHidden} 个卫星会未显示（点「卫星会」看）` : ''}${payload.meta && payload.meta.modelReady === false ? ' · 无可用模型（只能同步）' : ''}${payload.meta && payload.meta.fallback ? ' · 回退数据' : ''}`
                  : '读取缓存中…')}`,
          ),
          notice
            ? h('div', { style: noticeStyle, role: 'status', 'aria-live': 'polite' },
              h('span', { style: { flex: '1 1 auto' } }, loading ? notice : notice),
              h('button', {
                style: { ...iconButton, marginLeft: '0', padding: '0 6px' },
                onClick: () => setNotice(null),
                title: '关闭提示',
                'aria-label': '关闭提示',
              }, '✕'),
            )
            : null,
          // 出错时给一个能点的出口：读者不需要知道该跑哪条命令，先重试一次最省事。
          error ? h('div', { style: { padding: '8px 12px', color: UI.colors.hot }, role: 'alert' },
            h('div', null, `⚠ ${error}`),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' } },
              h('button', { onClick: () => load(ROUTE_RECORDS), style: chipStyle(false) }, '重试'),
              h('span', { style: { color: UI.colors.muted } }, '重试不行就点「同步」，或跑 /ccf status 看服务端状态。'),
            ),
          ) : null,
          bulkSources.alternatives.length > 0 || bulkSources.preferred.length > 0
            ? h('div', {
              style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', padding: '6px 12px', borderBottom: `1px solid ${UI.colors.line}`, color: UI.colors.muted, fontSize: '12px' },
              role: 'group',
              'aria-label': '统一采信某个来源',
            }, [
              bulkSources.alternatives.length > 0 ? h('span', { key: 'label' }, '这些冲突统一采信：') : null,
              ...bulkSources.alternatives.map(([source, n]) => h('button', {
                key: `set-${source}`,
                style: chipStyle(false),
                onClick: () => preferAll(source),
                title: `这些会里有 ${n} 个能按 ${source} 的说法显示；没有这个来源说法的会会跳过`,
              }, `${source} ${n}`)),
              // 已经改过的：给一条回头路，不然批量点错了只能逐个卡片点回来
              bulkSources.preferred.length > 0 ? h('span', { key: 'undo-label', style: { marginLeft: '6px' } }, '已采信：') : null,
              ...bulkSources.preferred.map(([source, n]) => h('button', {
                key: `undo-${source}`,
                style: chipStyle(true),
                onClick: () => preferAll(source, true),
                title: `把这 ${n} 个会恢复成默认来源（只回滚采信 ${source} 的那批，别的来源不碰）`,
              }, `撤销 ${source} ${n}`)),
            ])
            : null,
          h('div', { style: { flex: '1 1 auto', overflowY: 'auto', overscrollBehavior: 'contain' } },
            shownRows.length === 0 && !loading
              ? h('div', { style: { padding: '18px 12px', color: UI.colors.muted } },
                payload
                  ? mode === 'pending'
                    ? '名单里的会都已经有数据了。'
                    : area
                      ? `这个方向（${area}）在这个窗口里没有会。换个方向或把天数放大。`
                      : mode === 'data'
                        ? '这个窗口里没有截稿的会。把天数放大，或点「补数据」让模型补。'
                        : mode === 'pins'
                          ? '还没有关注任何会：点卡片右上角的 ☆ 把一个会钉在最上面，之后它不受天数和截稿时间限制。'
                          : mode === 'marks'
                            ? '裁决过的会都在这里：标了「不是这个会」的、确认了「就是这个会」的。想还原就展开卡片点撤销。'
                            : mode === 'conflicts'
                              ? '当前筛选下没有来源不一致的记录。两个源差的不到一天时不算冲突，详情里仍会列出。'
                          : '这个窗口里没有会议。把天数放大，或点「补数据」让模型补。'
                  : '还没有数据。点「同步」几秒拉完 CCFDDL 官方数据；点「补数据」用模型逐个会搜官网（更全，慢）。第一次用建议先点「同步」。')
              : shownRows.map((row) => h(Card, {
                key: row.key,
                row,
                timeZone,
                expanded: expanded[row.key] === true,
                onPin: pin,
                onMine: mineOne,
                onPrefer: prefer,
                onMark: mark,
                onToggle: () => setExpanded((previous) => ({ ...previous, [row.key]: !(previous[row.key] === true) })),
              })),
          ),
          payload && payload.attribution
            ? h('div', { style: { borderTop: `1px solid ${UI.colors.lineSoft}` } },
              h('button', {
                style: { ...iconButton, marginLeft: '0', border: 'none', padding: '3px 12px', color: UI.colors.muted, fontSize: '10px' },
                onClick: () => setShowSources((value) => !value),
                title: '数据来源与致谢',
                'aria-expanded': showSources ? 'true' : 'false',
              }, showSources ? '来源说明 ▾' : '来源说明 ▸'),
              showSources
                ? h('div', { style: { padding: '2px 12px 6px', color: UI.colors.muted, fontSize: '10px' } }, payload.attribution)
                : null,
            )
            : null,
          h('div', { style: footerStyle },
            versionLabel(payload)
              ? h('span', null, versionLabel(payload))
              : h('span', { style: { color: UI.colors.warn } }, '宿主端未返回版本号（旧模块），重启 DSH 后才生效'),
            h('span', { style: { marginLeft: 'auto' } }, `时间按 ${timeZone || '本地时区'} 显示`),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- 注册
    function apply(ctx) {
      ctx.slots.inject(SLOT, () => ctx.slots.register(
        { name: SLOT, id: 'dsh-ccf-panel', order: 30 },
        () => h(CcfPanel),
      ))
    }

    /**
     * 一条记录的来源说明：模型挖的、CCFDDL 接口、回退数据，还是不知道。
     * 面板上每张卡片都会显示它，避免把回退数据当成"官方最新"。
     */
    function sourceLine(record, timeZone) {
      if (!record || typeof record !== 'object') return '来源未知'
      const minedAt = parseMs(record.minedAt)
      if (record.mined || record.source === 'model') {
        return minedAt === null ? '模型挖掘' : `模型挖掘 · ${formatInstant(minedAt, timeZone)}`
      }
      const source = String(record.source ?? '')
      if (source === 'ccfddl-api' || source === 'ccfddl' || source === 'ccfddl-dir' || source === 'ccfddl-tar') {
        return 'CCFDDL 接口'
      }
      if (source) return `回退数据 ${source}（可用「补数据」让模型补）`
      return '来源未知'
    }

    /**
     * 时区口径：记录的原始时区（CCFDDL 里常见 `AoE`、`UTC-12:00`、`America/Los_Angeles`）。
     * 面板统一按本地时区显示，但和官网对照时差一天很常见，所以展开详情里再印一遍官方说法。
     */
    function zoneOffsetMinutes(spec) {
      const text = String(spec ?? '').trim().toUpperCase()
      if (!text) return null
      if (text === 'AOE') return -12 * 60
      const matched = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(text)
      if (!matched) return null
      const sign = matched[1] === '-' ? -1 : 1
      return sign * (Number(matched[2]) * 60 + Number(matched[3] ?? 0))
    }

    function formatOffset(instant, offsetMinutes) {
      if (!Number.isFinite(instant) || !Number.isFinite(offsetMinutes)) return ''
      const shifted = new Date(instant + offsetMinutes * 60 * 1000)
      const pad = (value) => String(value).padStart(2, '0')
      return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
    }

    /** 例：`AOE 2026-11-16 23:59`；没有原始时区就回空串（不猜）。 */
    function sourceZoneLine(record) {
      const spec = String(record?.timezone ?? '').trim()
      const instant = parseMs(record?.deadline)
      if (!spec || instant === null) return ''
      const offset = zoneOffsetMinutes(spec)
      const shown = offset === null ? formatInstant(instant, spec) : formatOffset(instant, offset)
      return shown ? `${spec.toUpperCase()} ${shown}` : ''
    }

    /**
     * 把失败翻译成用户能照做的一句话。
     * 面板最常见的两种坏情况不是"网断了"，而是"跑的还是旧模块"和"请求被拦成一段 HTML"——
     * 原始异常（Unexpected token '<' / Failed to fetch）对读者没有任何指导意义。
     */
    function describeFailure(info) {
      const status = info && Number.isFinite(info.status) ? info.status : null
      const raw = info && typeof info.text === 'string' ? info.text.trim() : ''
      const failure = info && info.failure
      if (raw && (raw.startsWith('<') || /^<!doctype/i.test(raw))) {
        return `返回的是网页而不是数据（HTTP ${status ?? '?'}）：这条路由没挂上，DSH 里跑的还是旧模块——重启一次桌面端再试。`
      }
      if (status === 404) return '路由不存在（HTTP 404）：插件可能是旧版本，重启一次桌面端再试。'
      if (status === 403) return '被拒绝了（HTTP 403）：面板只接受本机回环地址发来的请求。'
      if (status !== null && status >= 500) return `服务端出错了（HTTP ${status}）：看 DSH 日志里 dsh-ccf 那几行，然后再点一次「重试」。`
      if (failure) {
        const name = String(failure.name || '')
        const message = String(failure.message || failure)
        if (/SyntaxError/.test(name) || /JSON/i.test(message)) return `返回的不是 JSON（HTTP ${status ?? '?'}）：多半是旧模块或代理拦截，重启一次桌面端。`
        if (/failed to fetch|fetch failed|networkerror/i.test(`${name} ${message}`)) return '连不上本地服务：DSH 可能没在运行，或者端口变了；刷新页面后再试。'
        return `出错了：${message}`
      }
      return `出错了（HTTP ${status ?? '?'}）`
    }

    /**
     * 数据源健康：只看"更新时间"的话，一个源悄悄失败只会让数据变旧而不报警。
     * 返回空串表示这次的源全成功；否则点名哪几个没拉到。
     */
    function sourcesWarning(meta) {
      const sources = meta && Array.isArray(meta.sources) ? meta.sources : []
      const bad = sources.filter((source) => source && source.ok === false)
      if (bad.length === 0) return ''
      const names = bad.map((source) => source.id || '未知源').join('、')
      return `${bad.length}/${sources.length} 个源没拉到（${names}）`
    }

    /** 往届截稿（`2026: 2026-11-14` 这种），没有就回空串。 */
    function historyLine(record) {
      const history = Array.isArray(record?.history) ? record.history.filter(Boolean) : []
      return history.length > 0 ? history.join(' / ') : ''
    }

    /**
     * 两个源对同一个会给出了不同的截止时间时，把另一个说法摆出来（最多两条）。
     * 面板不替用户断言谁对——官网以 CCFDDL 为准，但用户可能正好在别的站点看到的。
     */
    function conflictLine(record, timeZone) {
      const list = Array.isArray(record?.alternatives) ? record.alternatives.filter(Boolean) : []
      if (list.length === 0) return ''
      const zone = timeZone || 'Asia/Shanghai'
      const parts = list.slice(0, 2).map((item) => {
        const when = formatInstant(parseMs(item.deadline), zone)
        const source = String(item.source || '另一来源')
        return when ? `${source} ${when}` : source
      })
      return `另一来源：${parts.join('；')}`
    }

    /** 批量关注：把一批 key 并进现有列表，保持顺序、不重复。 */
    function mergePins(existing, keys) {
      const seen = new Set()
      const merged = []
      for (const key of [].concat(existing ?? [], keys ?? [])) {
        const text = String(key ?? '').trim()
        if (!text || seen.has(text)) continue
        seen.add(text)
        merged.push(text)
      }
      return merged
    }

    /** "上次看到过哪些截稿"：`{ '<key>': <deadline 毫秒> }`，用来做收起态的新数据小红点。 */
    function seenStamp(records) {
      const stamp = {}
      for (const record of Array.isArray(records) ? records : []) {
        const key = String(record?.key ?? '').trim()
        const deadline = parseMs(record?.deadline)
        if (!key || deadline === null) continue
        stamp[key] = deadline
      }
      return stamp
    }

    /** 比"上次看过"多了或变了的记录：新会议、或者同一个会截稿时间改了。 */
    function freshRows(records, seen) {
      const known = seen && typeof seen === 'object' ? seen : {}
      return (Array.isArray(records) ? records : []).filter((record) => {
        const key = String(record?.key ?? '').trim()
        const deadline = parseMs(record?.deadline)
        if (!key || deadline === null) return false
        return known[key] !== deadline
      })
    }

    function readSeen() {
      try {
        const raw = window.localStorage.getItem(STORAGE_SEEN)
        const parsed = raw ? JSON.parse(raw) : null
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    function writeSeen(stamp) {
      try {
        window.localStorage.setItem(STORAGE_SEEN, JSON.stringify(stamp && typeof stamp === 'object' ? stamp : {}))
      } catch {
        /* 存不下就算了：小红点本来只是提示 */
      }
    }

    /** 客户端侧需要的服务（宿主按名字先等待就绪）。 */
    const inject = ['slots']

    Object.assign(exports, {
      apply,
      inject,
      // 纯函数导出，给单元测试与将来别的入口复用
      buildRows,
      describeFailure,
      sourcesWarning,
      formatInstant,
      countdownLabel,
      isStale,
      isNew,
      urgentRows,
      updateSummary,
      versionLabel,
      progressLabel,
      rankWeight,
      sourceLine,
      sourceZoneLine,
      historyLine,
      conflictLine,
      zoneOffsetMinutes,
      formatOffset,
      mergePins,
      seenStamp,
      freshRows,
      readSeen,
      writeSeen,
      readPins,
      writePins,
      togglePin,
      buildIcs,
      foldLine,
      clipboardText,
      icsStamp,
      ROUTE_RECORDS,
      ROUTE_SYNC,
      ROUTE_UPDATE,
      ROUTE_PREFER,
      alternativesView,
      SLOT,
    })

    return module.exports
  },
})
