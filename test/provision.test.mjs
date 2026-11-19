import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionFiles, ensureWorkflows, kitHash, laneMoves, loadDefinitions } from '../bridge/provision.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'devflow-'))

test('provisionFiles：新项目写入全套文件，二次运行不变', () => {
  const ws = tmp()
  const a = provisionFiles(ws)
  assert.ok(a.overwritten.includes('docs/process/WORKFLOW.md'))
  assert.ok(a.overwritten.some(f => f.startsWith('docs/process/agents/discuss/')))
  for (const f of ['docs/VISION.md', 'docs/ARCHITECTURE.md', 'docs/testing/TEST_STRATEGY.md', 'docs/ops/DEPLOY.md', 'CHANGELOG.md']) assert.ok(existsSync(join(ws, f)), f)
  assert.deepEqual(a.gitignore, ['.dsh/', '.dsh-kanban.json'])
  const b = provisionFiles(ws)
  assert.deepEqual([b.overwritten, b.created, b.gitignore], [[], [], []])
})

test('provisionFiles：覆盖前备份被改过的旧文件，已有的骨架文档不动，.gitignore 只追加缺的', () => {
  const ws = tmp()
  mkdirSync(join(ws, 'docs/process'), { recursive: true })
  writeFileSync(join(ws, 'docs/process/WORKFLOW.md'), '我改过的版本')
  writeFileSync(join(ws, 'docs/VISION.md'), '我自己写的远景')
  writeFileSync(join(ws, '.gitignore'), 'node_modules\n.dsh/')
  const r = provisionFiles(ws, { now: new Date('2026-01-02T03:04:05Z') })
  assert.ok(r.overwritten.includes('docs/process/WORKFLOW.md'))
  assert.notEqual(readFileSync(join(ws, 'docs/process/WORKFLOW.md'), 'utf8'), '我改过的版本')
  const bak = join(ws, '.dsh/kit-backup/2026-01-02T03-04-05-000Z/docs/process/WORKFLOW.md')
  assert.equal(readFileSync(bak, 'utf8'), '我改过的版本')
  assert.equal(readFileSync(join(ws, 'docs/VISION.md'), 'utf8'), '我自己写的远景')
  assert.ok(!r.created.includes('docs/VISION.md'))
  assert.equal(readFileSync(join(ws, '.gitignore'), 'utf8'), 'node_modules\n.dsh/\n.dsh-kanban.json\n')
})

const fakeCore = (existing = []) => {
  const calls = []
  return { calls, listWorkflows: () => existing,
    createWorkflow: async (req, actor, sel) => { calls.push(['create', req, actor, sel]) },
    updateWorkflow: async (req, actor, sel) => { calls.push(['update', req, actor, sel]) } }
}

test('ensureWorkflows：没有就创建，definition 不含 name', async () => {
  const core = fakeCore()
  const r = await ensureWorkflows(core, 'ws1', { force: true })
  assert.deepEqual(r.created, ['研发交付'])
  const [, req, actor] = core.calls[0]
  assert.equal(req.name, '研发交付'); assert.equal(req.definition.name, undefined)
  assert.equal(req.definition.stages.length, 9); assert.equal(actor.kind, 'user')
})

test('ensureWorkflows：内容相同不更新；不同时带 revision 更新并保留已选模型；force=false 不动', async () => {
  const { name, ...def } = loadDefinitions()[0]
  const same = [{ id: 'w1', name, revision: 3, definition: { ...def, stages: def.stages.map(s => s.kind === 'agent' ? { ...s, modelSelection: { provider: 'p', model: 'm' } } : s) } }]
  const c1 = fakeCore(same); await ensureWorkflows(c1, 'ws1', { force: true }); assert.equal(c1.calls.length, 0)
  const old = [{ id: 'w1', name, revision: 3, definition: { ...def, description: '旧描述', stages: def.stages.map(s => s.id === 'discuss' ? { ...s, prompt: '旧', modelSelection: { provider: 'p', model: 'm' } } : s) } }]
  const c2 = fakeCore(old); const r = await ensureWorkflows(c2, 'ws1', { force: true })
  assert.deepEqual(r.updated, ['研发交付'])
  const [, req] = c2.calls[0]
  assert.equal(req.expectedRevision, 3); assert.equal(req.workflowId, 'w1')
  assert.equal(req.definition.description, def.description)
  assert.deepEqual(req.definition.stages.find(s => s.id === 'discuss').modelSelection, { provider: 'p', model: 'm' })
  assert.equal(req.definition.stages.find(s => s.id === 'discuss').prompt, def.stages[0].prompt)
  const c3 = fakeCore(old); await ensureWorkflows(c3, 'ws1', {}); assert.equal(c3.calls.length, 0)
})

test('laneMoves：套件甬道按顺序排最前，其余保持相对顺序且不丢', () => {
  const L = ['开始', '讨论', '实施']
  const cols = [{ id: 'z', title: 'Z' }, { id: 'c', title: '实施' }, { id: 'a', title: '开始' }, { id: 'y', title: 'Y' }, { id: 'b', title: '讨论' }]
  const ids = cols.map(c => c.id)
  for (const m of laneMoves(cols, L)) { ids.splice(ids.indexOf(m.id), 1); ids.splice(m.toIndex, 0, m.id) }
  assert.deepEqual(ids, ['a', 'b', 'c', 'z', 'y'])
  assert.deepEqual(laneMoves([{ id: 'a', title: '开始' }, { id: 'b', title: '讨论' }, { id: 'c', title: '实施' }], L), [])
})

test('kitHash：稳定', () => { assert.equal(kitHash(), kitHash()); assert.match(kitHash(), /^[0-9a-f]{16}$/) })
