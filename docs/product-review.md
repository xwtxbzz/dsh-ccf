# dsh-ccf 产品评审（第 1 轮）

评审对象：`dsh-ccf` 0.4.0（CCF 会议截稿侦测插件）
评审立场：**使用者视角**——一个正在写论文、准备投稿的研究者，在 DSH 里干活时，"抬头看一眼右侧"应该能直接回答什么。
评审日期：2026-10-31

---

## 0. 一句话结论

功能已经"能用"，但**产品上还停在"数据浏览器"**：它把接口/缓存里有的字段摊开给人看，
却没有替用户回答"我现在该投哪个会、还有几天、我该做什么"。最大的三个硬伤是
**改了不生效却看不出来**、**第一次打开是空的**、**长任务没有反馈**。

---

## 1. 用户想用它回答的五个问题

按使用频率排序。产品做得好不好，就看这五个问题能不能在 3 秒内答出来：

| # | 问题 | 现在能不能答 | 卡在哪 |
|---|------|--------------|--------|
| Q1 | **最近哪个会要截稿？还剩几天？** | 半能 | 要自己往下滚；没有"最紧急"的汇总；窗口默认 120 天把"下周截稿"和"四个月后"混在一屏 |
| Q2 | **这个会值不值得投（等级/方向/录用率）？** | 不能 | 卡片只有等级+方向；`acceptRate`/`h5`/`submitLink` 在数据里但界面不显示 |
| Q3 | **我的数据是不是新的？谁给的？** | 半能 | 有"更新时间"和来源行，但"上周更新成功 3 个失败 5 个"这类事实看不到 |
| Q4 | **名单里还有多少会没数据？怎么补？** | 半能 | 有"待补 N"，但没说"一次只补 6 个""从哪个开始补"，用户点一次发现只多 6 条会以为坏了 |
| Q5 | **我改的代码到底生效了没？** | **不能** | 面板和 `/ccf status` 都不显示版本；客户端 bundle 与服务端模块的生效时机不同，用户三次遇到"看不到变化" |

---

## 2. 问题清单与优先级

### P0 —— 不修就会让人以为"插件坏了"

**P0-1 版本不可见，新旧代码混淆。**
证据：0.3.1 修好"只有 20 个会议"后，用户打开面板仍是旧数字；0.4.0 改完接口后，活体探测
`/dsh-ccf/api/v1/records` 仍返回 `withDeadline:404`（旧口径），因为桌面端进程还在跑旧模块。
用户唯一能得到的线索是我在对话里说"重启"，界面本身**零信息**。
修法：payload 带 `version`，面板底部常驻 `dsh-ccf vX.Y.Z`；`/ccf status` 首行显示版本；
服务端 schema 与客户端期望不一致时显式提示"宿主端比客户端旧，请重启 DSH"。

**P0-2 首次打开是空面板。**
证据：新装用户打开面板 → "还没有数据。点「更新」用模型搜官网，或点「同步」拉 ccfddl 的回退数据。"
两个按钮、两种机制、用户不知道区别，而且"更新"要花几分钟、"同步"几秒。
修法：数据为空或超过 6 小时未更新时，**自动跑一次接口同步**（不需要模型、几秒完成）；
把两个按钮改名为「补数据（模型）」「同步（接口）」，并在提示里说清代价。

**P0-3 「更新」是长任务，但没有反馈。**
证据：`POST /update` 一次跑 6 个会 ×（搜索+抓官网+模型），实测 20–60 秒；这期间按钮只变成
"…"，结束后 payload 被整体替换，用户看不出"成功几个、失败几个、为什么失败"。
后端 `note` 里其实有 `本轮处理 6 个会，成功 2 个，失败 4 个` 与失败原因，但被客户端丢弃。
修法：把 `note` 显示成可关闭的结果条；状态行常驻"上次补数据：成功 X / 失败 Y"。

### P1 —— 让"看一眼"真的成立

**P1-1 没有紧急度汇总。** 顶部应有一条"7 天内 N 个截稿 · 最紧：STOC 2027 还剩 1 天 20 小时"，
没有则整条不出现（不占位）。

**P1-2 卡片不能展开，信息半遮半掩。** `acceptRate`/`h5`/`submitLink`/`aliases` 已在 payload 里，
界面上一个都看不到。点击卡片标题展开/收起详情。

**P1-3 时间语义不明确。** 面板按 `Asia/Shanghai` 显示，但会议截稿的真身常是 AoE（UTC-12），
"11-16 23:59"和"11-17 19:59"两个数字都正确，用户会怀疑哪个是"官方截止"。状态行加一句
"时间按 Asia/Shanghai 显示"。

**P1-4 键盘/无障碍缺失。** ESC 不能关面板，按钮没有 `aria-label`，也没有 `role="dialog"`。

**P1-5 数据来源说明太吵。** `attribution` 整段常驻在工具栏下方占两行，只在"回退数据"时才有必要。

**P1-6 命令没有帮助入口。** `/ccf` 只有未知子命令时才打印用法；补 `/ccf help`。

### P2 —— 可以以后做

- 面板可拖拽调宽度（现在固定 388px）
- 卡片右键"复制 venue"、点 submitLink 直接开投稿页
- 「待补」批量补：`/ccf update --focus CV` 已有，但面板没有按方向批量补的入口
- 变更提示：某个会新增截稿时，tab 上出小圆点
- 摘要截止（abstract deadline）与截稿（paper deadline）的视觉区分，现在都是普通一行

---

## 3. 本轮已修（0.4.1）

| 问题 | 改动 |
|------|------|
| P0-1 | `lib/ui.js` payload 增 `version`；`lib/create.js` 从 package.json 读版本并透传；面板底部显示 `dsh-ccf vX.Y.Z`；`/ccf status` 首行显示版本与数据目录 |
| P0-2 | 面板打开时若缓存为空或 `updatedAt` 超过 6 小时，自动 `POST /sync` 一次（带 guard，不循环）；按钮改名「补数据（模型）」「同步（接口）」并加 title 说明耗时 |
| P0-3 | `POST /update` 的 `note` 显示为可关闭结果条；状态行追加"上次补数据 成功 X / 失败 Y" |
| P1-1 | 新增 `urgentRows()`，面板顶部加"7 天内 N 个截稿"黄色横幅（0 个时不渲染） |
| P1-2 | 卡片标题可点击展开详情：全称、别名、录用率、h5、投稿链接 |
| P1-3 | 状态行注明时区 |
| P1-4 | ESC 关闭、`role="dialog"`、按钮 `aria-label` |
| P1-5 | `attribution` 收进"来源"折叠区，仅回退数据时默认展开 |
| P1-6 | 新增 `/ccf help`；`/ccf` 无参时打印帮助而不是静默 list |

## 4. 验证证据（0.4.1）

| 项 | 证据 |
|----|------|
| 单测 | `npm test` 全绿：yaml 5 / core 16 / sync 6 / catalog 10 / miner / plugin 10 / ui **10** / client **16** / `SMOKE OK` |
| 新增用例 | `panelPayload carries the plugin version`、`urgentRows keeps only the next seven days`、`updateSummary describes the last mining run`、`versionLabel is empty when the host runs an old module` |
| 真实渲染 | `node test/panel.render.test.mjs` → `PANEL RENDER OK`；渲染文本已含「补数据」「同步」「宿主端未返回版本号（旧模块），重启 DSH 后才生效」「时间按 Asia/Shanghai 显示」，并观察到打开时自动发出的 `POST /sync` |
| 现网探测 | `GET http://127.0.0.1:63028/dsh-ccf/api/v1/records` → `version=''`，说明运行中的进程仍是旧模块（这正是 P0-1 要暴露的现象）；重启后应出现 `version: "0.4.1"` |

## 5. 下一轮待办

1. 摘要截止 vs 截稿的视觉分层（P2）
2. 面板按方向批量补数据入口（P2）
3. 变更提示（新截稿出现时 tab 小圆点）（P2）
4. 面板宽度可调（P2）
5. 真实环境回归：重启桌面端后逐项核对 P0/P1 修复（需要用户配合重启）

## 6. 第 2 轮评审（0.5.0）——把"能看"推到"能扫完"（2026-10-31）

第二轮不再问"有没有这个功能"，而是问"一个要投稿的人，能不能在 10 秒内决定投不投、还剩多少坑要填"。带着这个标准重看面板与命令，新发现七个问题：

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N1 | 点「补数据」后按钮只变成 `…`，几十秒里不知道是死是活 | 状态行显示 `正在补数据… 已 N 秒`；完成后回执与「上次补数据 成功 X / 失败 Y」照旧 |
| N2 | 待补卡片只说"名单里有"，想去看看会议是什么却无处可点 | 待补卡片加 `DBLP ↗` 直达会议主页（来自名单里的 `dblp` 字段） |
| N3 | 362 个会里有 250 个待补，但只能一个个 `--focus` 补 | `/ccf update --area <方向>`、工具参数 `area`、`planUpdate` 支持方向过滤；面板工具栏加「方向」下拉（十个 CCF 方向） |
| N4 | 摘要截止和截稿长得一样重，读者要自己判断哪个更要紧 | 摘要截止的值降级为弱化色 |
| N5 | 刚补到的会议和几天前的混在一起，看不出这一轮的成果 | 最近 24h 内被模型挖到的记录打红字「新」 |
| N6 | 面板固定 388px，地点/全称一长就被挤断 | 左边缘拖拽改宽（300–720px），宽度存 `localStorage` |
| N7 | 首次打开空白面板时，文案没说"先点哪个" | 空态改为"先点「同步」几秒拉完；「补数据」更全但慢"，并在错误态重复同一句引导 |

**验证（0.5.0）**：`npm test` 全绿（yaml 5 / core **17** / sync 6 / catalog 10 / miner 10 / plugin 10 / ui 10 / client **17** / `SMOKE OK`）；新增用例 `isNew flags records mined within a day`、miner 的 `area` 过滤（中文方向名与 `CV` 片段两种）、`CCFDDL 接口：sub=SC 是安全方向，不是高性能计算`、`panelPayload … areaGroup`。`node test/panel.render.test.mjs` → `PANEL RENDER OK`，渲染文本含 `全方向` 下拉与既有引导语。

### 6.1 做 N3 时顺带抓出的两个真 bug（N8 / N9）

做"按方向筛选/补数据"时先按面板实测，发现筛出来是空的——原因不是没数据，而是两套词表：

| 编号 | 问题 | 修法 |
|------|------|------|
| N8 | 记录里的 `area` 是上游子类（`CV`、`AI/ML`），面板下拉给的是名单里的中文大类（`人工智能`…），按方向一筛就空 | `lib/ui.js` 的 `panelPayload` 给每条记录补 `areaGroup`（用 `sameVenue` 对回名单取中文方向），面板按 `areaGroup` 过滤；`lib/create.js` 的 `buildList` 同样先把中文方向解析成一批会议再按会议名过滤，且**先取全量再截断 limit**（否则 limit 会先把别的方向截掉） |
| N9 | `S&P`、`CCS`、`USENIX Security` 在列表里显示成「高性能计算」——`CCFDDL_SUB_LABELS` 把 `SC` 当成了 SuperComputing，但 CCFDDL 的 `SC` 是 Security & Cryptography | 改映射：`SC/SEC/SP → 网络与信息安全`、`MS/SE → 软件工程/系统软件/程序设计语言`、`OS → 计算机体系结构/并行与分布计算/存储系统`；展示侧优先用名单里的中文方向（`buildList` 里用 `sameVenue` 回填 `area`），不再直接印上游标签 |

改完用真实缓存重跑：`S&P 2027 → 网络与信息安全`、`CCS 2026 → 网络与信息安全`、`VLDB 2027 → 数据库/数据挖掘/内容检索`；`ccf_deadlines({days:365, area:'人工智能', limit:8})` 返回 8 条（CVPR 2027 打头），`--pending --area 人工智能` 返回 21 个待补会。

**仍未做（留到下一轮再看）**：
1. 真实环境回归（客户端 bundle 与宿主模块都要重启桌面端才生效，需用户配合）；
2. "补数据"期间的任务队列视图（现在可以边补边筛，但看不到排队情况）；
3. 方向下拉与 `--area` 的结果回报里还没列出"这个方向补了几个、失败几个"；
4. 用真实模型跑一次「补数据」，核对回执文案与失败原因是否够用（P0-3 的验收）。

## 7. 第 3 轮评审（0.6.0）——从"看得到"推到"盯得住"

第三轮换了问法：**一个真的在赶 deadline 的人，会不会每天打开它？** 只看不动的列表，答案是不会。于是盯三件事：我关心的那几个会在哪、补数据这一轮到底补了哪些方向、以及"还差多少"到底该信哪个数字。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N10 | 只关心 CVPR、ICML 两三个会，但它们夹在几百个会里，窗口一收就消失、截稿一过更消失 | 卡片右侧加 **☆/★ 关注**：关注的会不受天数窗口、不受"截稿已过"限制，永远排最前；面板收起时标签直接显示 `★N 最近那一个会 + 倒计时`；关注列表存 `localStorage`（`dsh-ccf:pins`），纯客户端、多窗口共享 |
| N11 | 用 `--area 人工智能` 补完一轮，回执只说"成功 3 个"，不知道是哪个方向的 3 个 | `runUpdate` 增加 `byArea` 统计，回执多一行 `按方向：人工智能 3 成功 / 0 失败；…`；`POST /update` 的响应也带 `byArea` |
| N12 | **同一件事出现两个数字**：系统提示说"名单里还有 56 个会没有截稿时间"，面板标题栏说"待补 250"，还有一处"有数据 134"——134+250=384 > 362，读者只能怀疑插件在编数 | 抽出 `catalog.js` 的 `matchVenue` + `catalogCoverage`，让面板、`/ccf list` 的覆盖度行、`/ccf status`、系统提示**共用一份判定**；待补再拆成「只有往届日期」与「从未抓到」两类，三个数字从此自洽：`有数据 112 + 待补 250 = 362` |

**N12 的根因**（值得记下来）：`miner.planUpdate` 用"简称归一化后完全相等"判断有没有数据，`ui.sameVenue` 用"去厂商前缀 + 别名 + 卫星后缀"判断，两套算法各数各的；再加上一处把**记录条数**（407 条里 134 条有未来截稿）当成了**会议个数**，于是出现 134 + 250 > 362 的算术矛盾。修完后真实缓存上三者完全一致：

```
coverage: {"total":362,"future":112,"past":201,"never":49,"pending":250}
panel   : {"pending":250,"pendingPast":201,"pendingNever":49,"withFuture":112}
agree: true
```

**验证（0.6.0）**：`npm test` 全绿（yaml 5 / core 17 / sync 6 / catalog / miner / plugin 10 / ui 10 / client **20** / `SMOKE OK`）；新增用例 `buildRows keeps pinned conferences regardless of window and past deadlines`、`togglePin adds, removes and never duplicates`、`readPins tolerates missing or broken localStorage`、catalog 的覆盖度用例（`future/past/never` 与 `SPAA ≠ S&P`）、ui 的自洽断言（`withFuture + pending = conferences`）。`node test/panel.render.test.mjs` → `PANEL RENDER OK`，渲染文本里每张卡片都出现 ☆。

**仍未做（下一轮候选）**：
1. 真实环境回归（宿主模块与客户端 bundle 都要重启才生效）；
2. 关注列表还不能批量操作（现在一个个点 ★，362 个会里挑 10 个要点 10 次）；
3. 「待补」视图里点某一类（只有往届 / 从未抓到）批量补，现在还只能全量或按方向补；
4. 用真实模型跑一次「补数据」，验收回执文案（P0-3）。

## 8. 第 4 轮评审（0.7.0）——从"能看到"推到"能带走"

第四轮的问法变成了：**看完之后，你打算怎么用它？** 真在赶 deadline 的人不会一直开着面板，他要的是把信息带进自己的工具里（周报、日历、微信里发给师兄）。顺手也补了三个"看得见但用不上"的硬伤。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N13 | 面板默认停在「全部」，一打开先扫一堆灰的待补卡片；三个视图 chips 也不显示各有多少个 | 默认视图改为「有数据」；chips 直接印数量（`全部 362 / 有数据 112 / 待补 250`），状态行改为 `· 有数据视图` / `· 待补视图`，不再出现"当前 2 条有数据"这种连读歧义 |
| N14 | 想把这周的截稿贴进周报、或加进系统日历，只能一张张手抄 | 工具栏加 **「复制」**（当前视图 → 制表符清单，直接贴邮件/周报）与 **「日历」**（当前视图 → `.ics` 文件，每个会一条「截稿」提醒，有审稿决定的再加一条；过期与待补的会不导，避免把死线塞进日历） |
| N15 | 没配模型时点「补数据」按钮，只会转几秒然后悄悄回退成 ccfdl 数据，用户以为模型跑过了 | 服务端在 `meta.modelReady` 里告诉面板模型可用性；不可用时按钮置灰、tooltip 写明"先用「同步」"，状态行补 `· 无可用模型（只能同步）` |
| N16 | 搜索框只搜会议名，想按地点（"Honolulu"）或方向（"软件工程"）找会都不行 | `buildRows` 的匹配字段扩到 简称/全称/别名/地点/方向大类/年份；占位文案改成"搜会议名/地点/方向…" |

**为什么选「导出」而不是「提醒推送」**：推送需要常驻进程与系统通知权限，插件跑在 DSH 进程里、天生不该去抢通知；而 `.ics` 是用户已有工具（日历 App）的入口，一行文本拷贝也是。把"带得走"做对，比多做一条通知更符合插件的边界。

**验证（0.7.0）**：`npm test` 全绿（yaml 5 / core 17 / sync 6 / catalog 10 / miner / plugin 10 / ui **11** / client **23** / `SMOKE OK`）；新增用例 `panelPayload tells the panel whether a model is available`、`buildRows search also matches place, direction and year`、`buildIcs writes one all-day-ish event per deadline and skips past ones`（断言 `UID:cvpr|2027-截稿@dsh-ccf`、`SUMMARY:CVPR 2027 截稿`、过期与待补不计入 VEVENT、`END:VCALENDAR`）、`clipboardText renders a tab separated list for the current view`。`node test/panel.render.test.mjs` → `PANEL RENDER OK`，渲染文本里出现「复制」「日历」与 `· 有数据视图`。

**仍未做（下一轮候选）**：
1. 真实环境回归（宿主模块与客户端 bundle 都要重启才生效）；
2. 关注列表批量操作（导入/导出几个 key，或"把当前视图全关注"）；
3. 「待补」按类批量补（只有往届 / 从未抓到分开补）；
4. 真实模型跑一次「补数据」验收回执（P0-3），并核对 `byArea` 那行在真实数据下的读感。

## 9. 第 5 轮评审（0.8.0）——让「待补 250」真正可操作

第五轮只问一件事：**说了有 250 个会待补，那我下一步该点哪里？** 结果发现"待补"这个数字在三个地方口径不同、而且没有任何入口能只补其中一类。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N17 | 同一个会，面板说"有数据"、补数据计划说"待补"——比如 `KDD` 的记录在名单里对应 `SIGKDD`，`CVPR Workshops` 对应 `CVPR`，挖掘侧用"简称完全相等"判定，就被当成没有数据，白跑一次模型 | 判定统一到 `lib/catalog.js` 的 `matchVenue`：`miner.js` 新增 `recordsOf(records, conf)` 走同一套别名/卫星会议规则，面板、提示词、`/ccf list`、挖掘计划四处同源 |
| N18 | 「待补」是一个笼统的数：里面既有"会议确实存在但只抓到往届日期"，也有"从来没抓到过"，补的时候没法分开 | `planUpdate`/`runUpdate`/`ccf_update`/`/ccf update` 都支持 `scope: 'past' \| 'never'`；`POST /update` 接受 JSON body；面板「待补」视图多出 `补往届 N` / `补从未 M` 两个按钮（数量来自 `counts.pendingPast/pendingNever`） |
| N19 | 只想补某一个会（比如听说某会今年提前了），也得让它排队等 | 待补卡片加「补这个会」，只对这一个跑（`{focus: 名称, limit: 1}`） |
| N20 | **过去只有往届日期的会被当成"健康"**：判定用"截稿比 400 天前更老"才入队，于是"3 个月前截稿"的记录既不算待补、也不会被补，覆盖度却说它是待补 | `planUpdate` 改成"**没有任何未来截稿 → 待补**"（`next-edition`），`windowDays` 只用于排序，不再决定算不算待补；回执加一行 `本次范围：只有往届日期（跳过 N 个不符合条件的会）` |

顺带修掉的一个静默 bug：`doUpdate` 之前把 `area` **丢了**——`ccf_update({area})` 与 `/ccf update --area` 看起来都支持，实际根本没传到挖掘计划里（N3 只做了一半）。这次 `doUpdate` 显式透传 `area` 与 `scope`。

**验证（0.8.0）**：`npm test` 全绿（yaml 5 / core 17 / sync 6 / catalog 10 / miner / plugin 10 / ui **13** / client **23** / `SMOKE OK`）；新增用例 `POST /update passes focus and scope from the JSON body`、`POST /update answers 501 when no miner is wired`、miner 的 `scope` 三类过滤与 `skipped` 计数、`KDD 的记录要算作 SIGKDD 的数据`。`node test/panel.render.test.mjs` → `PANEL RENDER OK`；`node test/integration.test.mjs` → `INTEGRATION OK`（`update: model=false fallback=true catalog=362 pending=250`）。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端后逐项核对，当前活体仍是 `version=''`）；
2. 关注列表批量操作（"把当前视图全关注" / 导入导出）；
3. 补数据时的任务队列视图（现在能连点，但看不到排队）；
4. 真实模型跑一次「补数据」验收回执（P0-3），核对 `byArea` 与 `本次范围` 两行在真实数据下的读感。

## 10. 第 6 轮评审（0.9.0）——把"和官网对不上"变成看得懂

这一轮换了个身份：**手里开着会议官网、同时开着面板的人**。他要核对两件事——"我刚才在官网看到的 11 月 16 日，为什么面板写 17 日？" 和 "这个会去年什么时候截的？" 前者是时区口径，后者是历史数据，数据其实都在，只是面板从没展示出来。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N21 | 面板按本地时区显示，官网按 AoE 写，**同一个截稿差一天**，看着像数据错了 | 记录保留上游原始 `timezone`（`AoE` / `UTC-12:00` / `PT`…），面板展开详情新增一行「官方口径」：`AOE 2026-11-16 23:59`；本地时间仍是主显示，底部"时间按 Asia/Shanghai 显示"不变 |
| N22 | 想知道"这个会往年什么时候截"（判断今年是否提前、要不要现在就写），只能自己去翻往年页面 | `normalizeCcfddlApi` 把同一系列**其它届**的截稿收进 `history`（只收更早的、新的在前、最多 3 条），展开详情新增「往届截稿」行；模型单独挖到的新会议没有历史届，就不显示这一行 |
| N23 | 关注只能一个个点 ☆，想挑十个会要点十次 | 工具栏加「全关注」（当前视图里有数据的会一次钉住，已关注的不会重复）与「清关注 N」；纯客户端 `localStorage`，与单个 ☆ 共用一份列表 |
| N24 | `mergePins` 之前不存在，批量关注只能靠手写数组拼接，容易产生重复 key | 抽出纯函数 `mergePins(existing, keys)`（去空、去重、保序），配单测 |

**踩到的一个真 bug（顺手修）**：`formatInZone('UTC-12:00')` 会让 `Intl.DateTimeFormat` 抛 `Invalid time zone specified`——固定偏移不是合法 IANA 名。往届日期原来打算用它格式化，一跑就炸。改为新加的 `formatDateInZone()`/`historyFromEditions()`：先用 `tzOffsetMinutes()` 把时刻平移到该时区，再用 UTC getter 拼日期，`AoE`、`UTC±H:MM`、IANA 三种写法都能走通。

**验证（0.9.0）**：`npm test` 全绿（yaml 5 / core 17 / sync 6 / catalog 10 / miner / plugin 10 / ui **13** / client **26** / `SMOKE OK`）；新增用例 `sourceZoneLine prints the official zone wording (AoE / UTC-12)`（含 `UTC+05:30`、`America/Los_Angeles`、缺时区回空）、`historyLine renders previous editions`、`mergePins unions without duplicating`，core 的 CCFDDL 用例补了 `history` 与 `timezone` 断言，ui 的 payload 用例补了这两个字段的投影。`node test/panel.render.test.mjs` → `PANEL RENDER OK`。真实缓存重灌后：407 条里 **356 条带往届截稿**、371 条带原始时区。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端，活体仍是 `version=''`）；
2. 补数据任务队列视图；
3. 变更提示（新截稿出现时在收起态标签上打小圆点）；
4. 真实模型跑一次验收 P0-3。

**代码位置**：`lib/core.js` 的 `formatDateInZone` / `historyFromEditions` / `normalizeCcfddlApi`；`lib/ui.js` 的 `panelPayload` 投影；`client/client.js` 的 `zoneOffsetMinutes` / `formatOffset` / `sourceZoneLine` / `historyLine` / `mergePins` 与 `Card` 展开详情、`Toolbar` 的「全关注」「清关注」。

## 11. 第 7 轮评审（0.10.0）——把面板当天的两个"脚下坑"填掉

这一轮盯的是"用久了才会遇到的坑"，而不是新功能：

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N25 | 手快连点两下「补数据」（或两个窗口各点一次），会同时起两轮挖掘：模型调用翻倍，两个 `runUpdate` 各自读旧缓存再写回，**后写完的覆盖前面的成果** | `lib/create.js` 的 `doUpdate` 加单飞锁：第二轮直接返回 `{ok:false, busy:true, note:'上一轮补数据还在跑（已 N 秒），等它结束再点。'}`，不发第二次模型请求；`lib/ui.js` 的 `POST /update` 把 `busy` 映射成 **409**（而不是 200 或 500），面板据此走"提示条"而不是"红字报错" |
| N26 | 面板收起后，后台补到了新会、或某会截稿时间被改，**用户完全不知道**；只有展开才看得见 | 客户端记"已看过的截稿"快照（`localStorage` 的 `dsh-ccf:seen`，`{key: deadline 毫秒}`），收起态标签在出现新 key 或 deadline 变化时亮红字「新」；展开并加载一次即写回快照，红点消失。纯客户端比较，不额外请求 |

**顺手确认的两件事**：
1. `runUpdate` 内部对"没有模型 → 回退 CCFDDL 数据"的路径已经有，但**并发的两轮**会各自拿缓存做基线；加了单飞锁之后这条路径也安全了。
2. 面板收到 409 时不能把 `payload` 丢掉——原来的 `load()` 会在非 2xx 时抛错并保留旧数据；现在显式处理 409：保留旧数据 + 弹提示条，界面状态不倒退。

**验证（0.10.0）**：`npm test` 全绿（yaml 5 / core 17 / sync 6 / catalog 11 / miner / plugin **11** / ui **14** / client **28** / `SMOKE OK`），`node test/panel.render.test.mjs` → `PANEL RENDER OK`。新增用例：`同一时间只跑一轮补数据：第二次立刻回 busy，不排第二轮`（用空 `sources` 让回退同步立刻失败，测试不联网）、`POST /update answers 409 while another run is still in flight`、`seenStamp records the deadlines the reader has already seen`、`freshRows flags new venues and changed deadlines only`。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端后逐项核对；活体仍是 `version=''`，说明当前进程还是旧模块）；
2. 真实模型跑一次验收（P0-3 的回执文案是否够用）；
3. 面板里直接看"这次补数据排在第几个、还剩几个"（现在只有单飞锁，没有队列）；
4. `.ics` 里加上会议地点与官网链接（现在只有摘要与日期）。

**代码位置**：`lib/create.js` 的 `doUpdate`（单飞锁 `updateInFlight` / `updateStartedAt`）；`lib/ui.js` 的 `POST /update`（409 + `busy`）；`client/client.js` 的 `seenStamp` / `freshRows` / `readSeen` / `writeSeen` / `STORAGE_SEEN` 与 `CcfPanel` 的 `seen` 状态、收起态标签、`load()` 的 409 分支。

## 12. 第 8 轮评审（0.11.0）——导出的日历真的会提醒吗

这一轮把「日历」按钮产出物导进真实日历看一眼，发现三个问题（前两个是**用户拿到手就会遇到的**）：

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N27 | 导出的 `.ics` 导进日历后**一条提醒都没有**——用户按"提醒我投稿"的期待点了「日历」，结果只是多了几个静默日程 | 每个 VEVENT 里加 `BEGIN:VALARM / TRIGGER:-P1D / ACTION:DISPLAY / DESCRIPTION:<会> 截稿 就在明天 / END:VALARM`，提前一天弹 |
| N28 | 标题里年份重复：`CVPR 2027 2027 截稿`（记录 `name` 已含年份，又拼了一次 `year`） | 只有 `name` 里不含年份时才追加 `year` |
| N29 | 长行不折行：会议全称 + 地点 + 链接拼起来常超过 75 字节，Outlook 老版本/部分手机日历会**直接拒收整个文件** | 新增 `foldLine(line, limit=73)`（按 UTF-8 字节折行、续行以空格开头），`buildIcs` 对**每一行**折行后再拼 |
| N30 | 「待补」视图里天数选择器还在，但点它什么都不变（待补的会本来就没有日期） | 待补视图下把天数选择器置灰，`title` 写明"待补列的是还没有日期的会，天数在这里不起作用" |
| N31 | 首次使用就撞上"另一个窗口正在补数据"时，面板会拿一个**没有 `records` 的 409 body** 去渲染 | 409 分支不再碰 `payload`，只弹提示条，界面维持空态/旧数据 |

**踩到的坑（保留）**：折行一开始写成"对整个 VEVENT 块折行"，因为块内本身含 `\r\n`，折行点落到了 `DTSTART` 中间（`DTS` + `  TART`），解析出来是坏事件。改成把事件按**行**push 进 `lines`、逐行折行才对——ICS 的折行单位是"内容行"，不是"整个组件"。

**验证（0.11.0）**：`npm test` 全绿（yaml 5 / core 17 / sync 6 / catalog 11 / miner / plugin 11 / ui 14 / client **30** / `SMOKE OK`）；`node test/panel.render.test.mjs` → `PANEL RENDER OK`。新增用例 `buildIcs adds a reminder and never repeats the year in the title`（断言 `VALARM`、`TRIGGER:-P1D`、不含 `CVPR 2027 2027`）、`foldLine keeps every ICS line inside the 75-byte limit`（用 `TextEncoder` 逐行核对 ≤75 字节，并验证短行不被折）。手工核对生成物：两事件、每事件带提醒、最长行 0 条超限。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端后逐项核对；活体仍是 `version` 缺失）；
2. 真实模型跑一次验收（P0-3 的回执文案）；
3. 补数据队列视图（现在只有单飞锁）；
4. 面板里显示"这条记录的往届截稿来自哪一届"的更多细节。

**代码位置**：`client/client.js` 的 `foldLine` / `buildIcs`（`VALARM`、年份去重）/ `Toolbar`（待补视图置灰天数）/ `CcfPanel` 的 `load()` 409 分支。

## 13. 第 9 轮评审（0.12.0）——两个源说法不一样时，面板在骗谁

这一轮问的是"**数据可信度**"：插件同时吃 CCFDDL 和 paper-deadlines 两路数据，当它们对同一个会给出不同截稿时，面板显示的是哪一路？用户看得出来吗？

答案是：以前看不出来。`dedupeRecords` 的规则是"先到者优先、缺字段由后者补"——第二个源给了不同的日期时**被静默丢掉**，卡片照常写"截稿 11-17"，用户以为这就是唯一答案。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N32 | 两个来源给的截稿不同，面板只显示一个，**且不说这是哪一路的** | `dedupeRecords` 在时间不一致时把后者留成 `alternatives: [{source, deadline, notification}]`；`panelPayload` 投影 `alternatives` 与 `conflict`；卡片标题加红框「来源不一致」（`title` 里写另一来源与时间），展开详情多一行「来源冲突」；状态行加 `· N 条来源不一致`；`/ccf venue` 的文本输出多一行 `来源不一致：<源> <时间>（上面显示的是首选来源）` |
| N33 | 如果每条都亮红字，42 个会（真实缓存）里有一半只是 AoE 与本地日历的**一天边界差**，反而制造噪音 | 分两档：差 **>36 小时**才算「冲突」（打红字 + 计数），差一天以内的仍写进详情行但不打标记。真实数据：403 条里 42 条有另一来源，其中 **26 条**属于真冲突（如 CVPR 2027 首选 `11-17`、另一来源 `11-14`，ACL 2027 首选 `01-05`、另一来源 `02-16`） |

**为什么值得做**：投稿人最怕的是"照着面板准备，结果官网是另一天"。而两个开源数据源真的会不一致——这不是插件能"修"的，但插件必须**说出来**，并把"首选是哪一路"讲清楚（`source` 字段原本就有，只是从没在冲突场景下被摆到台面上）。

**验证（0.12.0）**：`npm test` 全绿（yaml 5 / core **18** / sync 6 / catalog 11 / miner / plugin 11 / ui **15** / client **31** / `SMOKE OK`）；`PANEL RENDER OK`。新增用例：core 的 `去重：两个源给了不同截稿时留下另一种说法，而不是默默丢弃`（含 `formatVenue` 输出断言）、ui 的 `panelPayload carries a competing deadline from another source`（差 42 天打标记、差 1 天只留痕、`counts.conflicts=1`）、client 的 `conflictLine surfaces the other source`。真实缓存重灌（`D:\doctor\_tools\sync_real_cache_conflicts.mjs`，403 条 / ccfddl-api 377 + paper-deadlines 26）后：42 条带另一来源、26 条红字冲突。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端；活体 `version` 仍缺失）；
2. 真实模型跑一次验收（P0-3）；
3. 补数据队列视图（现在只有单飞锁）；
4. 让用户能"采信另一来源"（点一下把首选换成 alternatives 里的某一条）——需要缓存侧写 `preferredSource`，本轮先不做，避免和模型挖掘的写入打架。

**代码位置**：`lib/core.js` 的 `dedupeRecords`（`alternatives`）与 `formatVenue`（来源不一致行）；`lib/ui.js` 的 `isBigConflict` / `panelPayload`（`alternatives` / `conflict` / `counts.conflicts`）；`client/client.js` 的 `conflictLine` 与 `Card`（红色「来源不一致」标记、详情行）、状态行；`D:\doctor\_tools\sync_real_cache_conflicts.mjs`（真实重灌 + 冲突统计）。

## 14. 第 10 轮评审（0.13.0）——我说了"有两个说法"，然后呢

上一轮把冲突摆到了台面上，但没有回答读者紧接着的那个问题：**"我信哪一边？"** 面板标了红框、写了另一来源，然后就没有下文——用户要么自己记住哪个日期、要么去翻官网。这一轮补的就是这一步。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N34 | 看到「来源不一致」，但没有办法说"我按 paper-deadlines 那个走" | 卡片展开后列出另一种说法，每条带「采信」按钮；`POST /dsh-ccf/api/v1/prefer` 把 `{key, source}` 写进缓存的 `preferredSource`；点完之后卡片、复制清单、`.ics`、`/ccf list`、`ccf_deadlines` 全部按选中的那条显示；再点「恢复默认」回到插件自己的首选 |
| N35 | 用户点了「采信」之后，会不会把数据改坏 / 下轮同步又改回去？ | **只写 `preferredSource` 一个字段，`deadline` 等主值一律不动**：显示层用 `applyPreferred()` 派生（原来的首选自动变成"另一种说法"），同步与模型挖掘照旧合并主记录，用户随时能点回去；集成测试里断言了"磁盘上的主记录没被改" |

**命令侧**：`/ccf prefer <会议名>` 看当前按哪一路显示、另一路是多少；`/ccf prefer CVPR paper-deadlines` 采信；`/ccf prefer CVPR --reset` 恢复；`/ccf status` 多一行「采信：N 个会按你选的来源显示」。

**验证（0.13.0）**：
- `npm test` 全绿：yaml 5 / core **19** / sync 6 / catalog 11 / miner / plugin 11 / ui **16** / client **32** / `SMOKE OK`；`PANEL RENDER OK`。
- 真实缓存：CVPR 默认 `ccfddl-api 2026-11-17`，采信 `paper-deadlines` 后显示 `2026-11-14`，另一说法变成 `ccfddl-api 2026-11-17`，**缓存文件里的 `deadline` 仍是 11-17**。
- 端到端（`node test/integration.test.mjs`，真 cordis + 真 webServer + 真上游）：`prefer: aaai|2027 采信 paper-deadlines → 显示 2026-07-28T11:59:59.000Z，已恢复默认`，`INTEGRATION OK`。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端；活体 `version` 仍缺失）；
2. 真实模型跑一次验收（P0-3）；
3. 补数据队列视图（现在只有单飞锁）；
4. "采信"的批量操作（同一个会每年都会冲突，现在要每年点一次）。

**代码位置**：`lib/core.js` 的 `applyPreferred` / `applyPreferredAll`；`lib/ui.js` 的 `arrayOf`（展示全程走派生视图）、记录投影的 `preferredSource` / `preferred`、`POST /prefer` 路由；`lib/create.js` 的 `viewRecords` / `doPrefer`（写 `preferredSource`）、`/ccf prefer` 子命令、`status` 的采信行、`createUiRoutes({ prefer })`；`client/client.js` 的 `ROUTE_PREFER` / `alternativesView`（采信按钮 + 恢复默认）/ `Card` 的 `onPrefer`。


## 15. 第 11 轮评审（0.14.0）——同一种冲突，第二年还会再来一次

第 10 轮让用户能"采信"，但选择记在 `<会>|<年>` 上：CVPR 2027 点了，明年 CVPR 2028 又会开一次同样的冲突，用户得再点一遍。这类"每年都会重演的问题"如果每年都要人工处理，功能等于白做。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N36 | 同一个会每年都冲突一次，每年都要重新点「采信」 | 点「采信」时同时写入缓存 `meta.preferredByVenue[<会议系列>] = <来源>`；新一届没有自己的偏好时自动沿用系列记忆，卡片上写「沿用你给这个会设的来源，新一届自动生效」；「恢复默认」把记录上的偏好与系列记忆一起清掉 |
| N37 | 「IEEE/CVF CVPR」「CVPR 2027」「cvpr」是不是同一个会？记在谁名下？ | 新增 `venueKey()`：去年份、去括号、**反复去掉 acm/ieee/usenix/sig/the/cvf 前缀**再小写（`IEEE/CVF CVPR` 要连去两层，否则会落到 `cvf cvpr`）；记忆只在 `venueKey` 上生效，记录自己的 `preferredSource` 永远优先 |

**为什么不做成"永久改主记录"**：主记录是"数据源说的"，采信是"读者选的"。把后者覆盖到前者上，下一次同步就分不清哪条是上游给的、哪条是人改的；而且用户改错了没有退路。派生视图 + 一条记忆，随时可逆。

**验证（0.14.0）**：
- `npm test` 全绿：yaml 5 / core **20** / sync 6 / catalog 11 / miner / plugin **12** / ui **17** / client 32 / `SMOKE OK`；`PANEL RENDER OK`。
- 新增用例：core 的「采信记得住会：去年点过一次，今年新一届自动沿用」（含 `venueKey('IEEE/CVF CVPR') === 'cvpr'`、记忆指向不存在的来源时安静退回、原对象不被改）；ui 的「panelPayload applies the per-venue preferred source to a new edition」；plugin 的「采信会记到会议系列上：明年新一届不用再点，恢复默认一起清掉」（断言磁盘上的 `meta.preferredByVenue` 与恢复时被删）。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端；活体 `version` 仍缺失）；
2. 真实模型跑一次验收（P0-3）；
3. 补数据队列视图（现在只有单飞锁）；
4. 「按系列」记忆的可视化管理（现在只能通过某一条记录间接清除）。

**代码位置**：`lib/core.js` 的 `venueKey` / `applyPreferred(record, venuePrefs)` / `applyPreferredAll`；`lib/ui.js` 的 `arrayOf(records, venuePrefs)` 与 `panelPayload` 里读 `cache.meta.preferredByVenue`、投影 `preferredInherited`；`lib/create.js` 的 `viewRecords`（透传系列记忆）、`doPrefer`（写/删 `meta.preferredByVenue`，返回 `remembered`/`venue`）、`/ccf prefer` 的回执；`client/client.js` 的 `alternativesView`（继承时改写文案）。

## 16. 第 12 轮评审（0.15.0）——「补数据」时看得见在补第几个（2026-11-01）

前一轮把「采信」记住了，但点「补数据」时面板上仍然只有一个不动的秒表：一轮 6 个会要几十秒到几分钟，`POST /update` 要整轮跑完才回，读者既不知道现在补到哪个会，也分不清是卡住了还是在慢慢跑。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N38 | 点了「补数据」，几十秒里只有「正在补数据… 已 37 秒」，不知道在补哪个会、还剩几个 | 服务端在挖掘过程中推进度：`runUpdate({ onProgress })` 每开始/结束一个会报一次；`create.js` 存快照（`total/index/done/current/ok/failed/last`），`/records` 的 `meta.updateProgress` 带出来；面板状态行显示「正在补数据 3/6：CVPR · 61 秒（本轮已补到 2 个，没补到 1 个）」，并在挖掘期间每 2.5 秒读一次 `/records` |

**为什么进度走 `/records` 而不是让 `/update` 流式返回**：`POST /update` 的语义是"给我结果"，流式化要改协议、还要处理中途断连；而面板本来就有一个 2.5 秒的轻轮询可以复用。进度只是"顺便能看见"，不该为它引入新的传输形态。

**两个刻意的取舍**：
1. 进度回调里抛异常被吞掉（`try { onProgress?.(payload) } catch {}`）——进度是旁路信息，不能因为它把挖掘搞挂；
2. 快照在 `finally` 里清空，即使 `runUpdate` 抛异常，面板也不会永远停在"正在补数据 3/6"。

**验证（0.15.0）**：
- `npm test` 全绿：yaml 5 / core 20 / sync 6 / catalog 11 / miner（含进度 7b 段）/ plugin **13** / ui **18** / client **33** / `SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`（403 条 / 待补 250）。
- 新增用例：miner 的「onProgress 每个会都有 start/done，回调抛异常不影响挖掘」；ui 的「panelPayload tells the panel how far the mining run got」（idle → `busy:false`；running → total 6 / index 3 / current CVPR / elapsedMs 42000）；client 的「progressLabel only speaks when the host says a run is in flight」（三种退化形态）；plugin 的「进度快照：没在跑时是 null，跑完也回到 null」。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端；活体 `version` 仍缺失）；
2. 真实模型跑一次验收（P0-3）；
3. 补数据队列视图（现在只有单飞锁 + 单轮进度）；
4. 「按系列」记忆的可视化管理（现在只能通过某一条记录间接清除）。

**代码位置**：`lib/miner.js` 的 `runUpdate({ onProgress })` 与 `say()`；`lib/create.js` 的 `updateProgress` 快照、`progress()`、409 回执里的"正在补 X"；`lib/ui.js` 的 `progressOf()` 与 `panelPayload.meta.updateProgress`；`client/client.js` 的 `progressLabel()`、`mining` ref 与 2.5 秒轮询 effect。

## 17. 第 13 轮评审（0.16.0）——关注的会要能"只看这些"，装上了也要知道面板在哪（2026-11-01）

这一轮换了立场：一个已经关注了三个目标会的人。他的动作不是"翻列表"，而是"盯住这三个"。此时面板上的三个视图（全部 / 有数据 / 待补）都没法回答"我关注的那几个现在什么状态"——关注只影响排序，仍混在 100 多条里。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N39 | 关注了三个会，但想"只看关注的"只能自己在长列表里找 ★ | `buildRows` 支持 `onlyPinned`；工具栏新增「关注 N」视图（只有关注过才出现，避免多一个空入口），空态文案说明怎么关注；状态行显示「关注视图」 |
| N40 | 装好插件、用了一阵，才知道右侧还有一个面板；`/ccf status` 与系统提示里都没提 | 系统提示的「数据状态」行末尾加一句「桌面端右侧有「📅 会议」面板（点开即列表，可按方向/等级筛、可导出日历）」；`/ccf status` 增加「面板：桌面端右侧「📅 会议」标签（点开即列表；没显示就重启一次 DSH）」 |

**为什么「关注」视图不做成默认**：关注是少数人的动作，默认视图应该是"最近有什么会要截稿"；把关注做成第四个 chip，需要时才出现，既不打乱习惯，也不让人对着空列表发愣。

**为什么提示语要写进系统提示**：插件最常被"读"的地方是系统提示，而不是面板本身。用户问"最近有什么会"时，模型如果顺带说一句"右侧面板也能看"，面板才被发现；否则它一直是个隐藏功能。

**验证（0.16.0）**：
- `npm test` 全绿：yaml 5 / core 20 / sync 6 / catalog 11 / miner / plugin **13** / ui 18 / client **34** / `SMOKE OK`。
- 新增用例：client 的「onlyPinned narrows the list to the starred conferences」（含"关注为空时是空列表，不退回全部"）；plugin 的 prompt 段断言 `「📅 会议」面板`、status 断言 `「📅 会议」标签`。
- `panel.render.test.mjs` 增加真实交互：点卡片 ☆ → 工具栏出现「关注 1」→ 点它只剩 CVPR、状态行变「关注视图」、未关注的 ICLR 消失。
- `INTEGRATION OK`（403 条 / 待补 250）。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端；活体 `version` 仍缺失）；
2. 真实模型跑一次验收（P0-3）；
3. 补数据队列视图（现在只有单飞锁 + 单轮进度）；
4. 系列记忆的可视化管理（现在只能通过某一条记录间接清除）。

**代码位置**：`client/client.js` 的 `buildRows({ onlyPinned })`、`Toolbar` 的 `modes`（`pinCount > 0` 才加「关注」）、`CcfPanel` 的 `rows` 分支与空态、状态行的「关注视图」；`lib/create.js` 的 `updateNote`（面板提示）与 `/ccf status` 的「面板」行。

## 18. 第 14 轮评审（0.17.0）——模型挖错了怎么办，批量补到底补几个（2026-11-01）

这一轮问的是"数据出错时我能做什么"。面板上的日期都来自公开数据或模型挖掘，一旦某个会挖错（模型把 workshop 的日期当成主会、把去年的页面当今年），用户眼下只有两条路：忍着，或者去改 `~/.dsh/ccf/cache.json`。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N41 | 卡片上「补往届 201」「补从未 49」看着像"一次全补完"，实际一次只补 2 个，点完就没了，也没说为什么 | 点下去时的提示改成"每次 2 个（省模型开销），可以再点"；回执照旧带本轮的 `本次范围…` 与本轮处理数 |
| N42 | 模型挖到的日期明显不对，却没有"重挖这个会"的入口——只能等下一轮懒更新，或者手改缓存 | 展开详情里，**模型挖掘来的记录**多一个「重挖这个会」按钮：走 `POST /update` 的 `focus`（顺便也把它当成"我不放心这条，再确认一次"的入口），带 `title` 说明这条是模型挖的 |

**为什么只给"模型挖到的"加重挖**：来自 CCFDDL 首选源的记录再挖一次没有意义（`/update` 的成功路径会把挖到的值写进主记录，反而可能把权威数据覆盖成模型猜的）。只有在 `source === 'model'` 时，重挖才是"提高准确度"而不是"降低准确度"。

**为什么重挖不先删记录**：删除会让「对待补的分类」瞬间变化（有数据 → 从未抓到），也会让面板在重挖失败时丢掉已有值。直接覆盖更安全：失败时旧值仍在。

**验证（0.17.0）**：
- `npm test` 全绿：yaml 5 / core 20 / sync 6 / catalog 11 / miner / plugin 13 / ui 18 / client 34 / `SMOKE OK`。
- `panel.render.test.mjs` 新增真实交互：把 ICLR 记录改成 `source: 'model'` → 卡片显示「新」与「模型挖掘 · 时间」→ 点标题展开 → 出现「重挖这个会」→ 点它发出 `POST /dsh-ccf/api/v1/update`，body 含 `"focus":"ICLR"`。同时保留原有的关注（★）流程断言。
- `INTEGRATION OK`（403 条 / 待补 250）。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端；活体 `version` 仍缺失）；
2. 真实模型跑一次验收（P0-3）；
3. 补数据队列视图（现在只有单飞锁 + 单轮进度）；
4. 系列记忆的可视化管理（现在只能通过某一条记录间接清除）。

**代码位置**：`client/client.js` 的 `Card` 展开区（`record.source === 'model'` 时渲染「重挖这个会」）与 `CcfPanel.updateScope` 的提示语；测试在 `test/panel.render.test.mjs`（ICLR 改成 model 源 + 重挖断言）与 `test/client.test.mjs`（关注视图）。

## 19. 第 15 轮评审（0.18.0）——面板写的是本地时间，官网写的是 AoE，谁对（2026-11-01）

这一轮站在"正开着会议官网对日期"的人这边。会议室里最常见的争执不是数据缺，而是"官网说 11 月 16 日 23:59（AoE），面板说 11 月 17 日 19:59"——两个都对，但面板没有任何地方告诉读者它换算了时区。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N43 | 截稿值只有本地时间，看不出官网那个 UTC−12 / AoE 口径是哪一刻；想核对就得自己减 20 小时 | 截稿值加悬停说明（`sourceZoneLine`：`UTC-12:00 2026-11-16 23:59`）；`/ccf venue` 的每届行追加「官方口径 UTC-12:00：截稿 2026-11-16 23:59」（新 `officialZoneText()`） |
| N44 | `formatVenue` 的每届行排版有个孤零零的 `·`（`  - 2027: · 截稿 …`），在命令与工具输出里很显眼 | 改成"先收集片段再 join"，末尾冒号后面不再留分隔符；没有日期时行尾只剩 `:` |
| N45 | 试过搜索、等级、方向、天数之后，没有回到默认的出口，只能一项项手动清 | 工具栏在**任一筛选偏离默认**（搜索非空 / 等级非 all / 方向非空 / 天数非 120）时显示「重置筛选」，一次清空四项并把天数恢复 120 |

**为什么把官方口径放在悬停与命令输出，而不是换成主显示**：主显示必须是读者所在时区（他在 Asia/Shanghai 排日程），官方口径是"核对用"的第二信息；两个都常驻会让每张卡片多一行噪音。

**顺带修掉的一个真 bug**：`formatInZone(instant, 'UTC-12:00')` 会抛 `RangeError: Invalid time zone specified: UTC-12:00`——固定偏移不是 IANA 时区，不能交给 `Intl`。新增 `formatInZoneSafe()`：固定偏移走 `tzOffsetMinutes` 平移 + UTC getter，IANA 仍交给 `formatInZone`。

**验证（0.18.0）**：
- `npm test` 全绿：yaml 5 / core **22** / sync 6 / catalog 11 / miner / plugin 13 / ui 18 / client 34 / `SMOKE OK`。
- `test/core.test.mjs` 新增两例：`formatInZoneSafe(Date.parse('2026-11-17T11:59:59Z'), 'UTC-12:00') === '2026-11-16 23:59'`、`officialZoneText() === 'UTC-12:00：截稿 2026-11-16 23:59'` 且 `formatVenue` 含「官方口径」。
- `panel.render.test.mjs` 新增真实交互：CVPR 记录带 `timezone: 'UTC-12:00'` → 截稿值节点 `title` 含 `UTC-12:00 2026-11-19 12:00`；把天数改成 30 → 出现「重置筛选」→ 点击后按钮消失、天数回到 120。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端；活体 `version` 仍缺失）；
2. 真实模型跑一次验收（P0-3）；
3. 补数据队列视图；
4. 系列记忆的可视化管理（现在只能通过某一条记录间接清除）。

**代码位置**：`lib/core.js` 的 `formatInZoneSafe`/`officialZoneText` 与 `formatVenue`；`client/client.js` 的 `Line`（新增 `title` 透传）、`Card` 的截稿行、`Toolbar` 的「重置筛选」与 `CcfPanel` 的 `onReset`。

## 20. 第 16 轮评审（0.19.0）——出错时面板在说什么（2026-11-01）

这一轮站在"插件刚才还好好的、现在打开是空的"的人这边。桌面端没重启、端口变了、服务端 500、路由 404——这些在开发者眼里是四个不同的问题，在读者眼里是同一句话："它坏了，我该干什么？"

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N46 | 出错时面板写「读取失败：Unexpected token '<', "<!doctype "...」——这是把 JS 异常原样丢给读者 | 新增 `describeFailure()`：把「返回 HTML / 404 / 403 / 5xx / 连不上 / 不是 JSON」翻成一句能照做的话（多数情况指向"重启一次桌面端"）。`load()` 改成先读文本再自己解析，不再让 `response.json()` 抛异常 |
| N47 | 报错区只有文字，没有能点的地方；想"再试一次"得先知道跑哪条命令 | 报错区加「重试」按钮（重新 `GET /records`），旁边一行说明"重试不行就点「同步」，或跑 `/ccf status`" |
| N48 | 面板收起时完全看不出里面出过错——标签上照样写「会议 N」 | 出错且没有数据时，收起态标签亮一个 ⚠（`title` 带完整原因，`aria-label` 读作"面板读取失败"） |

**为什么先读文本再解析**：`Response.json()` 在路由没挂上时会抛 `SyntaxError`，而这时 HTTP 状态码还是 200（返回的是 SPA 首页），只看 `response.ok` 根本发现不了。先拿 `text()`、再自己 `JSON.parse`，才能同时判断"状态码对不对"和"返回的是不是数据"。

**为什么错误文案里点名"重启桌面端"**：这是本插件最高频的困惑——服务端模块热生效、客户端 bundle 要重启才进 boot graph，两边不同步时表现就是"面板是空的 / 路由 404 / 返回 HTML"。把这条写进错误信息，比写进 README 更有用。

**验证（0.19.0）**：
- `npm test` 全绿：yaml 5 / core 22 / sync 6 / catalog 11 / miner / plugin 13 / ui 18 / client **35** / `SMOKE OK`。
- `test/client.test.mjs` 新增 `describeFailure()` 六种输入（HTML→重启、404→路由不存在、403→回环、500→服务端出错、`TypeError('Failed to fetch')`→连不上本地服务、未知错误仍带原文）。
- `test/panel.render.test.mjs` 新增真场景：fetch 桩返回 SPA 首页 → 面板文本含「重启」且**不含** `Unexpected token`、出现「重试」按钮 → 换回正常响应点「重试」→ CVPR 卡片恢复。
- `INTEGRATION OK`（403 条 / 待补 250）。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端；活体 `version` 仍缺失）；
2. 真实模型跑一次验收（P0-3）；
3. 补数据队列视图；
4. 系列记忆的可视化管理。

**代码位置**：`client/client.js` 的 `describeFailure`（纯函数，已导出）、`load()` 的"先读文本再解析"、报错区与收起态 ⚠。

## 21. 第 17 轮评审（0.20.0）——不用鼠标能不能看完这张表（2026-11-01）

前面的轮次都在关心"信息对不对、够不够"，这一轮换成**只动键盘的人**（远程终端里接显示器、手边没鼠标，或者纯粹用 Tab 走完整个界面）。测法是：只用 `Tab` / `Enter` / `Space` / `Esc`，能不能把这张表从头看到尾。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N49 | 卡片标题行是 `div role="button"` + `onClick`——看着像按钮，Tab 却聚焦不到，回车也没反应，详情永远展不开 | 加 `tabIndex: 0` 与 `onKeyDown`（`Enter` / `Space` → `preventDefault()` + `onToggle()`），`aria-expanded` 原样保留 |
| N50 | 点开面板之后焦点还留在那个已经被卸载的标签上，掉到 `body`；按 `Esc` 收起后也一样，键盘用户得重新 Tab 一路找回来 | 面板 `section` 加 `tabIndex={-1}` + `ref`，打开时 `focus()`；收起时把焦点还回标签按钮。用 `wasOpen` ref 标记"刚刚是开着的"，避免首次挂载就抢走用户正在打字的焦点 |
| N51 | 提示条（"已同步 403 条""上次补数据成功 3 个"）和报错区都只是纯视觉变化，读屏软件不会念 | 提示条 `role="status" aria-live="polite"`，报错区 `role="alert"` |

**为什么不用全局快捷键（比如 `Ctrl+Shift+D`）**：DSH 里同时有输入框、终端、编辑器在吃键盘事件，加一个全局快捷键很容易和它们抢；而右侧标签本来就在 Tab 顺序里，进去只差"焦点要落在面板上"这一步，把这一步做对就够了。

**验证（0.20.0）**：
- `npm test` 全绿：yaml 5 / core 22 / sync 6 / catalog 11 / miner / plugin 13 / ui 18 / client 35 / `SMOKE OK`。
- `test/panel.render.test.mjs` 新增键盘流程（jsdom 真实 `tabIndex` / `focus()`）：卡片标题行 `tabindex="0"` → 派发 `keydown{key:'Enter'}` → 详情"别名"出现；派发 `Escape` → 回到收起态且 `document.activeElement === 标签按钮`；再点开 → `document.activeElement` 的 `role` 是 `dialog`。
- `INTEGRATION OK`（403 条 / 待补 250）。

**仍未做（下一轮候选）**：
1. 真实环境回归（重启桌面端；活体 `version` 仍缺失）；
2. 真实模型跑一次验收（P0-3）；
3. 补数据队列视图；
4. 系列记忆的可视化管理。

**代码位置**：`client/client.js` 的 `Card` 标题行（`tabIndex`/`onKeyDown`）、`CcfPanel` 的 `panelRef`/`tabRef`/`wasOpen` 焦点 effect、提示条与报错区的 ARIA 角色。

## 22. 第 18 轮评审（0.21.0）——数据看起来是新的，但其实是半个来源

这一轮的立场是"每天点开看一眼就信了"的读者。我把真实缓存 `C:\Users\15961\.dsh\ccf\cache.json` 整份过了一遍体检：摘要截止晚于截稿、审稿决定早于截稿、会期早于截稿、年份和记录对不上、未来超过 900 天、过去超过 900 天——**一项异常都没有**。所以这一轮没有去做"标可疑日期"，而是发现了一个更朴素、也更危险的问题：

> 面板只告诉我"什么时候更新的"，没告诉我"这次是哪几个源拉到的"。

`syncSources` 其实是逐个源跑、把每个源的结果写进 `cache.reports`（`{ id, ok, count, error }`），全部源都失败时还会保留旧缓存并把失败原因写进 `cache.lastAttemptAt / cache.lastError`。但这些信息**从来没到过界面上**：只要还有一个源能用，面板就显示"昨天 22:04 更新"，读者完全看不出他的数据只剩一个来源。

| 编号 | 问题（用户视角） | 修法 |
|------|------------------|------|
| N52 | 两个源里有一个挂了，面板看起来一切正常——数据其实是"半套" | `lib/ui.js` 的 `panelPayload` 把 `cache.reports` 投影成 `meta.sources[{id,ok,count,error}]`；面板状态行在最前面显示红字 `⚠ 1/2 个源没拉到（paper-deadlines）`，悬停看每个源的错误原文 |
| N53 | 上次同步整个失败了（旧缓存还在），界面上找不到这件事 | `meta.lastAttemptAt` / `meta.lastError` 一起投出来；没有源健康问题时，状态行显示 `⚠ 上次同步失败：10-31 11:04`，悬停给出 `CCFDDL 接口: ...; paper-deadlines: ...` |

**为什么不直接禁用面板/弹大窗**：数据本身仍然是有效的（旧缓存没坏），读者要的是"知道这一条是几个源支撑的"，不是被拦住。所以做成状态行上的一个红字告警 + 悬停细节，保持"抬头看一眼"的成本不变。

**验证（0.21.0）**：
- `test/ui.test.mjs` 新增 `panelPayload surfaces per-source health and the last failed attempt`（两个源一成一败 → `meta.sources` 的 `[id, ok, count]`、失败源 `error`、`lastAttemptAt` 的 ISO、`lastError`）→ ui **19 passed**。
- `test/client.test.mjs` 新增 `sourcesWarning 点名没拉到的源，全成功时保持安静`（`null` / `{}` / 空数组 / 全成功 → `''`；1 成 1 败 → `1/2 个源没拉到（paper-deadlines）`）→ client **36 passed**。
- 全量：yaml 5 / core 22 / sync 6 / catalog 11 / miner / plugin 13 / ui 19 / client 36 / `SMOKE OK`；`PANEL RENDER OK`。

**仍未做（留到下一轮）**：
1. 真实环境回归——桌面端从 0.4.x 起就没重启过，活体 `/dsh-ccf/api/v1/records` 的 `version` 至今为空，`meta` 里也没有 `sources`；
2. 真实模型跑一次「补数据」验收（P0-3 的回执文案）；
3. 补数据任务队列视图；
4. 系列记忆（`meta.preferredByVenue`）的可视化管理：现在只能靠 `/ccf prefer` 一条条恢复。

## 23. 第 19 轮评审（0.22.0）——不是"查不到"，是"查不到之后呢"

这一轮没有坐在面板前，而是**直接照用户的用法去查工具**：`ccf_venue` 查 `BIBM`（他自己的方向）、`ICLR`（顶会但 CCF 名单里没有）、`MICCAI`、`NIPS`（大家都这么叫）、`FoobarConf`（根本不存在）。真机输出里抓到三个问题，其中一个是**崩溃级**的。

### 23.1 N54：等级有两套权威，名单外与名单内混在一张纸上

`ICLR` 的输出第一行写着 `CCF-A`——这个等级来自 CCFDDL（上游把 ICLR 标成 A），但 CCF 官方名单里**没有 ICLR**。同一份输出里，`/ccf list --rank CCF-A` 的筛选、面板「名单 362 个会」的统计，又都不含 ICLR。读者把这两件事拼起来就会疑心"到底听谁的"。

修法：`ccf_venue` 查完再对一次名单——命中记录但名单里没有这个会时补一行：

> 名单说明：这个会不在 CCF 名单（362 个）里，上面的等级/方向来自 CCFDDL；按等级筛选与「待补」统计都不含它。

两边等级不一样时（例如数据说 B、名单说 A）也补一行说明谁说的。

### 23.2 N55：查不到的时候只给一句"数据里没有"，没有出路

原来未命中的唯一答复是 `数据里没有 "X"。先 /ccf list 看看有什么，或 /ccf sync 更新数据。`——但"查不到"其实分两种，用户能做的事完全不同：

| 情况 | 原来 | 现在 |
|------|------|------|
| 名单里有、只是还没挖到（如 `STOC`） | 同一句，看起来像没这个会 | `名单里有「STOC · ACM Symposium on the Theory of Computing」（CCF-A · 计算机科学理论），但还没有截稿数据。用 /ccf update --focus STOC 让模型去它官网挖一次，或在面板「待补」视图里点「补这个会」。` |
| 名单外也没有（如 `FOOBAR`） | 同一句 | `既不在 CCF 名单（362 个）里，数据里也没有 "FOOBAR"。名单外的会收不进「待补」，也不会被按名单挖掘；CCFDDL 只收主要会议，小会/新会要等社区数据或直接看官网。` |

### 23.3 N56（真 bug，0.18.0 引入）：`timezone: "AoE"` 的记录会让整次 `ccf_venue` 崩掉

给"官方口径"那行写完，`formatInZoneSafe` 只判了 `UTC±` 前缀，其余一律交给 `Intl.DateTimeFormat`——而 `Intl` 不认 `AoE`，直接抛 `RangeError: Invalid time zone specified: AoE`。上游**绝大多数**记录的时区就是 `AoE`，所以这不是边角：`ccf_venue` 对它们全都会抛错，连"查一个会"都做不了。

修法：`tzOffsetMinutes` 与 `formatInZoneSafe` 都先把 `AoE`（大小写都算）当固定偏移 `-720` 处理，只有真正的 IANA 名字才走 `Intl`。顺带把 `formatVenue` 里 `head.history.length` 改成先 `Array.isArray` 兜底——旧缓存里没有 `history` 字段（0.9.0 才加），一读就抛。

**为什么这个 bug 能活过两轮**：`panel.render.test.mjs` 里的 CVPR 记录写的是 `timezone: 'UTC-12:00'`，正好绕过 `AoE` 分支；真正的数据是全 AoE。教训记在这：**测试夹具的时区要贴近真实数据**。

### 23.4 验证（0.22.0）

- `test/plugin.test.mjs` 新增 `ccf_venue：名单外 / 名单里但没数据 / 两套等级说法，都要讲清楚`（`FOOBAR` → "既不在 CCF 名单"＋"名单外收不进待补"；`STOC` → "名单里有…"＋`--focus STOC`；`ICLR` → "不在 CCF 名单"＋"来自 CCFDDL"；`NIPS` → 命中 NeurIPS 且**不**标名单外）→ plugin **14 passed**。
- `test/core.test.mjs` 新增 `官方口径：AoE 这种"时区名"不能让整次查询炸掉（回归）`（`formatInZoneSafe(…, 'AoE')`、小写 `aoe`、`officialZoneText`、`formatVenue` 四处）→ core **23 passed**。
- 真机复核（真实缓存 404 条）：`NIPS` → `NeurIPS 2026 · CCF-A`，无名单外说明；`ICLR` → 有"不在 CCF 名单"一行；`STOC` → 正常详情。
- 全量：yaml 5 / core 23 / sync 6 / catalog 11 / miner / plugin 14 / ui 19 / client 36 / `SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。

**仍未做（留到下一轮）**：
1. 真实环境回归——桌面端仍未重启（活体 `version` 为空），这一轮的输出是在源码层 + 真实缓存上验的；
2. 真实模型跑一次「补数据」验收（P0-3 的回执文案）；
3. 补数据任务队列视图；
4. 系列记忆（`meta.preferredByVenue`）的可视化管理。

## 24. 第 20 轮评审（0.23.0）——命令行和面板说的是不是同一件事

上一轮在工具侧抓到了崩溃；这一轮换成**命令行用户**的视角：`/ccf status`、`/ccf config`、`/ccf list --pending`、搜一个不存在方向的关键词。四条命令里有两条在自相矛盾。

### 24.1 N57：`/ccf status` 说「待补 56」，面板说「待补 250」

`status` 里那行读的是 `cache.meta.pending`——那是**上一轮挖掘**结束时留下的旧快照；而面板和 `ccf_deadlines` 早就改成了用 `catalogCoverage` 现算。于是同一个插件，一个入口说 56、另一个入口说 250。这正是 N12（数字口径不一致）在**命令行**里的残留：上次只修了面板与工具，忘了 status。

修法：status 也走 `catalogCoverage`，输出改成

> 覆盖：112 个有未来截稿，250 个待补（其中 201 个只有往届日期、49 个从未抓到；名单共 362 个会）

### 24.2 N58：`/ccf config` 里的数据源是假的

`config` 打印数据源时用的是写死的旧默认值，只有 `paper-deadlines` 一条；而 `sync` 实际用的 `DEFAULT_SOURCES` 第一条是 **CCFDDL 接口**（`https://ccfddl.com/conference/allconf.json`）。用户照 `config` 去理解数据从哪来，理解到的就是错的——尤其"官方接口优先"这件事，正是上一轮改的主线。

修法：`const sources = config.sources ?? DEFAULT_SOURCES`，并在标题里写明"按顺序；第一个取不到才用下一个"。

### 24.3 N59：搜索没结果时，建议不解决问题

搜 `bioinformatics` 时提示"可以放宽条件：`/ccf list 240` 或 `/ccf list 120 --rank CCF-B`"——可生信类的会**根本不在 CCF 名单里**，放宽窗口不会让它们出现。补第三行：

> 如果这类会本来就少，可能是它不在 CCF 名单里：用 `/ccf list --pending --search <关键词>` 看名单里有没有还没数据的会，或用 `ccf_venue` 直接查一个会的名字。

顺带把 `--pending` 的尾巴从"用 `ccf_update` 或 `/ccf update` 让模型去补"改成四条具体用法（`--area` 批量方向 / `--focus` 单个会 / `--scope past|never` 分类补 / 面板三个按钮）。

### 24.4 验证（0.23.0）

- `test/plugin.test.mjs` 的 status/config 用例加强：seeded 缓存里故意塞 `meta: { pending: 999 }`，断言 status 输出含 `覆盖：N 个有未来截稿，M 个待补` 与 `名单共 362 个会`、且**不含 999**；config 断言含 `ccfddl-api` 与 `allconf.json` → plugin **14 passed**。
- 真机复核（真实缓存 404 条）：status 与面板完全一致（112 / 250 / 201 / 49）；config 第一源是 CCFDDL 接口；`search=bioinformatics` 多出第三行解释。
- 全量：yaml 5 / core 23 / sync 6 / catalog 11 / miner / plugin 14 / ui 19 / client 36 / `SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。

**仍未做（留到下一轮）**：
1. 真实环境回归——桌面端仍未重启（活体 `version` 为空），以上都是源码层 + 真实缓存验证；
2. 真实模型跑一次「补数据」验收（P0-3）；
3. 补数据任务队列视图；
4. `meta.preferredByVenue`（系列记忆）的可视化管理。

## 25. 第 21 轮评审（0.24.0）——多出来的 68 张卡去哪了

这一轮换了一个最朴素的核对方式：**把面板上的数字加起来**。

真实缓存里 404 条记录，面板标题栏写「名单 362 个 · 有数据 112 · 待补 250」——112 + 250 = 362，账是对的。可列表里滚一滚就会看到 `CoRL 2026`、`EACL 2027`、`CICAI 2026` 这些卡片，它们既不出现在「待补」里（因为不在 CCF 名单），也不计入「有数据 112」。用户的第一反应是"插件少数了 68 个"或者"这些卡是假的"。

### 25.1 N60：名单外的会既不算有数据、也不算待补，但卡片就在列表里

实测：404 条记录里 **336 条能对上 CCF 名单**，**68 条对不上**（CCFDDL 收了、CCF 名单没收），其中 **22 条还有未来截稿**。这 68 个会以前只活在列表里，任何计数都不提它们。

修法（把"名单外"作为第三种状态数出来，而不是塞进现有两桶）：

- `lib/catalog.js` 的 `catalogCoverage` 返回值新增 `outside`（对不上任何名单会的记录）与 `counts.outside / counts.outsideFuture`；
- `lib/ui.js` 的 `panelPayload` 把这两个数放进 `counts`，面板状态行在 `counts.outside > 0` 时追加 `· 名单外 68 个会`，悬停说明写"CCFDDL 收了、CCF 名单没收的会（不计入 362）"；
- `lib/create.js`：`/ccf status` 的覆盖行尾巴加"；另有 68 个名单外的会"，`/ccf list` 的覆盖度段多一行"另有 68 个名单外的会（CCFDDL 收录、CCF 名单未收，其中 22 个还有未来截稿），不计入这 362 个"。

**关键的账**：`有数据 + 待补 = 362` 保持不变，名单外的会另起一行——因为它们是"CCF 没有这个会"，不是"CCF 这个会没数据"，混进 `待补` 会让 362 这个分母变得不可解释。

### 25.2 验证（0.24.0）

- `test/catalog.test.mjs`：加两个名单外记录（一个还有未来截稿、一个已过期）→ `counts.outside === 2`、`outsideFuture === 1`，且 `future`/`pending` 不受影响、`future + pending === total` 仍成立。
- `test/ui.test.mjs`：`panelPayload counts the conferences that the CCF list does not carry` → `outside 2`、`outsideFuture 1`、`counts.records 3`，且 `CoRL` 不出现在 `pending`。
- `test/plugin.test.mjs`：新增「/ccf status 会把"名单外的会"单独说出来」→ status 含 `另有 1 个名单外的会`，`/ccf list` 含完整那句说明 → plugin **15 passed**。
- `test/panel.render.test.mjs`：夹具补 `counts`，断言状态行出现 `名单外 2 个会` → `PANEL RENDER OK`。
- 真实缓存复核：`counts {total:362, future:112, past:201, never:49, pending:250, outside:68, outsideFuture:22}`，`112 + 250 = 362`。
- 全量：yaml 5 / core 23 / sync 6 / catalog 11 / miner / plugin 15 / ui 20 / client 36 / `SMOKE OK`；`INTEGRATION OK`。

**仍未做（留到下一轮）**：
1. 真实环境回归——桌面端仍未重启（活体 `version` 为空），以上都是源码层 + 真实缓存验证；
2. 真实模型跑一次「补数据」验收（P0-3）；
3. 补数据任务队列视图；
4. 名单外的会要不要也能"补数据"（目前它们不进 `待补`，也就没有入口）——下一轮先问清楚这件事该不该做。

## 26. 第 22 轮评审（0.25.0）——名单外的会点「补这个会」会发生什么

上一轮把 68 个"名单外"的会单独数出来了。这一轮顺着问：**用户看到 `CoRL 2026` 的卡片，想让它更准，能做什么？**

真实用法是去面板/命令里点它的名字。而这条路以前是死的：

### 26.1 N61：名单外的会按名字补数据，等于什么都没发生

`planUpdate` 只遍历 CCF 名单里的 362 个会；`focus` 只是在这个集合里做子串过滤。于是 `ccf_update({ focus: 'CoRL' })`（或面板里对名单外卡片点"补这个会"）→ `selected` 为空 → 回执说"本次范围内没有需要补的会"，模型一次也没跑。

修法：`focus` 在名单里找不到任何匹配时，**按用户给的名字单独排一个会**去挖（`planUpdate` 里 `focused` 标记 + 名单外合成条目，`outside: true`）：

- 一条记录都没有 → `reason: 'new'`；
- 有记录但没有未来截稿 → `reason: 'next-edition'`；
- 已有未来截稿 → 不进计划（避免白跑模型）。

同时面板给名单外的卡片补一行说明与本轮入口：

> 不在 CCF 名单里（CCFDDL 收录），不算在 362 个会内。 **补这个会**

`panelPayload` 新增 `outside` 标记（`coverage.outside` 的 key 集合），卡片据此决定是否渲染这一行。

### 26.2 一个被测试抓住的真 bug

第一次把 `outsideKeys` 写在 `records` 映射旁边——但那时 `coverage` 还没算（TDZ），`panelPayload` 直接抛 `ReferenceError`，`GET /records` 变成 **500**。`ui.test.mjs` 立刻报 `500 !== 200`。修法：`outsideKeys` 挪到 `coverage` 之后。

> 教训：**派生变量必须写在它依赖的值之后**；`panel.render` 用的是手工 `PAYLOAD`，不会经过 `panelPayload`，所以单靠渲染测试抓不到这一类错。

### 26.3 验证（0.25.0）

- `test/miner.test.mjs`：名单外 focus 三种情形（无记录 → `new`；只有往届 → `next-edition`；有未来截稿 → 不进计划）全部通过。
- `test/ui.test.mjs`：`outside` 标记正确（CoRL/CICAI 为 true、CVPR 为 false），`pending` 里没有名单外的会 → ui **20 passed**。
- 真实缓存复核：404 条中 **68 条被标为名单外**（22 条还有未来截稿），CVPR 等名单内会不误标；`counts` 与上一轮一致。
- 全量：yaml 5 / core 23 / sync 6 / catalog 11 / miner / plugin 15 / ui 20 / client 36 / `SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。

**仍未做（留到下一轮）**：
1. 真实环境回归——桌面端仍未重启（活体 `version` 为空），以上都是源码层 + 真实缓存验证；
2. 真实模型跑一次「补数据」验收（P0-3）；
3. 补数据任务队列视图；
4. 名单外的会挖到之后，要不要提示"它不在名单里，按等级筛选看不到它"（现在只有卡片上那行说明）。

## 27. 第 23 轮评审（0.26.0）——"365 天内只有 8 个会截稿"是真的吗

这一轮换到**读回答的人**的位置：模型拿着 `ccf_deadlines` 的返回去写结论。真实调用（limit 8，365 天窗口）以前第一行是：

> 未来 365 天内 8 个截稿（时间按 Asia/Shanghai 显示，现在 …）

用户/模型读到的结论就是"一年内只有 8 个会要截稿"。实际是 **133 个**，那 8 个只是我给的 `limit`。

### 27.1 N62：limit 截断在回答里隐身

`queryDeadlines` 先过滤再 `slice(0, limit)`，返回的数组已经丢了"一共匹配多少"。渲染层只能按 `rows.length` 写标题，于是"截断后的条数"冒充"总数"。

修法：

- `lib/core.js` 新增 `queryDeadlinesWithMeta(records, options)` → `{ rows, matched, limit, hidden }`；`queryDeadlines` 保留为取 `.rows` 的薄包装（老调用与测试不受影响）。
- `formatList` 支持 `options.matched`：被截断时标题改成
  > 未来 365 天内共 133 个截稿，这里按最近排序列出前 8 个（用 limit 调大，或用 --rank / --area / 更短天数缩小范围）
- `lib/create.js` 的 `buildList` 用 meta 版拿 `matched`（按名单方向过滤后重算），并把它交给 `formatList`；`ccf_deadlines` 的 `data` 新增 `matched` 与 `hidden`。

这样"8"和"133"同时在回答里出现，读答案的人自己能判断要不要追问。

### 27.2 验证（0.26.0）

- `test/core.test.mjs`：`queryDeadlinesWithMeta(..., { limit: 2 })` → `rows 2 / matched 3 / hidden 1`；`formatList(..., { matched: 3 })` 含 `共 3 个截稿`、`列出前 2 个`、`limit`；不截断时**不**出现 `列出前`。
- 真机（真实缓存 404 条）：`days:365` → `count 133 / matched 133 / hidden 0`；`days:365, limit:8` → `count 8 / matched 133 / hidden 125`；`days:30` → `count 34 / matched 34 / hidden 0`。
- 全量：yaml 5 / core 23 / sync 6 / catalog 11 / miner / plugin 15 / ui 20 / client 36 / `SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。

**仍未做（留到下一轮）**：
1. 真实环境回归——桌面端仍未重启（活体 `version` 为空）；
2. 真实模型跑一次「补数据」验收（P0-3）；
3. 补数据任务队列视图；
4. `ccf_venue` 与 `/ccf venue` 同样可能被 limit 影响（目前它们不截断，但如果以后加 limit，要复用这次的口径）。

## 28. 第 24 轮评审（0.27.0）——缓存坏了，面板说"你还没有数据"

这一轮换到**换一台电脑**的位置：新机器、拷过来的旧 `~/.dsh/ccf/cache.json`、手工改过一半的文件、数据目录不可写。

先探了四种环境（临时目录里造）：

| 场景 | 现象 |
|------|------|
| 数据目录不存在 | `loadCache` 返回 `null` |
| cache.json 被截断（JSON 坏） | `loadCache` 返回 `null` |
| cache.json 是合法 JSON 但结构不对（`{"hello":"world"}`） | `loadCache` 返回 `null` |
| 面板拿到 `null` 缓存 | `ok:true`、`count:0`、所有计数为 0 —— **不报错** |

四种情况被折叠成同一个 `null`，面板于是显示"还没有数据"，`/ccf status` 也说"还没有缓存，先跑 sync"。可磁盘上那份文件还在，里面原本有 400 多个会——用户看到的是"我的数据没了"，而不是"这个文件读不出来了"。

### 28.1 N63：把"读不出来"和"没有"分开

- `lib/sync.js` 新增 `inspectCache(dataDir)` → `{ state: 'ok' | 'missing' | 'corrupt' | 'unreadable', cache, file, error }`；`loadCache` 改成取 `.cache`（老调用语义不变）。
- `lib/create.js` 的 `currentCache` 同步记录 `state/error`，新增 `cacheStatus()`；`/ccf status` 在 `corrupt` 时返回**错误**（不是"还没有缓存"）：
  > 缓存文件读不出来：JSON 解析失败：Expected ',' or '}' …  
  > 文件：C:\Users\…\.dsh\ccf\cache.json  
  > 原文件没有被动过，可以先备份再跑 /ccf sync 重建（重建会覆盖它），或手动修好 JSON 后 /ccf status 再看。
- 工具与命令的空数据分支不再一律说"还没有数据"，而是先问缓存状态（`cacheHint()`）：坏 JSON → 给文件路径与"先备份再 sync"；打不开 → 指向权限/`dataDir`。
- `lib/ui.js` 的 `panelPayload` meta 新增 `cacheState / cacheError / cachePath`；客户端顶部告警优先说缓存：
  > ⚠ 缓存文件读不出来（JSON 解析失败：…）：点「同步」重建；原文件仍在 C:\Users\…\cache.json
- 文案里**不写"数据已丢失"**：文件没被覆盖，这话不能说重；只写"读不出来、原文件还在"。

### 28.2 验证（0.27.0）

- `test/sync.test.mjs`：`inspectCache` 四态（missing / 坏 JSON / 结构不对 / ok），并确认 `loadCache` 对不存在目录仍返回 `null`。
- `test/ui.test.mjs`：`panelPayload(null, { cacheStatus: { state:'corrupt', error, path } })` → `meta.cacheState==='corrupt'`、`cacheError` 带 JSON、`cachePath` 以 `cache.json` 结尾。
- `test/plugin.test.mjs`：缓存是坏 JSON 时 `/ccf status` 返回 `kind:'error'`，文本含"缓存文件读不出来"与路径，且**不含**"还没有缓存"。
- `test/panel.render.test.mjs`：真渲染 + 坏缓存 meta → 面板正文出现"缓存文件读不出来"和"重建"（而不是一张空表）。
- 全量：yaml 5 / core 23 / sync 7 / catalog 11 / miner / plugin 16 / ui 21 / client 36 / `SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。

### 29.4 N66：数据目录指到一个文件时，原来的诊断是误诊

`dataDir` 指向一个普通文件时，`statSync` 成功、`readFileSync` 读到的是那个文件的内容，于是 JSON 解析失败 → 面板/`status` 报"缓存文件读不出来（JSON 解析失败）"。真正的问题是**数据目录配错了**，说成 JSON 坏了会把人带去修 JSON。

修法：`create.js` 新增 `dataDirProblem()`（`statSync(dataDir)`，存在但不是目录 → "数据目录 X 不是一个目录（它是一个文件）"；`ENOENT` → 没问题；其它 IO 错 → 权限提示），`/ccf status` 在报缓存之前先报这个；`/ccf config` 的数据目录行带上"（有问题：…）"。

验证：`/ccf status`（`dataDir` = 一个文件）返回 `kind:'error'` 且含"不是一个目录"、**不含**"JSON 解析失败"；`/ccf config` 含"有问题"。

**仍未做**：
1. 真实环境回归（桌面端仍未重启，活体 `version` 为空）；
2. 真实模型跑一次补数据验收（P0-3 回执）；
3. 补数据任务队列视图；
4. 数据目录只读在 Windows 上没法用 `chmod` 复现，这条要靠 `dataDir` 指向一个普通文件来测（本轮只做了 `unreadable` 分支的代码路径，未做端到端）；
5. 同步写盘失败（磁盘满/权限）目前会让 `/ccf sync` 抛错——还没包成"人话"。

## 29. 第 25–26 轮评审（0.28.0 → 0.29.0）——写不进去和"我人在国外"

继续"换一台电脑"这条线，收了两个：

### 29.1 N64：缓存写不进去时，抛的是 `EEXIST: file already exists, mkdir …`

把 `dataDir` 指到一个普通文件（常见的误配：手滑把目录名写成文件名、或者从别处拷来一个同名文件），`/ccf sync` 与补数据都会直接抛 Node 的原始错误：

> Error [ERR_MODULE_NOT_FOUND]… / EEXIST: file already exists, mkdir 'C:\…\not-a-dir'

读者既不知道"同步成功没成功"，也不知道该怎么办。更糟的是补数据路径：模型已经花了几十秒跑完，最后写盘失败，用户看到一条红色堆栈。

修法：

- `lib/sync.js` 新增 `describeWriteFailure(error, dataDir)`，把 `EEXIST/ENOTDIR`（数据目录不是目录）、`EACCES/EPERM`（没有权限）、`ENOSPC`（磁盘满）翻成人话，其它错误兜底也带文件路径；所有分支都强调"旧缓存没有被改动"。
- `syncSources` 把 `saveCache` 包进 try/catch：写失败时返回 `{ ok:false, saveError, report }`，**保留旧缓存**，并把 `cache` 记进 `reports`（面板的源健康会显示"没拉到"），不再假装同步成功。
- `create.js` 补数据路径的 `saveCache` 也包了一层：抛出的错误变成 `describeWriteFailure` 的句子，`ccf_update` / 面板看到的是"缓存写不进去：…"，而不是 `EEXIST`。

验证：`syncSources({ sources: [], dataDir: <一个普通文件> })` → `ok:false`、`saveError` 含"不是一个目录"、`report` 含"缓存写不进去"和"旧缓存没有被改动"；`/ccf sync` 在同场景返回 `kind:'error'` 且同样带原因。

### 29.2 N65：换台电脑，时间还是北京时间

插件默认 `timezone: 'Asia/Shanghai'` 写死。人到了国外，面板每行时间都是北京时间，底部那行小字"时间按 Asia/Shanghai 显示"虽然诚实，但等于让用户自己换算——而这个插件本来就是"抬头一眼看截稿"。

修法：默认值改成**这台机器自己的时区**（`lib/core.js` 新增 `systemTimeZone(fallback)`，用 `Intl.DateTimeFormat().resolvedOptions().timeZone`，拿不到时才回退 `Asia/Shanghai`）；显式配了 `timezone` 的仍然以配置为准。`/ccf config` 会把自己实际用的时区打出来。

### 29.3 验证（0.28.0 / 0.29.0）

- `test/sync.test.mjs`：写失败用例（`ok:false` / "不是一个目录" / "旧缓存没有被改动"）。
- `test/plugin.test.mjs`：`/ccf sync` 在写失败目录上回 `kind:'error'` 并带原因；`/ccf config` 用的是本机时区。
- `test/core.test.mjs`：`systemTimeZone()` 与本机 `Intl` 一致、拿不到时回退。
- 全量：yaml 5 / core 24 / sync 8 / catalog 11 / miner / plugin 18 / ui 21 / client 36 / `SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。

**仍未做**：
1. 真实环境回归（桌面端仍未重启，活体 `version` 为空）；
2. 真实模型跑一次补数据验收（P0-3 回执）；
3. 补数据任务队列视图；
4. 只读**文件**（不是目录）上的 `unreadable` 分支仍无端到端测试；
5. 同步成功但某个源持续失败时，面板只在源健康里说明，还没有"连续失败 N 次就降级/提醒"的策略。

## 30. 第 26 轮评审（0.30.0）——两个窗口一起用

这一轮站在**同一台机器开着两个 DSH 窗口**的人的位置：一个窗口在补数据（几十秒到几分钟），另一个窗口顺手 `/ccf sync` 一下，或者也点一下「补数据」。

### 30.1 N67：补数据会把别人刚同步到的会写没

`lib/miner.js` 的 `runUpdate` 用**开跑时**那份 `records` 快照算出 `finalRecords` 再写盘。中间另一个窗口同步到了新会（例如刚开完的 KDD），这些会不在快照里，于是补数据一写完 —— 新会没了。用户视角：同步成功提示刚出现，刷新一看少了几个会。

修法（`lib/core.js` + `lib/create.js`）：

- 新增 `mergeKeepingNewlyAdded(next, latest)`：以 `next` 为准，把 `latest` 里 `next` 没有的 `key` 补到末尾；没有增量时原样返回同一个数组（不做无谓拷贝）。
- 补数据的 `saveCache` 包装里先 `loadCache(dataDir)`，用上面的函数并入"别的窗口新写的"记录，再落盘；并入时 `logger.info` 记一句"补数据期间缓存多了 N 条（别处刚同步的），已并入"。

### 30.2 N68：两个窗口会一起挖

进程内的 `updateInFlight` 只能拦自己。另一个窗口点「补数据」会同时开跑，各自写缓存、互相覆盖。

修法：`dataDir` 里放 `update.lock`（`{pid, at}`）：

- 拿到锁才跑；`EEXIST` 且锁龄 < 10 分钟 → 直接回 busy：`另一个窗口的补数据还在跑（已 N 秒），等它结束再点。锁文件：…`
- 超过 10 分钟的锁当成失效（进程被强杀/断电），直接接管，不能把功能永久卡死。
- 释放时只删 `pid === process.pid` 的锁，绝不误删别人的。
- 锁文件本身写不了（目录是文件、没权限）时**不拦**补数据，让它去撞真正的写盘错误——锁不该成为新的故障点。

### 30.3 顺带修掉的一个同步竞态

两次点击可能都在拿到锁之前通过了 `updateInFlight` 检查（`acquireUpdateLock` 是异步的）。加了同步标记 `updateStarting`，从进门到 `updateInFlight` 赋值之间也挡住，第二次点击立刻回 busy。

### 30.4 验证（0.30.0）

- `test/core.test.mjs`：`mergeKeepingNewlyAdded` 保留自己的记录、补上别处的会、无增量时返回同一数组、`next` 为空时全保。
- `test/plugin.test.mjs`：手写一个新鲜锁文件 → `doUpdate` 回 `busy:true` 且提示"还在跑"，并且**别人的锁文件原样留着**；一小时前的旧锁 → 能接管、正常跑完。
- 全量：yaml 5 / core 25 / sync 8 / catalog 11 / miner / plugin 21 / ui 21 / client 36 / `SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。

**仍未做**：
1. 真实环境回归（桌面端仍未重启，活体 `version` 为空）；
2. 真实模型跑一次补数据验收（P0-3 回执）；
3. 补数据任务队列视图；
4. 源连续失败 N 次是否降级/提醒；
5. 锁文件的"同机不同用户"场景（`dataDir` 一般在自己家目录下，暂不处理）。

## 31. 第 27 轮评审（0.31.0）——换一台电脑打开它

前 30 节都在"同一台机器 + 同一份缓存"里看问题。这轮把场景换成**换环境**：别人的电脑、被手改过的文件、别的工具写进去的时间戳。

### 31.1 名单文件读不出来时，它在装作"名单里没有会"

`catalogPath` 指错、名单 JSON 被截断、缺 `areas` 字段——这三种情况以前在 `loadCatalog` 里被折叠成一个 `null`，然后：

- `/ccf status` 印 `名单：未找到 data/ccf-catalog.json`（哪怕配置指的是别的路径）；
- `/ccf update` 回"没有 CCF 名单文件，无法按名单挖掘"（不说清是哪个文件、坏在哪）；
- 面板显示「名单 0 个」「待补 0」，看起来像是"这个插件本来就没覆盖几个会"。

**修法**：`lib/catalog.js` 新增 `inspectCatalog(file)`，返回 `state: 'ok' | 'missing' | 'corrupt' | 'unreadable'` + `path` + `error`（`loadCatalog` 仍是老语义：读不到给 `null`）。`createCcf` 把它变成一句 `catalogLine()`：

- ok → `362 个 CCF 会议（…抓取于 …）`
- missing → `没找到名单文件 <绝对路径>（插件自带 data/ccf-catalog.json；可以设 catalogPath 指到你自己的名单）`
- corrupt → `名单文件 <绝对路径> 读不出来（JSON 解析失败：…）：面板只能列 CCFDDL 收过的会，「待补」也数不出来。…`

面板侧通过 `meta.catalogState` 拿到同一状态，顶部红字提示；`/ccf status` 与 `/ccf update` 都用同一句话，不会一处说"没找到"、一处说"没有数据"。

**顺带修的一处**：`/ccf status` 在"还没有缓存"分支直接 return 了，名单好坏根本印不出来——现在那三行里也有名单状态。

### 31.2 缓存里的时间写成字符串，就变成空白

`formatInZone` 只认 `Number.isFinite(instant)`。如果 `updatedAt` 是 ISO 字符串（手改、旧版本写的、或别的脚本写的），结果是空字符串，句子成了 `数据时间 （前）`、`数据同步于 （前）`。

**修法**：`lib/core.js` 新增 `toInstant(value)`（`Date` / 数字 / ISO 字符串 → 毫秒，其他 → `null`），`formatInZone` 与 `formatInZoneSafe` 首行统一走它；`/ccf status` 与 `/ccf list` 计算"多久以前"也改用 `toInstant`。

### 31.3 几件事同时坏的时候，别让后一条盖掉前一条

名单坏了、缓存也坏了、还有个源没拉到时，面板状态行原来只显示第一条命中的告警（`catalogAlert || cacheAlert || sourcesWarning`）。现在改成**收集 + `；` 连接**，三条一起出现：

> ⚠ CCF 名单文件读不出来：… ； 缓存文件读不出来（…）：点「同步」重建 … ； 1/2 个源没拉到（paper-deadlines） · 2026-11-01 03:12 更新 · 当前 40 条

同时状态行不再是"有告警就不显示状态"，而是 `⚠ 告警 · 正常状态文字`——告警和"现在看到的是哪一屏"两件事都要在。

### 31.4 验证

- 新用例：`catalog.test` 的 `inspectCatalog` 三态（ok / missing / corrupt，含"缺 areas 也算 corrupt"）、`core.test` 的 `toInstant` 接受 ISO 字符串（含 `formatInZone(iso)` 不再为空）、`plugin.test` 的「名单文件缺失/坏掉时，status 与 update 都要说出来」（断言不再出现"名单：未找到"）、`ui.test` 的 `meta.catalogState`、`panel.render` 的「名单坏了要在面板上说」。
- 全量：`yaml 5 / core 26 / sync 8 / catalog 11 / miner / plugin 22 / ui 22 / client 36 / SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。
- 真实环境复核（`mkdtemp` + 真 `defineTool`）：名单缺失 → `名单：没找到名单文件 …nope.json…`；名单截断 → `名单：名单文件 …bad.json 读不出来（JSON 解析失败：Unterminated string in JSON at position 49…）`；缓存 `updatedAt` 写成 ISO → `数据时间 2026-11-01 02:18（1 小时前）`。

### 31.5 仍未做

1. 真实环境回归——桌面端一直没重启，活体 `/dsh-ccf/api/v1/records` 的 `version` 仍是空，这一项从 0.22.0 挂到现在；
2. 真实模型跑一次「补数据」，核对回执文案与失败原因（P0-3）；
3. 源连续失败 N 次要不要降级/升级提醒（现在只是每次说出来）；
4. 名单文件自带版本的"自动更新名单"（现在是同步数据，不换名单）。

## 32. 第 28 轮评审（0.32.0）——它给模型的"事实"里有假数字

这轮盯的是**插件对外说的话准不准**：一处说给模型（系统提示里的会议摘要），一处说给用户（模型挖到的日期从哪来）。

### 32.1 系统提示把"只列了 8 条"说成"一共 8 个"

本轮实测（真实缓存 404 条）：

- 30 天内实际有 **34** 个截稿；
- 但系统提示写的是 `数据同步于 2026-11-01 01:07，未来 30 天内有 8 个：`，然后列 8 条。

原因是 `promptText()` 用 `queryDeadlines(..., limit: maxPromptItems)`，然后拿 `rows.length` 当总数。模型读到的是一句**看起来很确定的事实**，于是很自然地对用户说"最近 30 天只有 8 个会截稿"——和上一轮 `ccf_deadlines` 的 N62 是同一个病，但这次长在 prompt 里，影响更坏（工具返回至少还有 `data.matched` 可查，prompt 没有）。

**修法**：`promptText()` 改用 `queryDeadlinesWithMeta()`，按 `matched` 与 `rows.length` 分两种句式：

- 没截断：`未来 30 天内有 34 个：`
- 被截断：`未来 30 天内有共 34 个截稿，这里按最近排序列出前 8 个：`

### 32.2 模型挖到的日期，没有"出处"

`/ccf venue CVPR` 里，模型挖到的记录只写 `模型挖掘 · 时间`；用户想核对"它到底看的是哪个页面"时无路可走。而 `mineVenue()` 明明抓过页面（`pages` 数组），只是用完就丢了。

**修法**：
- `lib/miner.js` 的 `mineVenue()` 把抓到的页面写进记录：`record.minedFrom = pages.map(p => p.url)`，返回值的 `pages` 也用同一份；
- `lib/core.js` 的 `formatVenue()` 在 `source === 'model'` 且 `minedFrom` 非空时多一行 `挖自：https://… ； https://…`（最多两条）；
- `lib/ui.js` 的 `panelPayload` 投影 `minedFrom`（最多 3 条），面板展开详情多一行「挖自」，与「重挖这个会」挨着——"不信它 → 点开看它读了什么 → 不对就重挖"。

权威源（`ccfddl-api`）的记录不会出现这行：不要把名册数据说成"模型挖的"。

### 32.3 验证

- 新用例：`core.test` 的「prompt 注入遵守条数上限」补两条断言（含 `共 5 个截稿`、`列出前 3 个`）；新增「模型挖到的记录在详情里写清出处」（模型源有 `挖自：`，CCFDDL 源没有）；`miner.test` 断言 `mined.record.minedFrom[0] === mined.pages[0]` 且是 http(s) 链接；`ui.test` 断言 `panelPayload` 原样带出 `minedFrom`；`panel.render` 在展开 ICLR（模型源）后断言页面出现「挖自」。
- 全量：`yaml 5 / core 27 / sync 8 / catalog 11 / miner / plugin 22 / ui 23 / client 36 / SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。
- 真机核对：`promptText()` 现在首行是 `未来 30 天内共 34 个截稿，这里按最近排序列出前 8 个：`（原来写"有 8 个"）。

### 32.4 仍未做

1. **真实环境回归**（桌面端一直没重启，活体 `version` 仍为空）——已连续 7 轮挂在第一位；
2. 真实模型跑一次「补数据」核对回执（P0-3）；
3. 系统提示的成本：650 字符 ≈ 325 token/轮，目前每轮都注入；是否改成"只在有 7 天内截稿时注入"值得下一轮量化；
4. 挖到的出处只记 URL 不记"哪句话"——要不要把模型引用的原句也存下来（会显著变长，未做）。

## 33. 第 29 轮评审（0.33.0）——三个会在拿别人的数据充数

这轮盯**名单与数据的自洽**：把 CCF 名单里 362 个会按简称排一遍，看有没有"一个简称两个会"。

### 33.1 名单里 `FSE` 有两个

官方名单里 `fse` 同时是：

- 网络与信息安全 · **CCF-B** · Fast Software Encryption（IACR 的对称密码会）
- 软件工程/系统软件/程序设计语言 · **CCF-A** · ACM International Conference on the Foundations of Software Engineering

而覆盖度只按简称匹配（`matchVenue`），于是缓存里那一条 `FSE 2027`（安全那个会）**同时把两个会都算成"有数据"**。后果：

- 面板说「有数据 112」，其中软工 FSE 是假的；
- 软工 FSE 永远不进「待补」，`/ccf list --pending --area 软件工程` 不会提示补它；
- `/ccf venue FSE` 只显示安全那个（CCF-B），读者会以为 FSE 就是 CCF-B。

顺着这条线查下去，一共 **3 个会**在拿别人的数据充数：

| 被充数的会 | 数据其实是谁的 | 原因 |
|-----------|---------------|------|
| `FSE@软件工程`（CCF-A） | FSE（安全，CCF-B） | 简称完全相同 |
| `SEC@网络与信息安全`（CCF-C，IFIP 信息安全会） | USENIX Security | `VENUE_ALIASES` 里 `security → sec` 把"security"这个词太当回事 |
| `MMAsia@计算机图形学与多媒体`（CCF-C） | ACM MM | `SATELLITE_SUFFIXES` 的 `asia` 规则把 `mm` 当成 `mmasia` 的主会 |

### 33.2 修法：一条记录只归一个会

`lib/catalog.js` 新增 `pickByFullName(row, candidates)`：简称匹配出多个候选时，用记录的 `fullName` 与名单 `fullName` 比相似度（完全相同 100、互相包含 50、否则英文词重叠计分）挑最像的那个。

`catalogCoverage` 改成**先给每条记录找唯一归属**，再按归属统计：

```js
const candidates = conferences.filter((conference) => matchVenue(name, conference))
const owner = candidates.length === 1 ? candidates[0] : pickByFullName(row, candidates)
owned.get(owner).push(row)     // 未匹配 → 名单外
```

账目变化（真实缓存 404 条）：`future 112 → 109`、`never 49 → 52`、`pending 250 → 253`，`future + pending = 362` 仍成立；`outside` 仍是 68。

`/ccf venue` 也补一句，当名单里有多个同简称的会：

> 名单说明：名单里有 2 个简称都是「FSE」的会，数据里这条更接近 CCF-B（网络与信息安全）；另一个是 CCF-A（软件工程/系统软件/程序设计语言）ACM International Conference on the Foundations of Software Engineering。

### 33.3 验证

- 新用例：`catalog.test` 的「名单里同简称的两个会」——两个 `FSE` + `ACM MM`/`MMAsia`，断言只有 2 个会算"有数据"、另 2 个仍是待补、`pickByFullName` 挑中安全那个；`plugin.test` 的 FSE 双会用例（报告含「2 个简称都是「FSE」的会」「更接近 CCF-B」「CCF-A」）。
- 全量：`yaml 5 / core 27 / sync 8 / catalog 11 / miner / plugin 22 / ui 23 / client 36 / SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。

### 33.4 仍未做

1. **真实环境回归**（桌面端始终没重启，活体 `version` 一直为空）——从 0.22.0 挂到现在；
2. 真实模型跑一次「补数据」核对回执（P0-3）；
3. 系统提示 325 token/轮 是否按窗口收敛；
4. `VENUE_ALIASES` 里 `security → sec` 这条别名现在退化成"只在单候选时才生效"，但语义仍偏松，下一轮打算按"记录 fullName 里有没有 security 全称"再做一层确认；
5. 名单里 `MMAsia` 这类卫星会与主会的关系目前靠后缀表，长期应该由数据源给出 `parent` 字段。

## 34. 第 30 轮评审（0.34.0）——简称撞车时，它宁可认错也不认空

上一轮把"一条记录只归一个会"做出来了，但归属规则只看全称像不像，**看不出来"完全不像"**：评分都是 0 时它仍然挑了第一个候选。这一轮把这条补上。

### 34.1 实测：边缘计算那个 SEC 被算成了 USENIX Security

缓存里有一条 `SEC 2026 · ACM/IEEE Symposium on Edge Computing`（边缘计算会，不在 CCF 名单里）。名单里叫 `SEC` 的是 IFIP 信息安全会，而 `USENIX Security` 也在名单里。简称 `SEC` 同时匹配这两个，全称比对时：

- 与 `IFIP International Information Security Conference`：共同词 0；
- 与 `USENIX Security Symposium`：共同词 `symposium`（每个会名里都有）→ 得分 1 → **赢了**。

于是"边缘计算"的数据被算给了 USENIX Security，`有数据 109` 里又混进一个假数。

### 34.2 修法：全称一个"有区分度的词"都对不上，就不认领

`lib/catalog.js`：

- 新增 `GENERIC_WORDS`（on / of / conference / symposium / international / ieee / acm / usenix …共 20 多个"每个会名都有"的词）与 `wordsOf()`；
- `pickByFullName()` 打分改为：全称完全相同 100、互相包含 50、否则**只按有区分度的词重合计分**（每词 10）；全部为 0 时返回 `null`；
- `catalogCoverage()` 遇到 `null` 归属 → 记入 `unmatched`（= 名单外）。

效果（真实缓存 404 条）：`outside 68 → 69`（那个边缘计算 SEC 现在如实算"名单外"），`future/past/never` 不变（109 / 201 / 52），两个 `SEC` 条目都仍在「待补」。

### 34.3 顺手加固的注册表

- `SATELLITE_SUFFIXES` 规则（`CVPR Workshops` 算 CVPR）要求**主会名至少 4 个字母**，否则 `MM` 会被当成 `MMAsia` 的主会（`mm` + `asia`）。现在 `ITC`/`ITC-Asia`、`ACM MM`/`MMAsia` 这类两三个字母的会不再互相吸附。
- `ccf_venue` 的同简称说明里 `pickByFullName(...)` 可能返回 `null`，已改成 `?? listed`，不会因为"认不出来"而抛错。

### 34.4 验证

- 新用例：`catalog.test` 的「简称撞车但全称毫无关系」——边缘计算 `SEC` 记录：`future 0 / outside 1 / never 2`；真的 `USENIX Security` 记录：`future 1` 且归给 `USENIX Security`（不是 `SEC`）。
- 全量：`yaml 5 / core 27 / sync 8 / catalog 11 / miner / plugin 22 / ui 23 / client 36 / SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。

### 34.5 仍未做

1. **真实环境回归**（桌面端始终没重启，活体 `version` 一直为空）——从 0.22.0 挂到现在，仍是最该做的一件事；
2. 真实模型跑一次「补数据」核对回执（P0-3）；
3. 系统提示 325 token/轮 是否按窗口收敛；
4. 名单里卫星会与主会的关系（`ITC-Asia`、`MMAsia`、`UbiComp/ISWC`）目前靠后缀表 + 全称比对，长期应由数据源提供 `parent` 字段；
5. `VENUE_ALIASES` 里 `security → sec` 现在只在"单候选"时生效，语义仍偏松，下一步考虑删掉它并让 USENIX Security 只靠全称对齐。

## 35. 第 31 轮评审（0.35.0）——每轮都在花的那 325 个 token

前几轮都在修"说得对不对"，这轮回到 32.4 里自己留下的问题：**系统提示每轮都注入，成本是多少、值不值**。

### 35.1 计量

真实缓存（404 条）下 `promptText()` 输出 650 字符 ≈ **325 token**，其中 8 条会议各约 75 字符；而这 8 条只是"30 天内 34 个"里的前 8 个。

两个问题叠在一起：

1. **贵**：每一轮对话都花掉 325 token 买一段"最近的会议"，其中 5 条基本没用（人不会为第 6 个会改主意）；
2. **假**：它写「未来 30 天内有 8 个」——8 是"列了几条"，不是"有几个"（这条 0.32.0 修了总数，但条数仍由 `maxPromptItems` 决定）。

### 35.2 决策：默认 3 条，总数照实说

`DEFAULTS.maxPromptItems` 从 **8 → 3**，配合 0.32.0 的 `matched` 总数，注入变成：

```
## 会议截稿（dsh-ccf）
数据同步于 2026-11-01 01:07，未来 30 天内共 34 个截稿，这里按最近排序列出前 3 个：
- VLDB 2027 · CCF-A · 数据库/数据挖掘/内容检索 · 2026-11-02 09:00（1 天 4 小时后）
- CVC 2027 · Non-CCF · 人工智能 · 2026-11-02 19:59（1 天 15 小时后）
- SAI 2027 · Non-CCF · 交叉/综合/新兴 · 2026-11-02 19:59（1 天 15 小时后）
需要更远的窗口或按等级/方向筛选时，调用 `ccf_deadlines`（days/rank/area/search）。…
```

实测 **650 → 342 字符（约 325 → 171 token/轮）**，且第一句就把"还有 31 个没列"说清楚；想看全部仍然一条工具调用的事。

### 35.3 顺带：删掉 `security → sec` 那条别名

`VENUE_ALIASES` 里 `security: 'sec'` 本意是让"USENIX Security"对上名单，但 USENIX Security 在名单里**有自己的条目**，而 `SEC` 是 IFIP 的信息安全会。这条别名只会把两个会搅在一起（33/34 节反复踩）。删除后：

- `USENIX Security` 记录仍能靠"同简称"匹配它自己的条目（`coreName` 两边都归一成 `security`）；
- `SEC` 不再被 USENIX Security 的记录认领。
- 单测里那条"USENIX Security 应等于 SEC"的断言同步改成 false，并注明原因。

### 35.4 顺带：把"认领得可疑"变成提示而不是拒绝

34 节把"全称 0 分"判成名单外，实测发现**11 条里 10 条是真数据**（名单全称措辞不同：`ACM SIGGRAPH Annual Conference` vs `ACM Special Interest Group on Computer Graphics`、`SIGMOD` 的 `ACM Conference on Management of Data`、名单里 `onBiometrics` 连写导致词被粘连等）。

所以改成：

- **只有一个候选** → 照收（否则会误伤真数据），但 `fullNameScore === 0` 时记一条 `weakMatches`；
- **多个候选** → 仍按 34 节规则，0 分不认领、算名单外。

面板上这类记录展开会多一行「建议核对：这条记录的全称和名单里同名会不一致，可能是另一个会（同简称）」；`/ccf status` 多一行「待核对：11 条记录的全称与名单对不上…」。真实数据：`future 109 / past 202 / never 51 / outside 68 / weakMatches 11`，`future+pending=362` 仍成立。

### 35.5 验证

- 新用例：`core.test` 的「prompt 默认只列 3 条」——10 个未来会议下只出 3 条 bullet、含 `共 10 个截稿`、整段 < 500 字符；`catalog.test` 的边缘计算 SEC 改为断言 `weakMatches=1`；`ui.test` 的 `panelPayload` 断言记录带 `weakMatch: true`；`panel.render` 覆盖「建议核对」行与既有交互。
- 全量：`yaml 5 / core 28 / sync 8 / catalog 11 / miner / plugin 22 / ui 24 / client 36 / SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。

### 35.6 仍未做

1. **真实环境回归**（桌面端始终没重启，活体 `version` 仍为空）——最该做的一件事，已挂 8 轮；
2. 真实模型跑一次「补数据」核对回执（P0-3）；
3. 注入策略再进一步：只在"7 天内有截稿 或 用户问到会议"时注入（现在是常态注入 3 条），需要先有"用户问到会议"的判定信号；
4. `weakMatches` 的 11 条里，工具侧还没有「标记这条是别的会」的按钮（面板只提示），下一步考虑给 `/ccf prefer` 之外加 `/ccf ignore <key>`。

## 36. 第 32 轮评审（0.36.0）——"没有急事"就别占三行

上一轮把注入从 8 条压到 3 条（650 → 342 字符）。这轮问下一层：**"3 条"对谁最有价值？** 答案是"7 天内有要交的东西"的时候；如果最近的会在 40 天后，那三条列表照样每轮占 342 字符，信息量却只有"最近是哪个"。

### 36.1 退化形态：一行摘要

新增 `DEFAULTS.promptSoonDays = 7`（可配）。`promptText()` 先按 `leadDays` 取窗口内的前 `maxPromptItems` 条，再看其中有没有落在这 7 天里的：

- **有** → 照常列条目（这几条真的可能改变你的决定）；
- **没有** → 只写一行：

```
## 会议截稿（dsh-ccf）
未来 200 天内共 78 个截稿，7 天内没有要交的；最近：PODS 2027（CCF-B） 2026-12-11 19:59（40 天 15 小时后）。查全部用 `ccf_deadlines`。
```

实测：**116 字符 ≈ 58 token**（对比全列表 342 字符 ≈ 171 token、旧版 650 字符 ≈ 325 token）。模型仍然知道"有这件事、共几个、最近是谁"，只是不再替它把三条列表念一遍。

### 36.2 一行摘要也要说人话

第一版摘要里用的是 `first.venue`（`CVPR`），结果摘要变成"最近：CVPR 2026-11-14"——**年份丢了**，跟旧测试的期望也对不上。改成 `first.name || first.venue`（`CVPR 2027`）并补上 `（CCF-A）`，一行里"哪个会、什么等级、什么时候、还有多久"都在。

### 36.3 为什么会动到别的测试

`prompt 注入遵守条数上限` 与 `prompt 默认只列 3 条` 两个旧用例的夹具把截稿放在 10–19 天后——正好落进新的"7 天内没有"分支，于是 bullet 数变 0。两处都显式传 `promptSoonDays: 60`，语义变成"窗口足够大时仍受条数上限约束"，这才是这两个用例本来要测的东西。

### 36.4 验证

- 新用例：`core.test` 的「近期没有截稿时，注入退化成一行」——两条 12 月的会 → 输出恰好 2 行、含 `共 2 个截稿`、不含 `- ` 条目、整段 < 200 字符；再给一条 3 天后的会 → 恢复逐条列出。
- 全量：`yaml 5 / core 29 / sync 8 / catalog 11 / miner / plugin 22 / ui 24 / client 36 / SMOKE OK`；`PANEL RENDER OK`；`INTEGRATION OK`。

### 36.5 仍未做

1. **真实环境回归**（桌面端始终没重启，活体 `version` 仍为空）——已挂 9 轮；
2. 真实模型跑一次「补数据」核对回执（P0-3）；
3. `weakMatches` 那 11 条还没有「这条是别的会」的手动出口（计划 `/ccf ignore <key>`，让覆盖度把它算成名单外）；
4. `promptSoonDays` 还没在 `/ccf config` 里显示，也没进 README 配置表——下一步补；
5. 注入策略的终局可能是"用户问到会议时才注入"，但那需要判定信号，暂不做。

## 37. 第 33 轮评审（0.37.0）——"这条不是那个会"，以及它牵出的两个口径漏洞

这一轮的问法来自 0.35.0 留下的那 11 条 `weakMatches`：面板会说"这条建议核对"，然后呢？用户核对完（"SEC 那条其实是 IFIP 的会，不是 USENIX Security"）却没有任何办法把这个判断**告诉插件**——下次打开还是一样的数字。

所以这一轮加了一个动作和一个状态：

- `/ccf ignore <会议名或 key>`：把某条记录标成「不是这个会」。它从此不喂任何名单里的会，算进「名单外」，也不再占用「待补」的名额；`--undo` 撤销。
- 面板上这类卡片标「已标记」，并与「待补」「名单外」的计数对齐。

### 37.1 N80：一次同步就把用户的选择冲掉了（真数据丢失）

`lib/sync.js` 的 `syncSources` 成功分支原来这样写缓存：

```js
? { schema: CACHE_SCHEMA, updatedAt: now, reports, records: merged }
```

`previous.meta` 被整个丢掉。也就是说 0.14.0 做的「采信按会议系列记住」（`meta.preferredByVenue`）和自动更新的 `lastAutoUpdateAt`，**每点一次「同步」就清空一次**。用户会看到"我明明设过，怎么又变回默认来源了"——而且它不会报错。

修法是"同步只该换数据，不该动用户的选择"：

```js
? {
    schema: CACHE_SCHEMA,
    updatedAt: now,
    reports,
    records: merged,
    ...(previous?.meta && typeof previous.meta === 'object' ? { meta: previous.meta } : {}),
  }
```

新增用例 `test/sync.test.mjs`「同步不能把用户的选择冲掉（meta 要跟着数据一起留）」：先写一份带 `meta.preferredByVenue` / `meta.lastAutoUpdateAt` 的缓存，跑一次真同步，断言两者都还在、数据也换成了新的。

### 37.2 N81：`/ccf ignore` 在命令行做完，面板变了、命令行的数字没变

标完之后再跑 `/ccf status`，覆盖数字**一位都没动**（还是 109 / 253 / 68）。原因是 `ignoredKeys` 只传给了面板那条路：

| 调用点 | 位置 | 有没有传 ignoredKeys |
|--------|------|----------------------|
| 面板 `panelPayload` | `lib/ui.js` | 有 |
| `ccf_venue` 工具 | `lib/create.js` 的 venueTool | 漏 |
| `buildList`（`/ccf list`） | 同上 | 漏 |
| `/ccf status` | 同上 | 漏 |

修法是加一个统一的读取函数，四处共用：

```js
const ignoredKeysOf = (cache) => new Set((cache?.meta?.ignoredKeys ?? []).filter(Boolean))
```

这正是 0.6.0 的 N12（"status 说 56、面板说 250"）的同类问题：**同一个事实在两处各算一遍，就一定有一天会对不上**。真数据复核：标掉 `USENIX Security` 之后 `future 109 → 108`、`pending 253 → 254`、`outside 68 → 69`，撤销后回到 109 / 253 / 68。

### 37.3 N82：文档里写着的 `/ccf pending`，其实从来没实现

真机跑 `/ccf pending --area 人工智能`，回的是 `未知子命令 "pending"`——而 `USAGE` 里从 0.6.0 起就写着这一行。修法不是"把文档删掉"，而是把它做成真别名：

```js
const [rawSub, ...rest] = raw.split(/\s+/).filter(Boolean)
const sub = rawSub === 'pending' ? 'list' : rawSub
if (rawSub === 'pending') rest.push('--pending')
```

新增用例 `test/plugin.test.mjs`「/ccf pending 是 list --pending 的别名」：两种写法第一行必须一致。教训是：**文档里承诺的命令，要么实现，要么删掉**——留着比没有更坏，因为用户会照着试。

### 37.4 验证

- `npm test`：yaml 5 / core 29 / sync 9 / catalog 11 / plugin **24** / ui **25** / client 36 / `SMOKE OK`；`test/panel.render.test.mjs` → `PANEL RENDER OK`；`test/integration.test.mjs` → `INTEGRATION OK`。
- 真数据（`C:/Users/15961/.dsh/ccf/cache.json` 的副本）：`ignore USENIX Security` → `future 108 / pending 254 / outside 69`，`--undo` 回到 `109 / 253 / 68`；`/ccf pending --area 人工智能` 返回 21 个待补会（AAAI、NeurIPS…）。
- 新增 `meta.ignoredKeys` 字段：字符串数组，存的是记录的 `key`（`venue|year`）。

### 37.5 仍未做

1. **真实环境回归仍被阻塞**：桌面端自 0.17.x 起就没重启过，活体 `/dsh-ccf/api/v1/records` 的 `version` 一直为空。0.22→0.37 的所有改动都只有单测与探针证据，没有一次在真面板上点过。
2. 「已标记」的卡片目前只能靠 `/ccf ignore --undo` 撤销，面板上没有撤销入口。
3. `weakMatches` 那 11 条里，`SEC`/`FSE` 这类确实需要裁决，但 `CVPR Workshops`、`SIGGRAPH` 这种只是名单措辞不同——应该能"确认它不是问题"，而不是每次都提示。
4. `/ccf config` 还没有输出 `promptSoonDays` 与 `meta.ignoredKeys` 的数量。


## 38. 第 34 轮评审（0.38.0）——「建议核对」之后，用户还需要一个结论

上一轮（0.37.0）给了"不是这个会"的出口，但这轮把它当用户真用一遍，问题立刻出来了：0.35.0 留下的那 11 条 `weakMatches` 里，**10 条其实就是同一个会**（IJCB、Eurographics、SIGGRAPH、SIGMOD、CVPR Workshops…全称措辞不同而已，名单里甚至把 `onBiometrics` 连写成一个词）。用户核对完的结论通常是"**就是它**"，可当时的唯一动作只有"它不是"——**一个只会否定的界面，等于没给人裁决权**。

### 38.1 N83：确认也是一种结论，而且要记得住

- 新增 `meta.confirmedKeys`（记录 key 数组）与 `/ccf confirm <名字或 key> [--undo]`；
- `catalogCoverage` 新增 `options.confirmedKeys`：确认过的记录**照常参与统计**（它就是这个会的数据），只是不再进 `weakMatches`；
- 面板对这三类记录都给出入口：
  - `weakMatch`（还没裁决）→「就是这个会」「不是这个会」两个按钮；
  - `confirmed`（已确认）→「取消确认」；
  - `ignored`（已标记不是）→「撤销「不是这个会」」。
- 面板与服务端共用一条路由 `POST /dsh-ccf/api/v1/confirm`，body 为 `{key, mark: 'confirm'|'ignore', undo}`，`mark` 决定写 `confirmedKeys` 还是 `ignoredKeys`——两个动作对称，撤销都不会删数据。

真数据复核（活缓存副本，11 条 weak）：

```
BEFORE : 待核对：11 条…
WEAK   : IJCB / Eurographics / ACM SIGGRAPH / ACM SIGGRAPH ASIA …
CONFIRM: 已确认 ijcb|2027 就是名单里那个会…
AFTER  : 待核对：10 条…
PANEL  : {"confirmed":true,"weakMatch":false}
UNDO   : 已取消…确认 → BACK: 待核对：11 条
```

### 38.2 顺手修掉的两处"只修了一半"

- **N84**：0.37.0 只给 `/ccf status`、`/ccf list`、`ccf_venue` 传了 `ignoredKeys`，这一轮加 `confirmedKeys` 时**同样三处又漏了一遍**（status 还在报"待核对 1 条"）。现在统一由 `ignoredKeysOf(cache)` / `confirmedKeysOf(cache)` 两个函数供给，四处共用——这类"每加一个 meta 字段就得记得改四处"的结构本身是隐患，已记进"仍未做"。
- **N85**：面板上点按钮不生效也不报错——`Card` 的 props 解构里漏了 `onMark`，点「就是这个会」直接抛 `ReferenceError: onMark is not defined`。**是 `panel.render` 的点击断言把它抓出来的**（手写 PAYLOAD 的渲染测试之前只断言文本，抓不到这种"点了没反应"）。

### 38.3 验证

- `npm test`：yaml 5 / core 29 / sync 9 / catalog 11 / plugin **25** / ui **27** / client 36 / `SMOKE OK`；`test/panel.render.test.mjs` → `PANEL RENDER OK`（含"点「就是这个会」→ 发出 `POST /confirm`，body 带 `"mark":"confirm"`"）；`test/integration.test.mjs` → `INTEGRATION OK`。
- 新增用例：catalog「确认过的记录不再提示核对，但照样算数据」；plugin「/ccf confirm：核对过就不该再提示，撤销能回来」；ui「panelPayload 尊重「就是这个会」」+「POST /confirm 记下核对结论（mark=ignore 走同一条路）」；render「弱匹配卡片给出两个结论按钮，点击真的发请求」。

### 38.4 仍未做

1. **真实环境回归**：桌面端仍未重启（活体 `version` 为空），0.22→0.38 全是单测 + 探针证据。
2. `meta` 字段已经三个（`ignoredKeys`/`confirmedKeys`/`preferredByVenue`），每个都要求"四处都传"——应该收敛成一个 `marksOf(cache)` 统一入口。
3. 撤销入口只在卡片展开后出现，没有一个"我标过哪些"的清单（`/ccf status` 只报数量）。
4. `weakMatches` 里 `CVPR Workshops` 这类其实是"名单里没有 workshop 条目"，也许该单独归为"卫星会"而不是让人逐条确认。


## 39. 第 35 轮评审（0.39.0）——「我标过哪些」，以及为什么总在同一个地方漏

上一轮修完 N84（`confirmedKeys` 又漏传三处）之后，最该问的不是"还漏没漏"，而是**为什么每次都漏在同一个地方**：`meta` 里每加一个字段（`ignoredKeys`、`confirmedKeys`、`preferredByVenue`），就要求在 `status`、`buildList`、`ccf_venue`、面板四处各记得传一次；谁忘了，同一件事就会有两个数（N12 → N81 → N84，已经连着三轮）。

而且站在用户那边还有第二个缺口：他现在能标"不是这个会"、能确认"就是这个会"，然后**没有任何地方能回头看见自己标过什么**——标错了只能靠回忆逐条 `--undo`。

### 39.1 N86：一个入口，取代"每个字段四处传"

`lib/create.js` 里 `ignoredKeysOf` / `confirmedKeysOf` 合并成：

```js
const marksOf = (cache) => ({
  ignoredKeys: new Set((cache?.meta?.ignoredKeys ?? []).filter(Boolean)),
  confirmedKeys: new Set((cache?.meta?.confirmedKeys ?? []).filter(Boolean)),
})
```

五处覆盖度调用全部改成展开这个对象（`catalogCoverage(records, catalog, { now, ...marksOf(cache) })`），`doIgnore` / `doConfirm` 内部那两次"临时算一次覆盖度"也从 `marksOf(cache)` 取另一半，不再自己拼。以后再加一个裁决字段，只需要改这一个地方。

### 39.2 N87：/ccf marks

- 没有任何标记：直接告诉用户去哪里标（面板卡片展开 / `/ccf confirm` / `/ccf ignore`）；
- 有标记：先一行总览，再分两类列出会议名与年份，每类后面跟着撤销命令；
- `--ignored` / `--confirmed` 只看一类；
- `/ccf status` 在计数大于 0 时补一行 `标记：N 个「不是这个会」、M 个「就是这个会」（清单 /ccf marks）`；
- 面板状态行补 `· 已裁决 N`（`meta.marks` 只带两个数字，不为两个计数去读全量记录）。

真数据复核（活缓存副本）：

```
初始      : 还没有任何标记。…命令是 /ccf confirm <名字> 与 /ccf ignore <名字>。
标记之后  : 标记：1 个「不是这个会」，1 个「就是这个会」
            不是这个会（撤销：/ccf ignore <名字> --undo）：
              - SEC 2026
            就是这个会（撤销：/ccf confirm <名字> --undo）：
              - IJCB 2027
status    : 标记：1 个「不是这个会」、1 个「就是这个会」（清单 /ccf marks）
面板      : {"ignored":1,"confirmed":1}
复原后    : 还没有任何标记。
```

### 39.3 验证

- `npm test`：yaml 5 / core 29 / sync 9 / catalog 11 / plugin **27** / ui **28** / client 36 / `SMOKE OK`；`PANEL RENDER OK`。
- 新增用例：plugin「/ccf marks：我做过哪些裁决，一次看清，也能只挑一类」（含 `--confirmed` 过滤与 status 行）、「没有任何标记时给出去哪里标的指引」；ui「meta.marks 告诉面板我裁决过多少条」。

### 39.4 仍未做

1. **真实环境回归仍被阻塞**：桌面端自 0.17.x 起没重启过。这一轮开始的时候，系统提示里仍然打印着 `数据同步于 2026-11-01 01:07，未来 30 天内有 8 个` 和 `名单里还有 56 个会没有截稿时间`——那是 0.2x 时代的文案；0.36.0 之后应该是「共 34 个截稿…前 3 个」，`待补` 也早该是 253 而不是 56。
2. 标记清单只有命令侧，面板上还没有"我标过哪些"的入口（状态行只给数字）。
3. `CVPR Workshops` 这类卫星会仍混在「建议核对」里，应该单独归为"名单未收的卫星会"。
4. `marksOf` 收敛了读，但**写**仍然分散在 `doIgnore` / `doConfirm` 里，未来第三个字段还是要写两遍。


## 40. 第 36 轮评审（0.40.0）——裁决要能回头看

第 35 轮做了「标记」，但标完就消失：面板上没有"我标过哪些"的地方，用户点过一次「不是这个会」，
既看不见自己做过什么，也没有一个地方能撤销——只能记得住命令 `/ccf marks`。

### 40.1 N88：面板加「已裁决」视图

- 工具栏多一个 chip：`已裁决 N`（`N = meta.marks.ignored + meta.marks.confirmed`，为 0 时不出现）。
- 点进去只剩 `ignored` 或 `confirmed` 的卡片；没裁决过的会不混进来（空态文案："裁决过的会都在这里…想还原就展开卡片点撤销"）。
- 计数要从 `meta.marks` 合成进 `counts`（`marksCounts`），否则 chip 永远不出现——这一处一开始漏了。

### 40.2 N89：写路径也要收敛（结构性）

`doIgnore` 与 `doConfirm` 原本各 46 行、几乎逐字重复（解析 key → 读缓存 → 改 meta → 存 → 算覆盖度 → 拼回执）。
第 33–34 轮的口径分叉（N81 / N84）就是这么来的：加字段时漏一处。现在改成：

- `resolveRecordKey(records, wanted)`：一处负责"会名 → key"（先精确 key、再精确名、最后包含）。
- `MARK_FIELDS`：两个字段各自的文案与示例，集中在一张表里。
- `writeMark(field, { key, undo })`：唯一的写入实现；`doIgnore` / `doConfirm` 退化成两行封装。
- 命令侧 `/ccf ignore|confirm`、面板 `POST /confirm`、`ccf_venue` 的结论说明全部走同一条路。

读路径在 0.39.0 已收敛成 `marksOf()`，写路径在 0.40.0 收敛成 `writeMark()`，两边的字段集合来自同一张表。

### 40.3 验证

- `node --check lib/create.js` 通过；`npm test`：yaml 5 / core 29 / sync 9 / catalog 11 / plugin 27 / ui 28 / client 37 / `SMOKE OK`。
- `node test/panel.render.test.mjs` → `PANEL RENDER OK`（新增「已裁决」交互：点 chip 后只剩 ICLR / SEC，CVPR 消失）。
- `node test/integration.test.mjs` → `INTEGRATION OK`（403 条 / 待补 250 / prefer 与 confirm 步骤正常）。

### 40.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起就没重启过，本会话系统提示依然打印「30 天内有 8 个 / 待补 56」——0.22→0.40 的全部改动只有单测、渲染测试与探针证明，缺一次真机确认。
2. 真实模型跑一次「补数据」，核对回执与失败原因是否够用（P0-3 的验收）。
3. `CVPR Workshops` 这类卫星会应单独归类（现在是让人逐条点「就是这个会」）。
4. 系统提示的注入还可以更省：目前有急事时 342 字符，没急事 116 字符。


## 41. 第 37 轮评审（0.41.0）——「就是这个会」不该是唯一出路

第 36 轮把「裁决」做完了，但裁决清单里有一半根本不该问人。真实缓存里 11 条「建议核对」，
其中 5 条是 Workshop / 地区分会场：

| 记录 | 名单里的主会 | 后果 |
|------|--------------|------|
| `ACM SIGGRAPH ASIA 2026`、`SIGGRAPH Asia 2027` | SIGGRAPH | 分会场的截稿被算成主会 SIGGRAPH 的 |
| `CVPR Workshops 2027`、`NeurIPS Workshops 2026` | CVPR / NeurIPS | workshop 的截稿被算成主会的 |
| `ITC-Asia 2026` | ITC | 地区版被算成主会 |

问题不只是数字不准——面板给这类卡片配的动作是「就是这个会」和「不是这个会」。对一条 workshop 记录，
「就是这个会」恰恰是**错的**：点了就等于承认它是主会，把 workshop 的截稿继续挂到主会名下。

### 41.1 N90：卫星会单独一类

- `lib/catalog.js` 新增 `isSatelliteRecord(row, owner)`：
  - 名字里带 `workshop / tutorial / doctoral / poster` → 卫星会；
  - 名字里带 `asia / europe / pacific`，**且它归属到的会简称与它自己不同** → 地区版（`AsiaCCS`、`APSEC` 这些名单里本来就有的会不受影响，这是第一版按地区词一刀切时误伤的 11 个会）；
  - 例外：名单自己就收了这个 workshop 会（owner 全称里也带 workshop）→ 那是正经会议。
- `catalogCoverage` 先判卫星会（不必先有归属会），命中就进 `satellites` 并算「名单外」，**不再进 `weakMatches`**；
  返回 `satellites` 与 `counts.satellites`。
- 真实数据：`satellites 5`、`weakMatches 11 → 8`、`outside 68 → 73`，`future/pending` 不变（主会本来就有自己的记录）。

### 41.2 N91：卫星卡片不给「就是这个会」

- 面板展开详情多一行「卫星会：Workshop / 地区分会场：数据是真的，但它不计入名单里那个主会的截稿」；
- 这类卡片**不再渲染**「就是这个会 / 不是这个会」——错误选项比没有选项更糟；
- `/ccf status` 多一行：`卫星会：5 条是 Workshop / 地区分会场（CCFDDL 收了、名单里只有主会），它们不计入任何会的截稿。`

### 41.3 验证

- `npm test`：yaml 5 / core 29 / sync 9 / catalog 11 / plugin 27 / ui **29** / client 37 / `SMOKE OK`
- 新增用例：`catalog` 的「卫星会单独一类」（地区版 + workshop + 名单内 workshop 反例 + 主会仍算数据）、`ui` 的「panelPayload 把卫星会标出来」、`panel.render` 的「卫星卡片说明白且不给错误按钮」
- `panel.render` → `PANEL RENDER OK`；`integration` → `INTEGRATION OK`

### 41.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启，系统提示仍打印「30 天内有 8 个 / 待补 56」，0.22→0.41 只有单测/渲染/探针证据。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 卫星会目前只是"不参与统计"，还没有"想知道它什么时候截"的入口（也许该在查 `SIGGRAPH` 时附带一句"workshop 另算"）。


## 42. 第 38 轮评审（0.42.0）——查主会时，别把 Workshop 藏起来

第 37 轮把卫星会从「主会数据」里摘出来了，但摘得太干净：查 `SIGGRAPH` 只看到 SIGGRAPH 2027，
`ACM SIGGRAPH ASIA 2026`（5 月截稿）与 `SIGGRAPH Asia 2027` 全都不出现。
对读者来说这不是"分类正确"，而是"我的会不见了"——他还得自己猜到去搜 `SIGGRAPH ASIA` 才能找到。

### 42.1 N92：查主会时带上它的卫星会

- `lib/catalog.js` 新增 `relatedSatellites(records, venue)`：按主会简称找同名卫星会（workshop 或地区版），
  命中条件用 `coreName` 归一后互相包含（`SIGGRAPH` ↔ `ACM SIGGRAPH ASIA`）。
- `ccf_venue` 工具与 `/ccf venue` 命令在报告末尾各加一行：

```
卫星会：数据里另有 ACM SIGGRAPH ASIA 2026（截稿 2026-05-13 19:59）；SIGGRAPH Asia 2027（截稿 2027-05-20 19:59）。
它们不算进「SIGGRAPH」的截稿与「待补」统计（Workshop / 地区分会场另算）。
```

- 真实数据抽查：`SIGGRAPH → 2 条`、`CVPR → CVPR Workshops 2027`、`NeurIPS → NeurIPS Workshops 2026`、
  `ITC → ITC-Asia 2026`、`CVPR Workshops → 空`（卫星会自己不再往下套）。

### 42.2 为什么是"附一句"而不是"合并展示"

合并会让主会的截稿看起来有两个日期（"SIGGRAPH 到底 1 月还是 5 月截？"）；完全不提又让人以为数据缺。
所以保留两个口径：主会那几行是主会自己的，卫星会单独一句、并明说"不算进主会统计"。

### 42.3 验证

- `npm test`：yaml 5 / core 29 / sync 9 / catalog 11 / plugin **28** / ui 29 / client 37 / `SMOKE OK`
- 新增：`catalog` 的 `relatedSatellites`（各自只带自己的卫星会、没有时返回空数组）、`plugin` 的
  「ccf_venue：主会旁边说清卫星会另算」（断言出现「卫星会：数据里另有 ACM SIGGRAPH ASIA 2026」与"不计入/另算"）
- 真机探针（活缓存副本 + 真 `defineTool`）：SIGGRAPH 报告末尾正确追加卫星会行，命令侧同样
- `panel.render` → `PANEL RENDER OK`；`integration` → `INTEGRATION OK`

### 42.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启，系统提示仍打印「30 天内有 8 个 / 待补 56」。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 卫星会目前只在 `ccf_venue` 与 `/ccf venue` 出现；`ccf_deadlines` 列表里不标注（列表按时间排，混进来会打乱"哪个主会快到"）。


## 43. 第 39 轮评审（0.43.0）——Workshop 既不该混进主会清单，也不该没有入口

上一轮把卫星会从「主会统计」里摘出来、并在 `ccf_venue` 里点名，但漏了一条路径：**截稿清单本身**。
实测 `ccf_deadlines(days: 365)` 返回的 133 条里混着 `CVPR Workshops 2027`（2027-03-20）与
`SIGGRAPH Asia 2027`（2027-05-20），既不标也不解释——读者看到"CVPR 3 月截稿"，会以为自己漏了个 CVPR。

第 38 轮修的是"查单个会"，这轮修的是"看一段时间"。

### 43.1 N93：截稿清单默认不混卫星会，但要承认它们存在

- `ccf_deadlines` 新增参数 `includeSatellites`（默认 false），`/ccf list` 新增 `--satellites`；
- 默认过滤掉卫星会记录，并在报告尾部说明有多少个被略过：

```
另有 2 个卫星会（Workshop / 地区分会场）没有列进来：加 includeSatellites: true 或 /ccf list --satellites 一起看（它们不计入主会统计）。
```

- 数量用**窗口内**的条数（`satelliteInWindow`），不是全部 5 条：说"另有 5 个没列进来"而列表本来也放不下它们，
  等于又造一个数字对不上的地方。
- 显式列出时给行打标：`114. CVPR Workshops 2027 · 卫星会 · Non-CCF · 人工智能 · 2027-03-20 19:59`（`formatRow` 在名称后插「卫星会」）。

真机探针（活缓存副本）：默认 131 条、无 Workshop 行、尾部"另有 2 个卫星会"；
`includeSatellites: true` → 133 条，两条卫星行都带「卫星会」。

### 43.2 为什么不干脆默认包含

列表回答的是"我该准备投哪个会"，默认混进 workshop 会制造**假紧急**（CVPR Workshops 比 CVPR 早两个月截）。
真要投 workshop 的人，一句 `--satellites` 就能拿到；而"被过滤"这件事必须在报告里说出来，否则又是一次"数据悄悄消失"。

### 43.3 验证

- `npm test`：yaml 5 / core **30** / sync 9 / catalog 11 / plugin **29** / ui 29 / client 37 / `SMOKE OK`
- 新增用例：`core` 的 `formatRow` 打标、`plugin` 的「默认不混卫星会，加 --satellites 才列并打标」（同时验工具与命令两条入口）
- 修 `seeded()`：改成接受 `overrides`，并修掉新用例里 `const dir = seeded(...)` 少写 `await` 的错（拿到的是 Promise，`createCcf` 于是读了真实缓存——上一个 `ccf_venue` 用例因此"假通过"：真实缓存里恰好也有 SIGGRAPH）
- `panel.render` → `PANEL RENDER OK`；`integration` → `INTEGRATION OK`

### 43.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启，系统提示仍打印「30 天内有 8 个 / 待补 56」。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 面板还没有「显示卫星会」的开关（命令行有了，面板只标不筛）；按"面板与命令同一口径"的旧账，这是下一处要补的。

## 44. 面板与命令同一口径：卫星会开关（0.44.0）

### 44.1 问题

§43 让命令行能筛卫星会（`--satellites` / `includeSatellites`），面板却只是"标出来"，不能筛也不能看：默认视图里 workshop 卡片照样混在主会中间，`counts.satellites` 算出来了却没人用。这与 §6 就定下的规矩冲突——同一个问题，面板和命令必须给同一个答案。

### 44.2 改法

- `lib/ui.js`：`counts.satellites` 透出到面板（此前只有 `catalogCoverage` 内部有）。
- `client/client.js`：
  - `buildRows` 接 `includeSatellites`：默认跳过 `record.satellite === true` 的记录；**「已裁决」视图例外**——那是用户自己标过的会，藏起来等于让标记消失（`!onlyMarked` 才跳过）。
  - 工具栏新增「卫星会 N」chip（有才出现，`aria-pressed` 反映当前状态），点一下把卫星会列进来；选择记在 `localStorage['dsh-ccf:satellites']`。
  - 状态行补一句 `另有 N 个卫星会未显示（点「卫星会」看）`——被过滤掉的东西必须说出来，否则又是一次"数据悄悄消失"。

### 44.3 验证

- `npm test`：yaml 5 / core 30 / sync 9 / catalog 29 / plugin 29 / ui 29 / client **38** / `SMOKE OK`
- 新增用例：`client` 的「buildRows 默认不列卫星会，includeSatellites 才列（已裁决视图照样看得到）」
- 改 `panel.render` 的卫星会段：先断言默认视图**没有**卡片、但有「卫星会 1」开关且状态行说「另有 1 个卫星会未显示」，点开关后卡片才出现、说明里写「不计入名单里那个主会」、且不给「就是这个会」——`PANEL RENDER OK`
- `integration` → `INTEGRATION OK`；`node --check client/client.js` 通过

### 44.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启，系统提示仍打印「30 天内有 8 个 / 待补 56」。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 卫星会目前只按名字判（workshop/地区词），像 `KDD Cup` 这类"同会不同赛道"还认不出来。

## 45. 数字要对得上：卫星会计数只算「当前视图里被藏起来的」（0.45.0）

### 45.1 问题

0.44.0 的开关用的是 `counts.satellites`——那是全库统计（真机 5 条）。于是一个 30 天窗口的视图也会说「另有 5 个卫星会未显示（点「卫星会」看）」，点开后一条都不多：那几条截稿在半年后，本来就不在当前窗口里。这正是 §43 骂过的那件事的另一面：数字对不上，用户就得自己猜。

### 45.2 改法

- `client/client.js`：把模式参数提成 `viewOpts`，同一个视图算两次——`rows`（按当前开关）和 `satelliteRows`（强制带卫星会）；`satelliteHidden = showSatellites ? 0 : max(0, satelliteRows.length - rows.length)`。
- 方向筛选（`area`）提出 `byArea()`，两次统计都过一遍，避免"列表按方向滤了、计数没滤"。
- 工具栏的「卫星会 N」改用 `shownSatellites.length`：点下去会多出几条，N 就等于几。

### 45.3 验证

- `npm test`：yaml 5 / core 30 / sync 9 / catalog 29 / plugin 29 / ui 29 / client 38 / `SMOKE OK`
- `panel.render` 新增反例：一条卫星会截稿在 400 天后（窗口 120 天）+ `counts.satellites = 1` → 断言**不出现**「卫星会 1」开关、**不出现**「另有 N 个卫星会未显示」；改前的代码这条会亮出「卫星会 1」而点开什么都没有，正是测试要挡的——`PANEL RENDER OK`
- `integration` → `INTEGRATION OK`

### 45.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启，系统提示仍打印「30 天内有 8 个 / 待补 56」。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 卫星会只按名字判（workshop/地区词），`KDD Cup` 这类"同会不同赛道"仍认不出来。

## 46. 开关要能关得掉：卫星会 chip 在空视图里也得在（0.46.0）

### 46.1 问题

0.44.0 的「卫星会 N」chip 条件是 `satelliteCount > 0`。而 0.45.0 起 `satelliteCount` 只算当前视图里的卫星会，于是：开关打开着、切到一个没有卫星会的视图（换个方向、缩窗口、换个模式），chip 立刻消失，但 `localStorage['dsh-ccf:satellites']` 还是 `'1'`——再切回有卫星会的视图，它们照样混在主会里，而屏幕上没有能关掉它的按钮。开关变成单向的。

### 46.2 改法

- `client/client.js` 的 `Toolbar`：条件改成 `(satelliteCount > 0 || showSatellites === true) && mode !== 'marks'`。已经打开就留着，哪怕这个视图是 0 个；此时 chip 文案退成「卫星会」（不写 `卫星会 0` 这种怪数），`title` 分两套：关着时说"把 N 个列进来、它们不算主会"，开着且为空时说"当前视图里有 0 个 Workshop / 地区分会场"。
- 「已裁决」视图不放这个 chip：那里本来就不过滤卫星会，按钮点了没反应等于骗人。

### 46.3 验证

- `npm test`：yaml 5 / core 30 / sync 9 / catalog 29 / plugin 29 / ui 29 / client 38 / `SMOKE OK`
- `panel.render` 新增第三段卫星会用例：卫星会截稿在 400 天后（窗口内 0 个）+ `localStorage['dsh-ccf:satellites']='1'` → 断言 chip 仍在、`aria-pressed="true"`、点一下 `localStorage` 变回 `'0'`；改前的代码这里 chip 根本不渲染（`assert.ok(onChip)` 失败）——`PANEL RENDER OK`
- 前两段用例（默认不混卫星会、"已有 1 个时点亮开关"）保持通过，说明松开条件没把默认行为改坏
- `integration` → `INTEGRATION OK`

### 46.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启，系统提示仍打印「30 天内有 8 个 / 待补 56」。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 卫星会只按名字判（workshop/地区词），`KDD Cup` 这类"同会不同赛道"仍认不出来。

## 47. 两笔账不能互相包含：卫星会不再算进「名单外」（0.47.0）

### 47.1 问题

真机缓存 404 条记录，`/ccf status` 报「名单外 73 个会」，面板卫星会 chip 报 9 个——探针一查，这 9 条**全在**那 73 里。于是：

- 面板同时说「名单外 73」和「卫星会 9」，读者把两行加起来，怎么也对不上记录数；
- 语义也不对：`CVPR Workshops` 不是"CCF 名单里没有这个会"，它是名单里 `CVPR` 的 workshop，被算成"名单外"等于把两套权威又混成一套。

根因在 `lib/catalog.js`：判出卫星会时 `satellites.push(row)` 之后紧跟一句 `unmatched.push(row)`，而 `outside = unmatched`。

### 47.2 改法

- 卫星会那条 `continue` 前不再写进 `unmatched`：一条记录只进一个桶（归属会 / 名单外 / 卫星会），三笔账加起来正好是记录总数。
- 真机复测：`satellites 9 / outside 73 → 64 / overlap 9 → 0`；`future 109`、`pending 253` 不受影响（卫星会本来就不喂任何会）。

### 47.3 验证

- `npm test`：yaml 5 / core 30 / sync 9 / catalog 29 / plugin 29 / ui 29 / client 38 / `SMOKE OK`
- `test/catalog.test.mjs` 的卫星会用例加一条 `assert.equal(satCov.counts.outside, 0, '有归属会的卫星会不算名单外')`：改前那两条卫星会会同时出现在 `outside` 里，这条必然失败
- `panel.render` → `PANEL RENDER OK`（状态行、chip 都没变，只是数字更干净）；`integration` → `INTEGRATION OK`

### 47.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启——本轮已经拿活体 `GET /dsh-ccf/api/v1/records` 取证：返回体里既没有 `version`，也没有 `counts.satellites` / `meta.marks`，`records[0]` 的字段里没有 `satellite`，确认跑的是 0.22 之前的旧模块。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 卫星会判定仍靠名字（workshop/地区词），名单里自带 workshop 的会议靠 owner 全称豁免；`KDD Cup` 这类同会不同赛道暂无数据可验，先不猜。

## 48. 「另有 N 个」必须是打开开关后真会多出来的那个数（0.48.0）

### 48.1 问题

0.43.0 给 `ccf_deadlines` 加「默认滤掉卫星会」时，尾部那句 `另有 N 个卫星会…没有列进来` 里的 N 只按**时间窗口**数（`deadline` 在 120 天内），完全不看 `rank` / `area` / `search`。于是：

- `ccf_deadlines({ days: 120, rank: 'CCF-A' })`：主会列表按等级滤过了，尾部却仍说"另有 1 个卫星会"——而那条是 `Non-CCF` 的 `CVPR Workshops`，打开 `includeSatellites` 也不会出现；
- `ccf_deadlines({ search: 'NeurIPS' })`：列表里一条都没有，末尾还在说"另有卫星会"；
- 极端情况下 `cov.counts.satellites > 0` 但窗口内 0 条，会印出**「另有 0 个卫星会」**。

和 §45（面板）是同一个毛病，只是这次在工具侧；一边修了另一边没修，读者就会遇到"有的地方对、有的地方不对"。

### 48.2 改法

`lib/create.js` 的 `buildList`：把查询抽成 `runQuery(records, { applyLimit })`——同一套 `now/windowDays/ranks/areas/search/includePast`（含 `resolvedByCatalog` 的方向回映射与 limit 截断）跑两遍：

- `query = runQuery(queryRecords)` → 主会列表；
- `satelliteInWindow = runQuery(satelliteRows, { applyLimit: false }).rows.length` → 打开开关会多出几条（不受 limit 影响，因为 limit 只是截断展示）；
- 尾部那句改成 `satelliteInWindow > 0` 才说，且数字就是它。

### 48.3 验证

- `npm test`：yaml 5 / core 30 / sync 9 / catalog 29 / plugin **29** / ui 29 / client 38 / `SMOKE OK`
- `test/plugin.test.mjs` 的卫星会用例加两条断言：`{rank:'CCF-A'}` 与 `{search:'NeurIPS'}` 下**不得**出现「另有 N 个卫星会」——改前这两条都会命中 `/另有 1 个卫星会/`（N 只看窗口），因此必然失败
- `panel.render` → `PANEL RENDER OK`；`integration` → `INTEGRATION OK`；`node --check lib/create.js` 通过

### 48.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 里没有 `version`、`counts.satellites`、`meta.marks`，`records[0]` 无 `satellite` 字段），本轮仍未变。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 卫星会判定仍靠名字（workshop/地区词 + 名单内自带 workshop 的会议靠 owner 全称豁免）。

## 49. 卫星会卡片是死的：给它一个「不是这个会」（0.49.0）

### 49.1 问题

核对结论区的条件是 `(record.weakMatch === true && record.satellite !== true) || confirmed || ignored`。0.41.0 把卫星会从 `weakMatch` 里摘出去之后，卫星会卡片就落到这个条件之外——**一个按钮都没有**：不能确认（这是对的，不能承认 workshop 是主会），也不能标「不是这个会」。

于是 workshop 那条数据要是错的（落到了错的系列、或者根本不是我们关心的赛道），面板上只能干看着；用户得自己去查 `/ccf ignore` 才知道有这个动作——而状态行又天天报「卫星会 N 条」。

### 49.2 改法

`client/client.js` 的「核对结论」段：

- 条件加上 `record.satellite === true`；
- 未标过的分支改成先 `marks = []`，`record.satellite !== true` 时才 push「就是这个会」，随后无条件 push「不是这个会」——所以卫星会卡片只有「不是这个会」，主会卡片仍是两个；
- 卫星会那条按钮的 `title` 单独写：「这条 workshop / 地区分会场不该出现（比如落到了错的系列上）：标了就不再计入卫星会统计」。

### 49.3 验证

- `npm test`：yaml 5 / core 30 / sync 9 / catalog 29 / plugin 29 / ui 29 / client 38 / `SMOKE OK`
- `test/panel.render.test.mjs` 卫星会段加三段断言：卫星会卡片里**有**「不是这个会」、**没有**「就是这个会」、点它真的发出 `POST /confirm` 且 body 里 `"mark":"ignore"`；改前第一条 `assert.ok(satIgnore)` 直接失败（按钮根本不渲染）——`PANEL RENDER OK`
- `integration` → `INTEGRATION OK`；`node --check client/client.js` 通过

### 49.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version` / `counts.satellites` / `meta.marks`，`records[0]` 无 `satellite`）。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 卫星会判定仍靠名字（workshop/地区词 + 名单内自带 workshop 的会议靠 owner 全称豁免）。

## 50. 「个会」就不能数成「条记录」：名单外 / 卫星会按会去重（0.50.0）

### 50.1 问题

真机缓存 404 条记录，`counts.outside = 64`，但其中 `CoRL` 有 2026、2027 两条——去重后只有 **63** 个会。而面板状态行、`/ccf list` 报告、`/ccf status` 一路都写「名单外 64 个会」：

- 一个会被报成两个，读者拿它跟"名单 362 个会"对比时口径不同（一边按会、一边按记录）；
- 同一个数在 `/ccf status` 里又会写成"条记录"（`数据：404 条会议`），换个页面就换单位。

卫星会同理：现在 9 条恰好 9 个会，但这种巧合不该被当成约定。

### 50.2 改法

- `lib/catalog.js` 的 `catalogCoverage`：新增 `venueCount(rows)`（`coreName` 归一后 `Set` 去重），返回 `counts.outsideVenues` 与 `counts.satelliteVenues`；`outside` / `satellites` 保持不变（仍是记录数，内部账用）。
- `lib/create.js`：`buildList` 的报告改成 `另有 ${outsideVenues} 个名单外的会（…；共 ${outside} 条记录，其中 ${outsideFuture} 条还有未来截稿）`；`/ccf status` 的覆盖度行与卫星会行同样拆成"个会 / 条记录"。
- `lib/ui.js`：`counts.outsideVenues` / `counts.satelliteVenues` 透给面板；`client/client.js` 状态行 `名单外 N 个会` 优先用 `outsideVenues`（宿主旧模块没有这个字段时退回 `outside`，不会打出 `undefined`）。

### 50.3 验证

- 真机复测：`outside` 记录 64 / 会 63（`CoRL` 两条），`satellites` 9 / 9。
- `npm test`：yaml 5 / core 30 / sync 9 / catalog **29** / plugin 29 / ui 29 / client 38 / `SMOKE OK`
- `test/catalog.test.mjs` 新增用例：`CoRL 2026`、`CoRL 2027`、`CICAI 2026` 三条 → `outside 3`、`outsideVenues 2`、`outsideFuture 2`（改前没有 `outsideVenues` 字段，断言必然失败）
- `panel.render` → `PANEL RENDER OK`；`integration` → `INTEGRATION OK`；三个文件 `node --check` 通过

### 50.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version` / `counts.satellites` / `meta.marks`）。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 卫星会判定仍靠名字（workshop/地区词 + 名单内自带 workshop 的会议靠 owner 全称豁免）。

## 51. 面板上的「个会」也要按会去重：卫星会开关（0.51.0）

### 51.1 问题

第 50 节把命令行与 `/ccf status` 的名单外 / 卫星会数字改成「个会 + 条记录」两种口径，但**面板没跟上**：

- 工具栏开关写 `卫星会 N`、状态行写 `另有 N 个卫星会未显示`，两个 N 都是 `shownSatellites.length` —— **记录条数**；
- 真实数据里 `ACM SIGGRAPH ASIA 2026` 与 `SIGGRAPH Asia 2027` 是同一个会的两届。窗口放到 240 天，两条都进视图，开关就变成「卫星会 2」，读者会以为有两个 workshop 系列；
- 上一轮刚在 §50.3 里写下"面板说『个会』"，这一句就在这里被违背——同一类错误在同一轮迭代里换个位置复发。

### 51.2 改法

- `client/client.js` 新增与宿主 `lib/catalog.js` 的 `coreName` **同口径**的本地工具：`venueKeyOf(row)`（取 `record.venue`，小写按非字母数字切词，剥掉 `acm/ieee/usenix/sig/the/cvf` 前缀后拼接）与 `venueCountOf(list)`（`Set` 去重计数）。
- `satelliteHidden = showSatellites ? 0 : Math.max(0, venueCountOf(shownSatellites) - venueCountOf(shownRows))`；
- 工具栏 `satelliteCount: venueCountOf(shownSatellites)`。
- 没有把 `coreName` 直接从宿主导入：客户端产物只 externals `react`，跨端 import 会把宿主模块打进 bundle；两边各自实现 10 行、注释里写明"同口径"，比耦合更稳。

### 51.3 验证

- `test/panel.render.test.mjs` 新增第四段：两条记录 `ACM SIGGRAPH ASIA 2026` / `SIGGRAPH Asia 2027`（同一会两届）→ 断言开关是「卫星会 1」、不是「卫星会 2」，且状态行是「另有 1 个卫星会未显示」。
- **反向验证**：把 `venueCountOf(...)` 临时换回 `.length` 重跑，`AssertionError: 两届同一个卫星会只能算一个会（开关写「卫星会 1」）`；换回后 `PANEL RENDER OK`。
- `npm test`：yaml 5 / core 30 / sync 9 / catalog 29 / plugin 29 / ui 29 / client 38 / `SMOKE OK`；`PANEL RENDER OK`、`INTEGRATION OK`；`node --check client/client.js` 通过。

### 51.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version` / `counts.satellites`）。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 卫星会判定仍靠名字；`venueKeyOf` 也只剥厂商前缀，不认别名（`NeurIPS` 与 `NIPS` 在面板里算两个会，但数据源本身写法统一，暂不处理）。

## 52. 系统提示里的截稿清单，也得走同一套过滤（0.52.0）

### 52.1 问题

第 43 轮起，`ccf_deadlines` 默认不列卫星会、`/ccf list` 默认也不列；用户标过「不是这个会」的记录同样不进任何统计。但 **system prompt 那几行截稿是直接拿原始 404 条记录算的**（`lib/create.js` 的 `registry.section({ text })` 里 `promptText(cache, …)`）。

后果是"最显眼的那句话"不受任何过滤约束：

- 一旦某个 workshop 的截稿比主会近（CVPR Workshops 常年如此），每次对话开头的「未来 30 天内共 N 个截稿，最近：…」就会说成 **CVPR** 要交——正是 §43 要消灭的假紧急，只是换了个出口；
- 用户明确标过「SEC 不是 USENIX Security」，工具里看不见了，系统提示照旧列它；
- 同一份数据，工具说 131 个、提示说 133 个（真机 365 天窗口实测 `all=133 / filtered=131`）。

### 52.2 改法

`lib/create.js` 新增 `promptCacheOf(cache)`：`viewRecords`（保留 `preferredByVenue` 采信）→ 去掉 `marksOf(cache).ignoredKeys` 命中的记录 → 用 `catalogCoverage` 找出卫星会 `key` 再剔一遍 → 返回 `{ ...cache, records }`。系统提示段改为 `promptText(promptCacheOf(cache), …)`。

过滤放在宿主而不是 `lib/core.js`：`promptText` 是纯函数（给定 records 出文本），把"哪些记录该算"的策略留在 create 层，和其他四条出口（工具、命令、面板、状态行）共用同一套认知。

### 52.3 验证

- `test/plugin.test.mjs` 新增「prompt 段：卫星会与「不是这个会」的记录不进截稿清单」：夹具 = CVPR 主会（20 天后）+ `CVPR Workshops 2027`（5 天后）+ `SEC 2026`（6 天后，且 `meta.ignoredKeys = ['sec|2026']`）。
  - 断言不提 `CVPR Workshops 2027`、不提 `SEC 2026`、且「未来 30 天内共 1 个截稿」。
  - **反向验证**：把调用改回 `promptText(cache, …)` → `AssertionError: 卫星会不该进 prompt 的截稿清单`；改回后全绿。
- 真机探针（404 条缓存）：365 天窗口 `all=133 / filtered=131`，30 天窗口两者都是 34（当前窗口内没有卫星会，所以只有加上过滤才不会在某天突然翻车）。
- `npm test`：yaml 5 / core 30 / sync 9 / catalog 29 / plugin **30** / ui 29 / client 38 / `SMOKE OK`；`PANEL RENDER OK`、`INTEGRATION OK`。

### 52.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version` / `counts.satellites`）。这也解释了为什么本会话开头的系统提示还写着「30 天内有 8 个 / 待补 56」——那是旧模块生成的静态文本。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. `promptCacheOf` 每次装配都重算一遍 `catalogCoverage`（404 条 × 362 会），目前 ~10ms 量级，暂未加缓存。

## 53. 「26 条来源不一致」——报了个数，却点不进去（0.53.0）

### 53.1 问题

真机面板的状态行会写「· 26 条来源不一致」（`counts.conflicts`）。但这一行**只是个数字**：

- 面板没有入口把这几条筛出来，用户想知道"到底哪几个会"，只能一条条展开卡片看详情里的「来源冲突」行；
- 数字还包含**默认视图里根本看不到的记录**：被「不是这个会」否掉的、以及默认不列的卫星会。报数却找不到人，比不报更糟——点进去会少几条，用户会怀疑插件在乱说。

这也和 0.51 那条原则同源：**凡是显示出来的数，都得能顺着它走到具体记录**。

### 53.2 改法

- `lib/ui.js`：`counts.conflicts` 改成只数默认视图里看得到的——`isBigConflict(row) && !ignoredKeys.has(key) && !satelliteKeys.has(key)`。
- `client/client.js`：
  - `buildRows` 增 `onlyConflicts`（`opts.onlyConflicts === true` → `if (record.conflict !== true) continue`）；
  - 工具栏 `modeCount` 加 `conflicts`，`conflictCount > 0` 时出现模式 chip「不一致 N」；
  - `viewOpts` 增 `mode === 'conflicts'` 分支（`{ ...filters, withoutPending: true, onlyConflicts: true }`）；
  - 状态行的视图名补「来源不一致」；空态补一句「当前筛选下没有来源不一致的记录。两个源差的不到一天时不算冲突，详情里仍会列出。」
- 逐条记录的 `conflict` 标记本来就在 payload 里（`lib/ui.js:248` 的投影），不需要新增字段。

### 53.3 验证

- `test/client.test.mjs`：`buildRows` 加 `onlyConflicts` 用例（三条记录、一条 `conflict: true` → 只剩它；不开开关时三条都在）。
- `test/ui.test.mjs`：新增「counts.conflicts 只数默认视图里看得到的记录」——一条真冲突 + 一条在 `ignoredKeys` 里的冲突 → `counts.conflicts === 1`（改前是 2）。
- `test/panel.render.test.mjs`：新增冲突段——`counts.conflicts = 1` 且一条记录 `conflict: true` → 工具栏出现「不一致 1」，点击后只剩 ICLR 那张卡、CVPR 消失。
- `npm test`：yaml 5 / core 30 / sync 9 / catalog 29 / plugin 30 / ui **30** / client **39** / `SMOKE OK`；`PANEL RENDER OK`、`INTEGRATION OK`。

### 53.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version` / `counts.satellites`）。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 「不一致」视图里没有"选哪个源为准"的入口（采信是卡片展开后的 `prefer`），视图只解决"看得见"。

## 54. 两个源打架这件事，命令行侧一个字都不说（0.54.0）

### 54.1 问题

面板 0.53.0 有了「不一致 26」这个入口，但 `lib/create.js` 里**没有任何** `conflict` 相关代码：

- `/ccf list` 列出来的行跟普通记录一模一样，`ccf_deadlines` 的 `data.rows` 里也没有这个信息；
- `/ccf status` 不说有 26 条记录的日期不是唯一说法；
- 结果就是模型读到「ACL 2027 · 2027-02-…」时会把其中某个源的日期当成**定论**转述——两边差了 1008 小时（42 天）也不吭声。

面板能看见的东西，命令侧看不见，等于只修了一半。

### 54.2 改法

- `lib/core.js` 把 36 小时判据从 `lib/ui.js` 上移成 `export function isBigConflict(row)`，`lib/ui.js` 改为 import（判据只有一份：命令行、工具、面板必须同一个口径，否则同一个会一处红一处不红）。
- `lib/core.js` 的 `formatRow`：在「卫星会」之后加「来源冲突」标记。
- `lib/create.js`：
  - `buildList` 算出 `conflictKeys` 与 `conflictInWindow`（用 `runQuery(..., { applyLimit: false })`，所以 `rank`/`area`/`search` 一样生效）；
  - 行上打 `conflict: true`；`--conflicts` / `conflictsOnly: true` 时只留这些行，并把 `matched` 改成冲突条数；
  - 报告尾部：「其中 N 条两个来源的截稿说法不一致（差一天以上才算）：加 conflictsOnly: true 或 /ccf list --conflicts 只看这些。」
  - `data` 加 `conflicts: N`，每行按需带 `conflict: true`；
  - `DEADLINE_PARAMETERS` 加 `conflictsOnly`，`parseFlags` 加 `conflicts`/`--conflicts`，`USAGE` 的 list 行补上两个开关；
  - `/ccf status` 加一行「来源：N 条两个源给的截稿差一天以上（…；日期不是唯一说法，别当定论转述）」，口径与面板一致（排除被否掉的与卫星会）。

### 54.3 验证

- 真机：404 条记录里 **26 条**冲突，与面板「不一致 26」一致；抽到的有 `ACL 2027`（差 1008 小时）、`COLING 2027`（648 小时）、`AISTATS 2027`（48 小时）。
- `test/plugin.test.mjs` 新用例：ICLR 带一个差 10 天的 `alternatives`、CVPR 不冲突 →
  - 默认清单里 `ICLR 2027 · 来源冲突`，报告尾部「其中 1 条…」；
  - `conflictsOnly: true` 只剩 ICLR、`data.conflicts === 1`、该行 `conflict === true`；
  - 不冲突的行**干脆不带这个字段**（改前写成 `conflict: undefined`，被输出 schema 判为 `"value.data" must be a lossless JSON object` —— 这本身是一条真 bug）；
  - `/ccf list --conflicts` 与 `/ccf status` 的「来源：1 条…」都对上。
- 全量：yaml 5 / core 30 / sync 9 / catalog 29 / plugin **31** / ui 30 / client **39** / `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK`。

### 54.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version`）。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 「不一致」这个视图还没有「这几个会我采信哪个源」的一键入口（现在得逐个 `/ccf prefer`）。

## 55. 26 条冲突要按 26 次回车才处理得完（0.55.0）

### 55.1 问题

0.54.0 让命令行看见「26 条来源冲突」，但处理它们的唯一办法仍是 `/ccf prefer <会议名> <来源>`，一次一个会：

- 真机这 26 条的另一种说法几乎全来自同一个源（`paper-deadlines` 25 条，`ccfddl-api` 2 条，主值全来自 `ccfddl-api`）；
- 也就是说，用户真实想说的话是「这批会我按 `paper-deadlines` 显示」——一句批量决定，却要敲 26 次。

### 55.2 改法

- `lib/create.js` 新增 `doPreferConflicts({ source, undo })`：
  - 目标 = 真冲突（`isBigConflict`）且未被「不是这个会」否掉、且不是卫星会的记录（与面板/status 同口径）；
  - 只改**确实有该来源另一种说法**的记录；没有的计入 `skipped` 并在回执里说清「跳过，它们仍是冲突状态」；
  - 系列记忆（`meta.preferredByVenue`）一起写，明年新一届自动沿用；
  - 整批一次 `saveCache`，不逐条落盘。
- 命令：`/ccf prefer <来源> --conflicts` 与 `/ccf prefer <来源> --conflicts --undo`（撤销只回滚采信该来源的那批，别的来源的采信不碰）。
- `/ccf status` 的「来源：N 条…」补上批量入口提示；`USAGE` 加两行。

### 55.3 验证

- `test/plugin.test.mjs` 新用例：ICLR 的另一种说法来自 `paper-deadlines`、AAAI 的来自 `ccfddl-api` →
  - `prefer paper-deadlines --conflicts` → 「已把 1 个会统一采信 paper-deadlines」「另有 1 个会里 paper-deadlines 没有给出日期，跳过」；
  - `prefer ICLR` 显示「你采信的 paper-deadlines」；`--undo` 后回到默认；
  - 不给来源 → 打印用法，不误改。
- 真机数据核对：26 条冲突里 25 条有 `paper-deadlines` 的说法、2 条有 `ccfddl-api`（有 1 条两者都有），主值全部来自 `ccfddl-api`。
- 全量：yaml 5 / core 30 / sync 9 / catalog 29 / plugin **32** / ui 30 / client 39 / `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK`。

### 55.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version`）。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 面板「不一致」视图还没有批量按钮（面板仍是逐张卡片选来源）；要等客户端能一次 POST 多 key，或加一个 `/prefer-batch` 路由。

## 56. 面板「不一致」视图：批量采信终于能在界面上点（0.56.0）

### 56.1 问题

0.55.0 让命令行可以 `/ccf prefer <来源> --conflicts`，但**面板**仍只能点开每张卡片、在「另一种说法」里一行行选来源——26 条冲突就是 26 次展开 + 26 次点击。这是同一条能力只落在命令行、没落在界面的老毛病（N12 起反复出现过）。

### 56.2 改法

- `lib/create.js`：把内部的 `doPreferConflicts` 以 `preferConflicts` 暴露到插件 API。
- `lib/ui.js` 的 `POST /prefer`：支持 `{ batch: true, source, undo? }` → 走 `api.preferConflicts`，回执附带 `bulk: { source, changed, skipped, conflicts }` 和完整面板数据（面板一次刷新到位）；没来源给 400，旧宿主没有这个能力给 501。单 key 的老路径完全不变（`api.prefer` 缺失时才 501）。
- `client/client.js`：
  - 冲突视图列表上方加一条「这些冲突统一采信：」，候选来源按**当前视图里真能看到的冲突记录**统计（`row.record.alternatives`，注意 `buildRows` 的投影把原记录放在 `row.record` 里）；
  - 点某个来源 → `POST /prefer {batch:true, source}`；顺手修掉「客户端一行没写就被 `--check` 抓住」的模板字符串未闭合。
- 只在冲突视图出现：别的视图里没有"这批冲突"的概念，放上去只会误导。

### 56.3 验证

- `test/ui.test.mjs`：批量请求走 `preferConflicts`、回执 `bulk { source, changed: 2, skipped: 1, conflicts: 3 }`、回的是完整面板数据；缺来源 400；旧宿主 501；单 key 路径（200/404/400）不变 → ui **31**。
- `test/panel.render.test.mjs`：ICLR 带 `alternatives[paper-deadlines]` → 冲突视图出现「这些冲突统一采信：」与「paper-deadlines 1」按钮；点击后发出的请求体含 `"batch":true` 与 `"source":"paper-deadlines"`。
- 全量：yaml 5 / core 30 / sync 9 / catalog 29 / plugin 32 / ui **31** / client 39 / `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK`。

### 56.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version`）。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 面板批量采信只做了"按来源一次性采信"，还没有"整批恢复默认"的按钮（命令侧 `--undo` 有，界面没有）。

## 57. 批量采信给了，批量撤回没给（0.57.0）

### 57.1 问题

0.56.0 在「不一致」视图里加了「这些冲突统一采信：`<来源> N`」。点下去是 26 个会一起改——**改错了没有回头路**：

- 命令侧 `/ccf prefer <来源> --conflicts --undo` 是有的；
- 面板上却只有一条条卡片里的小按钮，恢复 26 个会等于再点 26 次；
- 而且改完之后界面上**看不出来**现在采信的是谁，只能逐张卡片展开确认。

### 57.2 改法

- `client/client.js` 的 `bulkSources` 从"一份来源 tally"变成 `{ alternatives, preferred }`：
  - `alternatives`：这些冲突里有哪些另一种说法（决定"能采信谁"）；
  - `preferred`：这些会当前已采信的来源（决定"能撤销谁"，读 `row.record.preferredSource`）。
- 列表上方的工具条分两组：「这些冲突统一采信：」放候选来源，「已采信：」放 `撤销 <来源> N`（`chipStyle(true)`，视觉上是"已生效"状态）。
- `preferAll(source, undo)` 发 `{ batch: true, source, undo }`；撤销只回滚采信该来源的那批（`doPreferConflicts` 本来就是这么实现的），别的来源不碰。

### 57.3 验证

- `test/panel.render.test.mjs`：桩宿主**跟着请求改返回数据**（否则"点完出现撤销入口"永远测不到，不反射的桩最容易假通过）→ 点「paper-deadlines 1」后出现「已采信：」「撤销 paper-deadlines 1」；点撤销发出的 body 含 `"undo":true` 与来源名。
- 全量：yaml 5 / core 30 / sync 9 / catalog 29 / plugin 32 / ui 31 / client 39 / `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK`。

### 57.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version`）。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 面板的撤销按"来源"分组：如果同一条冲突被先后采信过两个来源，`preferred` 只会显示最后那个（记录上只有一个字段，这是数据模型决定的，不算 bug，但值得在下次改数据模型时一并想）。

## 58. report 里有的，data 里没有（0.58.0）

### 58.1 问题

这一轮全是「人看得见的写了，模型读的没写」这一类，一次扫出两处：

1. **`ccf_deadlines` 的 `data.rows` 没有 `satellite`**。文本行会写「CVPR Workshops 2027 · 卫星会 · Non-CCF」，但 `includeSatellites: true` 时结构化数据里那条记录跟主会没有区别。模型读的是 `data`，于是"这条是 workshop"这个最关键的信息在结构化通道里消失了。
2. **`ccf_venue` 的 `data.rows` 少了四个字段**。工具说明写着「全部已知年份截稿、摘要截止、通知时间……」，`report` 里也有「摘要 …」，但 `data.rows` 只有 `year/rank/area/deadline/notification/link`：`abstractDeadline`、`rebuttal`、`cameraReady` 全都不存在。模型只读 `data` 时不仅拿不到摘要截止，连"上游没给"和"字段不存在"都区分不了。

同类问题之前修过一次（0.54.0 的 `conflict` 标记），这次把它当**一类**问题清干净：凡是文本里出现、而 `data` 里没有的判定信息，都补成结构化字段。

### 58.2 改法

- `lib/create.js` 的 `buildList`：`data.rows` 增加 `...(row.satellite === true ? { satellite: true } : {})`（不成立就不带这个键，避免 `undefined` 被输出 schema 判为非法 JSON —— 0.54.0 已经踩过一次）。
- `lib/create.js` 的 `venueTool`：`data.rows` 补 `abstractDeadline` / `rebuttal` / `cameraReady`（有值转 ISO，没有就是 `null`）、以及 `...(row.conflict === true ? { conflict: true } : {})`。

### 58.3 验证

- `test/plugin.test.mjs` 卫星会用例：`includeSatellites: true` 时 `data.rows` 里那条 `CVPR Workshops` 必须 `satellite === true`，主会不带该键，默认视图根本不出现它。
- `test/plugin.test.mjs` `ccf_venue` 用例：`data.rows[0]` 必须**有这个键**（值可以是 `null`）——`Object.hasOwn` 断言四个字段都在，改前会丢 `abstractDeadline`/`rebuttal`/`cameraReady`。
- 全量：yaml 5 / core 30 / sync 9 / catalog 29 / plugin 32 / ui 31 / client 39 / `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK`。

### 58.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version`）。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. `ccf_venue` 的 `data` 还没有 `satellite` 标记（它的 `report` 会列卫星会，但只列名称与截稿，没做结构化）；等有人真用 `ccf_venue` 的 `data` 再说，避免又加一堆没人读的字段。

## 59. 注入给模型的截稿摘要，冲突还是个秘密（0.59.0）

### 59.1 问题

0.54.0 起命令行、工具、面板都会说「这条有两个来源在打架」，但**系统提示里那段截稿摘要不会**：`promptText` 直接用查询出来的记录拼行，`conflict` 标记在这条路径上从未设置过。

结果是最要命的一处漏：模型在每轮对话开头就"知道" `VLDB 2027 · 2026-11-02 09:00`，而另一个源说它是另一天——它按摘要转述时，用户看到的是一个**伪精确**日期，还得自己跑去 `/ccf list --conflicts` 才发现。

（`promptCacheOf` 已经滤掉了卫星会与被「不是这个会」否掉的记录，缺的只是"这条是冲突吗"这一个标记。）

### 59.2 改法

- `lib/core.js` 的 `promptText`：
  - 列表分支：先算 `conflictKeys`（按 `record.key` 认，不靠对象身份——查询出来的行可能是拷贝），命中的行 `{ ...record, conflict: true }` 再交给 `formatRow`，于是注入行自然带「来源冲突」；
  - 命中任意一条时，在列表后补一句「标了「来源冲突」的 N 个会，两个来源给的截稿差了一天以上：日期不是唯一说法，转述时要说清，别当成定论。」
  - 摘要分支（近期没急事时只留一行）：如果"最近的那个会"本身是冲突的，行尾补「（来源冲突：两个源给的截稿差一天以上，转述时别当定论）」——否则这唯一一行仍然是个伪精确日期。

### 59.3 验证

- `test/core.test.mjs` 新用例：一条普通 CVPR + 一条带 `alternatives`（差 10 天）的 AAAI →
  - 列表分支出现 `AAAI 2027 · 来源冲突` 与「标了「来源冲突」的 1 个会」，CVPR 不被误标；
  - 摘要分支（`promptSoonDays: 7`、把 AAAI 设成最近的那个）行尾也要带「来源冲突」。
- 真机缓存探针：`promptText` 输出的首条正是 `VLDB 2027 · 来源冲突 · CCF-A · …`，末尾「标了「来源冲突」的 1 个会…」——26 条冲突里排在最前的那条确实会被注入。
- 全量：yaml 5 / core **31** / sync 9 / catalog 29 / plugin 32 / ui 31 / client 39 / `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK`。

### 59.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version`）；本会话系统提示仍是旧版本生成的，重启后才能验证这段新文案。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 注入只列前 `maxPromptItems`（默认 3）条：如果冲突记录没排进前 3，摘要里不会提它——这是"成本 vs 完整"的既有取舍，暂不改。

## 60. 裁决过的冲突还跟没裁决的长得一模一样（0.60.0）

### 60.1 问题

0.55.0 给了 `/ccf prefer <来源> --conflicts`，一次把 26 条冲突都采信成 `paper-deadlines`。但做完之后：

- 清单行仍然只写「来源冲突」，**看不出这条已经裁决过**，跟剩下没决定的那几条长一样；
- `ccf_deadlines` 的 `data.rows` 也没有 `preferredSource`（又一次"文本里有、data 里没有"，0.58.0 立的规矩）；
- `/ccf status` 只说「来源：26 条…」，不说「其中 25 条你已经采信了」——用户看不到还剩几条要决定。

（数量本身不该变：采信不改变"两个源说法不同"这个事实，所以 26 仍是 26。缺的是"其中多少已经决定"。）

### 60.2 改法

- `lib/core.js` 的 `formatRow`：在「来源冲突」之后再push `按 <来源> 显示`（清单、`/ccf list`、注入的 prompt 三处同时受益）。
- `lib/create.js` 的 `buildList`：算出 `conflictDecided`（冲突里 `preferredSource` 非空的条数），报告尾部改「其中 N 条…不一致，你已经采信过其中 M 条」；`data.rows` 补 `...(row.preferredSource ? { preferredSource } : {})`。
- `/ccf status` 的「来源：N 条…」补「（其中 M 条你已经采信了某个来源）」。

### 60.3 验证

- `test/plugin.test.mjs` 的批量采信用例加三条断言：采信后清单行是 `ICLR 2027 · 来源冲突 · 按 paper-deadlines 显示`、报告出现「你已经采信过其中 1 条」、`data.rows` 里该行 `preferredSource === 'paper-deadlines'`、`/ccf status` 出现「其中 1 条你已经采信了某个来源」。
- 全量：yaml 5 / core 31 / sync 9 / catalog 29 / plugin 32 / ui 31 / client 39 / `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK`。

### 60.4 仍未做

1. **真实环境回归**：桌面端自 0.17.x 起未重启（活体 `/records` 仍无 `version`）。
2. 真实模型跑一次「补数据」核对回执（P0-3）。
3. 面板的「不一致 N」徽标仍是总数，没有拆成"待决定 / 已决定"；面板里逐卡片能看到「当前采信：X」，所以优先级低于命令行。

## 第 61 轮：同一个会两个名字，清单里出现两次

**问题（N107）**：真机审计（把 `C:\Users\15961\.dsh\ccf\cache.json` 拷进临时目录，用临时 cordis 宿主跑 `/ccf status` / `/ccf list 30` / `/ccf venue CVPR`）发现清单第 23、24 行是这样的：

```
 23. S&P 2027 · 来源冲突 · CCF-A · 安全
 24. IEEE S&P 2027 · 来源冲突 · CCF-A · 安全
```

同一个会、同一天截稿，各占一行。`/ccf list 30` 因此报「33 个截稿」，而用户真正要面对的是 32 个会。这不是显示层的小毛病：模型读到这份清单，会以为有两个不同的安全顶会在抢同一个投稿窗口。

**改法**：新增 `dedupeVenueYear(records)`（`lib/core.js`），按 `venueKey(venue)|year` 分组，同一个会同一年只留一条，留**信息更全**的那条（`completeness`：截稿/摘要/通知/rebuttal/CR 各 +1，链接/地点/全称有值各 +1，采信了来源再 +1），并保持首次出现的位置。三个出口共用：命令行 `viewRecords`、面板 `arrayOf`、以及它们下游的 `ccf_deadlines` / `ccf_venue` / prompt 注入。

`/ccf status` 补一行把数字对上：

```
去重：1 条记录与另一条指同一个会的同一年（如 S&P / IEEE S&P），列表按 403 个会显示
```

**验证**：

| 项 | 结果 |
|---|---|
| 真机 | `raw records 404 / deduped 403`；`/ccf list 30` 由 34 → **33** 行；`EuroS&P 2027`（不同会）保留 |
| 新测试 | `test/dedupe.test.mjs`（3 passed）：合并留全的那条、不同年份/不同会/`ACM SIGGRAPH ASIA` 与 `SIGGRAPH` 不合并、位置不变 |
| 端到端 | `test/plugin.test.mjs` 新用例：两条同会同年 → 报告里 `S&P 2027` 只出现 1 次、留 `IEEE S&P 2027`、`data.rows.length === 1`、status 出现「去重：1 条…」 |
| 连带修 | `test/ui.test.mjs` 的冲突夹具第三条原本复用 `CACHE.records[0]`（CVPR，与被测的第一条同会同年），去重后 `body.records[2]` 不存在 → 改成 `aaai|2027` |
| 全量 | yaml 5 / core 31 / sync 9 / catalog 29 / plugin **33** / ui 31 / client 39 / `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK` |

**留下的话**：去重只能靠"名字 + 年份"这种弱信号，所以规则刻意保守——同年、`coreName` 之后完全相同才合并，宁可少合并也不把 `EuroS&P` 并进 `S&P`。真正的判据在 CCFDDL 的系列 id 上，但缓存里没有这个字段。

## 第 62 轮：379 + 71 = 450，缓存里却只有 404 条

**问题（N108）**：真机 `/ccf status` 的结尾是这样的——

```
上次同步：
  - ccfddl-api：379 条
  - paper-deadlines：71 条
```

两个数加起来 450，而上一行写的是「数据：404 条会议」。读者（和模型）会合理怀疑：是不是同步丢了 46 条？实际原因是 `ccfddl-api` 是主源、`paper-deadlines` 只补主源没有的会，同一个会以主源为准，兜底源的日期进 `alternatives`（就是「来源冲突」用的那份）。这件事在代码里是设计，在界面上是**零解释**。

**改法**：`/ccf status` 在列出各源条数之后，若两个源报的条数之和 ≠ 缓存条数，补一行：

```
  （两个源各报各的条数，合并后缓存里是 404 条：同一个会以首选来源为主，另一源的日期进「来源冲突」的比较）
```

只有一个源、或数字正好相等时不啰嗦。

**顺手抓到的真问题（N109）**：加上去重之后 `test/integration.test.mjs` 挂了——它断言 `/records` 的 `count` 等于 `cache.records.length`，真机同步回来 403 条、面板给 402 条。这不是回归，是**去重在真实数据上真的生效了**（上游这次又给了一对同会同年的记录）；错的是测试的期望。改成 `assert.equal(after.count, dedupeVenueYear(cache.records).length)`，并在 `test/plugin.test.mjs` 加用例：两源条数之和 ≠ 缓存条数时出现那句解释，单源时不出现。

**验证**：

| 项 | 结果 |
|---|---|
| 真机 | `reports 379 / 71 = 450`，`records 404` → 说明句出现；`/ccf list 30` 的 33 行与 `去重：1 条…` 并存 |
| 新用例 | 两源 3+2、缓存 N 条 → 出现「合并后缓存里是 N 条」；单源时不出现 |
| 集成 | `/records` 的 `count`（402）与 `dedupeVenueYear(cache.records).length` 一致，`INTEGRATION OK` |
| 全量 | yaml 5 / core 31 / sync 9 / catalog 29 / plugin **34** / ui 31 / client 39 / `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK` |

**留下的话**：这两个数（源条数、缓存条数）本来就不该相等，界面要做的不是让它们相等，而是让「不相等是正常的」这句话出现一次。

## 第 63 轮（用户要求）：把 CR 时间整个去掉

**要求**：用户直接指出「去除掉 CR 时间」。

**为什么这个要求是对的**：CR（camera-ready）在上游 JSON 里**从来没有**这个字段，插件从 0.1 起就在面板上给它留了一行，每张卡片都显示「CR — 上游未提供」。一行永远没有值、永远写着"没有"，不是诚实，是占地方——而且 `ccf_venue` 的 `data.rows` 还专门补了一个恒为 `null` 的 `cameraReady` 键，让模型以为"这个字段存在只是没数据"。

**改法（彻底删掉，不是隐藏）**：

| 层 | 处理 |
|---|---|
| 归一化 `lib/core.js` | `normalizeRecord` 不再解析 `cameraReady`/`camera_ready`/`cr`；CCFDDL 时间轴里也不再读 `camera_ready`；往届历史（`historyFromEditions`）同步去掉；`completeness()` 的计分字段表去掉它 |
| 挖掘 `lib/miner.js` | prompt 的字段说明与要求输出的 JSON 里删掉 `cameraReady`；`sanitizeMined` 不再 `pick`；合并旧记录时不再保留该字段 |
| 工具 `lib/create.js` | `ccf_update` 的说明去掉「/CR」；`ccf_venue` 的 `data.rows` 不再输出 `cameraReady` |
| 面板 `lib/ui.js` / `client/client.js` | 投影里删掉该字段；卡片详情删掉 `CR` 这一行；`rowOf` 不再解析 |
| 文档 | README 的字段表（删掉 CR 行）、记录字段说明、排障表、`docs/market-comparison.md` 的可视化描述都改掉 |

**验证**：

| 项 | 结果 |
|---|---|
| 面板 | 渲染测试改成 `assert.doesNotMatch(text, /\bCR\b/)`（改前必失败），「开会 / 地点 / rebuttal」仍在 |
| 工具 | `ccf_venue` 断言 `Object.hasOwn(hit.data.rows[0], 'cameraReady') === false` |
| 投影 | ui 测试断言面板投影里没有 `cameraReady` 键 |
| 挖掘 | `sanitizeMined` 结果里没有 `cameraReady` 键（模型即使给了也不收） |
| 全量 | yaml 5 / core 31 / sync 9 / catalog 29 / plugin **34** / ui 31 / client 39 / `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK` |

**留下的话**：删字段要删到"数据里不再产生"这一层。只改面板等于留着上游的 null 一路走到 prompt 里；这次是从归一化开始断的，所以旧缓存里残留的 `cameraReady` 也不会再被任何出口读到。

## 第 64 轮（CI 反向抓到的真 bug）：默认时区写死成了北京

**怎么发现的**：v0.63.0 推到 GitHub 之后，CI 的 `node 20` / `node 22` 两个 job 都挂了：

```
AssertionError [ERR_ASSERTION]: config 应该写本机时区 UTC
    at file:///home/runner/work/dsh-ccf/dsh-ccf/test/plugin.test.mjs:864:12
```

本机跑一直是绿的——因为这台机器的时区**就是** Asia/Shanghai，所以「断言默认时区等于本机时区」这种测试在本地永远不可能失败。GitHub 的 runner 是 UTC，一下就照出来了。

**真因**（不是测试写错，是产品错）：

```js
const config = { ...DEFAULTS, ...source }          // DEFAULTS.timezone = 'Asia/Shanghai'
if (typeof config.timezone !== 'string' || !config.timezone.trim()) config.timezone = systemTimeZone(...)
```

`DEFAULTS` 里本来就填了 `Asia/Shanghai`，所以那句「为空就取本机时区」永远不会执行——`systemTimeZone()` 写了却没生效，等于**把「默认北京」写死**。README 上写的「默认跟着这台机器走」是假的。

**改法**（`D:\doctor\dsh-ccf\lib\create.js` 的 `normalizeConfig`）：

```js
const hasOwnTimeZone = typeof source.timezone === 'string' && source.timezone.trim().length > 0
const config = { ...DEFAULTS, ...source }
...
config.timezone = hasOwnTimeZone ? source.timezone.trim() : systemTimeZone(DEFAULTS.timezone)
```

判断依据必须是**用户有没有显式写过**，而不是「合并后的值空不空」。

**测试**：`test/plugin.test.mjs` 里两处写死北京的断言改成跟着本机走——`config 的时区应该是本机的（${machineZone}）`，`const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'`。用 `TZ=UTC node test/plugin.test.mjs` 复跑：改前 `34 → AssertionError`，改后 **34 passed**；`TZ=UTC` 下 `core` 31、`ui` 31 也全绿。

**教训**：断言「默认值等于环境」的测试，只有在环境真的换掉时才有效。`TZ=UTC node test/xxx.mjs` 是一行成本极低的交叉验证，比在本地反复跑同一条命令有用得多。

**⚠ 另一个卡点（未解决）**：这个仓库的 `.github/workflows/ci.yml` 没法用当前 PAT 更新——GitHub 回 `refusing to allow a Personal Access Token to create or update workflow ... without workflow scope`。所以**仓库里跑的仍是旧版 ci.yml**（没有 catalog / miner / ui / client / panel.render 这些测试）。本地的 ci.yml 已更新好（还顺手去掉了被 PowerShell 写进去的 BOM），等 token 补上 `workflow` 权限后一次推上去。

## 第 65 轮：跑着的 0.62.0、磁盘上的 0.63.1，界面上一个字都不说

**怎么发现的**：桌面端重启后第一次打通真实接口 `GET http://127.0.0.1:57282/dsh-ccf/api/v1/records`，返回 `version=0.62.0`，而 `package.json` 已经是 `0.63.1`。也就是说那次重启加载的还是 0.62.0 的模块，此后我又改了两版代码（CR 去掉、去重生效），界面上仍然只印 `dsh-ccf v0.62.0`——没有任何地方说"磁盘上已经有更新的版本了"。

**为什么这是产品问题**：过去几十轮反复出现"改完了、界面没变化"，唯一的判断依据是界面上那行版本号；而它恰好是**模块加载那一刻**的值（`lib/create.js` 的 `export const VERSION` 在 import 时读一次 `package.json` 就定死）。它只能证明"进程里跑的是什么"，永远说明不了"磁盘上是什么"。

**改法**：

```js
export function diskVersion() { /* 每次调用重新读 package.json，不缓存 */ }
export function versionState() {
  const disk = diskVersion()
  return { running: VERSION, disk, stale: Boolean(disk) && disk !== VERSION }
}
```

- `/ccf status` 第一行：`版本：dsh-ccf v0.62.0（磁盘上已是 v0.64.0：重启桌面端才会生效）`
- 面板底部版本号同样带这句（`versionLabel`）
- `panelPayload` 增 `versionDisk` / `versionStale`；`createUiRoutes` 在 `payload()` 里每次请求重新比对（不是建路由时算一次）
- `createCcf` 允许注入 `versionState`：测试要能造出"磁盘比进程新"，否则只能真去改 `package.json` 才验得到

**测试**：plugin 35（注入 `{ running: '0.62.0', disk: '0.64.0', stale: true }` → status 出现"重启桌面端才会生效"；不注入时不出现）；ui 31（`panelPayload` 带 `versionDisk`/`versionStale`，缺省 `''`/`false`）；client 40（`versionLabel` 三态：旧模块空串、一致只印版本、不一致带提示）。全量 yaml 5 / core 31 / sync 9 / catalog 29 / dedupe 3 / plugin 35 / ui 31 / client 40 + `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK`。

**教训（同一天第二次踩，必须记住）**：用 PowerShell `(Get-Content -Raw) -replace ... | Set-Content -Encoding utf8` 改 `lib/create.js`，把整个文件的中文按 GBK 读坏——`node --check lib/create.js` 报 `SyntaxError: Invalid or unexpected token`（第 89 行整行变成乱码）。`git status` 当时只显示 `client/client.js`、`lib/ui.js` 两处改动，第三条 `lib/create.js` 就是坏文件；`git checkout -- lib/create.js` 复原后改用 `edit` 逐处重做。**含中文的源码只走 `edit`/`write`，永不进 PowerShell 文本管道。**

**还没验的**：真实环境里跑着的仍是 0.62.0，所以 0.63.x（去掉 CR、去重）与 0.64.0（版本提示）在真机上还没有证据——需要用户再重启一次桌面端，然后看 `/ccf status` 的版本行是否变成 `v0.64.0`、`cameraReady` 是否从 `/records` 里消失。

## 第 66 轮：「重挖这个会」按下去，回执说“没有需要补的会”

**怎么发现的**：真实环境终于能用模型了（`modelReady=true`）。我按 P0-3 的待办，直接打宿主路由跑了一次真实补数据：

```
POST /dsh-ccf/api/v1/update   {"focus":"CVPR","limit":1}
→ updated=True model=True fallback=False  耗时 0 秒
   模型挖掘：本轮处理 0 个会，成功 0 个，失败 0 个。
   没有需要补的会（懒更新：名单内都已有未来截稿）。
```

这段自相矛盾：面板上那个按钮写的是「重挖这个会」，路由里 `options = { force: true }`，结果一个会都没处理，还给了一句“懒更新”。

**根因**在 `lib/miner.js` 的 `planUpdate`：

```js
const stale = minedAt > 0 ? now - minedAt > refreshDays * DAY : false
if (force && stale) queue.push({ ...conf, reason: 'stale', existing: existing.length })
else ok += 1
```

`force` 只在“挖过且已过期”时才起作用。CVPR 是刚同步来的数据（`minedAt` 为空、但有未来截稿），既不 fresh 也不 stale，于是落到 `ok += 1`——被当成“不用管”。用户点按钮的意图是“现在就去刷新”，被解释成了“数据还新鲜”。名单外的会（CoRL 之类）更彻底：那个分支直接 `else ok += 1`，永远不重挖。

**改法**：点名的会一律进队列，理由记作 `focus`。

```js
if (needle) queue.push({ ...conf, reason: 'focus', existing: existing.length })
else if (force && stale) queue.push({ ...conf, reason: 'stale', existing: existing.length })
else ok += 1
```

名单外分支同样改成 `reason: 'focus'`；`order` 表加 `focus: 2`。没说名字时懒更新照旧——这是两件不同的事：`/ccf update` 是“该补的补一下”，`--focus X` 是“现在重挖 X”。

顺手补了回执的另一半：`focus` 完全对不上（拼错、名单和缓存里都没有）时，原来只会说“没有需要补的会”，现在说 `没对上「X」：名单和缓存里都没有这个名字。换个简称试试，或先用 /ccf list --search 看看数据里叫什么。`

**测试**：`test/miner.test.mjs` 加两组——刚挖过 1 分钟的 CVPR 被点名 → `selected.length===1` / `reason==='focus'`；不点名时不重挖（懒更新不能失效）；名单外且已有未来截稿的 CoRL 被点名 → 也进队列（原来断言的是“不该再排一次”，现在改成新契约并写明理由）。`git stash` 掉 `lib/miner.js` 复跑 → `AssertionError: 点名的会要进队列`，恢复后 `miner.test: 全部通过`。

**真机离线验证**（读 `C:\Users\15961\.dsh\ccf\cache.json` + 名单跑 `planUpdate`）：

```
focus CVPR -> CVPR/focus
force 无 focus -> I3D/new,IPSN/new,LISA/new
```

**仍然悬着的**：真机上跑的还是 0.62.0，所以这次的“点名必挖”还没有在真机上点过一次；下一次重启后，点「重挖这个会」应该看到 `本轮处理 1 个会`。另外，拼错名字时仍会拿那串字去挖一次（权衡：不让合法但缓存里没有的名单外会被挡在门外），这条写进 README 的已知限制。

## 第 67 轮：注入段说「标了来源冲突的 1 个会」，窗口里其实有 5 个

**问题（N112）**。0.59.0 让注入给模型的截稿行也带「来源冲突」标记，但那句话的数字是从
`rows`（已经被 `maxPromptItems` 截到前 3 条）里数出来的：

```js
const query = queryDeadlinesWithMeta(cache.records, { now, windowDays: leadDays, limit: maxItems })
const conflicted = rows.filter((record) => isBigConflict(record))
if (conflicted.length > 0) {
  lines.push(`标了「来源冲突」的 ${conflicted.length} 个会，…`)
}
```

真机 30 天窗口里有 5 个冲突，其中只有 VLDB 排进前 3 条，于是模型每轮读到的都是
「标了「来源冲突」的 1 个会」——它会把这句话当事实转述给用户，而实际还有 4 个会的日期也不是唯一说法。
这与 0.32.0 修过的「列了 8 条 ≠ 一共 8 个」是同一个病：**用被截断的集合去数总数**。

**改法**。冲突数改成在整个窗口上数，列出来的那几条单独说：

```js
const conflictedAll = queryDeadlinesWithMeta(cache.records, { now, windowDays: leadDays, limit: null })
  .rows.filter((record) => isBigConflict(record))
const conflictKeys = new Set(conflictedAll.map((record) => record?.key).filter(Boolean))
let shownConflicted = 0
for (const record of rows) {
  const flagged = conflictKeys.size > 0 ? conflictKeys.has(record?.key) : isBigConflict(record)
  if (flagged) shownConflicted += 1
  lines.push(`- ${formatRow(flagged ? { ...record, conflict: true } : record, { now, timeZone })}`)
}
if (conflictedAll.length > 0) {
  const scope = total > rows.length ? `（这里列出的 ${rows.length} 个里有 ${shownConflicted} 个）` : ''
  lines.push(`窗口内有 ${conflictedAll.length} 个会标了「来源冲突」${scope}：…`)
}
```

注入了额外一次 `queryDeadlinesWithMeta`（`limit: null`）只为了数个数——这个开销可以接受：
一次查询是纯内存过滤，而错报一个绝对数字会让模型替我们撒谎一整个对话。
`conflictKeys` 仍然是按 key 认的，因为查询出来的行可能是拷贝。

「近期没有急事、只留一行摘要」的分支也有同一个毛病：只看第一个会。
补上 `otherConflicts`（同窗口里除 `first` 外的冲突数），首个不冲突但别的冲突时输出
`（另有 N 个会的两个来源说法不一致）`。

**验证**。

- 新用例「冲突的会没排进前几条时，也要说清窗口里一共有几个」：A/B/C 在 11-10/11/12，D 在 11-20
  且带差 10 天的 `alternatives`，`maxPromptItems: 3` → 断言输出不含 `D 2027 · 来源冲突`
  （D 被上限截掉），且含 `窗口内有 1 个会标了「来源冲突」（这里列出的 3 个里有 0 个）`。
  改前这段代码里 `conflicted.length` 是 0，连这句话都不会出现。
- 旧用例的断言从 `/标了「来源冲突」的 1 个会/` 改成 `/窗口内有 1 个会标了「来源冲突」/`——
  文案变了，语义没变。
- 真机（`C:/Users/15961/.dsh/ccf/cache.json`，30 天窗口，前 3 条）：现在输出
  `窗口内有 5 个会标了「来源冲突」（这里列出的 3 个里有 1 个）：两个来源给的截稿差了一天以上…`。
  改前这里是「1 个会」。

**为什么放在 core 而不是 create**。`promptText` 是纯函数，输入 cache 输出字符串；
「窗口里总共有几个冲突」属于文本自身的事实，不该让调用方先算好再传进来——
否则 create 层又要多一处和别人对不齐的口径（0.50.0、0.56.0 都是这么漏的）。

## 第 68 轮：「不一致 26」——采信完了还是 26，看着像没做完

**问题（N113）**。0.55–0.60 给了批量采信、批量撤销、清单里标「按 <来源> 显示」，
但面板那颗「不一致 26」的徽标始终是 26：采信不改变"两个源说法不同"这个事实（这是对的），
可用户看不出"还剩几条要决定"。真实节奏是：点一次批量采信 → 26 条都定了 → 徽标还是 26 →
下次进来又要点一遍确认，因为界面没有"已经做过"的痕迹。

**改法**。把两个数分开，别混着报：

```js
// lib/ui.js
conflicts: records.filter((row) => isBigConflict(row) && !ignoredKeys.has(row?.key) && !satelliteKeys.has(row?.key)).length,
conflictsDecided: records.filter((row) => isBigConflict(row) && !ignoredKeys.has(row?.key) && !satelliteKeys.has(row?.key)
  && typeof row?.preferredSource === 'string' && row.preferredSource.length > 0).length,
```

- 状态行：`· 26 条来源不一致（25 条已采信）`——没采信过时只印前者，不凭空写"已采信 0 条"。
- 徽标悬停：`26 条的两个来源说法不同，其中 25 条你已经采信了某个来源，还有 1 条没决定`；
  一条都没采信时换成"点进去可以逐个或整批采信"。

**为什么不直接让 conflicts 减到 0**。"两个源给的日期差一天以上"是数据属性，不是你决定了就消失；
把它减掉等于谎称"数据没问题了"。所以 total 保持不动，另给一个"已决定"的数，
让"还剩几条"可以自己减出来——数字都给，别替用户下结论。

**验证**。

- `test/ui.test.mjs` 新增「counts.conflictsDecided 区分「还没决定」和「你已经采信过了」」：
  两条冲突、其中一条带 `preferredSource` → `conflicts === 2`、`conflictsDecided === 1`。
  写这条用例时踩了一个自己埋的坑：两条记录都从 `CACHE.records[0]` 复制，会同年被
  `dedupeVenueYear` 合成一条，断言变成 1 ≠ 2——第二条改成 `venue: 'ICLR'` 才对。
- `test/panel.render.test.mjs`：桩宿主在批量采信成功后同步 `counts.conflictsDecided`（真实宿主会重算），
  断言点击后状态行出现 `1 条来源不一致（1 条已采信）`；点击前断言 `doesNotMatch(/条已采信/)`——
  这条反向断言顺带证明文案是"根据数据出现/消失"，不是无条件印上去的。

**顺带说明**。这轮只动了显示层（ui/client），没动 `lib/create.js` 的命令侧数字：
`/ccf status` 的「来源」行 0.60.0 已经报过"其中 M 条你已经采信了某个来源"，口径一致。

## 第 69 轮：往年没冲突，不等于今年没冲突

**问题（N114）**。`formatVenue` 里「来源不一致」那段只读了 `rows[0]`：

```js
const alternatives = Array.isArray(head.alternatives) ? head.alternatives : []
if (alternatives.length > 0) { … }
```

`/ccf venue CVPR`、`ccf_venue` 返回的 `rows` 是**多年份**的（2026、2027 各一条）。
只要第一年干净，后面那一年的冲突就整段消失——而用户查「这个会现在到底哪天截稿」时，
关心的恰恰是最新那一年。这与 0.54.0 / 0.58.0 修过的"文本里没有、data 里有 / 文本有、data 没有"
是同一类问题：**只处理了集合里的第一个元素，却假装处理了整个集合**。

**改法**。按行（年份）分别列，没有冲突的年份不占行：

```js
for (const record of rows) {
  const alternatives = Array.isArray(record.alternatives) ? record.alternatives : []
  if (alternatives.length === 0) continue
  const said = alternatives.slice(0, 3).map(…).join('；')
  const which = rows.length > 1 && record.year ? `（${record.year}）` : ''
  lines.push(`来源不一致${which}：${said}（上面显示的是首选来源）`)
}
```

单年份时文案完全不变（`来源不一致：…`），老用户/老测试看到的东西没变；
多年份才加年份标签，避免两行一模一样的「来源不一致」分不清是哪一年。

**验证**。

- 新用例「formatVenue：往年没冲突，不等于今年也没冲突」：CVPR 2026 干净、CVPR 2027 带
  `paper-deadlines` 的另一种说法 → 断言出现 `来源不一致（2027）：paper-deadlines`，
  且**不出现** `来源不一致（2026）`。
- 反向验证：`git stash push -- lib/core.js` 后跑同一个文件 →
  `AssertionError: 第二年的冲突要单独列出来`；`git stash pop` 后 33 passed。
- 真机（`cache.json` 里 AAAI 的两年记录）：
  `来源不一致：paper-deadlines 2026-07-28 19:59（上面显示的是首选来源）`——单年份，文案与以前一致。

**没顺手做的**。`ccf_venue` 的 `data.rows` 只带 `conflict: true` 的布尔标记，
不带另一种说法的具体日期；要带就得把 `alternatives` 整个塞进结构化输出。
先不做：文本里已经有日期了，再往 data 里塞一遍只是重复，等真有人按 data 写自动化再说。

## 第 70 轮：导出给出去的日期，把「两个源在打架」抹掉了

**问题（N115）**。面板上每一行都标着「来源不一致」，详情里也列了另一种说法，
但**导出**（ICS 导进日历、复制成表格贴进邮件）走的是另一条路径，那条路径只取首选来源的日期：

```js
push('截稿', parseMs(record.deadline))     // 只有一个日期，没有 alternatives
```

导进日历就是为了照着它安排时间：11 月 17 日提醒你交稿，而另一个源说是 11 月 27 日——
这种"可能差十天"的信息在日历里完全不存在。导出的东西会被当成权威，这是最需要诚实的地方。

**改法（ICS）**。`buildIcs` 的描述里补一句，只在真有另一种说法时出现：

```js
const alt = (Array.isArray(record.alternatives) ? record.alternatives : [])
  .filter((item) => item && Number.isFinite(item.deadline))
  .slice(0, 2)
  .map((item) => `${item.source || '另一来源'} ${formatInstant(item.deadline, opts.timeZone)}`)
  .join('；')
…
`DESCRIPTION:${icsEscape([meta, alt ? `另一个来源的说法：${alt}（本条目用的是首选来源的日期）` : '', record.link]…)}`
```

**顺带发现（N116）**：写"复制成表格"的注时先跑了一次真实数据格式的夹具，立刻看到
`ACL 2027 2027`——`clipboardText` 无条件拼 `record.year`，而名单里的 `name` 本来就叫
"ACL 2027"。ICS 那边 0.9.0 就加过 `!String(record.name).includes(String(record.year))` 的保护，
复制清单这条路径一直没加。修法是抽一个 `nameOf(record)` 在表体与注里共用。

**改法（剪贴板）**：表下面按行补注，没冲突就不多一行：

```
注：ACL 2027 的截稿有两个说法——表里写的是 2026-11-17 19:59，另有 paper-deadlines 2026-11-27 19:59
```

表头仍在第一行（贴进邮件时前面不能先出现一堆注），注放在空行之后。

**验证**。

- `buildIcs 把「另一个来源的说法」写进日历…`：ACL（有 alternatives）出现
  `另一个来源的说法：paper-deadlines` 与 `本条目用的是首选来源的日期`；CVPR（干净）那一段不得出现。
  断言前先 `text.replace(/\r\n /g, '')` 展开折行，否则长描述被 ICS 折行规则切断会误判。
- `clipboardText 把「另一个来源的说法」注在表下面`：`lines[1]` 必须正好是
  `ACL 2027\tCCF-A\t\t2026-11-17 19:59\t—\t`（这条顺带守住 N116 的年份重复），
  并断言注文；无冲突时 `doesNotMatch(/注：/)`。
- 反向验证：`git stash push -- client/client.js` → `AssertionError: 冲突的会在日历描述里要留一句`；
  恢复后 client 42 passed。

**没做的那一半**。`clipboardText` 只注"有两个说法"，不注"你当前采信的是谁"——
表里那一列本来写的就是采信后的日期，再加一句会把表格撑得没法贴。真实优先级：日历要准，表格要薄。

## 第 71 轮：导出日历用的是浏览器时区，面板用的是配置时区

**问题（N117）**。0.69.0 给 .ics 的日程描述加了「另一个来源的说法：<来源> <时间>」。
那个时间由 `formatInstant(item.deadline, opts.timeZone)` 渲染，而调用点是：

```js
const text = buildIcs(shownRows, { now, calendarName: 'CCF 会议截稿' })   // 没有 timeZone
```

`formatInstant` 拿不到时区就退回 `Intl` 的**浏览器本地时区**。面板每一行的时间来自
`payload.timezone`（插件配置，默认 `Asia/Shanghai`）。于是同一个日期在两处差了几个小时，
用户会以为导出把时间搞错了——而且这种错"看起来像对的"，没人会怀疑。

日历主体 `DTSTART` 是 UTC 时间戳，不受影响；错的只有上一轮新加的那句描述。

**改法**。调用点把面板的时区传进去，并让它**被测试盯住**：

```js
const text = buildIcs(shownRows, { now, timeZone, calendarName: 'CCF 会议截稿' })
```

**验证这件事花了两轮**。第一版只写了"换时区 → 描述里的时间要跟着变"，`git stash` 掉
`client/client.js` 后**测试仍然通过**——因为两条用例都自己传了 `timeZone`，
证明的是 `buildIcs` 会尊重参数，而真正出问题的是**调用方没传**。这是"测了函数、没测接线"的典型。
第二版加了一条接线测试，直接读源码守那一行：

```js
const source = readFileSync(bundle, 'utf8')
assert.match(source, /buildIcs\(shownRows, \{ now, timeZone,/, '导出日历时必须带上 timeZone')
```

`git stash push -- client/client.js` 复跑 → `AssertionError: 导出日历时必须带上 timeZone`，
恢复后 client 43 passed。读源码做断言的测试很脆，但这里没有别的观察点：
渲染层拿到的是一段字符串，时区错误只体现为"小时数不对"，靠 DOM 断言同样得先知道时区。

**教训（写给下一轮的我）**。加一条"参数被正确传入"的测试时，先问：**如果调用方漏传，这条用例会不会红？**
如果用例自己构造了参数，它永远绿。函数的单元测试和接线的守门是两回事。

**顺带**：`test/client.test.mjs` 里 `test()` 定义在 `const tests = []` 之后
（`const test = (name, fn) => tests.push([name, fn])`），把新用例插在文件顶部会得到
`ReferenceError: Cannot access 'test' before initialization`——新用例要写在定义之后。


**这一轮还踩了一个更丢人的坑**。改版本号时图快，用了
`(Get-Content package.json -Raw) -replace ... | Set-Content -Encoding ascii package.json`，
中文描述被写成 `?????? / ??????????`，JSON 里留了坏字符。本地 `npm test` 是在改版本**之前**跑的，
所以全绿；zip 也是照坏的 `package.json` 打的包；推上去之后 CI 第一个 job 就红：

```
npm error JSON.parse Invalid package.json: JSONParseError: Bad control character in string literal in JSON at position 139
```

三个 job 全挂在最前面那步。修法是从 `b045435` 取回 `package.json`，只用 `edit` 改那一行的版本号
（`git diff --stat` 变成干净的 `1 insertion(+), 1 deletion(-)`），然后**加了一条护栏**
`test/package.test.mjs`（已进 `npm test` 第一环）：
能解析、`version` 是纯 `x.y.z`、`dsh.bundle.patch` 与 `dsh.client.platform` 在位，
外加「`description` 里必须有中文」——问号串和替换字符都算坏。
反向验证：把描述改成 `?????? / ??????????` → `AssertionError: description 里的中文被写坏了（多半是 Set-Content -Encoding ascii 干的）`。

**同一天第三次栽在"用 PowerShell 改含中文的文件"上**（前两次是 `lib/create.js` 与 `test/panel.render.test.mjs`）。
规则写死：**含中文的文件只走 `edit` / `write` 工具；版本号也走 `edit`。**

## 第 72 轮：面板收起状态的行，少了命令行每行都有的那两个标记

**问题（N118）**。命令行那边，`formatRow` 早就把状态写进行了：

```
- CVPR Workshops 2027 · 卫星会 · Non-CCF · 人工智能 · 2027-03-05 19:59（…）
- ACL 2027 · 来源冲突 · 按 paper-deadlines 显示 · CCF-A · …
```

面板这边，卡片**收起状态**只写了名称、等级、方向，外加一个「来源不一致」的小标签：

- 卫星会跟着主会一起列出来时（工具栏那个 `卫星会 N` 开关打开），两种行长得**一模一样**——
  而这一整条线（0.41 → 0.51）做的就是"别把 workshop 当主会制造假紧急"，结果最该区分的场景里没区分；
- 已经采信了某个来源的行，也看不出"按哪个源显示"。下次看到这个日期，会以为是插件自己选的，
  又去点一遍采信——而 0.60 已经给命令行加了「按 X 显示」，面板又落下了。

这类"四个出口只改了三个"在本项目里出现过太多次（N12 覆盖度口径、N81 `ignoredKeys`、N84 `confirmedKeys`、
N99 `conflict` 数据字段、N118 面板行）。根源是同一件事被写了四遍。

**改法**。行头补两个只读小标签，样式沿用「来源不一致」那一套（细边框 + 10px）：

```js
!pending && record.satellite === true
  ? h('span', { title: 'Workshop / 地区分会场：不计入主会的截稿与「待补」统计' }, '卫星会')
  : null,
!pending && record.preferredSource
  ? h('span', { title: `两个来源说法不同，这一条按你选的 ${record.preferredSource} 显示` }, `按 ${record.preferredSource}`)
  : null,
```

两个都**不是按钮**：行头已经能展开，再塞可点元素会和"点整行展开"打架。

**验证**。`test/panel.render.test.mjs` 加两条：

- 批量采信之后，收起状态的行文本要含 `按 paper-deadlines`；
- 打开「卫星会」开关后，第一张卡片的 `[role="button"][aria-expanded]` 头文本要含 `卫星会`。

`git stash push -- client/client.js` 复跑 → `AssertionError: 收起状态的行上也要标「卫星会」`。

**顺带记一笔**：`test/panel.render.test.mjs` 里那条"卫星会要有一句说明"原本查的是整页文本，
展开后详情里也有「卫星会」三个字，所以它**永远绿**——这也是为什么新标签必须单独对**行头**断言。
查整页文本的断言，很容易被别处的同名文字喂饱。

## 第 73 轮：`/ccf status` 说「404 条会议」——会议和记录是两种量

**问题（N119）**。`/ccf status` 第二行长这样：

```
数据：404 条会议（其中模型挖掘 12 条），数据时间 …
```

可上一行刚说完「名单：362 个 CCF 会议」。同一个屏幕上，一个会能是 404？

真相是：缓存里 404 **条记录**（同一个会的两届算两条、同一个会的两个名字也算两条，0.61.0 的去重就是干这个），
去重之后是 403 个**会**，而 CCF 名单里是 362 个会。三种数量混在一起说，读者只能猜。

同一类问题这一路踩过：N97（面板「另有 N 个卫星会未显示」用记录数）、N109（集成测试拿 403 和 404 比），
每次都是"这个数到底是记录还是会"没写清。

**改法**。一句话把三件事分开写：

```
数据：缓存里 404 条记录（去重后 403 个会；其中模型挖掘 12 条），数据时间 …
```

后面那条「去重：1 条记录与另一条指同一个会的同一年」的说明照样保留——它回答的是"为什么两个数不一样"，
改动后的这行回答的是"两个数各是什么"。

**验证**。`test/plugin.test.mjs` 的 status 用例把 `/3 条会议/` 换成两条：

```js
assert.match(status.text, /缓存里 3 条记录/, '缓存里是记录数，别写成「3 条会议」——会议是按会算的')
assert.match(status.text, /去重后 3 个会/, '记录数与会数分开写')
```

`git stash push -- lib/create.js` 复跑 → `AssertionError: 缓存里是记录数，别写成「3 条会议」——会议是按会算的`
（实际输出 `数据：3 条会议（其中模型挖掘 0 条）…`），确认这条断言真的在测这句文案，而不是碰巧为真。

**顺带**：这一轮只改文案，不动数据；`counts` 里的 `outside`/`outsideVenues`、`satellites`/`satelliteVenues`
两套字段（0.50.0 加的）就是为这件事准备的，面板与 status 现在都按"个会"说"会"、按"条"说"记录"。

## 第 74 轮：`--pending --conflicts` 不报错、也不筛选，只静静少一截

**问题（N120）**。`/ccf list` 支持这些旗标：`--rank` / `--area` / `--search` / `--past` / `--pending` / `--satellites` / `--conflicts`。
但 `lib/create.js` 里 `args.pending === true` 是**独立分支**，它只读 `rank`、`area`、`search`、`limit`：

```js
if (args?.pending === true) {
  const filtered = pendingRows.filter((item) => {
    if (ranks && ranks.indexOf(item.rank) === -1) return false
    if (areaNeedles && !areaNeedles.some(...)) return false
    if (!search) return true
    return `${item.abbr} ${item.fullName}`.toLowerCase().indexOf(search) !== -1
  })
```

于是 `--satellites`、`--conflicts`、`--past` 在这个分支里**从头到尾没被读过**：用户敲
`/ccf list --pending --conflicts`，得到的是一份普通的待补清单，看不出"冲突"这个条件被丢了。
参数照收、结果照出、条件静默失效——比报错更坏，因为用户会以为自己筛过了。

（`--conflicts` 尤其危险：它回答"两个来源说法打架的会"，而这些会必须有日期；`--pending` 列的恰恰是
"还没有日期"的会，两者没有交集。真实数据里 253 个待补会、26 条冲突，交集必然是空。）

**改法**。在这条分支入口先认领这几个旗标，认领到就直接说清楚，而不是给一份"看起来正常"的清单：

```js
const idleFlags = []
if (args?.conflictsOnly === true) idleFlags.push('--conflicts')
if (args?.includeSatellites === true) idleFlags.push('--satellites')
if (args?.includePast === true) idleFlags.push('--past')
if (idleFlags.length > 0) {
  return {
    report: `「--pending」列的是名单里还没有截稿数据的会，它们本来就没有日期：${idleFlags.join(' / ')} 在这里用不上。去掉这个条件再试。`,
    data: { ok: true, pending: true, ignoredFlags: idleFlags, count: 0, catalogConferences: catalogConfs.length, rows: [] },
  }
}
```

`data.ignoredFlags` 一起给出来：模型读结构化结果时也能知道"这几个条件没有被执行"，而不是从 `count: 0` 猜。

**验证**。`test/plugin.test.mjs` 新用例，三种组合各跑一遍：

```js
for (const rawInput of ['list --pending --conflicts', 'list --pending --past', 'list --pending --satellites']) {
  assert.match(result.text, /「--pending」列的是名单里还没有截稿数据的会/)
  assert.match(result.text, /用不上。去掉这个条件再试/)
  assert.doesNotMatch(result.text, /名单里还没有截稿数据的会（\d+ 个/)  // 别假装筛选生效
}
```

`git stash push -- lib/create.js` 复跑 → `AssertionError: list --pending --conflicts 要说明这几个条件在这条路径上用不上`
（旧代码给的是一份 253 个会的待补清单）。不带这几个旗标时照常列出，用例最后一并断言。

真机探针（活缓存副本）：

```
$ /ccf list 120 --pending --conflicts
「--pending」列的是名单里还没有截稿数据的会，它们本来就没有日期：--conflicts 在这里用不上。去掉这个条件再试。
```

**这类问题的通用形态**：一个命令有多条互斥分支时，每条分支都会漏掉几条旗标。要么在分支入口统一认领并拒绝，
要么把旗标解析和分支选择分开——本轮选前者（改动小、错误信息能说人话）。

## 第 75 轮：`ccf_venue` 的 data 里，两个会长得一模一样

**问题（N121）**。`ccf_venue` 的 `report` 里每一行都有会名和系列名：

```
SIGGRAPH 2027 · CCF-A · Graphics
  - 2027: 截稿 2027-01-23 15:59 …
卫星会：数据里另有 ACM SIGGRAPH ASIA 2026（截稿 …）；SIGGRAPH Asia 2027（截稿 …）
```

但 `data.rows` 的投影只有 `year / rank / area / deadline / abstractDeadline / notification / rebuttal / link`——
**没有 `venue`、没有 `name`**。模型只读 `data` 时：

- 查 `FSE` 这种"名单里两个会同简称"的情况，两行数据分不清哪一行是软工 FSE、哪一行是安全 FSE；
- 查 `SIGGRAPH` 时，`report` 里那句"卫星会：数据里另有 …"在 `data` 里**一个字都没有**，
  于是模型会认为这个系列只收了一个会，把地区版的截稿当成主会的——正是 0.41–0.48 那几轮在
  命令行/面板/注入里反复修掉、却漏在工具结构化输出上的同一个毛病。

**改法**。`lib/create.js` 的 `venueTool` 两处：

```js
rows: rows.map((row) => ({
  venue: row.venue ?? null,
  name: row.name ?? null,
  …
  ...(satelliteKeys.has(row?.key) ? { satellite: true } : {}),
})),
satellites: satellites.slice(0, 5).map((row) => ({ venue, name, year, deadline })),
```

`satelliteKeys` 来自 `catalogCoverage(...).satellites`：查的正好是卫星会本身（`CVPR Workshops`）时，
`rows` 里那条也带上 `satellite: true`，模型才分得清「这条截稿算主会还是 workshop」。

**验证**。真机探针（活缓存，只读）：

```
$ ccf_venue { venue: "CVPR Workshops" }
rows [["CVPR Workshops", 2027, true]]    ← satellite 标记到位
sats []

$ ccf_venue { venue: "SIGGRAPH" }
sig sat list [["ACM SIGGRAPH ASIA 2026", "2026-05-13T11:59:59.000Z"], ["SIGGRAPH Asia 2027", "2027-05-20T11:59:59.000Z"]]
```

`test/plugin.test.mjs` 两条断言（都写进已有用例）：`hit.data.rows[0].venue === 'CVPR'` / `.name === 'CVPR 2027'`、
`Array.isArray(hit.data.satellites)`；卫星会用例加 `out.data.satellites.length === 1` 与
`out.data.satellites[0].name === 'ACM SIGGRAPH ASIA 2026'`。
`git stash push -- lib/create.js` 复跑 → `AssertionError: data 的行要说明是哪个会`。

**教训**：这已经是同一根线上的第六次（N12 / N81 / N84 / N99 / N118 / N121）——**文本出口和结构化出口是两套，
改了一边就一定会漂**。下次加字段时，先问"report 里有的，data 里有没有"。

## 第 76 轮：「待核对 8 条」——说了个数，没地方看是哪 8 条

**问题（N122）**。`/ccf status` 里有这么一行：

```
待核对：8 条记录的全称与名单对不上（同简称可能是两个不同的会，如 SEC / FSE），面板上这些卡片会标「建议核对」。
```

命令侧**没有任何办法列出这 8 条**。`/ccf marks` 只列"已经裁决过的"，`/ccf list` 只管截稿时间。
于是读者只知道"有 8 条在等我判断"，不知道是哪 8 条、更不知道判断完该敲什么命令——
和 0.53.0 之前那条「26 条来源不一致，点不进去」是同一个毛病（N100 的翻版）。

**改法**。新增 `/ccf review`：把 `catalogCoverage(...).weakMatches` 逐条列出来，每条带「对就 confirm、
不对就 ignore」两条命令：

```
待核对：8 条记录的全称与名单对不上（同简称可能是两个会，如 SEC / FSE、CVPR / CVPR Workshops）
  - SEC 2027：数据里的全称「ACM/IEEE Symposium on Edge Computing」更像名单里的 SEC
    对就 /ccf confirm SEC；不对就 /ccf ignore SEC
  …
裁决过的会不再出现在这里，用 /ccf marks 看已经标过什么。
```

细节：

- 用 `viewRecords(cache)`（与面板、清单同口径：去重 + 采信 + 剔掉坏的），不漏不错位；
- `marksOf(cache)` 传给 `catalogCoverage`，所以「就是这个会」确认过的记录自动从清单消失（否则这个清单永远清不掉）；
- 超过 20 条只列前 20，末尾说还剩几条，并指向面板；
- 名单读不到时直接报错（"缺了就没法判断这条记录对应名单里哪个会"），而不是给一份空清单假装"没有需要核对的"；
- `USAGE` 与 `/ccf status` 的待核对那行都指向 `/ccf review`。

**验证**。

```
$ /ccf review
待核对：8 条记录的全称与名单对不上（…）
  - IJCB 2027：数据里的全称「International Joint Conference on Biometrics」更像名单里的 IJCB
    对就 /ccf confirm IJCB；不对就 /ccf ignore IJCB
  …
```

`test/plugin.test.mjs` 新用例：造一条 `venue: 'SEC'` 但全称完全不像 SEC 的记录 → 断言出现「待核对：1 条记录」、
点出 `SEC 2027`、两条命令都在；随后 `/ccf confirm SEC`，再跑 `/ccf review` 必须是「没有需要核对的记录」。
`git stash push -- lib/create.js` 复跑 → `AssertionError: 未知子命令 "review"。`

**顺带**：这一轮没动面板——面板本来就有「建议核对」的卡片与两个按钮，缺的一直是命令侧这个入口。

## 第 77 轮：真实环境终于对上了（顺带修好「不一致 26」点进去只有 17 张）

### 一、真实环境回归：0.63→0.75 全部生效

桌面端这次重启后进程真的换成了新模块，活体接口自证：

| 检查项 | 结果 |
|---|---|
| `GET /dsh-ccf/api/v1/records` → `version` | `0.75.0`（此前一直是 0.62.0） |
| `versionDisk` / `versionStale` | `0.75.0` / `false`——0.64.0 加的"磁盘比进程新"提示不再误报 |
| 记录里还有没有 `cameraReady` | 402 条里 **0** 条（0.63.0 的「去掉 CR」在真机生效） |
| `counts.outside` / `outsideVenues` | `64 / 63`（0.50.0 的"条记录 vs 个会"分家） |
| `counts.satellites` / `satelliteVenues` | `9 / 8`（0.47.0 起卫星会不再混进名单外） |
| `counts.conflictsDecided` | `0`（0.67.0 的新字段，真机读得到） |
| `meta.marks` | `{ ignored: 0, confirmed: 0 }` |
| `ccf_venue SIGGRAPH` | 末尾出现「卫星会：数据里另有 ACM SIGGRAPH ASIA 2026…（不计入主会统计）」 |
| `ccf_deadlines days=10 conflictsOnly` | `VLDB 2027 · 来源冲突 · … 2026-11-02 09:00（16 小时后）` |

之前那次"系统提示已经是新文案、接口却报 0.62.0"，不是缓存错乱：`systemPrompt` 段与 `webServer` 路由是在不同时刻注册的，
进程里确实同时存在两代代码。结论写在这里：**接口自报的版本号才是真话，别用"某处文案变了"推断版本。**

### 二、真机顺手抓出的一个问题（N123）：「不一致 26」点进去只有 17 张

活体数据：402 条记录里 26 条是两个来源打架的，但其中 **9 条截稿早就过了**。
而面板「不一致」视图和 `/ccf list --conflicts` 默认都不列往届——于是红点写 26、点进去 17 张卡片。

同一类问题已经修过三次（N94 卫星会窗口数、N120 `--pending` 吞掉筛选条件、N119 记录数当会数），
这次栽在"按什么时间基准数"上：`isBigConflict` 只看两个源的日期差，不看这个日期是不是已经过去。

**改法**：

- `lib/ui.js` 的 `counts.conflicts` 增加"还没过截止"这一条（`row.deadline >= now`，用 `options.now` 而不是 `Date.now()`，
  否则测试写死的时间点会随真实时间漂移）；新增 `counts.conflictsPast` 单独数过期的。
- `lib/create.js` 的 `/ccf status` 同一口径：`来源：17 条…；另有 9 条已经过了截止（/ccf list --conflicts --past 看）`；
  全部过期时明说 `来源：没有还没到截止的冲突；9 条已经过了截止…`，而不是把这一行整段吞掉（那样读者会以为冲突清零了）。

**验证**：

```
$ node _probe4/conf.mjs        # 读真机缓存，用 lib/core.js 的同一套函数
records 402 future 133
conflicts all 26 conflicts future 17
conflicts past 9
ACL 2027 | COLT 2027 | CVPR 2027 | ECAI 2027 | IJCAI 2027 | NAACL 2027 | RSS 2027 | InterSpeech 2027
| ICDM 2027 | VLDB 2027 | WSDM 2027 | ISCA 2027 | IMC 2027 | SIGCOMM 2027 | FSE 2027 | USENIX Security 2027 | ISSTA 2027
```

改完 `counts.conflicts` 就是 17，与点进去的卡片数一致；9 条过期的在状态行里点名，`--conflicts --past` 能看。

测试：`test/ui.test.mjs` 加「`counts.conflicts` 不数已经过了截止的冲突」（一条未来的 + 一条 2025 年到期的 → `conflicts 1 / conflictsPast 1`）；
`test/plugin.test.mjs` 加「过了截止的冲突不算进来源，但要单独说一句」（只有一条过期冲突 → status 出现「没有还没到截止的冲突」与「1 条已经过了截止」）。
各自 stash 掉 lib 印证：`AssertionError: 只数还没到截止的那条`、`AssertionError: 没有未来的冲突时要明说，别让人去点空视图`。

## 第 78 轮：`/ccf review` 给的下一步命令，落到哪一届看运气

上一轮做了 `/ccf review`，真机上跑一遍发现命令本身有歧义：

```
  - SEC 2026：数据里的全称「ACM/IEEE Symposium on Edge Computing」更像名单里的 SEC
    对就 /ccf confirm SEC；不对就 /ccf ignore SEC
  - ACM SIGGRAPH 2026：…更像名单里的 SIGGRAPH
    对就 /ccf confirm ACM SIGGRAPH；…
  - SIGGRAPH 2027：…更像名单里的 SIGGRAPH
    对就 /ccf confirm SIGGRAPH；…
```

问题在于 `confirm`/`ignore` 是按**名字**解析记录的（`resolveRecordKey`），而同一个系列会有好几届同时留在缓存里。
`/ccf confirm SIGGRAPH` 到底改的是 2026 还是 2027，取决于记录的排序——确认完一届，另一届还得再确认一次，
两次命令长得还几乎一样，很容易以为已经处理过了。

**改法**：review 输出的命令改用 **key**（形如 `siggraph|2027`），key 里带年份，天然精确到届；
同系列还有其它届时，句尾补一句「命令里的 key 已经指定到这一届，同系列其它届要单独处理」。

```
  - SEC 2026：数据里的全称「ACM/IEEE Symposium on Edge Computing」更像名单里的 SEC
    对就 /ccf confirm sec|2026；不对就 /ccf ignore sec|2026
```

`writeMark`/`resolveRecordKey` 本来就支持带 `|` 的 key（`/ccf ignore "sec|2026"` 一直在文档里），
这次只是让 review 主动给出这种写法。

**验证**（真机 8 条全部变成 key 形式）：

```
对就 /ccf confirm ijcb|2027；不对就 /ccf ignore ijcb|2027
对就 /ccf confirm acm siggraph|2026；不对就 /ccf ignore acm siggraph|2026
对就 /ccf confirm siggraph|2027；不对就 /ccf ignore siggraph|2027
```

`test/plugin.test.mjs` 的 review 用例改成断言 `/\/ccf confirm sec\|2027/`、`/\/ccf ignore sec\|2027/`，
并用 `/ccf confirm sec|2027` 实际确认；另加同系列两届的场景（`siggraph|2026` + `siggraph|2027`）：

- review 必须同时给出两条命令；
- `/ccf confirm siggraph|2027` 之后，2026 届仍在清单里、2027 届消失。

`git stash push -- lib/create.js` 复跑 → `AssertionError: 下一步命令要精确到届（key），名字写「SEC」时分不清哪一届`。

**顺带**：这一轮是用真机数据做端到端巡检（`/ccf status`、`/ccf review`、`/ccf marks`、`/ccf list --conflicts 30` 一起跑），
其余三条输出与面板口径一致：`覆盖 109/253`、`名单外 63 个会（64 条记录）`、`卫星会 8 个（9 条记录）`、
`来源 17 条 + 另有 9 条已过截止`。

## 79. 第 77 轮：「模型：不可用」是个结论，说不出原因就等于让人猜

### 看到的现象

真机 `/ccf status` 印的是：

```
模型：不可用（只能回退到 ccfddl）
```

可是 0.65.0 那次真实补数据（`POST /dsh-ccf/api/v1/update {"focus":"CVPR","limit":1}`）的回执明明是 `model=True`。同一套代码，同一个宿主，两处判断打架，而界面上只有一句「不可用」——用户既不知道是自己没选模型，还是插件根本没拿到服务，也不知道该改哪里。

### 根因

`lib/miner.js` 的 `isModelAvailable(ctx)` 只回一个布尔值：

```js
export function isModelAvailable(ctx) {
  const llm = serviceOf(ctx, 'llm')
  return typeof llm?.stream === 'function'
}
```

而 `serviceOf` 为了不崩，把两条取服务的路径的异常全吞了（cordis 里 `ctx.llm` 在没声明 `inject` 时会抛 `cannot get property "llm" without inject`）。于是「没 inject」「服务没注册」「服务在但没有 `stream()`」「上下文压根没有 `ctx.get`」四种完全不同的处境，在界面上长成同一句话。

这也是这个插件反复出现的毛病：**结论印出来了，依据没有**。前面「待核对 8 条」没有入口（0.75.0 修）、「不一致 26」看不见冲突在哪（0.53.0 修）都是同一类。

### 改法

`lib/miner.js` 新增 `modelState(ctx)`，返回 `{ ready, reason, selection, hasGet }`，`isModelAvailable` 变成 `modelState(ctx).ready`（旧调用点不用动）：

| 处境 | reason |
| --- | --- |
| 没有 `ctx.get()` | 这个上下文没有 `ctx.get()`，读不到任何服务 |
| 读不到 llm | 没读到 llm 服务：宿主没把模型接给这个插件（或它比插件更晚注册） |
| 有 llm 没 `stream()` | 读到 llm 服务，但它没有 `stream()`（版本不匹配？） |
| 都正常 | 空字符串，并带上 `agentDefaultModel.currentSelection()` 的 `provider/model` |

配合三处出口：

1. `/ccf status` 的模型行：

```
模型：不可用 —— 没读到 llm 服务：宿主没把模型接给这个插件（或它比插件更晚注册）；补数据会退回 ccfddl 数据；上次补数据 11-01 15:20：用了模型
```

可用时是 `模型：可用（deepseek-account/deepseek-flash）`。**「上次补数据用没用模型」也接在同一行**——`cache.meta.modelUsed` 是 runUpdate 真实写下的结果，比任何探测都可信；两个说法再打架，一眼就能看出是"当时能用、现在读不到"。

2. 新命令 `/ccf model`，把依据摊开：

```
模型：可用
依据：读到 llm.stream()，当前选择 deepseek-account/deepseek-flash
上下文：有 ctx.get()
上次补数据：11-01 15:20，用了模型
```

不可用时多一段：`补数据仍能跑，但新会议只能用 CCFDDL / paper-deadlines 的现成数据；要让模型参与，先确认 DSH 里选好了默认模型，再重启一次桌面端。`

3. 面板：`lib/ui.js` 的 `meta` 增 `modelReason` / `modelSelection`（走 `api.modelState()`，每次请求重算），状态行从「· 无可用模型（只能同步）」变成带原因的写法。

### 验证

`test/miner.test.mjs` 四种处境各一条断言（含 `noGet.hasGet === false`）；`test/plugin.test.mjs` 新用例「/ccf model：模型不可用要说得清是哪种不可用」——假上下文没有 llm 时 status 必须出现 `模型：不可用 —— 没读到 llm 服务`、且**不得**再出现旧文案「不可用（只能回退到 ccfddl）」；注入 `{ async *stream() {} }` + `currentSelection` 后 `/ccf model` 必须写出 `deepseek-account/deepseek-flash`。

基线：package ok / yaml 5 / core 33 / sync 9 / catalog 29 / dedupe 3 / miner ok / plugin 39 / ui 33 / client 43 / `SMOKE OK` / `PANEL RENDER OK` / `INTEGRATION OK`。

### 这一轮学到的

- 「不可用」不是一个可行动的信息。**凡是"不可用/失败/为空"，都要在同一行给出依据和下一步**，否则用户只能重启、重装、或者来问我。
- 探测要落到**实际发生过的事实**上：`meta.modelUsed` 是 runUpdate 写的，`modelState` 是现在探测的，两者并排印出来，才解释得清「当时能用、现在读不到」这种矛盾。
