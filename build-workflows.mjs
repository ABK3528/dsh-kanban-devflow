// 生成 workflows.json：唯一一条 dsh-kanban Workflow「研发交付」。
// 每个 AI 阶段由一个角色 agent 执行：阶段提示词只指向项目里的 docs/process/WORKFLOW.md 和 docs/process/agents/<角色>/AGENT.md。
import { writeFileSync } from 'node:fs'

// 角色 → 负责的阶段。阶段 id 和标题被同步桥使用，不要改。
const ROLES = { discuss: '讨论', build: '实施', test: '测试', release: '发布' }
const STAGE_ROLE = { discuss: 'discuss', plan: 'build', code: 'build', test: 'test', prep: 'test', release: 'release' }

const agent = (id, title) => {
  const role = STAGE_ROLE[id]
  if (!role) throw new Error(`阶段 ${id} 没有对应的角色`)
  const dir = `docs/process/agents/${role}`
  return {
    id, kind: 'agent', title,
    prompt: [
      `你是「${ROLES[role]}」agent（${role}），执行「${id} ${title}」阶段。以下路径都相对原项目目录（Original project directory）。依次完整阅读：`,
      `1. docs/process/WORKFLOW.md 的「0 通用规则」；`,
      `2. ${dir}/AGENT.md：「${id} ${title}」小节，以及「你是谁」「输入」「输出」「禁止」「记忆」各节；`,
      `3. 记忆：${dir}/memory.md 和 .dsh/agents/${role}/memory.md，不存在就跳过。`,
      `严格按其执行本阶段。任务输入首行是「<ID> <标题>」。`,
    ].join('\n'),
  }
}
const review = (id, title, returnStageId, extra = '') => ({
  id, kind: 'review', title, returnStageId,
  prompt: `对照 docs/process/WORKFLOW.md 第 4 节「${title}」清单审核。满足就「通过并继续」；否则「打回重做」，在反馈里逐条写明要改什么（这就是和 AI 的讨论）。${extra}`,
})

const workflows = [
  {
    name: '研发交付',
    description: '讨论（需求/方案/用例，人工确认）→实施计划→编码→测试（只报告）→测试关卡（自动，有缺陷打回编码，最多 5 轮）→验收准备→人工验收→发布。需求、改进、缺陷、技术债共用。规范见 docs/process/WORKFLOW.md 和 docs/process/agents/。',
    inputLabel: '卡片',
    inputHint: '首行：<ID> <标题>（例：REQ-003 导出为 CSV；前缀 REQ/IMP/BUG/DEBT）。第二行起：需求原文、背景、约束、参考链接。',
    stages: [
      agent('discuss', '讨论'),
      review('g_discuss', '讨论确认', 'discuss'),
      agent('plan', '实施计划'),
      agent('code', '编码'),
      agent('test', '测试'),
      review('g_test', '测试关卡', 'code', '本关卡由同步桥按测试阶段回复的首行自动决定：「测试通过」自动通过；「测试未通过 N 项」自动打回到编码，缺陷清单作为反馈；连续 5 轮未通过后停下来等人。人也可以在这里直接决定。'),
      agent('prep', '验收准备'),
      review('g_accept', '验收', 'plan', '打回时反馈会先写进计划（返工 #n）再改代码。「通过并继续」后，发布阶段会申请一次沙箱提权：点开「发布」节点，在「等待审批」里点「允许一次」后，才合并到主分支、打 tag 并按 DEPLOY 发布。'),
      agent('release', '发布'),
    ],
  },
]

for (const w of workflows) if (w.stages.length > 16) throw new Error(`${w.name}: ${w.stages.length} stages > 16`)
writeFileSync(new URL('./workflows.json', import.meta.url), JSON.stringify(workflows, null, 2) + '\n')
console.log(workflows.map(w => `${w.name}: ${w.stages.length} 阶段`).join('\n'))
