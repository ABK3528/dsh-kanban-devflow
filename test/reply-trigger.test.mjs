// 人在卡片里回复一条，就自动去掉「待人工确认」并按回复执行，不再要求手动去标签。
// 用内存看板 + 假 core 跑真实的 tick()，不碰真实 DSH。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge, humanAction } from '../bridge/kanban-bridge.mjs'

const KANBAN = Symbol.for('dsh-kanban-flow-kit.kanban')
const WAIT = '状态::待人工确认'
const CANCELLED = '结果::已取消'

function memoryKanban() {
  const boards = new Map()
  let seq = 0
  const id = p => `${p}${++seq}`
  const board = ws => {
    if (!boards.has(ws.id)) boards.set(ws.id, {
      columns: [{ id: 'c-todo', title: 'To Do' }, { id: 'c-doing', title: 'Doing' }, { id: 'c-done', title: 'Done' }],
      labels: [], cards: [], activities: [], completedColumnId: 'c-done',
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
    updateCard: (b, a) => { Object.assign(b.cards.find(c => c.id === a.id), a) },
    moveCard: (b, a) => { b.cards.find(c => c.id === a.id).columnId = a.columnId },
    addComment: (b, a) => {
      const card = b.cards.find(c => c.id === a.id)
      card.comments ??= []
      card.comments.push({ id: id('m'), content: a.content, source: 'agent', createdAt: new Date().toISOString() })
    },
  }
  return {
    boards, calls: [],
    async dispatch(ws, method, args) {
      this.calls.push([ws.id, method])
      const b = board(ws)
      if (!ops[method]) return { error: `fake: ${method}` }
      ops[method](b, args)
      return { board: structuredClone(b) }
    },
  }
}

function setup(workspaces) {
  const profileDir = mkdtempSync(join(tmpdir(), 'devflow-profile-'))
  mkdirSync(join(profileDir, 'workflow-poc'))
  const kb = memoryKanban()
  globalThis[KANBAN] = kb
  const flows = new Map()
  const core = {
    listWorkflows: wsId => flows.get(wsId) ?? [],
    createWorkflow: async req => { flows.set(req.workspaceId, [...(flows.get(req.workspaceId) ?? []), { id: 'w1', revision: 1, name: req.name, definition: req.definition }]) },
    updateWorkflow: async () => ({}),
    listTasks: () => [],
    getTask: () => null,
  }
  const registry = { list: () => workspaces, get: id => workspaces.find(w => w.id === id) }
  const bridge = startBridge({ core, store: { listTaskSummaries: () => [], getTask: () => null }, attachments: {}, workspaceRegistry: registry, readArtifactText: async () => '', profileDir, intervalMs: 1e9 })
  return { kb, flows, bridge, profileDir }
}

const ws = name => {
  const path = mkdtempSync(join(tmpdir(), `devflow-${name}-`))
  mkdirSync(join(path, '.git'))
  return { id: name, path, status: async () => 'ok' }
}

// 一张停在「开始」甬道、还没启动流程的卡
function addStartCard(kb, wsId, { title = 'IMP-001 测试卡', labels = ['类型::改进'] } = {}) {
  const b = kb.boards.get(wsId)
  const col = b.columns.find(c => c.title === '开始')
  const card = { id: 'k2', columnId: col.id, title, note: '要做的事', labels: [...labels], comments: [] }
  b.cards.push(card)
  return card
}

// 模拟人在看板上发一条评论：评论本身 + 一条 human 的 card_comment_added 活动
function humanReply(kb, wsId, card, content, id = 'a999') {
  card.comments.push({ id: `m-${id}`, content, source: 'human', createdAt: new Date().toISOString() })
  kb.boards.get(wsId).activities.push({ id, ts: new Date().toISOString(), type: 'card_comment_added', source: 'human', cardId: card.id })
}

function agentReply(kb, wsId, card, content, id = 'a998') {
  card.comments.push({ id: `m-${id}`, content, source: 'agent', createdAt: new Date().toISOString() })
  kb.boards.get(wsId).activities.push({ id, ts: new Date().toISOString(), type: 'card_comment_added', source: 'agent', cardId: card.id })
}

test('人回复一条就自动去掉「待人工确认」并执行，不用手动去标签', async () => {
  const a = ws('reply')
  const { kb, bridge } = setup([a])
  try {
    await bridge.tick()
    const card = addStartCard(kb, 'reply')
    await bridge.tick()
    assert.ok(card.labels.includes(WAIT), '先由同步桥打上待人工确认')

    humanReply(kb, 'reply', card, '终止')
    await bridge.tick()

    const b = kb.boards.get('reply')
    const after = b.cards.find(c => c.id === 'k2')
    assert.ok(!after.labels.includes(WAIT), '回复后标签被自动去掉')
    assert.ok(after.labels.includes(CANCELLED), '按回复执行：终止 → 已取消')
    assert.equal(after.columnId, b.columns.find(c => c.title === '关闭').id, '卡片进关闭')
    assert.ok(after.comments.some(c => c.content.includes('【看板同步｜已取消')), '留下执行结果评论')
  } finally { bridge.dispose() }
})

test('人回复不带「开始/终止」，标签加回来并说明原因', async () => {
  const a = ws('bad')
  const { kb, bridge } = setup([a])
  try {
    await bridge.tick()
    const card = addStartCard(kb, 'bad')
    await bridge.tick()

    humanReply(kb, 'bad', card, '这个先放一放')
    await bridge.tick()

    const after = kb.boards.get('bad').cards.find(c => c.id === 'k2')
    assert.ok(after.labels.includes(WAIT), '认不出的回复：标签加回来')
    assert.ok(after.comments.some(c => c.content.includes('【看板同步｜未执行')), '说明为什么没执行')
  } finally { bridge.dispose() }
})

test('AI 的评论不触发；等人时人闲聊也不动标签', async () => {
  const a = ws('quiet')
  const { kb, bridge } = setup([a])
  try {
    await bridge.tick()
    const card = addStartCard(kb, 'quiet')
    await bridge.tick()

    agentReply(kb, 'quiet', card, '开始')
    await bridge.tick()
    assert.ok(kb.boards.get('quiet').cards.find(c => c.id === 'k2').labels.includes(WAIT), 'AI 评论不算回复')

    // 不在等人的卡（没有待人工确认）：人发评论不动标签
    const b = kb.boards.get('quiet')
    const other = { id: 'k3', columnId: b.columns.find(c => c.title === '实施').id, title: '随便记一笔', note: '', labels: [], comments: [] }
    b.cards.push(other)
    humanReply(kb, 'quiet', other, '记一下', 'a1000')
    await bridge.tick()
    const kept = kb.boards.get('quiet').cards.find(c => c.id === 'k3')
    assert.ok(!kept.labels.includes(WAIT), '没在等人：不会凭空打标签')
  } finally { bridge.dispose() }
})

test('humanAction：只认人的动作，且卡片要在等人', () => {
  const card = { labels: [WAIT] }
  const base = { cardId: 'k', ts: '' }
  assert.equal(humanAction({ ...base, type: 'card_comment_added', source: 'human' }, card), 'reply')
  assert.equal(humanAction({ ...base, type: 'card_comment_added', source: 'agent' }, card), null)
  assert.equal(humanAction({ ...base, type: 'card_comment_added', source: 'human' }, { labels: [] }), null)
  assert.equal(humanAction({ ...base, type: 'card_label_changed', source: 'human', from: WAIT, to: null }, card), 'label')
  assert.equal(humanAction({ ...base, type: 'card_label_changed', source: 'human', meta: { removed: [WAIT] } }, card), 'label')
  assert.equal(humanAction({ ...base, type: 'card_label_changed', source: 'agent', from: WAIT, to: null }, card), null)
  assert.equal(humanAction({ ...base, type: 'card_moved', source: 'human' }, card), null)
  assert.equal(humanAction({ ...base, type: 'card_comment_added', source: 'human' }, null), null)
})

test('「开始」甬道：手动去标签但没有新回复 → 标签加回来', async () => {
  const a = ws('noreply')
  const { kb, bridge } = setup([a])
  try {
    await bridge.tick()
    const card = addStartCard(kb, 'noreply')
    await bridge.tick()
    assert.ok(card.labels.includes(WAIT))

    card.labels = card.labels.filter(n => n !== WAIT)
    kb.boards.get('noreply').activities.push({ id: 'a903', ts: new Date().toISOString(), type: 'card_label_changed', source: 'human', cardId: card.id, meta: { removed: [WAIT] } })
    await bridge.tick()

    const after = kb.boards.get('noreply').cards.find(c => c.id === 'k2')
    assert.ok(after.labels.includes(WAIT), '标签加回来')
    assert.ok(after.comments.some(c => c.content.includes('没有找到你在提醒之后的回复')), '说明原因')
  } finally { bridge.dispose() }
})
