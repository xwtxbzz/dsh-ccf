# 市场对照：为什么还需要一个会议截稿插件

本文的数据都来自公开目录，采集时间 2026-10-31，可复现。

## 数据来源与口径

- 目录全量快照：`https://awesome-dsh-plugin.com/plugins.json`（9,229,852 字节，落盘为 `market_catalog.json`）。
- 统计口径：对每个条目的 `name`、`description.en`、`description.zh`、`keywords`、`category`、`source` 拼成一段文本做小写子串匹配（不是只匹配名字，避免漏掉"描述里提到但名字没提"的条目）。
- 总条目 **7,924 个**，分 23 类（`ui` 1558、`tools` 1061、`session` 567、`dev` 474、`workflow` 442、`model` 419、`usage` 418、`memory` 344、`theme` 310、`notify` 287、`skill` 285、`fun` 261、`remote` 238、`security` 216、`browser` 165、`vision` 161、`git` 161、`docs` 127、`market` 112、`voice` 102、`wsl` 82、`identity` 80、`agi` 54）。

## 命中情况

| 关键词 | 命中数 | 说明 |
| --- | --- | --- |
| `ccf` | **0** | 没有任何条目提到 CCF |
| `conference` | **0** | — |
| `deadline` | 4 | 全部与学术会议无关，见下 |
| `academic` / `scholar` / `arxiv` | 34 | 文献检索、写作、引用为主 |

`deadline` 的 4 个命中逐条核实：

| 条目 | `deadline` 的实际含义 |
| --- | --- |
| `dsh-minimal-UI-panels` | 终端命令 120 秒超时 |
| `dsh-tender-requirements` | 招标文件里抽"截标日期"这个字段 |
| `dsh-memoryleak` | 待办事项的一种类型（带截止时间） |
| `dsh-subagent-control#human-wait` | 人工介入等待的超时 |

学术方向最接近的几个（按 stars 排序，均为采集时快照）：

| 条目 | stars | 实际做什么 | 有没有截稿能力 |
| --- | --- | --- | --- |
| `EduWork#dsh-literature` | 262 | DBLP + arXiv 检索、BibTeX 获取、全文抓取 | 无 |
| `dsh-scholar` | 56 | "Academic assistant plugin."（描述就这一句） | 无 |
| `dsh-plugin-writing-guard` | 46 | 中英文学术写作防 AI 味、保护科学论断 | 无 |
| `dsh-ai4scholar` | 37 | 38 个工具覆盖 Semantic Scholar / PubMed / Google Scholar / arXiv / bioRxiv | 无 |
| `dsh-academic-research-skills` | 23 | 移植自 ARS 的研究技能包 | 无 |
| `dsh-literature` | 8 | 本地文献库 + Zotero 导出 + 全文抓取 | 无 |
| `dsh-zotero` / `dsh-cite` / `dsh-reference-checker` | — | 引用管理、GB/T 7714 格式化、引文核对 | 无 |

**结论：这个市场里有 34 个"找论文"的插件，0 个"管截稿"的插件。** 找论文解决"读什么"，截稿解决"什么时候必须交"，是两件事。

## 与近邻的差异维度

对比对象取功能最接近的三类：文献检索类（`EduWork#dsh-literature`、`dsh-ai4scholar`）、日程任务类（`dsh-personal-workbench`）、提醒类（`notify` 分类下的若干）。

| 维度 | 文献检索类 | 日程/提醒类 | dsh-ccf |
| --- | --- | --- | --- |
| 回答的问题 | 有哪些相关论文 | 我今天有什么日程 | 这个会哪天截稿、还剩几天 |
| 数据来源 | DBLP / arXiv / Semantic Scholar 实时查 | 用户自己录入 | 公开会议数据集，带 CCF 等级与方向 |
| 时间语义 | 不管 | 用户填的时间 | 解析 AoE / 显式偏移 → 换算本地时区 |
| 失效判定 | 每次实时查 | 无 | 缓存 `updatedAt` + `staleHours`，过期不注入 |
| 上下文成本 | 每次检索返回一堆论文 | 无 | 常驻 ≤8 行摘要，可关 |
| 准确性态度 | 依赖检索结果 | 依赖用户输入 | **不内置日期**，宁可显示"未同步"也不编 |

## 明确不做的事

- 不做文献检索（已有 34 个插件做得更好）。
- 不做日程管理（`dsh-personal-workbench` 已覆盖）。
- 不做投稿提醒推送（通知类插件更专业）。
- 不猜日期：上游没有的会，就承认没有。

## 与 ccfddl 的关系

[ccfddl/ccf-deadlines](https://github.com/ccfddl/ccf-deadlines) 是社区维护的权威数据，但它是一个**仓库**，不是插件：agent 不会主动去读它，也不会把"CVPR 还有 13 天"放进上下文。dsh-ccf 做的是把那份数据变成 DSH 里可调用、可过滤、可常驻的东西，并保留把它作为数据源（`ccfddl-tar` / `ccfddl-dir`）的能力。两者是数据与消费的关系，不是替代。
