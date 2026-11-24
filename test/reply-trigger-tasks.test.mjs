// 「人回复一条就自动去掉待人工确认」在各类等待状态下的行为：关卡、阻塞、测试关卡、验收、需要处理、
// 发布未完成、发布中等提权。用内存看板 + 假引擎跑真实 tick()，不碰 DSH。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge } from '../bridge/kanban-bridge.mjs'

const KANBAN = Symbol.for('dsh-kanban-flow-kit.kanban')
const WAIT = '状态::待人工确认'
const CANCELLED = '结果::已取消'
const FLOW = '研发交付'
const STAGES = [
  { id: 'discuss', title: '讨论', kind: 'agent' },
  { id: 'g_discuss', title: '讨论确认', kind: 'review', returnStageId: 'discuss' },
  { id: 'plan', title: '实施计划', kind: 'agent' },
  { id: 'code', title: '编码', kind: 'agent' },
  { id: 'test', title: '测试', kind: 'agent' },
  { id: 'g_test', title: '测试关卡', kind: 'review', returnStageId: 'code' },
  { id: 'prep', title: '验收准备', kind: 'agent' },
  { id: 'g_accept', title: '验收', kind: 'review', returnStageId: 'plan' },
  { id: 'release', title: '发布', kind: 'agent' },
]

// ---------- 内存看板 ----------
function memoryKanban() {
  const boards = new Map()
  let seq = 0
  const id = p => `${p}${++seq}`
  const board = ws => {
    if (!boards.has(ws.id)) boards.set(ws.id, {
      columns: [{ id: 'c-todo', title: 'To Do' }], labels: [], cards: [], activities: [], completedColumnId: null,
    })
    return boards.get(ws.id)
  }
  const ops = {
    get: () => ({}),
    addColumn: (b, a) => { b.columns.push({ id: id('c'), title: a.title }) },
    deleteColumn: (b, a) => { b.columns = b.columns.filter(c => c.id !== a.id) },
    moveColumn: (b, a) => { const c = b.columns.find(x => x.id === a.id); b.columns.splice(b.columns.indexOf(c), 1); b.columns.splice(a.toIndex, 0, c) },
    addLabel: (b, a) => { b.labels.push({ name: a.name, color: a.color }) },
    updateLabel: (b, a) => { const l = b.labels.find(x => x.name === a.name); if (a.newName) l.name = a.newName; if (a.color) l.color = a.color },
    deleteLabel: (b, a) => { b.labels = b.labels.filter(l => l.name !== a.name) },
    setCompletedColumn: (b, a) => { b.completedColumnId = a.columnId },
    addCard: (b, a) => {
      const card = { id: id('k'), title: a.title, note: a.note, labels: [...(a.labels ?? [])], columnId: a.columnId, priority: a.priority, comments: [] }
      b.cards.push(card)
      return { cardId: card.id }
    },
    updateCard: (b, a) => {
      const card = b.cards.find(c => c.id === a.id)
      for (const k of ['title', 'note', 'columnId', 'priority']) if (a[k] !== undefined) card[k] = a[k]
      if (a.labels) card.labels = [...a.labels]
    },
    moveCard: (b, a) => { b.cards.find(c => c.id === a.id).columnId = a.columnId },
    addComment: (b, a) => {
      const card = b.cards.find(c => c.id === a.id)
      card.comments ??= []
      card.comments.push({ id: id('m'), content: a.content, source: 'agent', createdAt: new Date().toISOString() })
    },
  }
  return {
    boards,
    async dispatch(ws, method, args) {
      const b = board(ws)
      if (!ops[method]) return { error: `fake: ${method}` }
      const out = ops[method](b, args) ?? {}
      return { ...out, board: structuredClone(b) }
    },
  }
}

// ---------- 假引擎 ----------
function makeTask({ id = 't1', workspaceId = 'ws', state = 'waiting_review', stageId = 'g_discuss', input = 'REQ-001 做点事', last = '' }) {
  const stage = STAGES.find(s => s.id === stageId)
  const visits = [{ id: 'v1', stageId, startedAt: Date.now() - 5000, closedAt: state === 'running' && stage.kind !== 'review' ? null : null, outcome: null }]
  const artifacts = last ? [{ id: 'a1', attemptId: 'at1', label: stage.title }] : []
  return {
    id, workspaceId, workflowName: FLOW, state, revision: 1, updatedAt: Date.now(),
    definition: { stages: STAGES }, currentStage: stage, currentVisitId: 'v1',
    visits, attempts: [], artifacts, effectiveArtifacts: artifacts, reviews: [], outputs: [],
    attention: { message: '测试环境起不来' }, canRetry: true, canReview: stage.kind === 'review' && state === 'waiting_review',
    review: stage.kind === 'review' && state === 'waiting_review' ? { id: `r-${stageId}`, subjectHash: 'h', returnStageId: stage.returnStageId } : null,
    input: { text: input },
  }
}

function setup() {
  const profileDir = mkdtempSync(join(tmpdir(), 'devflow-profile-'))
  mkdirSync(join(profileDir, 'workflow-poc'))
  const path = mkdtempSync(join(tmpdir(), 'devflow-tasks-'))
  mkdirSync(join(path, '.git'))
  const ws = { id: 'ws', path, status: async () => 'ok' }
  const kb = memoryKanban()
  globalThis[KANBAN] = kb
  const tasks = new Map()
  const flags = { delayDecision: false } // true 时 decideReview 只记账、任务状态不变（模拟引擎慢一拍）
  const decisions = [], retried = [], terminated = [], created = []
  let seq = 0
  const store = {
    listTaskSummaries: () => [...tasks.values()].map(t => ({ id: t.id, workspaceId: t.workspaceId, updatedAt: t.updatedAt })),
    // 返回快照：真实引擎里任务对象是不可变的，桥拿到的是当时那一刻的状态
    getTask: id => (tasks.has(id) ? structuredClone(tasks.get(id)) : null),
  }
  // 改任务也按「取快照 → 改 → 放回」来，和真实引擎一致
  const update = (id, fn) => { const t = structuredClone(tasks.get(id)); fn(t); tasks.set(id, t); return t }
  const core = {
    listWorkflows: () => [{ id: 'w1', revision: 1, name: FLOW, definition: { stages: STAGES } }],
    createWorkflow: async () => ({}),
    updateWorkflow: async () => ({}),
    createTask: async req => {
      const id = `t${++seq + 1}`
      created.push({ id, text: req.text })
      tasks.set(id, makeTask({ id, workspaceId: req.workspaceId, stageId: 'g_discuss', input: req.text }))
      return { id }
    },
    decideReview: async (req, actor) => {
      decisions.push({ ...req, actor })
      if (flags.delayDecision) { update(req.taskId, t => { t.updatedAt++; t.revision++ }); return {} }
      update(req.taskId, t => {
      const v = t.visits.find(x => !x.closedAt)
      if (v) { v.closedAt = Date.now(); v.outcome = req.decision }
      t.reviews.push({ id: t.review?.id, visitId: v?.id, state: req.decision, feedback: req.feedback, decidedBy: actor })
      t.review = null
      t.revision++
      t.updatedAt++
      if (req.decision === 'terminated') t.state = 'terminated'
      else if (req.decision === 'approved') { t.state = 'running'; t.currentStage = STAGES[STAGES.findIndex(s => s.id === t.currentStage.id) + 1] }
      else { t.state = 'running'; t.currentStage = STAGES[STAGES.indexOf(t.currentStage) - 1] ?? STAGES[0] }
      })
      return {}
    },
    retryTask: async req => { retried.push(req); update(req.taskId, t => { t.state = 'running'; t.revision++; t.updatedAt++ }) },
    terminateTask: async req => { terminated.push(req); update(req.taskId, t => { t.state = 'terminated'; t.revision++; t.updatedAt++ }) },
  }
  const texts = {}
  const bridge = startBridge({
    core, store, attachments: {}, workspaceRegistry: { list: () => [ws], get: () => ws },
    readArtifactText: async (att, art) => texts[art.id] ?? '', profileDir, intervalMs: 1e9,
  })
  return { kb, ws, bridge, tasks, decisions, retried, terminated, created, texts, flags }
}

const card = (kb, id) => kb.boards.get('ws').cards.find(c => c.id === id)
const onlyCard = kb => kb.boards.get('ws').cards[0]

function humanReply(kb, target, content, id = 'a900') {
  target.comments ??= []
  target.comments.push({ id: `m-${id}`, content, source: 'human', createdAt: new Date(Date.now() + 60_000).toISOString() })
  kb.boards.get('ws').activities.push({ id, ts: new Date().toISOString(), type: 'card_comment_added', source: 'human', cardId: target.id })
}

const comments = c => (c.comments ?? []).map(x => x.content)
const countMatching = (c, re) => comments(c).filter(x => re.test(x)).length

// 跑一次 tick，让同步桥把任务同步成卡片（带提醒）
async function prepare(ctx, task) {
  ctx.tasks.set(task.id, task)
  await ctx.bridge.tick()
  const c = onlyCard(ctx.kb)
  assert.ok(c, '同步桥应已建卡')
  assert.ok(c.labels.includes(WAIT), '等待人工处理时应带「待人工确认」')
  return c
}

test('关卡：回复「通过」→ 自动去标签、提交通过决定、不再重复提醒', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({}))
    humanReply(ctx.kb, c, '通过')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 1)
    assert.equal(ctx.decisions[0].decision, 'approved')
    assert.equal(ctx.decisions[0].actor.source, 'kanban-label')
    assert.ok(!card(ctx.kb, c.id).labels.includes(WAIT), '标签被自动去掉')
    assert.equal(countMatching(card(ctx.kb, c.id), /【看板同步｜已提交：通过并继续/), 1)
    await ctx.bridge.tick()
    const after = card(ctx.kb, c.id)
    assert.ok(!after.labels.includes(WAIT), '下一轮不会把标签加回来')
    assert.equal(countMatching(after, /【看板同步｜已提交/), 1, '不会重复提交')
    assert.equal(countMatching(after, /待人工确认｜/), 1, '不会重复提醒')
  } finally { ctx.bridge.dispose() }
})

test('关卡：回复一段意见 → 打回重做，反馈原样传下去', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({}))
    humanReply(ctx.kb, c, '文案改成「已删除」，并补一条用例')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions[0].decision, 'returned')
    assert.match(ctx.decisions[0].feedback, /文案改成「已删除」/)
    assert.match(comments(card(ctx.kb, c.id)).join('\n'), /已提交：打回重做（返工 #1）/)
    assert.ok(!card(ctx.kb, c.id).labels.includes(WAIT))
  } finally { ctx.bridge.dispose() }
})

test('关卡：回复「终止」→ 终止任务，卡片进关闭并打已取消', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({}))
    humanReply(ctx.kb, c, '终止')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions[0].decision, 'terminated', '关卡终止走 decideReview(terminated)')
    await ctx.bridge.tick()
    const after = card(ctx.kb, c.id)
    assert.ok(!after.labels.includes(WAIT))
    assert.ok(after.labels.includes(CANCELLED))
    assert.equal(after.columnId, ctx.kb.boards.get('ws').columns.find(x => x.title === '关闭').id)
  } finally { ctx.bridge.dispose() }
})

test('关卡：上游阻塞时回复「通过」→ 不提交，标签加回来并说明', async () => {
  const ctx = setup()
  try {
    const task = makeTask({ last: '阻塞：测试环境起不来' })
    ctx.texts.a1 = '阻塞：测试环境起不来'
    const c = await prepare(ctx, task)
    humanReply(ctx.kb, c, '通过')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 0, '阻塞时不该提交通过')
    const after = card(ctx.kb, c.id)
    assert.ok(after.labels.includes(WAIT), '标签加回来')
    assert.equal(countMatching(after, /【看板同步｜未执行/), 1)
  } finally { ctx.bridge.dispose() }
})

test('测试关卡人工放行：回复「通过」→ approved', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({ stageId: 'g_test' }))
    humanReply(ctx.kb, c, '通过')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions[0].decision, 'approved')
    assert.ok(!card(ctx.kb, c.id).labels.includes(WAIT))
  } finally { ctx.bridge.dispose() }
})

test('验收：回复「通过 + 附言」→ 通过，附言写进 decisions.md', async () => {
  const ctx = setup()
  try {
    const task = makeTask({ stageId: 'g_accept' })
    const dir = join(ctx.ws.path, '.dsh', 'workflow-artifacts', task.id, 'repo', 'docs', 'reqs', 'REQ-001')
    mkdirSync(dir, { recursive: true })
    const c = await prepare(ctx, task)
    // 卡片标题来自任务输入首行的编号
    humanReply(ctx.kb, c, '通过。Q1 选 B')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions[0].decision, 'approved')
    const md = readFileSync(join(dir, 'decisions.md'), 'utf8')
    assert.match(md, /## 验收｜通过/)
    assert.match(md, /Q1 选 B/)
  } finally { ctx.bridge.dispose() }
})

test('需要处理：回复「重试」→ 重试当前阶段', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({ state: 'needs_attention' }))
    humanReply(ctx.kb, c, '重试')
    await ctx.bridge.tick()
    assert.equal(ctx.retried.length, 1)
    assert.ok(!card(ctx.kb, c.id).labels.includes(WAIT))
    assert.equal(countMatching(card(ctx.kb, c.id), /【看板同步｜已提交：重试当前阶段/), 1)
  } finally { ctx.bridge.dispose() }
})

test('需要处理：回复认不出 → 不重试，标签加回来', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({ state: 'needs_attention' }))
    humanReply(ctx.kb, c, '先别动，我自己看看')
    await ctx.bridge.tick()
    assert.equal(ctx.retried.length, 0)
    assert.ok(card(ctx.kb, c.id).labels.includes(WAIT))
    assert.equal(countMatching(card(ctx.kb, c.id), /【看板同步｜未执行/), 1)
  } finally { ctx.bridge.dispose() }
})

test('需要处理：回复「终止」→ 终止任务', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({ state: 'needs_attention' }))
    humanReply(ctx.kb, c, '终止')
    await ctx.bridge.tick()
    assert.equal(ctx.terminated.length, 1)
    await ctx.bridge.tick()
    assert.ok(card(ctx.kb, c.id).labels.includes(CANCELLED))
  } finally { ctx.bridge.dispose() }
})

test('发布未完成：回复「知悉」→ 只去掉提醒，不新建任务', async () => {
  const ctx = setup()
  try {
    const task = makeTask({ state: 'completed', stageId: 'release', last: '未发布：主工作区有未提交改动' })
    ctx.texts.a1 = '未发布：主工作区有未提交改动'
    const c = await prepare(ctx, task)
    humanReply(ctx.kb, c, '知悉')
    await ctx.bridge.tick()
    assert.equal(ctx.created.length, 0)
    assert.ok(!card(ctx.kb, c.id).labels.includes(WAIT))
    assert.equal(countMatching(card(ctx.kb, c.id), /已提交：已知悉/), 1)
  } finally { ctx.bridge.dispose() }
})

test('发布未完成：回复「重试」→ 新建只重新发布的任务', async () => {
  const ctx = setup()
  try {
    const task = makeTask({ state: 'completed', stageId: 'release', last: '未发布：主工作区有未提交改动' })
    ctx.texts.a1 = '未发布：主工作区有未提交改动'
    const c = await prepare(ctx, task)
    humanReply(ctx.kb, c, '重试，已清理工作区')
    await ctx.bridge.tick()
    assert.equal(ctx.created.length, 1)
    assert.match(ctx.created[0].text, /接续 t1/)
    assert.match(ctx.created[0].text, /已清理工作区/)
    assert.match(comments(card(ctx.kb, c.id)).join('\n'), /已提交：新建只重新发布的任务/)
  } finally { ctx.bridge.dispose() }
})

test('发布未完成：回复认不出 → 不新建任务，标签加回来', async () => {
  const ctx = setup()
  try {
    const task = makeTask({ state: 'completed', stageId: 'release', last: '未发布：合并冲突' })
    ctx.texts.a1 = '未发布：合并冲突'
    const c = await prepare(ctx, task)
    humanReply(ctx.kb, c, '哦')
    await ctx.bridge.tick()
    assert.equal(ctx.created.length, 0)
    assert.ok(card(ctx.kb, c.id).labels.includes(WAIT))
  } finally { ctx.bridge.dispose() }
})

test('发布中等提权：回复任意内容 → 只记「已知悉」，不提交任何决定', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({ state: 'running', stageId: 'release' }))
    humanReply(ctx.kb, c, '好的，我去点允许')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 0)
    assert.equal(ctx.created.length, 0)
    assert.ok(!card(ctx.kb, c.id).labels.includes(WAIT), '标签被自动去掉')
    assert.equal(countMatching(card(ctx.kb, c.id), /【看板同步｜已知悉/), 1)
  } finally { ctx.bridge.dispose() }
})

test('手动去标签的老做法仍然有效（不需要评论活动）', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({}))
    // 先把回复写在卡片上（不产生评论活动），再模拟人手动点 ✕
    c.comments.push({ id: 'm-old', content: '打回：补用例', source: 'human', createdAt: new Date(Date.now() + 60_000).toISOString() })
    c.labels = c.labels.filter(n => n !== WAIT)
    ctx.kb.boards.get('ws').activities.push({ id: 'a901', ts: new Date().toISOString(), type: 'card_label_changed', source: 'human', cardId: c.id, meta: { removed: [WAIT] } })
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 1)
    assert.equal(ctx.decisions[0].decision, 'returned')
  } finally { ctx.bridge.dispose() }
})

test('手动去标签但没有新回复 → 标签加回来', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({}))
    c.labels = c.labels.filter(n => n !== WAIT)
    ctx.kb.boards.get('ws').activities.push({ id: 'a902', ts: new Date().toISOString(), type: 'card_label_changed', source: 'human', cardId: c.id, meta: { removed: [WAIT] } })
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 0)
    assert.ok(card(ctx.kb, c.id).labels.includes(WAIT))
    assert.equal(countMatching(card(ctx.kb, c.id), /没有找到你在提醒之后的回复/), 1)
  } finally { ctx.bridge.dispose() }
})

// ---------- 边界情况 ----------
// 先跑一轮接入，再手动塞一张「已经有任务、带待人工确认」的卡（模拟状态文件被清掉后的老卡）
async function seedCard(ctx, task) {
  ctx.tasks.set(task.id, task)
  await ctx.bridge.tick()
  const b = ctx.kb.boards.get('ws')
  const c = { id: 'k-seed', columnId: b.columns.find(x => x.title === '需求/技术讨论').id, title: 'REQ-001 做点事',
    note: `流程：${task.id}｜讨论确认｜等你确认｜x`, labels: [WAIT], comments: [] }
  b.cards.push(c)
  await ctx.bridge.tick() // 建立基线（不补发历史评论）
  return c
}

test('老卡（状态文件被清）带待人工确认：人回复一样能触发', async () => {
  const ctx = setup()
  try {
    const c = await seedCard(ctx, makeTask({}))
    assert.ok(c.labels.includes(WAIT))
    humanReply(ctx.kb, c, '通过')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 1)
    assert.equal(ctx.decisions[0].decision, 'approved')
    assert.ok(!card(ctx.kb, 'k-seed').labels.includes(WAIT))
  } finally { ctx.bridge.dispose() }
})

test('同一条回复产生两条活动：只执行一次', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({}))
    humanReply(ctx.kb, c, '通过', 'a910')
    // 再补一条指向同一张卡的活动（例如评论和标签活动都记了一次）
    ctx.kb.boards.get('ws').activities.push({ id: 'a911', ts: new Date().toISOString(), type: 'card_comment_added', source: 'human', cardId: c.id })
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 1, '同一件事只提交一次')
    assert.equal(countMatching(card(ctx.kb, c.id), /【看板同步｜已提交/), 1)
  } finally { ctx.bridge.dispose() }
})

test('回复之后任务已往下走：再发评论不会触发第二次', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({}))
    humanReply(ctx.kb, c, '通过')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 1)
    humanReply(ctx.kb, c, '再补一句说明', 'a920')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 1, '不在等人时的评论不算决定')
  } finally { ctx.bridge.dispose() }
})

test('不是「研发交付」流程的任务：人回复不动标签、不提交决定', async () => {
  const ctx = setup()
  try {
    const task = makeTask({})
    task.workflowName = '别的流程'
    const c = await seedCard(ctx, task)
    humanReply(ctx.kb, c, '通过')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 0)
    assert.ok(card(ctx.kb, 'k-seed').labels.includes(WAIT), '标签保持原样')
  } finally { ctx.bridge.dispose() }
})

test('接入前的历史回复不会被翻出来执行', async () => {
  const ctx = setup()
  try {
    const task = makeTask({})
    ctx.tasks.set(task.id, task)
    const b = await ctx.kb.dispatch(ctx.ws, 'get', {})
    const c = { id: 'k-old', columnId: 'c-todo', title: 'REQ-001 做点事', note: `流程：${task.id}`, labels: [WAIT], comments: [] }
    b.board.cards.push(c)
    // 接入之前就存在的旧评论和旧活动
    humanReply(ctx.kb, c, '通过', 'a5')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 0, '接入前的活动只做基线，不执行')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 0, '下一轮也不会补执行')
  } finally { ctx.bridge.dispose() }
})

test('提醒文案已改成「回复即可，标签自动去掉」', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({}))
    const ask = comments(c).find(x => /待人工确认｜/.test(x))
    assert.match(ask, /同步桥看到回复会自动去掉「待人工确认」标签/)
    assert.ok(!/手动去掉/.test(ask), '不再要求手动去标签')
  } finally { ctx.bridge.dispose() }
})

test('「开始」甬道的新卡：回复「开始」→ 建任务并进入讨论', async () => {
  const ctx = setup()
  try {
    await ctx.bridge.tick()
    const b = ctx.kb.boards.get('ws')
    const c = { id: 'k-start', columnId: b.columns.find(x => x.title === '开始').id, title: 'REQ-002 新需求',
      note: '要做的事', labels: ['类型::需求'], comments: [] }
    b.cards.push(c)
    await ctx.bridge.tick()
    assert.ok(c.labels.includes(WAIT), '同步桥提醒启动')

    humanReply(ctx.kb, c, '开始，先做最小版本')
    await ctx.bridge.tick()
    assert.equal(ctx.created.length, 1, '建了任务')
    assert.match(ctx.created[0].text, /^REQ-002 新需求/)
    assert.match(ctx.created[0].text, /先做最小版本/)
    assert.ok(!card(ctx.kb, 'k-start').labels.includes(WAIT), '标签自动去掉')
    assert.equal(countMatching(card(ctx.kb, 'k-start'), /【看板同步｜已启动/), 1)
  } finally { ctx.bridge.dispose() }
})

test('引擎慢一拍（决定已提交、任务还停在关卡）：不把标签加回来、不重复提醒', async () => {
  const ctx = setup()
  try {
    const c = await prepare(ctx, makeTask({}))
    ctx.flags.delayDecision = true
    humanReply(ctx.kb, c, '通过')
    await ctx.bridge.tick()
    assert.equal(ctx.decisions.length, 1)
    await ctx.bridge.tick()
    await ctx.bridge.tick()
    const after = card(ctx.kb, c.id)
    assert.ok(!after.labels.includes(WAIT), '任务还没往下走时也不把标签加回来')
    assert.equal(countMatching(after, /待人工确认｜/), 1, '不重复提醒')
    assert.equal(countMatching(after, /【看板同步｜已提交/), 1)
  } finally { ctx.bridge.dispose() }
})

for (const scenario of [
  { stageId: 'prep', state: 'running', lane: '发布' },
  { stageId: 'g_accept', state: 'waiting_review', lane: '发布' },
  { stageId: 'release', state: 'running', lane: '发布' },
  { stageId: 'release', state: 'completed', last: '未发布：冲突', lane: '发布' },
  { stageId: 'release', state: 'completed', last: '已回滚：冒烟失败', lane: '发布' },
  { stageId: 'release', state: 'completed', last: '已发布 v1.2', lane: '关闭' },
]) {
  test(`甬道映射：${scenario.stageId}/${scenario.state}/${scenario.last ?? ''} → ${scenario.lane}`, async () => {
    const ctx = setup()
    try {
      const task = makeTask(scenario)
      if (scenario.last) ctx.texts.a1 = scenario.last
      ctx.tasks.set(task.id, task)
      await ctx.bridge.tick()
      const b = ctx.kb.boards.get('ws')
      assert.equal(onlyCard(ctx.kb).columnId, b.columns.find(c => c.title === scenario.lane).id)
      assert.ok(!b.columns.some(c => c.title === '待验收'))
    } finally { ctx.bridge.dispose() }
  })
}
