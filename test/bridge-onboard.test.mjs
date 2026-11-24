// 同步桥自动接入的冒烟测试：内存看板 + 假 core/工作区注册表，不碰真实 DSH。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBridge } from '../bridge/kanban-bridge.mjs'

const KANBAN = Symbol.for('dsh-kanban-flow-kit.kanban')
const LANES = ['开始', '需求/技术讨论', '实施', '测试中', '发布', '关闭']

// 只实现同步桥接入时用到的 dispatch 方法
function memoryKanban() {
  const boards = new Map()
  let seq = 0
  const id = p => `${p}${++seq}`
  const board = ws => {
    if (!boards.has(ws.id)) boards.set(ws.id, {
      columns: [{ id: 'c-todo', title: 'To Do' }, { id: 'c-doing', title: 'Doing' }, { id: 'c-done', title: 'Done' }],
      labels: [], cards: [{ id: 'k1', columnId: 'c-doing', title: '我自己的卡', note: '', labels: [] }], activities: [], completedColumnId: 'c-done',
    })
    return boards.get(ws.id)
  }
  const ops = {
    get: b => ({}),
    renameColumn: (b, a) => { b.columns.find(c => c.id === a.id).title = a.title },
    addColumn: (b, a) => { b.columns.push({ id: id('c'), title: a.title }) },
    deleteColumn: (b, a) => { b.columns = b.columns.filter(c => c.id !== a.id) },
    moveColumn: (b, a) => { const c = b.columns.find(x => x.id === a.id); b.columns.splice(b.columns.indexOf(c), 1); b.columns.splice(a.toIndex, 0, c) },
    addLabel: (b, a) => { b.labels.push({ name: a.name, color: a.color }) },
    updateLabel: (b, a) => { const l = b.labels.find(x => x.name === a.name); if (a.newName) l.name = a.newName; if (a.color) l.color = a.color },
    deleteLabel: (b, a) => { b.labels = b.labels.filter(l => l.name !== a.name) },
    setCompletedColumn: (b, a) => { b.completedColumnId = a.columnId },
    updateCard: (b, a) => { Object.assign(b.cards.find(c => c.id === a.id), a) },
    addComment: () => {},
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
    createWorkflow: async (req) => { flows.set(req.workspaceId, [...(flows.get(req.workspaceId) ?? []), { id: 'w1', revision: 1, name: req.name, definition: req.definition }]) },
    updateWorkflow: async () => { throw new Error('不该更新') },
  }
  const registry = { list: () => workspaces, get: id => workspaces.find(w => w.id === id) }
  const bridge = startBridge({ core, store: { listTaskSummaries: () => [] }, attachments: {}, workspaceRegistry: registry, readArtifactText: async () => '', profileDir, intervalMs: 1e9 })
  return { kb, flows, bridge, profileDir }
}
const ws = (name, { git = true, off = false } = {}) => {
  const path = mkdtempSync(join(tmpdir(), `devflow-${name}-`))
  if (git) mkdirSync(join(path, '.git'))
  if (off) writeFileSync(join(path, '.dsh-devflow-off'), '')
  return { id: name, path, status: async () => 'ok' }
}

test('打开的 git 项目自动接入；非 git 和关掉的项目不动；第二轮不重复接入', async () => {
  const a = ws('a'), plain = ws('plain', { git: false }), off = ws('off', { off: true })
  const { kb, flows, bridge, profileDir } = setup([a, plain, off])
  try {
    await bridge.tick()
    // 文件
    assert.ok(existsSync(join(a.path, 'docs/process/WORKFLOW.md')))
    assert.ok(existsSync(join(a.path, 'docs/process/agents/test/AGENT.md')))
    assert.ok(existsSync(join(a.path, 'docs/testing/TEST_STRATEGY.md')))
    assert.match(readFileSync(join(a.path, '.gitignore'), 'utf8'), /\.dsh\//)
    for (const w of [plain, off]) assert.ok(!existsSync(join(w.path, 'docs')), w.id)
    // 看板：套件甬道在前、空的默认甬道删掉、有卡片的保留在最后
    const b = kb.boards.get('a')
    assert.deepEqual(b.columns.map(c => c.title), [...LANES, 'Doing'])
    assert.equal(b.cards[0].columnId, 'c-doing')
    assert.equal(b.completedColumnId, b.columns.find(c => c.title === '关闭').id)
    for (const n of ['类型::需求', '状态::待人工确认', '结果::已发布']) assert.ok(b.labels.some(l => l.name === n), n)
    assert.ok(!kb.boards.has('plain') && !kb.boards.has('off'))
    // 流程
    assert.deepEqual(flows.get('a').map(f => f.name), ['研发交付'])
    const st = JSON.parse(readFileSync(join(profileDir, 'workflow-poc/kanban-bridge.json'), 'utf8'))
    assert.ok(st.workspaces.a.kitHash)
    // 第二轮：不再改甬道、不再建流程
    const before = kb.calls.length
    await bridge.tick()
    const again = kb.calls.slice(before).map(c => c[1]).filter(m => m !== 'get')
    assert.ok(!again.some(m => ['deleteColumn', 'moveColumn', 'addColumn'].includes(m)), again.join(','))
    assert.equal(flows.get('a').length, 1)
  } finally { bridge.dispose() }
})

test('接入时删掉没卡片在用的多余标签，有卡片在用的保留', async () => {
  const a = ws('lbl')
  const { kb, bridge } = setup([a])
  try {
    await kb.dispatch(a, 'get', {})
    const b = kb.boards.get('lbl')
    b.labels.push(...['New Feature', 'bug', 'S1-需求', 'S3-方案与测试'].map(name => ({ name, color: '#000' })))
    b.cards[0].labels = ['S3-方案与测试']
    await bridge.tick()
    const names = b.labels.map(l => l.name)
    for (const gone of ['New Feature', 'bug', 'S1-需求']) assert.ok(!names.includes(gone), gone)
    assert.ok(names.includes('S3-方案与测试'))
    assert.ok(names.includes('类型::需求'))
  } finally { bridge.dispose() }
})

test('旧甬道「待验收」原地改名为「发布」，卡片留在里面', async () => {
  const a = ws('lane')
  const { kb, bridge } = setup([a])
  try {
    await kb.dispatch(a, 'get', {})
    const b = kb.boards.get('lane')
    b.columns.push({ id: 'c-old', title: '待验收' })
    b.cards.push({ id: 'k9', columnId: 'c-old', title: '旧卡', note: '', labels: [] })
    await bridge.tick()
    assert.ok(!b.columns.some(c => c.title === '待验收'))
    assert.equal(b.columns.find(c => c.id === 'c-old').title, '发布')
    assert.equal(b.cards.find(c => c.id === 'k9').columnId, 'c-old')
    assert.equal(b.columns.filter(c => c.title === '发布').length, 1)
  } finally { bridge.dispose() }
})

test('迁移后重复同步不再改名、不新增甬道', async () => {
  const a = ws('lane-repeat')
  const { kb, bridge } = setup([a])
  try {
    await kb.dispatch(a, 'get', {})
    const b = kb.boards.get(a.id)
    b.columns.push({ id: 'legacy', title: '待验收' })
    await bridge.tick()
    const before = kb.calls.length
    await bridge.tick()
    assert.ok(!kb.calls.slice(before).some(([, op]) => ['renameColumn', 'addColumn', 'deleteColumn', 'moveColumn'].includes(op)))
    assert.equal(b.columns.filter(c => c.title === '发布').length, 1)
  } finally { bridge.dispose() }
})

test('旧名和新名均有卡片时保留两列和卡片，不误删或重复改名', async () => {
  const a = ws('lane-conflict')
  const { kb, bridge } = setup([a])
  try {
    await kb.dispatch(a, 'get', {})
    const b = kb.boards.get(a.id)
    b.columns.push({ id: 'legacy', title: '待验收' }, { id: 'release', title: '发布' })
    b.cards.push({ id: 'old-card', columnId: 'legacy', title: '旧列卡', note: '', labels: [] },
      { id: 'new-card', columnId: 'release', title: '新列卡', note: '', labels: [] })
    await bridge.tick()
    assert.equal(b.columns.find(c => c.id === 'legacy').title, '待验收')
    assert.equal(b.columns.find(c => c.id === 'release').title, '发布')
    assert.equal(b.cards.find(c => c.id === 'old-card').columnId, 'legacy')
    assert.equal(b.cards.find(c => c.id === 'new-card').columnId, 'release')
    assert.ok(!kb.calls.some(([, op]) => op === 'renameColumn'))
  } finally { bridge.dispose() }
})
