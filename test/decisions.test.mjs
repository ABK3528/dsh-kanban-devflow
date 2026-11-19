// 人在关卡里的回复要传到后面所有阶段：引擎只保留最后一轮打回反馈，同步桥补上历史并写 decisions.md。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveDecision, withHistory } from '../bridge/kanban-bridge.mjs'

const stages = [{ id: 'discuss', title: '讨论' }, { id: 'g_discuss', title: '讨论确认' }, { id: 'g_test', title: '测试关卡' }]
const human = { source: 'kanban-label' }
// 复现 REQ-003：讨论确认打回两次，第二次打回时第一次的回答不能丢
const task = {
  id: 't1', definition: { stages }, currentStage: stages[1],
  visits: [{ id: 'v2', stageId: 'g_discuss', outcome: 'returned' }, { id: 'v4', stageId: 'g_discuss', outcome: 'returned' },
    { id: 'v6', stageId: 'g_discuss' }, { id: 'v9', stageId: 'g_test', outcome: 'returned' }],
  reviews: [
    { visitId: 'v2', state: 'returned', feedback: '1、项目目录。2、可以。3、好的。4、html报告。', decidedBy: human },
    { visitId: 'v4', state: 'returned', feedback: '5、默认。6、不用。\n\n【此前各轮你在关卡里的回复，仍然有效，本轮改了的以本轮为准】\n- 讨论确认（打回）：旧', decidedBy: human },
    { visitId: 'v9', state: 'returned', feedback: '【测试关卡打回｜第 1/5 轮】测试未通过 1 项', decidedBy: { source: 'bridge-auto' } },
    { visitId: 'v6', state: 'pending', feedback: null },
  ],
}

test('打回反馈附上此前各轮人工回复，不嵌套、不含自动关卡', () => {
  const fb = withHistory(task, '7、按耗时排序')
  assert.match(fb, /^7、按耗时排序/)
  assert.match(fb, /讨论确认（打回）：1、项目目录。2、可以。3、好的。4、html报告。/)
  assert.match(fb, /讨论确认（打回）：5、默认。6、不用。$/m)
  assert.equal(fb.split('【此前各轮').length, 2)
  assert.ok(!fb.includes('测试未通过'))
  assert.equal(withHistory({ ...task, reviews: [] }, 'x'), 'x')
})

test('只写「通过」不进历史；带附言的通过进历史', () => {
  const t = { ...task, reviews: [{ visitId: 'v2', state: 'approved', feedback: '通过。', decidedBy: human }] }
  assert.equal(withHistory(t, 'x'), 'x')
  t.reviews[0].feedback = '通过。Q1 选 B'
  assert.match(withHistory(t, 'x'), /讨论确认（通过）：通过。Q1 选 B/)
})

test('打回和通过的回复都写进 decisions.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'devflow-dec-'))
  const dir = join(root, '.dsh/workflow-artifacts/t1/repo/docs/reqs/REQ-003')
  mkdirSync(dir, { recursive: true })
  const ws = { path: root }, card = { title: 'REQ-003 排序比较' }
  assert.ok(saveDecision(ws, task, card, '5、默认。6、不用。', 'returned'))
  assert.ok(saveDecision(ws, task, card, '通过。Q1 选 B', 'approved'))
  assert.ok(!saveDecision(ws, task, card, '通过。', 'approved'))
  const md = readFileSync(join(dir, 'decisions.md'), 'utf8')
  assert.match(md, /## 讨论确认｜打回 #4（.+）\n5、默认。6、不用。/)
  assert.match(md, /## 讨论确认｜通过（.+）\nQ1 选 B/)
  assert.equal(md.split('# 人工决定').length, 2)
})
