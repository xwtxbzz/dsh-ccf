# dsh-ccf

> 给定一句话，知道下一个 CCF 截稿还有几天。

DSH 插件：把 CCF 会议的**截稿时间**变成 agent 真正知道的事实——工具能查、命令能筛、系统提示里常驻最近 30 天的截稿。

<!-- 徽章位置：发布到 GitHub 后替换为 CI / npm 徽章 -->

## 它解决什么

| 没有它 | 有它 |
| --- | --- |
| 问「CVPR 什么时候截稿」，agent 凭训练记忆编一个日期 | `ccf_deadlines` 返回数据里的真实日期 + 倒计时 + 官方主页 |
| 要自己开三个网页核对 AoE 与北京时间 | 时间在返回时已按 `Asia/Shanghai` 换算，并标注 AoE 来源 |
| 想起某个会时才去查，容易错过 | 系统提示里常驻「未来 30 天 5 个截稿」，每轮都看得见 |
| 数据来源不明、过期了也没人知道 | 缓存带 `updatedAt`，超过 `staleHours` 就不再注入，明确显示"数据未同步" |

**边界（重要）**：插件**不内置任何日期**。首次使用必须 `/ccf sync` 拉一次数据；离线时用上次缓存，从不编造。

## 安装

本包依赖 DSH 4 及 `@deepseek-ai/dsh-tools@>=0.1.0-rc.6`。

**A. 从 Git 仓库装**

```bash
dsh plugin --profile desktop add git+https://github.com/xwtxbzz/dsh-ccf.git
```

**B. 从本地目录装**（改代码时方便）

```bash
dsh plugin --profile desktop add file:D:\doctor\dsh-ccf
```

**C. 手动挂载**：把包名加入 profile 的 `dsh.profile.bundles`，然后重启 DSH。

装完重启 DSH（无客户端代码，不需要 `dev:web`）。确认加载：

```bash
dsh plugin --profile desktop list | grep ccf
```

## 60 秒上手

```text
/ccf sync                 # 拉一次数据（唯一必须做的准备）
/ccf list                 # 未来 120 天，按截稿升序
/ccf list --rank CCF-A    # 只看 A 类
/ccf list --area CV --limit 5
/ccf list --search neur   # 名字模糊搜
/ccf venue CVPR           # 单个会议的详情 + 往届截稿 + 录用率
/ccf status               # 缓存来自哪、多久前同步、多少条
/ccf config               # 当前生效配置
```

对应工具（agent 自己会调）：

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `ccf_deadlines` | `days` `rank` `area` `search` `limit` `includePast` `refresh` | 按窗口/等级/方向列出截稿 |
| `ccf_venue` | `venue` `refresh` | 查单个会议（精确优先，否则模糊） |

`refresh` 置真时先同步再回答——适合"我现在就要最新日期"的场景，代价是等一次网络。

## 配置

写在 profile 的插件 config 里（或项目根的 `dsh-ccf.json`，命令行用 `/ccf config` 查看生效值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `sources` | 见下 | 数据源数组，`{id, type, url/path}`，`type` = `json` / `ccfddl-dir` / `ccfddl-tar` |
| `windowDays` | `120` | `/ccf list` 默认往后看多少天 |
| `leadDays` | `30` | 系统提示里列多近的截稿 |
| `maxPromptItems` | `8` | 系统提示最多列几条 |
| `prompt` | `true` | 是否注入系统提示段 |
| `timezone` | `Asia/Shanghai` | 展示与解析用的时区 |
| `staleHours` | `168` | 缓存超过这么多小时就不再注入提示（列表/工具仍可用并提示过期） |
| `timeoutMs` | `20000` | 单次抓取超时 |
| `dataDir` | `~/.dsh/ccf` | 缓存目录 |

默认源只有一个公开 JSON（[paper-deadlines](https://yzyhhhstudy.github.io/paper-deadlines/data.json)），它自带显式时区偏移，所以不需要手算 AoE。想要社区权威数据时，把 [ccfddl](https://github.com/ccfddl/ccf-deadlines) 加进 `sources`：

```json
{
  "sources": [
    { "id": "paper-deadlines", "type": "json", "url": "https://yzyhhhstudy.github.io/paper-deadlines/data.json" },
    { "id": "ccfddl-tar", "type": "ccfddl-tar", "url": "https://github.com/ccfddl/ccf-deadlines/archive/refs/heads/main.tar.gz" },
    { "id": "ccfddl-local", "type": "ccfddl-dir", "path": "D:/repos/ccf-deadlines" }
  ]
}
```

多源按顺序合并，同一个 `venue|year` 先到者优先、空字段由后到者补。任一源失败不影响其他源；**全部失败时保留旧缓存**，只更新 `lastAttemptAt` 与 `lastError`。

## 数据与时间语义

- 每条记录带 `deadline`（截稿）、`abstractDeadline`（摘要截止）、`notification`（通知）、`confDate`（会期）、`rank`（CCF-A/B/C/Non-CCF）、`area`、`link`、`history`（往届截稿）、`acceptRate`、`h5`。
- 解析顺序：有显式偏移（`-08:00` / `Z`）→ 直接 `Date.parse`；无偏移 → 按 `timezone` 解释；只有日期 → 当天 `23:59:59`。
- AoE（Anywhere on Earth）= UTC-12，源码里是常量 `-720` 分钟，与 DST 无关（AoE 没有夏令时）。
- 展示一律换算到 `timezone`，并附倒计时（`3 天 21 小时后` / `已过 177 天 2 小时`）。
- 缓存文件 `~/.dsh/ccf/cache.json`，schema `dsh-ccf/cache/v1`，可直接删掉重同步。

## 已知限制

- 数据准确性取决于上游。插件只做归一化与换算，不判断"这个会议今年是否还办"。
- 覆盖 71 个有截稿日期的主会（含 AI/ML、CV、NLP、Systems、Security、DB、HCI、Theory 等），**没有** BIBM / ISMB / RECOMB / MICCAI 这类生物信息与医学影像会议——因为上游数据里就没有。
- 第三方 `ccfddl-tar` 源需要能访问 GitHub，国内网络下可能失败（此时用本地 `ccfddl-dir` 或只用默认 JSON 源）。
- 系统提示段是纯文本摘要，太长会挤占上下文，所以有 `maxPromptItems` 与 `staleHours` 两道闸。

## 开发

```bash
cd dsh-ccf
node test/yaml.test.mjs     # YAML 子集解析
node test/core.test.mjs     # 时区/倒计时/归一化/查询/提示
node test/sync.test.mjs     # JSON/目录/tar.gz/缓存（本地 HTTP，不联网）
node test/plugin.test.mjs   # 工具/命令/提示挂载（假 ctx）
node test/sdk-smoke.mjs     # 真 SDK 编译 schema（找不到 SDK 会 SKIP）
```

Windows 上先 `$env:NODE_NO_WARNINGS='1'`；`node --test <dir>` 在受限沙箱里会 EPERM，逐文件跑。

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 提示里没有截稿段 | 从未同步，或缓存超过 `staleHours` | `/ccf sync`；`/ccf status` 看 `updatedAt` |
| `sync` 报 `ECONNRESET` | 网络到不了源 | 换 `ccfddl-dir` 本地源，或稍后重试 |
| 时间差 8 小时 | 上游给的是 UTC 无偏移，而 `timezone` 配成了 UTC | 保持 `Asia/Shanghai`，或核对上游字段 |
| 搜不到某会议 | 上游没有该会 | 这是数据边界，不是 bug |
| 装了但 `/ccf` 不存在 | profile 的 `bundles` 没含包名 | 加进 bundles 后重启 |

## 许可

MIT
