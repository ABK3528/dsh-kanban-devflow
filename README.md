# dsh-kanban-devflow

> **在看板卡片里和 AI 对话，让它走完「讨论 → 计划 → 编码 → 测试 → 验收 → 发布」。你只需要回复和拍板。**
>
> A kanban-driven dev-delivery workflow for DeepSeek Harness (DSH) desktop, built on [@alpacachen/dsh-kanban](https://github.com/alpacachen/dsh-kanban). You talk to role agents through card comments; a bridge keeps the board and the Workflow engine in sync. Docs are in Chinese.

![看板总览：6 个甬道，卡片随流程自动移动](docs/images/board.png)

**目录**：👉 [**快速安装**](#安装) ｜ [它是什么](#它是什么) ｜ [流程一览](#流程一览) ｜ [看图了解](#看图了解) ｜ [日常怎么回复](#日常怎么回复) ｜ [功能细节](#功能细节) ｜ [文件目录](#文件目录) ｜ [常见问题](#常见问题) ｜ [安全边界](#安全边界) ｜ [致谢与许可](#致谢与许可)

## 它是什么

这是 [@alpacachen/dsh-kanban](https://github.com/alpacachen/dsh-kanban) 插件的**改造套件**。一条命令装好看板插件和补丁，之后在 DSH 里打开 git 项目就自动接入。它包含这些东西：

| 组成 | 作用 |
|---|---|
| **项目自动接入** | 打开项目时自动配好流程手册、角色、Workflow、看板甬道和标签、文档骨架 |
| **研发流程** | 一条 9 阶段的「研发交付」Workflow，需求、改进、缺陷、技术债都走它 |
| **四个角色 agent** | 讨论、实施、测试、发布，各有职责定义和记忆。测试只报告缺陷，不改代码 |
| **看板 ⇄ Workflow 同步桥** | 卡片跟着阶段换甬道、打标签、贴评论；你在卡片里的回复变成关卡决定 |
| **看板 UI 增强** | 多选标签、GitLab 风格评论时间线、评论贴图、产物在卡片里预览、实时保存 |

**适合谁**：在 DSH 桌面版里用 AI 写代码的个人开发者。你想让 AI 按固定流程工作、留下文档和测试记录，自己只在关键节点把关。

## 流程一览

![研发交付流程：9 个阶段，带打回边](docs/images/flow.png)

```
讨论 → ◆讨论确认 → 实施计划 → 编码 → 测试 → ◇测试关卡 → 验收准备 → ◆验收 → 发布
                                    ↑_____________|（有缺陷自动打回，最多 5 轮）
```

- **◆ 人工关卡**：卡片带上「待人工确认」标签时就在等你。讨论确认打回到「讨论」，验收打回到「实施计划」。
- **◇ 自动关卡**：同步桥读测试结论，有缺陷就打回编码，连续 5 轮没通过才交给你。
- 其余阶段全自动，你不用盯。

## 看图了解

**每个阶段一条评论，产物精简后直接贴在卡片上**。文档名是链接，点开在卡片里看全文。

![讨论 agent 的阶段评论：要点精简 + 文档链接](docs/images/stage-comment.png)

**关卡提醒列出「待你拍板」的问题和推荐选项**。你回复「通过」加选择，同步桥确认后流程继续。

![关卡提醒与回复](docs/images/gate.png)

<table>
<tr>
<td width="50%"><b>卡片描述末尾自动维护「阶段成果」表</b><br><img src="docs/images/card.png" alt="阶段成果汇总表"></td>
<td width="50%"><b>点评论里的文档链接，在卡片里预览全文</b><br><img src="docs/images/preview.png" alt="卡片内文档预览"></td>
</tr>
</table>

## 安装

**前提**：DeepSeek Harness 桌面版 0.2.2-rc.5 或更新版本（在 0.2.2-rc.5 上用过），终端里能运行 `dsh`；电脑上有 Node.js 18+ 和 git。**不需要**先装看板插件。

**第 1 步：一条命令装好**。先完全退出 DSH，在终端里粘贴运行，然后重新打开 DSH：

```bash
git clone https://github.com/ABK3528/dsh-kanban-devflow.git ~/code/dsh-kanban-devflow && node ~/code/dsh-kanban-devflow/bridge/install.mjs
```

这条命令会：

1. 没装 `@alpacachen/dsh-kanban`，或装的不是补丁适配的版本（比如之前的 1.12.1），就装上适配的 1.13.1。这个版本声明兼容 DSH 0.2.2-rc.5；你的 DSH 是别的版本时，会先为这一对精确版本授权（`dsh plugin allow-version … --accept-risk`，DSH 提示可能崩溃或数据损坏）。装插件、换版本或授权前，会先把 profile 的 `package.json`、`pnpm-lock.yaml`、`compatibility.json` 备份到 `~/.dsh/profiles/desktop/workflow-poc/install-backup-<时间>/`。
2. 给插件打补丁，加载同步桥和看板界面增强。插件原文件备份在 `workflow-poc/kanban-bridge-orig-<版本>/`。三个文件先在内存里全部打完，任何一处对不上就一个都不写，不会改坏插件。

需要装插件、换版本或授权时，DSH 必须是退出状态，否则命令会提示你先退出。DSH 版本低于 0.2.2-rc.5 时，命令会提示先升级 DSH。已经装好、版本也已授权的，DSH 开着也能跑，跑完重启 DSH 即可。

**第 2 步：打开项目就行**。重新打开 DSH 后，你在 DSH 里打开的每个 **git 项目**都会在几秒内自动接入全套：

| 内容 | 怎么处理 |
|---|---|
| 流程手册 `docs/process/WORKFLOW.md`、四个角色 `docs/process/agents/` | 用套件版本覆盖。项目里原来的版本不同时，先备份到 `<项目>/.dsh/kit-backup/<时间>/` |
| 「研发交付」Workflow | 没有就创建；有但和套件不同就更新（各阶段已选的模型保留） |
| 看板甬道 | 6 个甬道按顺序排在最前，「关闭」设为完成列。其他甬道里没有卡片的删掉，有卡片的保留在最后 |
| 看板标签 | 补齐 11 个「组::名」标签，旧的不分组标签原地改名 |
| 文档骨架 `docs/VISION.md`、`ARCHITECTURE.md`、`TEST_STRATEGY.md`、`DEPLOY.md`、`CHANGELOG.md` 等 | 只补缺的，已有的不动 |
| `.gitignore` | 追加 `.dsh/` 和 `.dsh-kanban.json` |

- 接入只写文件，**不提交**。看一眼改动，自己提交即可。骨架里的 TODO（特别是 `DEPLOY.md` 和 `TEST_STRATEGY.md` 的「命令」节）需要你或 AI 补上。
- 每个项目只接入一次。之后只有套件更新（`git pull` 后重启 DSH）时，才会再按上表覆盖一次。
- 不想接入某个项目：在项目根目录建一个空文件 `.dsh-devflow-off`。想全部关掉自动接入：启动 DSH 前设环境变量 `DSH_DEVFLOW_AUTO=0`（已接入的项目照常同步和更新）。
- 不是 git 仓库的目录不会被接入。

**第 3 步：建第一张卡**。在看板「开始」甬道新建一张卡，类型选「需求」，描述写清楚要做什么。卡片出现「待人工确认」后，回复「开始」，再去掉这个标签。之后卡片会自己往前走，到关卡再来找你。

**其他**

- 装完后不要移动或删除 `~/code/dsh-kanban-devflow`，补丁里记录的是它的路径。
- 更新套件：`git -C ~/code/dsh-kanban-devflow pull && node ~/code/dsh-kanban-devflow/bridge/install.mjs`，然后重启 DSH。
- 还原插件补丁：`node ~/code/dsh-kanban-devflow/bridge/install.mjs --remove`（插件本身保留；彻底卸载再运行 `dsh plugin --profile desktop remove @alpacachen/dsh-kanban`）。
- 想确认补丁在不在：`node ~/code/dsh-kanban-devflow/bridge/install.mjs --check`（只读，不改文件）。
- 用的不是默认的 `~/.dsh/profiles/desktop` 时，加环境变量 `DSH_PROFILE_DIR=<profile 目录>`。

安装出问题，先看下面的「常见问题」。

## 日常怎么回复

在卡片评论里回复，**然后去掉「待人工确认」标签**，同步桥才会执行：

| 回复 | 用在哪里 | 效果 |
|---|---|---|
| `开始` | 「开始」甬道的新卡 | 创建任务并启动 |
| `通过`（可接附言） | 讨论确认、验收、测试关卡 | 放行到下一阶段，附言会交给后续阶段 |
| 其他任何内容 | 同上 | 当作修改意见打回，卡片打「返工」 |
| `重试` | 卡片带「失败」时 | 重跑当前阶段；发布失败时新建只重新发布的任务 |
| `终止` | 任何等待中的卡 | 结束任务，卡片进「关闭」并打「已取消」 |

发布阶段要合并代码、打 tag，需要你到 Workflow 任务详情点开「发布」节点，选「等待审批」→「允许一次」。完整规则见 [WORKFLOW.md](WORKFLOW.md) 第 5 节。

## 功能细节

- **测试独立于实施**：测试 agent 只把缺陷写进 `defects.md`；实施 agent 逐条回应后修复，再测。
- **隔离的工作副本**：每张卡在 `.dsh/workflow-artifacts/<taskId>/repo` 的 `dev/<ID>` 分支上开发，主工作区保持只读，直到发布。
- **标签按「组::名」分组**：类型、状态、原因、标记、结果，同组互斥。看板上只显示短名，悬停显示全名。
- **评论按角色署名**：讨论、实施、测试、发布 agent 和同步桥各有头像和颜色，历史评论同样生效。
- **评论时间线**：相对时间、阶段和结果标签片、复制原文、Markdown 渲染；可以粘贴、拖入或插入图片，点击放大。
- **卡片详情实时保存**：没有「保存」按钮；标签片带 ✕，一点即删。

## 文件目录

| 文件 | 作用 |
|---|---|
| `WORKFLOW.md` | 研发流程手册：通用规则、交接卡、文档地图、关卡和看板约定。接入时复制到项目的 `docs/process/WORKFLOW.md` |
| `agents/` | 四个角色 agent：`discuss`、`build`、`test`、`release`，各含 `AGENT.md`（职责、步骤、输入输出、禁止事项）和 `memory.md`。接入时复制到项目的 `docs/process/agents/` |
| `templates/` | 文档骨架（VISION、ROADMAP、ARCHITECTURE、TEST_STRATEGY、用例库说明、DEPLOY、CHANGELOG），接入时项目里缺哪个补哪个 |
| `workflows.json` | 「研发交付」Workflow 定义（9 个阶段），由 `build-workflows.mjs` 生成 |
| `PROMPTS.md` | 日常使用、审核验收、同步桥说明，以及手动接入的提示词 |
| `bridge/kanban-bridge.mjs` | 看板 ⇄ Workflow 同步桥，运行在 DSH Host 进程内 |
| `bridge/provision.mjs` | 项目自动接入：写文件、创建或更新流程、排甬道 |
| `bridge/install.mjs` | 安装看板插件或换成适配版本（必要时授权 DSH 版本），给它打补丁或还原 |
| `test/` | `node --test test/`：接入逻辑和同步桥接入流程的测试，不碰真实 DSH |
| `bridge/ui/` | 注入插件前端的源码：标签选择器、评论时间线、产物预览、卡片弹窗实时保存 |
| `docs/design/stage-agents.md` | 设计文档：角色 agent、测试独立、评论精简等的设计与取舍 |
| `docs/images/` | README 截图 |

## 常见问题

**看板插件报错或不见了（之前装的是 1.12.1）**

套件以前适配的是 dsh-kanban 1.12.1，它只声明兼容 DSH 0.2.2-rc.3。DSH 0.2.2-rc.5 开始只加载声明兼容当前版本的插件，所以 1.12.1 会被跳过或报错。现在套件适配 1.13.1（声明兼容 rc.5）。完全退出 DSH，运行下面这条，再重新打开 DSH：

```bash
git -C ~/code/dsh-kanban-devflow pull && node ~/code/dsh-kanban-devflow/bridge/install.mjs
```

`install.mjs` 会把插件从 1.12.1 换成 1.13.1 并重新打补丁。换版本前会备份 profile 的 `package.json`、`pnpm-lock.yaml`、`compatibility.json`；看板数据存在各项目的 `.dsh-kanban.json` 里，换插件版本不会动它。

**升级 DSH 后看板插件不见了**

DSH 只加载声明兼容当前版本的插件。授权是按「插件版本 + DSH 版本」精确记录的，DSH 升级到插件没声明的版本后都要重新授权：退出 DSH，重跑一次 `install.mjs`，它会发现新版本没授权并补上（也可以手动运行下面这条）。

```bash
dsh plugin --profile desktop allow-version @alpacachen/dsh-kanban@1.13.1 --dsh-version <你的 DSH 版本> --accept-risk
```

DSH 提示这可能导致崩溃或数据损坏，介意的话先备份 `~/.dsh`。

**项目被自动接入后想撤回**

接入不会提交。用 `git status` 看改动，`git checkout`/删除不想要的文件即可；被覆盖的旧版流程手册和角色定义在 `<项目>/.dsh/kit-backup/<时间>/`。再建一个空文件 `.dsh-devflow-off`，以后就不会再接入。看板和 Workflow 的改动要在 DSH 界面里手动改回。

**我改过项目里的 WORKFLOW.md 或角色定义**

套件更新后第一次同步会覆盖它们，旧版备份在 `<项目>/.dsh/kit-backup/<时间>/`。想长期保留自己的改法，改套件仓库里的 `WORKFLOW.md` 和 `agents/`（会同步到所有项目），或者给这个项目建 `.dsh-devflow-off`。

**安装时提示「不是这套补丁适配的版本」**

补丁靠精确锚点改插件源码，`dsh-kanban` 每次发版打包产物的变量名都可能变，所以只对适配过的版本（目前 1.13.1）生效。完全退出 DSH，不带参数重跑 `install.mjs`，它会自动换成 1.13.1 再打补丁。

确认要拿没适配的版本试打，可以加 `--force`（不换插件版本）；锚点对不上时脚本会把所有文件先在内存里试打完再决定写不写，失败不会留下半打补丁的状态。

**升级 dsh-kanban 插件后补丁没了**

完全退出 DSH，重新运行 `install.mjs`，再打开 DSH。插件被升级到没适配的版本时，`install.mjs` 会换回适配的版本再打补丁。想用新版本，要等套件适配后 `git pull` 再跑。

**改了代码不生效**

改 `bridge/kanban-bridge.mjs` 要重启 DSH。只改 `bridge/ui/` 的话，重跑 `install.mjs` 再刷新看板页面即可。不确定补丁在不在，用 `install.mjs --check` 看。

## 安全边界

- 只有人在看板界面上操作（`activity.source === 'human'`）才会触发决定；AI 用 `kanban_*` 工具改标签不算。
- 唯一的例外是测试关卡：同步桥按测试结论自动通过或打回编码，决定记为 `bridge-auto`。它不会放行未通过的测试；连续 5 轮未通过、结论认不出来或测试阻塞时，一律交给你。
- 发布阶段要写主工作区，需要你在 Workflow 节点弹窗里点「允许一次」，同步桥不能代点。
- 同步桥只自动接入 git 项目，跳过有 `.dsh-devflow-off` 的项目；只处理「研发交付」流程的任务。
- 接入时覆盖文件前先备份，不提交，不删除有卡片的甬道，不动卡片。

## 致谢与许可

- 基于 [alpacachen/dsh-kanban](https://github.com/alpacachen/dsh-kanban)（MIT）。`install.mjs` 会在本机修改该插件的文件，并备份原文件以便还原；本仓库不包含该插件的源码。
- 本项目以 [MIT](LICENSE) 许可发布。与 DeepSeek 和 dsh-kanban 作者无关，不是官方项目。
