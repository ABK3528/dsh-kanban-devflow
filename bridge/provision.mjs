// 项目接入：把套件里的流程手册、角色定义、文档骨架和「研发交付」流程定义放进工作区。
// 由同步桥在 DSH 进程内调用（也可以在测试里单独调用）。除 core 之外都是纯文件操作。
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const KIT = join(dirname(fileURLToPath(import.meta.url)), '..')

const walk = (dir, base = dir) => {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, base))
    else out.push(p.slice(base.length + 1))
  }
  return out
}
const same = (file, text) => existsSync(file) && readFileSync(file, 'utf8') === text

// 用套件版本覆盖项目里的文件：[套件内路径, 项目内路径]
export function overwriteSet(kit = KIT) {
  return [
    [join(kit, 'WORKFLOW.md'), 'docs/process/WORKFLOW.md'],
    ...walk(join(kit, 'agents')).map(rel => [join(kit, 'agents', rel), `docs/process/agents/${rel}`]),
  ]
}
// 文档骨架：项目里没有才创建
export function templateSet(kit = KIT) {
  return walk(join(kit, 'templates')).map(rel => [join(kit, 'templates', rel), rel])
}
export function loadDefinitions(kit = KIT) {
  return JSON.parse(readFileSync(join(kit, 'workflows.json'), 'utf8'))
}
// 套件内容指纹：覆盖类文件和流程定义任何一处变了就变。工作区记下它，指纹没变就不重复覆盖。
export function kitHash(kit = KIT) {
  const h = createHash('sha1')
  for (const [src, dest] of overwriteSet(kit)) h.update(dest + '\0').update(readFileSync(src)).update('\0')
  h.update(readFileSync(join(kit, 'workflows.json')))
  return h.digest('hex').slice(0, 16)
}

/** 写入工作区。覆盖前把不同的旧文件备份到 <工作区>/.dsh/kit-backup/<时间>/。返回做了什么。 */
export function provisionFiles(wsPath, { kit = KIT, now = new Date() } = {}) {
  const res = { overwritten: [], created: [], gitignore: [] }
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const backupRoot = join(wsPath, '.dsh', 'kit-backup', stamp)
  for (const [src, rel] of overwriteSet(kit)) {
    const dest = join(wsPath, rel), text = readFileSync(src, 'utf8')
    if (same(dest, text)) continue
    if (existsSync(dest)) {
      const bak = join(backupRoot, rel)
      mkdirSync(dirname(bak), { recursive: true })
      writeFileSync(bak, readFileSync(dest))
    }
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, text)
    res.overwritten.push(rel)
  }
  for (const [src, rel] of templateSet(kit)) {
    const dest = join(wsPath, rel)
    if (existsSync(dest)) continue
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readFileSync(src))
    res.created.push(rel)
  }
  const ig = join(wsPath, '.gitignore')
  const cur = existsSync(ig) ? readFileSync(ig, 'utf8') : ''
  const have = new Set(cur.split('\n').map(l => l.trim()))
  const add = ['.dsh/', '.dsh-kanban.json'].filter(l => !have.has(l) && !have.has('/' + l))
  if (add.length) {
    writeFileSync(ig, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n')
    res.gitignore = add
  }
  return res
}

// 比较时去掉 modelSelection（它是各工作区自己的模型选择，不属于套件）
const sig = d => JSON.stringify({ description: d.description ?? '', inputLabel: d.inputLabel ?? '', inputHint: d.inputHint ?? '',
  stages: (d.stages ?? []).map(({ modelSelection: _m, ...s }) => s) })

/**
 * 保证工作区里有套件里的每条流程：没有就创建；有但内容不同就按当前 revision 更新（各阶段已选的模型保留）。
 * force=false 时，已有的流程不动（只补缺）。返回 { created, updated }。
 */
export async function ensureWorkflows(core, wsId, { force, kit = KIT } = {}) {
  const res = { created: [], updated: [] }
  const existing = core.listWorkflows(wsId)
  for (const { name, ...definition } of loadDefinitions(kit)) {
    const have = existing.find(w => w.name === name)
    if (!have) {
      await core.createWorkflow({ requestId: `kit-${randomUUID()}`, workspaceId: wsId, name, definition }, KIT_ACTOR, null)
      res.created.push(name)
    } else if (force && sig(have.definition) !== sig(definition)) {
      const models = new Map(have.definition.stages.filter(s => s.modelSelection).map(s => [s.id, s.modelSelection]))
      const stages = definition.stages.map(s => models.has(s.id) ? { ...s, modelSelection: models.get(s.id) } : s)
      await core.updateWorkflow({ requestId: `kit-${randomUUID()}`, workflowId: have.id, expectedRevision: have.revision, name, definition: { ...definition, stages } }, KIT_ACTOR, null)
      res.updated.push(name)
    }
  }
  return res
}
const KIT_ACTOR = Object.freeze({ kind: 'user', id: 'owner', source: 'devflow-kit' })

/** 甬道顺序：套件的甬道按顺序排在最前，其余的原样排在后面。只移动，不删除任何甬道。 */
export function laneMoves(columns, lanes) {
  const order = [...lanes.map(t => columns.find(c => c.title === t)).filter(Boolean), ...columns.filter(c => !lanes.includes(c.title))]
  const cur = columns.map(c => c.id), moves = []
  order.forEach((c, i) => {
    if (cur[i] === c.id) return
    cur.splice(cur.indexOf(c.id), 1); cur.splice(i, 0, c.id)
    moves.push({ id: c.id, toIndex: i })
  })
  return moves
}
