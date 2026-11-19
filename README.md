# dsh-kanban-devflow

> 让 AI 按「讨论 → 计划 → 编码 → 测试 → 验收 → 发布」走完研发流程，人只在看板上回复和拍板。
>
> A kanban-driven dev-delivery workflow for DeepSeek Harness (DSH) desktop, built on top of [@alpacachen/dsh-kanban](https://github.com/alpacachen/dsh-kanban). You talk to the AI through kanban card comments; a bridge keeps the board and the Workflow engine in sync. Docs are in Chinese.

这是 [@alpacachen/dsh-kanban](https://github.com/alpacachen/dsh-kanban) 插件的**改造套件**（不是独立插件）：给插件打一个小补丁，加入一个看板 ⇄ Workflow 同步桥、一套研发流程手册和一条 8 阶段的 Workflow 定义。

## 能做什么

- **一条流程覆盖所有工作**：需求（REQ）、改进（IMP）、缺陷（BUG）、技术债（DEBT）都走「研发交付」：

  ```
  讨论 → ◆讨论确认 → 实施计划 → 编码 → 测试 → ◇测试关卡 → 验收准备 → ◆验收 → 发布
                                      ↑______________|（有缺陷，最多 5 轮）
  ```

  ◆ 是人工关卡。讨论确认打回到「讨论」；验收打回到「实施计划」。
- **测试独立于实施**：每个阶段由一个角色 agent（讨论、实施、测试、发布）执行。测试只报告、不改代码，缺陷写进 `defects.md`；◇测试关卡由同步桥自动决定，有缺陷就打回编码，实施角色逐条回应后修复，连续 5 轮未通过才找你。
- **在看板上操作**：6 个甬道（开始、需求/技术讨论、实施、测试中、待验收、关闭），标签按「组::名」分组，表示类型和状态（状态::AI处理中、状态::待人工确认、原因::阻塞、标记::返工、结果::已发布……）。在卡片里回复「开始」「通过」「重试」「终止」或者直接写修改意见，再去掉「待人工确认」标签，同步桥就会替你执行。
- **产出物直接贴在卡片上**：每个阶段的报告，以及 PRD、技术方案、测试用例、实施计划、测试报告、发布说明，都会以评论形式出现在卡片里；描述末尾自动维护一张「阶段成果」汇总表，一眼看清每个阶段的结果和要点。
- **隔离的工作副本**：每张卡在 `.dsh/workflow-artifacts/<taskId>/repo` 的 `dev/<ID>` 分支上开发，主工作区只读；发布阶段需要你在 DSH 里点一次「允许一次」才会合并、打 tag。
- **看板 UI 增强**：卡片多标签、GitLab 风格的下拉多选标签选择器（标签片带 ✕，一点即删）、卡片详情实时保存（无「保存」按钮）、GitLab 风格的评论时间线（头像、相对时间、阶段/结果标签片、复制原文、Markdown 渲染）、评论里粘贴/拖入/插入图片并点击放大。

## 目录

| 文件 | 作用 |
|---|---|
| `WORKFLOW.md` | 研发流程手册：通用规则、交接卡、文档地图、关卡和看板约定。接入时复制到项目的 `docs/process/WORKFLOW.md` |
| `agents/` | 四个角色 agent 的定义：讨论 `discuss`、实施 `build`、测试 `test`、发布 `release`。每个角色有 `AGENT.md`（职责、各阶段步骤、输入、输出、禁止、记忆）和 `memory.md`（角色通用记忆）。接入时复制到项目的 `docs/process/agents/` |
| `workflows.json` | 「研发交付」Workflow 定义（9 个阶段），由 `build-workflows.mjs` 生成 |
| `build-workflows.mjs` | 生成 `workflows.json` |
| `PROMPTS.md` | 接入项目、日常使用、同步桥说明 |
| `bridge/kanban-bridge.mjs` | 看板 ⇄ Workflow 同步桥，运行在 DSH Host 进程内 |
| `bridge/install.mjs` | 给本机的 dsh-kanban 插件打补丁 / 还原 |
| `bridge/ui/` | 补丁注入插件前端的源码：标签多选、评论时间线与评论图片、卡片弹窗实时保存 |
| `docs/design/stage-agents.md` | 设计：每个阶段由独立 agent 处理（角色、技能、记忆、交接契约）。第一期（角色化）和第二期（测试独立）已实施 |

## 环境要求

- DeepSeek Harness 桌面版（在 0.2.2-rc.3、0.2.2-rc.5 上用过）
- 在 DSH 里装好 `@alpacachen/dsh-kanban`（在 1.12.1 上用过）
- Node.js 18+、git

## 快速开始

1. 克隆本仓库，**之后不要再移动目录**：补丁里记录的是同步桥文件的绝对路径。

   ```bash
   git clone https://github.com/ABK3528/dsh-kanban-devflow.git ~/code/dsh-kanban-devflow
   ```

2. 安装补丁，然后完全退出并重新打开 DSH 桌面版：

   ```bash
   node ~/code/dsh-kanban-devflow/bridge/install.mjs
   ```

   还原：`node ~/code/dsh-kanban-devflow/bridge/install.mjs --remove`。默认 profile 是 `~/.dsh/profiles/desktop`，可以用环境变量 `DSH_PROFILE_DIR` 指定别的 profile。

3. 在项目工作区的普通聊天里发送 `PROMPTS.md` 第一节的「项目接入」提示词（把 `KIT` 换成克隆路径）。它会整理看板甬道和标签、复制流程手册、补文档骨架，并创建「研发交付」流程。

4. 在看板「开始」甬道建一张卡，标题写 `REQ-001 你的需求`，在卡片里回复「开始」，再去掉「待人工确认」标签。

详细说明见 [PROMPTS.md](PROMPTS.md) 和 [WORKFLOW.md](WORKFLOW.md)。

## 常见问题

**升级 DSH 后看板插件不见了**

DSH 0.2.2-rc.5 开始只加载声明兼容当前版本的插件。dsh-kanban 1.12.1 只声明了 0.2.2-rc.3，所以启动时会被跳过。在插件作者发布新版本之前，可以先退出 DSH，自行承担风险，为当前这对精确版本授权：

```bash
dsh plugin --profile desktop allow-version @alpacachen/dsh-kanban@1.12.1 --dsh-version 0.2.2-rc.5 --accept-risk
```

DSH 提示这可能导致崩溃或数据损坏，授权前请备份 `~/.dsh`。

**升级 dsh-kanban 插件后补丁没了**

重新运行 `install.mjs` 并重启 DSH。如果插件代码改动太大，`install.mjs` 会报「锚点出现 0 次」，并且不做任何修改，需要先适配补丁。

**改了 `kanban-bridge.mjs` 不生效**

重启 DSH 才会加载新代码。

## 安全边界

- 只有人在看板界面上操作（`activity.source === 'human'`）才会触发决定；AI 用 `kanban_*` 工具改标签不算。
- 唯一的例外是测试关卡：同步桥按测试结论自动通过或打回编码，决定记为 `bridge-auto`。它不会放行未通过的测试，连续 5 轮未通过、结论认不出来或测试阻塞时一律交给你。
- 发布阶段要写主工作区，需要你在 Workflow 节点弹窗里点「允许一次」，同步桥不能代点。
- 同步桥只处理根目录有 `docs/process/WORKFLOW.md` 的工作区，以及「研发交付」流程的任务。

## 致谢与许可

- 基于 [alpacachen/dsh-kanban](https://github.com/alpacachen/dsh-kanban)（MIT）。`install.mjs` 会在本机修改该插件的文件，并备份原文件以便还原；本仓库不包含该插件的源码。
- 本项目以 [MIT](LICENSE) 许可发布。与 DeepSeek 和 dsh-kanban 作者无关，不是官方项目。
