// 看板 ⇄ Workflow 同步桥：在 DSH Host 进程内运行（由套件的看板插件 dsh-kanban-devflow 的 workflow 部分加载，路径登记在 profile 的 dsh-devflow-bridge.json，见 install.mjs）。
//
// 看板模型：甬道 = 阶段（开始、需求/技术讨论、实施、测试中、发布、关闭），标签 = 状态（谁在动、卡在哪）。
// 做什么：
//   1. Workflow → 看板：每个任务对应一张卡（没有就自动建卡并编号），甬道、描述第 1 行、标签、阶段结果评论实时同步。
//   2. 看板 → Workflow：卡片带「待人工确认」时，你在卡片里回复即可，桥读到回复就自动去掉标签并按回复执行
//      （手动去掉标签仍然可用，作为兼容路径）：
//        「开始」甬道里还没启动的卡：「开始…」=建任务并启动；「终止…」=取消。
//        等审核：「通过…」=通过并继续；「终止…」=终止任务；其他内容=打回重做，整段回复作为反馈。
//        失败/需处理：「重试…」=重试当前阶段；「终止…」=终止任务。
//        发布失败（任务已结束）：「重试…」=新建只重新发布的任务；「终止…」=取消。
//   测试关卡（g_test）例外，由桥自动决定，不找人：测试阶段只报告，回复首行「测试通过」=自动通过；「测试未通过 N 项」=自动打回到编码，
//   缺陷清单作为反馈；连续 5 轮仍未通过、首行无法识别或测试阶段阻塞时，才停下来等人。自动决定的来源记为 bridge-auto。
//   只认人在看板界面上的操作（activity.source === 'human'）：人发的评论、人手动去掉标签都算；AI 用 kanban_* 工具发评论或改标签都不算。
//   发布提权（「等待审批」→「允许一次」）是 DSH 的权限审批，不归 Workflow 管，仍须在节点弹窗里点。
//
// 自动接入：DSH 里打开的 git 项目，同步桥会自动写入流程手册、角色定义、文档骨架（缺的才建），创建/更新「研发交付」流程，
//   补齐并重排看板甬道和标签（见 provision.mjs）。套件内容变化（git pull 后重启 DSH）时再覆盖一次，覆盖前备份到 <项目>/.dsh/kit-backup/。
//   不想接入的项目：在项目根目录放一个空文件 .dsh-devflow-off；全局关闭自动接入：环境变量 DSH_DEVFLOW_AUTO=0。
// 只处理接入了本套件的项目（根目录有 docs/process/WORKFLOW.md），只处理「研发交付」流程的任务。
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { provisionFiles, ensureWorkflows, kitHash, laneMoves } from './provision.mjs'

const KANBAN = Symbol.for('dsh-kanban-flow-kit.kanban')
const FLOW = '研发交付'
// 标签按「组::名」分组（同 GitLab 的 scoped label，同组互斥）。评论和提示文字里仍写短名 WAIT_TEXT。
const WAIT_TEXT = '待人工确认'
const WAIT = '状态::待人工确认'
const LANE = { start: '开始', discuss: '需求/技术讨论', impl: '实施', test: '测试中', accept: '发布', closed: '关闭' }
const COLUMNS = Object.values(LANE)
const STAGE_LANE = { discuss: LANE.discuss, g_discuss: LANE.discuss, plan: LANE.impl, code: LANE.impl, test: LANE.test, g_test: LANE.test,
  prep: LANE.accept, g_accept: LANE.accept, release: LANE.accept }
const TYPE_LABEL = { REQ: '类型::需求', IMP: '类型::改进', BUG: '类型::缺陷', DEBT: '类型::技术债' }
const TYPE_PREFIX = Object.fromEntries(Object.entries(TYPE_LABEL).map(([p, l]) => [l, p]))
const LBL = { ai: '状态::AI处理中', blocked: '原因::阻塞', failed: '原因::失败', rework: '标记::返工', published: '结果::已发布', cancelled: '结果::已取消' }
// 旧的不分组标签名 → 新名。ensureBoard 会把看板里还在用旧名的标签原地改名（卡片上的引用跟着改）。
const LEGACY = { 需求: TYPE_LABEL.REQ, 改进: TYPE_LABEL.IMP, 缺陷: TYPE_LABEL.BUG, 技术债: TYPE_LABEL.DEBT, AI处理中: LBL.ai,
  待人工确认: WAIT, 阻塞: LBL.blocked, 失败: LBL.failed, 返工: LBL.rework, 已发布: LBL.published, 已取消: LBL.cancelled }
// 已停用的标签：「步骤」组去掉（甬道、描述第 1 行和评论标签已经说明当前阶段）；「紧急」改用卡片自带的优先级字段（high）。
// ensureBoard 会先把带「紧急」的卡片优先级设为 high，再删除这些标签（卡片上的引用随之清掉）。
const RETIRED = ['计划中', '开发中', '步骤::计划中', '步骤::开发中']
const RETIRED_URGENT = ['紧急', '优先级::紧急']
// 同步桥维护的标签；其余标签（类型和你自己加的）原样保留。
const MANAGED = new Set([WAIT, ...Object.values(LBL)])
const COLORS = { [TYPE_LABEL.REQ]: '#3b82f6', [TYPE_LABEL.IMP]: '#10b981', [TYPE_LABEL.BUG]: '#ef4444', [TYPE_LABEL.DEBT]: '#a16207', 
  [LBL.ai]: '#6366f1', [WAIT]: '#f59e0b', [LBL.blocked]: '#e11d48', [LBL.failed]: '#9f1239',
  [LBL.rework]: '#f97316', [LBL.published]: '#22c55e', [LBL.cancelled]: '#6b7280' }
const STATE_TEXT = { queued: '排队中', running: '运行中', waiting_review: '等你审核', needs_attention: '需要处理',
  failed: '失败', terminating: '终止中', terminated: '已终止', completed: '已完成' }
const OUTCOME_TEXT = { succeeded: '成功', returned: '打回', terminated: '终止', approved: '通过' }
const ACTOR = Object.freeze({ kind: 'user', id: 'owner', source: 'kanban-label' })
// 同步桥自动决定测试关卡时用的身份。引擎要求决定者 kind 为 user；source 用来在活动记录和评论里和人工决定区分开。
const AUTO = Object.freeze({ kind: 'user', id: 'bridge-auto', source: 'bridge-auto' })
const TEST_ROUNDS = 5
const ID_LINE = /^((REQ|IMP|BUG|DEBT)-\d{3,})\s+(.+)$/

const labelsOf = c => c.labels ?? (c.label ? [c.label] : [])
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x))

// 人的动作怎么算：卡片还带「待人工确认」时，人发一条评论（'reply'）或手动去掉这个标签（'label'）都算处理完了。
// 只认 activity.source === 'human'；AI 用 kanban_* 工具发的评论、改的标签都不算，避免自动循环。
export function humanAction(a, card) {
  if (!a || a.source !== 'human' || !card) return null
  if (a.type === 'card_comment_added') return labelsOf(card).includes(WAIT) ? 'reply' : null
  if (a.type === 'card_label_changed' && (a.meta?.removed ? a.meta.removed.includes(WAIT) : a.from === WAIT && a.to !== WAIT)) return 'label'
  return null
}
const typeOf = card => labelsOf(card).find(n => TYPE_PREFIX[n])
const idOf = card => /^((REQ|IMP|BUG|DEBT)-\d{3,})(\s|$)/.exec(card.title)?.[1]
// 描述末尾由同步桥维护的「阶段成果」区块：从这个标题行到描述结尾。不用 HTML 注释做标记，Markdown 预览里可能露出来。
const RESULTS_HEAD = '## 阶段成果（自动同步）'
const splitResults = note => {
  const lines = String(note ?? '').split('\n')
  const at = lines.findIndex(l => l.trim() === RESULTS_HEAD)
  return at < 0 ? { main: lines.join('\n'), block: '' } : { main: lines.slice(0, at).join('\n'), block: lines.slice(at).join('\n') }
}
const bodyOf = note => splitResults(note).main.split('\n').filter(l => !l.startsWith('流程：')).join('\n').trim()
const firstLine = text => (String(text ?? '').split('\n').map(s => s.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '')
const fmt = ms => {
  const d = new Date(ms), p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const actNum = id => Number(String(id ?? '').slice(1)) || 0
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const stageLabel = stage => (stage.kind === 'review' ? stage.id.replace(/^g_/, 'G:') : stage.id)
const setFlowLine = (note, line) => {
  const lines = String(note ?? '').split('\n')
  const at = lines.findIndex(l => l.startsWith('流程：'))
  if (at >= 0) lines[at] = line; else lines.unshift(line)
  return padFlow(lines.join('\n'))
}
// 「流程：」行后面紧跟正文时补一个空行，否则 Markdown 预览会把两行并成一段
const padFlow = note => {
  const lines = String(note ?? '').split('\n')
  const at = lines.findIndex(l => l.startsWith('流程：'))
  if (at >= 0 && at + 1 < lines.length && lines[at + 1].trim()) lines.splice(at + 1, 0, '')
  return lines.join('\n')
}
// 下一个编号：看板卡片、docs/reqs/ 目录名、git 分支名里出现过的都算，避免和已删卡片留下的文档或分支撞号。
function nextId(board, prefix, root) {
  const re = new RegExp(`(?:^|/)${prefix}-(\\d+)`)
  const names = board.cards.map(c => c.title)
  if (root) {
    try { names.push(...readdirSync(join(root, 'docs', 'reqs'))) } catch {}
    try {
      names.push(...execFileSync('git', ['-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
        { encoding: 'utf8', timeout: 5000 }).split('\n'))
    } catch {}
  }
  const max = Math.max(0, ...names.map(n => re.exec(n)?.[1]).filter(Boolean).map(Number))
  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}

// 草稿格式报告里某个「## 标题」小节的内容行。
// keepIndent：保留缩进，评论按 Markdown 渲染时子项仍是子项。
function section(lines, title, max, keepIndent = false) {
  const at = lines.findIndex(l => new RegExp(`^#+\\s*${title}`).test(l.trim()))
  if (at < 0) return null
  const out = []
  for (const l of lines.slice(at + 1)) {
    if (/^#+\s/.test(l.trim())) break
    if (l.trim()) out.push(keepIndent ? l.trimEnd() : l.trim())
  }
  return out.slice(0, max)
}

// 按行拼成不超过 size 字符的几段（插件评论上限 2000）。只在顶层条目（不缩进的行）前切，子项跟着父项走。
function chunks(lines, size) {
  const out = []
  let cur = []
  const len = a => a.join('\n').length
  const groups = []
  for (const l of lines) (/^\s/.test(l) && groups.length ? groups.at(-1) : (groups.push([]), groups.at(-1))).push(l)
  for (const g of groups) {
    if (cur.length && len([...cur, ...g]) > size) { out.push(cur.join('\n')); cur = [] }
    cur.push(...g)
  }
  if (cur.length) out.push(cur.join('\n'))
  return out.map(s => s.length > size ? s.slice(0, size - 1) + '…' : s)
}

// Markdown 按段落切成不超过 size 字符的几段；不在代码块中间切。
function mdChunks(text, size) {
  const blocks = []
  let cur = [], fence = false
  for (const l of String(text ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    if (!fence && !l.trim()) { if (cur.length) blocks.push(cur.join('\n')); cur = []; continue }
    cur.push(l)
  }
  if (cur.length) blocks.push(cur.join('\n'))
  const out = []
  let acc = ''
  for (const b of blocks) {
    if (acc && (acc + '\n\n' + b).length > size) { out.push(acc); acc = '' }
    acc = acc ? acc + '\n\n' + b : b
    while (acc.length > size) { out.push(acc.slice(0, size)); acc = acc.slice(size) }
  }
  if (acc) out.push(acc)
  return out
}

// 各阶段在工作副本里产出的文档，精简后放进阶段评论（相对 docs/reqs/<ID>/）。
const STAGE_DOCS = { discuss: ['brief.md', 'prd.md', 'tech.md', 'bug.md', 'cases.md'], plan: ['PLAN.md', 'plan.md'], test: ['test-report.md', 'defects.md'], prep: ['release.md'] }

// ---- 产物精简：评论里看得懂结论，全文点链接看 ----
// 链接指向 DSH 的 /api/file，看板插件（plugin/src/client/components/CardComments.tsx）拦下点击在卡片里弹出预览。
const fileHref = path => '/api/file?path=' + path.split('/').map(s => encodeURIComponent(s).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
// 截断时不留下没闭合的 `代码` 和 **加粗**，否则后面整段渲染都会乱
function mdClip(s, n) {
  let t = clip(String(s ?? '').replace(/\s+/g, ' ').trim(), n)
  if ((t.match(/`/g) ?? []).length % 2) t = t.slice(0, t.lastIndexOf('`')).replace(/[\s…,，、；;：:]+$/, '') + '…'
  if ((t.match(/\*\*/g) ?? []).length % 2) t = t.replace(/\*\*/g, '')
  return t
}
// 评论里不要的小节（细节留给文档本身）；DOC_KEY 是读者最关心的，篇幅不够时最后才删
const DOC_SKIP = /用例|TC 索引|回归清单|覆盖矩阵|非目标|范围外|轮次|发布步骤|冒烟|关联的|通用约定|现状|备选|工作量|性能与安全|对测试的影响|价值与成本|用户与场景|对照/
const DOC_KEY = /目标|要点|功能点|验收标准|变化|方案|改哪些|实施要点|步骤|偏离|命令|结果|测试结论|探索|版本号|变更说明|风险|回滚|待确认|未决|拍板|缺陷/
const PASSED = /^(通过|已修复|已关闭|已验证|关闭|不修|pass|ok)/i
const tableCells = row => row.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim())
// 表格转成要点：有「结果/状态」列的只列统计和没通过的行；交接卡单独取「目标」
function tableItems(rows) {
  const [head = [], ...rest] = rows.map(tableCells)
  const body = rest.filter(c => !c.every(x => !x || /^:?-{2,}:?$/.test(x)))
  if (head[0] === '项' && head[1] === '内容') return { card: Object.fromEntries(body.map(c => [c[0], c[1]])) }
  // 「结果」列是短词（通过/失败/待修复）才按状态统计；写的是长句（比如命令输出）就当普通表格
  const ri = head.findIndex((x, i) => /^(结果|状态)$/.test(x) && body.every(c => (c[i] ?? '').length <= 12))
  const row = c => c.filter(x => x && x !== '—' && x !== '-').slice(0, 4).join('｜')
  if (ri < 0) return { items: body.map(row) }
  // 编号写「（无）」的占位行（比如「第 1 轮未发现缺陷」）不计数，只剩占位行时直接显示它的说明
  const real = body.filter(c => !/^[（(]?(无|暂无|none|n\/a|—|-)[）)]?$/i.test(c[0] ?? ''))
  if (!real.length) return { items: body.map(c => row(c.slice(1))).filter(Boolean).slice(0, 1).concat(body.length ? [] : ['无记录']) }
  const tally = {}
  for (const c of real) { const k = (c[ri] || '—').split(/[（(\s]/)[0]; tally[k] = (tally[k] ?? 0) + 1 }
  return { items: [`共 ${real.length} 项：${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join('，')}`, ...real.filter(c => !PASSED.test(c[ri] ?? '')).map(row)] }
}
// 文档拆成「目标 + 小节（每节若干条，顶层条目、段落、表格行）」
export function parseDoc(text) {
  const doc = { goal: '', sections: [] }
  let cur = { title: '', level: 1, items: [] }, fence = false, table = null, absorb = false
  doc.sections.push(cur)
  const flush = () => {
    if (!table) return
    const t = tableItems(table); table = null
    if (t.card) doc.goal ||= t.card['目标'] ?? ''
    else cur.items.push(...t.items)
  }
  for (const raw of String(text ?? '').split('\n')) {
    const l = raw.trimEnd()
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue }
    if (fence) continue
    if (/^\s*\|/.test(l)) { (table ??= []).push(l); continue }
    flush()
    const h = /^(#{1,4})\s+(.*)$/.exec(l)
    if (h) {
      absorb = false
      const level = h[1].length, title = h[2].replace(/^\d+(\.\d+)*[.、]?\s+/, '').replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim()
      // 跳过的小节连同它下面的子小节一起跳过
      const parent = [...doc.sections].reverse().find(s => s.level < level)
      if (level > 1) doc.sections.push(cur = { title, level, items: [], skip: DOC_SKIP.test(title) || !!parent?.skip })
      continue
    }
    if (!l.trim() || /^(>|<!--)/.test(l)) continue
    const listed = /^\s*([-*+]|\d+[.、)])\s+/.test(l)
    // 第一个小节标题之前只收列表（有的计划把步骤直接列在大标题下），「依据」「基线」这类段落不要
    if (cur.level === 1 && !listed) continue
    const item = l.trim().replace(/^([-*+]|\d+[.、)])\s+/, '')
    // 子项（缩进）一般不进评论；父项以冒号结尾（「改 `cli.py`：」）时子项是正文，接到父项后面
    if (/^\s/.test(l)) { if (absorb && cur.items.length) cur.items[cur.items.length - 1] += (/[：:]$/.test(cur.items.at(-1)) ? '' : '；') + item; continue }
    absorb = /[：:]$/.test(item)
    cur.items.push(item.replace(/^\[([ xX])\]\s*/, (m, x) => (x.trim() ? '✅ ' : '⬜ ')))
  }
  flush()
  doc.sections = doc.sections.filter(s => s.items.length && !s.skip)
  return doc
}
// 一篇文档在给定精简程度下的 Markdown。lv.items 每节最多几条，lv.len 每条最多几字，lv.keep 最多保留几节。
function renderDoc(file, doc, lv) {
  let secs = doc.sections.map((s, i) => ({ ...s, i, key: DOC_KEY.test(s.title) }))
  if (lv.keep < secs.length) { // 先删非重点小节（从后往前），再删重点小节
    const order = [...secs].sort((a, b) => (a.key - b.key) || (b.i - a.i))
    const drop = new Set(order.slice(0, secs.length - lv.keep).map(s => s.i))
    secs = secs.filter(s => !drop.has(s.i))
  }
  const out = [`📄 **[${file.name}](${fileHref(file.path)})**` + (doc.goal ? `　${mdClip(doc.goal, lv.len)}` : '')]
  for (const s of secs) {
    const shown = s.items.slice(0, lv.items).map(x => `- ${mdClip(x, lv.len)}`)
    if (s.items.length > lv.items) shown.push(`- …另 ${s.items.length - lv.items} 条，见全文`)
    out.push((s.title ? `**${mdClip(s.title, 30)}**\n` : '') + shown.join('\n'))
  }
  const hidden = doc.sections.length - secs.length
  if (hidden > 0) out.push(`（另有 ${hidden} 节未列出，见全文）`)
  return out.join('\n\n')
}
const DOC_LEVELS = [{ items: 6, len: 110 }, { items: 5, len: 90 }, { items: 4, len: 70 }, { items: 3, len: 56 }, { items: 2, len: 44 }]
// 几篇文档合起来不超过 budget 字：逐级收紧条数和字数，再逐节删。
// 篇幅按权重分（需求/简要设计 > 技术方案 > 用例），前面的文档没用完的留给后面。
const DOC_WEIGHT = { 'brief.md': 3, 'prd.md': 3, 'bug.md': 3, 'cases.md': 1 }
export function condenseDocs(files, budget) {
  const parts = []
  let left = budget
  const weight = f => DOC_WEIGHT[f.name] ?? 2
  // 短文档先分（用不完的留给长文档），输出仍按原顺序
  const order = files.map((f, i) => i).sort((a, b) => files[a].text.length - files[b].text.length)
  order.forEach((idx, n) => {
    const file = files[idx], doc = parseDoc(file.text)
    const room = Math.floor(left * weight(file) / order.slice(n).reduce((s, i) => s + weight(files[i]), 0)) - 2
    let md = ''
    for (const lv of DOC_LEVELS) {
      for (let keep = doc.sections.length; keep >= (lv === DOC_LEVELS.at(-1) ? 0 : doc.sections.length); keep--) {
        md = renderDoc(file, doc, { ...lv, keep })
        if (md.length <= room) break
      }
      if (md.length <= room) break
    }
    if (md.length > room) md = `📄 **[${file.name}](${fileHref(file.path)})**`
    parts[idx] = md
    left -= md.length + 2
  })
  return parts.join('\n\n')
}

// 测试关卡怎么决定。head 是测试阶段回复的首行，streak 是此前连续被同步桥自动打回的次数（人做过决定就从头计）。
//   pass：测试通过，或重新发布模式下测试阶段跳过；fail：未通过，还没到上限，自动打回；
//   capped：未通过且已是第 TEST_ROUNDS 轮，交给人；unknown：首行认不出来，交给人。
export function testVerdict(head, streak) {
  const h = String(head ?? '').replace(/^[\s`*_>]+/, '')
  const round = streak + 1
  if (/^测试通过/.test(h) || /^跳过[:：]/.test(h)) return { kind: 'pass', round }
  if (/^测试未通过/.test(h)) return { kind: round >= TEST_ROUNDS ? 'capped' : 'fail', round }
  return { kind: 'unknown', round }
}
// 从最近一次决定往回数，连续被同步桥自动打回了几次。
export function autoReturnStreak(gateVisits, reviews) {
  let n = 0
  for (const v of [...gateVisits].reverse()) {
    const r = reviews.find(x => x.visitId === v.id)
    if (v.outcome === 'returned' && r?.decidedBy?.source === AUTO.source) n++
    else break
  }
  return n
}

// 从阶段报告里摘要。草稿格式：待你拍板 + 本轮修改；普通报告：首行结论 + 前几条要点。
function digest(text, max = 5) {
  const lines = String(text ?? '').split('\n')
  const asks = section(lines, '待你拍板', 60, true)
  if (asks) {
    const real = asks.filter(p => !/^-?\s*无\s*$/.test(p.trim()))
    // 项数按顶层条目算（不缩进的行），子项是选项和推荐。
    const count = real.filter(p => !/^\s/.test(p)).length
    return { draft: true, head: '', asks: real, count, changes: section(lines, '本轮修改', max) ?? [], points: [] }
  }
  return { draft: false, head: firstLine(text), asks: [], changes: [],
    points: lines.map(l => l.trim()).filter(l => /^([-*]|\d+[.、)])\s+/.test(l)).slice(0, max) }
}

// 「阶段成果」区块的 Markdown。opt.point 要点截断长度，opt.docs 是否带文档行，opt.last 只保留最后几行。
const RESULT_ICON = { 成功: '✅', 通过: '✅', 打回: '↩️', 终止: '⛔', 阻塞: '⚠️', 失败: '❌', 未通过: '❌', 需要处理: '⚠️', 等你审核: '🙋' }
const cell = s => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim() || '—'
function renderResults(rows, docs, opt) {
  const shown = opt.last ? rows.slice(-opt.last) : rows
  const out = [RESULTS_HEAD,
    `> 同步桥根据 Workflow 自动维护，更新于 ${fmt(Date.now())}。各阶段全文见下方评论；本节由同步桥覆盖，请不要在这里写内容。`,
    '', '| 阶段 | 结果 | 要点 | 时间 |', '|---|---|---|---|']
  if (shown.length < rows.length) out.push(`| … | | 更早的 ${rows.length - shown.length} 个阶段见评论 | |`)
  for (const r of shown) {
    out.push(`| ${cell(r.stage)}${r.round > 1 ? `（第 ${r.round} 轮）` : ''} | ${RESULT_ICON[r.result] ?? '⏳'} ${cell(r.result)} | ${cell(clip(r.point, opt.point))} | ${cell(r.time)} |`)
  }
  if (opt.docs && docs) out.push('', docs)
  return out.join('\n')
}
// 区块比较时忽略「更新于」时间，避免每次同步都改描述
const sameResults = (a, b) => a.replace(/更新于 [^。]*。/, '') === b.replace(/更新于 [^。]*。/, '')
// 把区块放到描述末尾；先尽量完整，超过 2000 字再逐级精简。你自己写的正文永远不截断，实在放不下就不写区块。
function withResults(note, rows, docs) {
  const main = splitResults(note).main.replace(/\s+$/, '')
  for (const opt of [{ point: 80, docs: true }, { point: 40, docs: true }, { point: 40, docs: false }, { point: 24, docs: false, last: 6 }, { point: 16, docs: false, last: 3 }]) {
    const next = `${main}\n\n${renderResults(rows, docs, opt)}`
    if (next.length <= 2000) return next
  }
  return null
}

// 人在关卡里的回复要一直传到后面的阶段，但引擎做不到：「通过」时的附言不进下游输入；打回的反馈只保留最后一轮
// （再次打回后，上一轮的反馈和那轮的报告都被作废）。角色之间只通过文件交接，所以每条人工回复（通过的附言、
// 打回的意见）都追加写到工作副本的 docs/reqs/<ID>/decisions.md，所有角色必读；打回时还把前几轮回复拼进反馈。
export function saveDecision(ws, task, card, text, decision) {
  try {
    const id = idOf(card)
    const note = decision === 'approved' ? text.replace(/^(通过|同意|批准|ok|lgtm|approve)[。.，,！!：:\s]*/i, '').trim() : text.trim()
    if (!id || !note || !ws.path) return false
    const dir = join(ws.path, '.dsh', 'workflow-artifacts', task.id, 'repo', 'docs', 'reqs', id)
    if (!existsSync(dir)) return false
    const file = join(dir, 'decisions.md')
    const stage = task.definition.stages.find(s => s.id === task.currentStage?.id)
    const kind = decision === 'approved' ? '通过' : decision === 'void' ? '作废' : `打回 #${task.visits.filter(x => x.outcome === 'returned').length + 1}`
    appendFileSync(file, (existsSync(file) ? '' : '# 人工决定\n\n人在审核关卡里的回复，按时间排列：「通过」时的补充说明是拍板结论或授权；「打回」是修改意见和对待拍板问题的回答。'
      + '都优先于文档里的暂定写法；同一个问题前后说法不同时，以后面的为准。\n')
      + `\n## ${stage?.title ?? '关卡'}｜${kind}（${fmt(Date.now())}）\n${note}\n`)
    return true
  } catch (error) { console.warn('kanban-bridge: saveDecision', error?.message ?? error); return false }
}

// 打回的反馈：本轮回复在前，附上此前各轮人在关卡里的回复（引擎只把最后一轮反馈交给下游，前几轮会丢）。
const HISTORY = '\n\n【此前各轮你在关卡里的回复，仍然有效，本轮改了的以本轮为准】\n'
export function withHistory(task, feedback) {
  const earlier = (task.reviews ?? []).filter(r => r.feedback && ['approved', 'returned'].includes(r.state) && r.decidedBy?.source !== AUTO.source)
    .map(r => [r, r.feedback.split(HISTORY)[0].trim()])
    .filter(([r, fb]) => r.state === 'returned' || fb.replace(/^(通过|同意|批准|ok|lgtm|approve)[。.，,！!：:\s]*/i, ''))
    .map(([r, fb]) => `- ${task.definition.stages.find(s => s.id === task.visits.find(v => v.id === r.visitId)?.stageId)?.title ?? '关卡'}`
      + `（${r.state === 'approved' ? '通过' : '打回'}）：${fb}`)
  if (!earlier.length) return feedback
  return (feedback + HISTORY + earlier.join('\n')).slice(0, 9500)
}

export function startBridge({ core, store, attachments, workspaceRegistry, readArtifactText, profileDir, intervalMs = 3000 }) {
  const statePath = join(profileDir, 'workflow-poc', 'kanban-bridge.json')
  let state = { workspaces: {}, tasks: {} }
  try { state = { workspaces: {}, tasks: {}, ...JSON.parse(readFileSync(statePath, 'utf8')) } } catch {}
  let dirty = false, running = false, again = false, disposed = false, debounce
  // 描述格式升级（v2 阶段成果区块，v3 流程行后空一行）：已有任务都重新过一遍（每个版本只做一次）
  const RESULTS_VERSION = 3
  if (state.resultsVersion !== RESULTS_VERSION) {
    for (const st of Object.values(state.tasks)) delete st.lastSeen
    state.resultsVersion = RESULTS_VERSION
    dirty = true
  }
  const log = (...a) => console.warn('kanban-bridge:', ...a)
  const KIT_HASH = (() => { try { return kitHash() } catch (error) { log('kitHash', error?.message ?? error); return null } })()
  const autoOnboard = process.env.DSH_DEVFLOW_AUTO !== '0'
  const save = () => {
    if (!dirty) return
    const tmp = statePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(state, null, 1))
    renameSync(tmp, statePath)
    dirty = false
  }

  const kanban = () => globalThis[KANBAN]
  const call = async (ws, method, args) => {
    const r = await kanban().dispatch(ws, method, args, 'agent')
    if (r?.error) throw new Error(`${method}: ${r.error}`)
    return r
  }
  const comment = (ws, cardId, content) => call(ws, 'addComment', { id: cardId, content: clip(content, 2000) })
  const refresh = async ws => (await call(ws, 'get', {})).board

  const artifactText = async artifact => {
    try { return await readArtifactText(attachments, artifact) } catch { return '' }
  }
  const visitText = async (task, visit) => {
    const attempts = new Set(task.attempts.filter(a => a.visitId === visit.id).map(a => a.id))
    const art = task.artifacts.filter(a => attempts.has(a.attemptId)).at(-1)
    return art ? artifactText(art) : ''
  }
  const lastOutput = async task => {
    const art = task.effectiveArtifacts.at(-1)
    return art ? firstLine(await artifactText(art)) : ''
  }

  // 只处理「研发交付」流程的任务（旧流程的任务不碰）。
  const flowOf = new Map()
  const isFlow = id => {
    if (!flowOf.has(id)) flowOf.set(id, store.getTask(id).workflowName === FLOW)
    return flowOf.get(id)
  }

  // 某阶段回复首行是「阻塞：原因」时，任务照常往下走（后面的阶段会跳过），但卡片要停在出问题的阶段并等你处理。
  const blockedCache = new Map()
  async function blocked(task) {
    const key = `${task.id}:${task.updatedAt}`
    if (blockedCache.has(key)) return blockedCache.get(key)
    let found = null
    for (const art of task.effectiveArtifacts) {
      const m = /^阻塞[:：]\s*(.*)$/.exec(firstLine(await artifactText(art)))
      if (!m) continue
      const attempt = task.attempts.find(a => a.id === art.attemptId)
      const visit = attempt && task.visits.find(v => v.id === attempt.visitId)
      found = { stageId: visit?.stageId, reason: m[1] || '见阶段报告' }
      break
    }
    if (blockedCache.size > 50) blockedCache.clear()
    blockedCache.set(key, found)
    return found
  }
  const reviewVisits = task => task.visits.filter(v => v.closedAt && task.definition.stages.find(s => s.id === v.stageId)?.kind === 'review')

  // ---- 测试关卡（g_test）：同步桥按测试阶段回复的首行自动决定 ----
  // 返回 null 表示流程定义里没有 g_test（旧版本定义的在途任务）。
  async function testGateInfo(task) {
    if (!task.definition.stages.some(s => s.id === 'g_test' && s.kind === 'review')) return null
    const testVisit = task.visits.filter(v => v.stageId === 'test' && v.closedAt).at(-1)
    const text = testVisit ? await visitText(task, testVisit) : ''
    const head = firstLine(text)
    const streak = autoReturnStreak(task.visits.filter(v => v.stageId === 'g_test' && v.closedAt), task.reviews)
    return { head, text, ...testVerdict(head, streak) }
  }
  // 能自动决定就决定，返回 true；交给人（阻塞、首行认不出、到了轮数上限、提交失败）返回 false。
  async function autoGate(task, st) {
    const r = task.review
    if (task.state !== 'waiting_review' || task.currentStage?.id !== 'g_test' || !r) return false
    if (st.autoFailed === r.id || await blocked(task)) return false
    const info = await testGateInfo(task)
    if (!info || !['pass', 'fail'].includes(info.kind)) return false
    const decision = info.kind === 'pass' ? 'approved' : 'returned'
    let feedback
    if (decision === 'approved') feedback = `【测试关卡自动通过】${info.head}`
    else {
      const lines = info.text.split('\n')
      // 去掉引擎的 workflow-handoff 代码块：那是给下一阶段的结构化交接，引擎另行注入，放进反馈只是噪音。
      const rest = lines.slice(lines.findIndex(l => l.trim()) + 1).join('\n')
        .replace(/^```workflow-handoff[^\n]*\n[\s\S]*?(?:^```[ \t]*$|$(?![\s\S]))/m, '').trim()
      feedback = clip(`【测试关卡打回｜第 ${info.round}/${TEST_ROUNDS} 轮】${info.head}\n`
        + '先读 defects.md，在「实施回应」列逐条回应（修 / 不同意），再按 AGENT.md 的「缺陷修复」修复。\n\n'
        + (rest || '（测试阶段没有列出缺陷明细，以 defects.md 为准）'), 6000)
    }
    try {
      // requestId 固定：同一个关卡重复提交时引擎回放第一次的结果，不会决定两次。
      await core.decideReview({ taskId: task.id, reviewId: r.id, subjectHash: r.subjectHash, expectedRevision: task.revision,
        requestId: `kanban-auto-${r.id}`, decision, feedback }, AUTO)
    } catch (error) {
      st.autoFailed = r.id
      dirty = true
      log('autoGate', task.id, error?.message ?? error)
      return false
    }
    return true
  }

  // ---- 看板结构：缺的甬道和标签补上（用户已授权创建/修改） ----
  async function ensureBoard(ws, board) {
    // 旧甬道名「待验收」→「发布」：原地改名，卡片跟着走；新名已存在时不动
    const old = board.columns.find(c => c.title === '待验收')
    if (old && !board.columns.some(c => c.title === LANE.accept)) { await call(ws, 'renameColumn', { id: old.id, title: LANE.accept }); board = await refresh(ws) }
    for (const title of COLUMNS) {
      if (!board.columns.some(c => c.title === title)) await call(ws, 'addColumn', { title })
    }
    let renamed = false
    for (const [from, to] of Object.entries(LEGACY)) {
      if (board.labels.some(l => l.name === from) && !board.labels.some(l => l.name === to)) {
        await call(ws, 'updateLabel', { name: from, newName: to }); renamed = true
      }
    }
    if (renamed) board = await refresh(ws)
    let cleaned = false
    for (const name of RETIRED_URGENT) {
      if (!board.labels.some(l => l.name === name)) continue
      for (const card of board.cards.filter(c => labelsOf(c).includes(name) && c.priority !== 'high')) await call(ws, 'updateCard', { id: card.id, priority: 'high' })
      await call(ws, 'deleteLabel', { name }); cleaned = true
    }
    for (const name of RETIRED) {
      if (board.labels.some(l => l.name === name)) { await call(ws, 'deleteLabel', { name }); cleaned = true }
    }
    // 套件标签以外、没有任何卡片在用的标签（插件默认的 New Feature/bug/Feedback、项目遗留的 S1-… 等）删掉；有卡片在用的保留。
    const KEEP = new Set([...Object.values(TYPE_LABEL), WAIT, ...Object.values(LBL)])
    const used = new Set(board.cards.flatMap(labelsOf))
    for (const l of board.labels) {
      if (KEEP.has(l.name) || used.has(l.name)) continue
      await call(ws, 'deleteLabel', { name: l.name }); cleaned = true
    }
    if (cleaned) board = await refresh(ws)
    for (const name of [...Object.values(TYPE_LABEL), WAIT, ...Object.values(LBL)]) {
      const have = board.labels.find(l => l.name === name)
      const color = COLORS[name] ?? '#94a3b8'
      if (!have) await call(ws, 'addLabel', { name, color })
      // 插件默认灰色的同名标签补上区分色；用户自己改过的颜色不动
      if (!have || have.color === '#94a3b8') await call(ws, 'updateLabel', { name, color })
    }
    let fresh = await refresh(ws)
    const done = fresh.columns.find(c => c.title === LANE.closed)
    if (done && fresh.completedColumnId !== done.id) {
      await call(ws, 'setCompletedColumn', { columnId: done.id })
      fresh = await refresh(ws)
    }
    return fresh
  }

  // ---- 计算任务在看板上的样子 ----
  async function view(task, st) {
    const stage = task.currentStage
    const blk = await blocked(task)
    let lane = STAGE_LANE[blk?.stageId ?? stage.id] ?? LANE.discuss
    let need = null // 需要人处理的原因；同一个 key 只提醒一次
    let status = STATE_TEXT[task.state] ?? task.state
    let ai = false, reasons = [], result = []
    if (st?.cancelled || task.state === 'terminated') {
      lane = LANE.closed; result = [LBL.cancelled]; status = '已取消'
    } else if (task.state === 'completed') {
      const last = await lastOutput(task)
      if (/^已发布/.test(last)) { lane = LANE.closed; result = [LBL.published]; status = clip(last, 40) } else {
        lane = LANE.accept; reasons = [LBL.failed]; status = `发布未完成：${clip(last, 30)}`
        need = { key: `completed:${task.id}`, kind: 'completed' }
      }
    } else if (task.state === 'waiting_review') {
      status = `等你${stage.id === 'g_accept' ? '验收' : '确认'}`
      if (blk) reasons = [LBL.blocked]
      need = { key: `review:${task.review?.id}`, kind: 'review' }
    } else if (task.state === 'needs_attention' || task.state === 'failed') {
      reasons = [LBL.failed]
      need = { key: `attention:${task.currentVisitId}:${task.revision}`, kind: 'attention' }
    } else if (task.state === 'running' && stage.id === 'release') {
      status = '发布中（可能在等你批准提权）'
      need = { key: `escalate:${task.currentVisitId}`, kind: 'escalate' }
    } else ai = task.state === 'running' || task.state === 'queued'
    const closed = lane === LANE.closed
    const last = reviewVisits(task).at(-1)
    const rework = !closed && task.state !== 'waiting_review' && last?.outcome === 'returned'
    const flowLine = `流程：${task.id}｜${stage.title}｜${status}｜${fmt(task.updatedAt)}${need ? '｜等你' : ''}`
    return { lane, need, flowLine, ai, reasons, rework, result, blocked: blk }
  }

  // 同步桥维护的那部分标签；类型和你自己加的标签保留。
  function managedLabels(card, v, wait) {
    const kept = labelsOf(card).filter(n => !MANAGED.has(n))
    const type = TYPE_LABEL[idOf(card)?.split('-')[0]]
    if (type && !kept.includes(type)) kept.unshift(type)
    return [...kept, ...(v.ai ? [LBL.ai] : []), ...(wait ? [WAIT] : []), ...v.reasons,
      ...(v.rework ? [LBL.rework] : []), ...v.result]
  }

  // ---- 建卡：Workflow 页面直接创建的任务 ----
  async function createCard(ws, board, task) {
    const lines = String(task.input?.text ?? '').split('\n')
    const m = ID_LINE.exec(lines[0]?.trim() ?? '')
    let id, title, body
    if (m) { id = m[1]; title = m[3]; body = lines.slice(1).join('\n').trim() } else {
      id = nextId(board, 'REQ', ws.path)
      title = task.title || firstLine(task.input?.text) || '未命名'
      body = String(task.input?.text ?? '').trim()
    }
    const v = await view(task)
    const note = [v.flowLine, body].filter(Boolean).join('\n')
    const r = await call(ws, 'addCard', { title: clip(`${id} ${title}`, 120), note: clip(note, 2000),
      labels: [TYPE_LABEL[id.split('-')[0]]], priority: 'medium', columnId: board.columns.find(c => c.title === v.lane)?.id })
    await comment(ws, r.cardId, `【看板同步｜建卡｜${fmt(Date.now())}】这个任务是在 Workflow 页面创建的，同步桥自动补建了卡片${m ? '' : `，看板编号 ${id}（任务输入首行没有编号）`}。\n之后任务的状态、阶段结果和待你处理的事项都会自动同步到这张卡。`)
    return r.cardId
  }

  // ---- 阶段结果评论 ----
  // 一个阶段只发一条评论：结论 + 本阶段产出文档的精简版（每篇带链接，点开在卡片里看全文）+ 阶段报告链接。
  // 不再把全文逐段贴成评论（太吵）。
  async function docsOf(ws, cardId, task, stage) {
    try {
      const card = (await refresh(ws)).cards.find(c => c.id === cardId)
      const id = card && idOf(card)
      if (!id || !ws.path) return []
      const dir = join(ws.path, '.dsh', 'workflow-artifacts', task.id, 'repo', 'docs', 'reqs', id)
      if (!existsSync(dir)) return []
      // 按目录里的真实文件名精确匹配（macOS 不分大小写，existsSync('plan.md') 对 PLAN.md 也返回 true）
      const names = new Set(readdirSync(dir))
      return (STAGE_DOCS[stage.id] ?? []).filter(name => names.has(name))
        .map(name => ({ name, path: join(dir, name), text: readFileSync(join(dir, name), 'utf8') }))
    } catch (error) { console.warn('kanban-bridge: docsOf', error?.message ?? error); return [] }
  }
  // 阶段报告全文：引擎在任务目录 .workflow-results/<attemptId>.md 存了一份
  function reportPath(ws, task, visit) {
    if (!ws.path) return ''
    const attempts = new Set(task.attempts.filter(a => a.visitId === visit.id).map(a => a.id))
    const art = task.artifacts.filter(a => attempts.has(a.attemptId)).at(-1)
    const path = art && join(ws.path, '.dsh', 'workflow-artifacts', task.id, '.workflow-results', `${art.attemptId}.md`)
    return path && existsSync(path) ? path : ''
  }

  async function postVisits(ws, cardId, task, st) {
    const posted = new Set(st.posted)
    const seq = {}
    for (const visit of task.visits) {
      seq[visit.stageId] = (seq[visit.stageId] ?? 0) + 1
      if (!visit.closedAt || posted.has(visit.id)) continue
      const stage = task.definition.stages.find(s => s.id === visit.stageId)
      if (!stage) { posted.add(visit.id); continue }
      const head = `【${stageLabel(stage)} #${seq[visit.stageId]}｜`
      let content
      if (stage.kind === 'review' && task.reviews.find(r => r.visitId === visit.id)?.decidedBy?.source === AUTO.source) {
        posted.add(visit.id); continue // 同步桥自动决定的关卡不单独发评论：结论已在测试评论里，打回原因在下一轮编码评论里
      }
      if (stage.kind === 'review') {
        const review = task.reviews.find(r => r.visitId === visit.id)
        const result = OUTCOME_TEXT[review?.state] ?? OUTCOME_TEXT[visit.outcome] ?? visit.outcome
        const src = review?.decidedBy?.source
        const who = src === 'kanban-label' ? '（看板回复）' : src === AUTO.source ? '（自动）' : ''
        // 自动决定的反馈是测试回复的转述，缺陷全文已随测试报告和 defects.md 贴过，这里只留首行。
        const fb = src === AUTO.source ? firstLine(review?.feedback) : review?.feedback
        content = `${head}${result}${who}｜${fmt(visit.closedAt)}】${stage.title}：${result}。`
          + (src === AUTO.source ? '由同步桥按测试结论自动决定。' : '')
          + (fb ? `\n反馈：\n${fb}` : '')
      } else {
        const text = await visitText(task, visit)
        const d = digest(text, stage.id === 'plan' ? 10 : 5)
        const result = visit.outcome === 'succeeded' ? (/^测试未通过/.test(d.head) ? '未通过' : '成功') : (OUTCOME_TEXT[visit.outcome] ?? visit.outcome)
        const docs = await docsOf(ws, cardId, task, stage), report = reportPath(ws, task, visit)
        const top = `${head}${result}｜${fmt(visit.closedAt)}】` + (d.draft
          ? `${stage.title}草稿已完成，待你拍板 ${d.count} 项（见审核提醒）。` + (d.changes.length ? `\n\n**本轮修改**\n${d.changes.map(x => `- ${mdClip(x.replace(/^([-*+]|\d+[.、)])\s+/, ''), 90)}`).join('\n')}` : '')
          // 有文档时要点从文档里摘；没有文档（编码阶段）才摘回复里的要点。验收准备回复的要点就是验收提醒的内容，不重复。
          : (d.head || stage.title) + (!docs.length && d.points.length && stage.id !== 'prep' ? '\n' + d.points.join('\n') : ''))
        const tail = '\n\n' + (report ? `完整报告：[${stage.title} #${seq[visit.stageId]} 阶段报告](${fileHref(report)})` : `完整报告：Workflow 任务详情 →「${stage.title}」节点`)
          + (docs.length ? '　点文档名看全文' : '')
        content = top + (docs.length ? '\n\n' + condenseDocs(docs, 2000 - top.length - tail.length - 4) : '') + tail
      }
      await comment(ws, cardId, content)
      posted.add(visit.id)
    }
    st.posted = [...posted]
  }

  // ---- 描述里的「阶段成果」：每个阶段一行（最近一轮），进行中的阶段也列出来 ----
  const rowCache = new Map() // visitId → 非审核阶段的结果和要点（报告全文只读一次）
  async function resultRows(task) {
    const rows = []
    for (const stage of task.definition.stages) {
      const visits = task.visits.filter(x => x.stageId === stage.id)
      if (!visits.length) continue
      const done = visits.filter(x => x.closedAt), last = done.at(-1), open = visits.find(x => !x.closedAt)
      let row = null
      if (last && stage.kind === 'review') {
        const review = task.reviews.find(r => r.visitId === last.id)
        const result = OUTCOME_TEXT[review?.state] ?? OUTCOME_TEXT[last.outcome] ?? last.outcome
        // 反馈开头的「通过」「终止」等关键词和结果重复，去掉
        const fb = firstLine(review?.feedback).replace(/^(通过|终止|打回|开始)[。.，,！!：:\s]*/, '')
        const src = review?.decidedBy?.source
        row = src === AUTO.source ? { result, point: `自动：${fb.replace(/^【[^】]*】/, '')}` }
          : { result, point: fb ? `反馈：${fb}` : src === 'kanban-label' ? '看板回复' : '' }
      } else if (last) {
        if (!rowCache.has(last.id)) {
          const d = digest(await visitText(task, last))
          const result = /^阻塞[:：]/.test(d.head) ? '阻塞' : /^测试未通过/.test(d.head) ? '未通过'
            : last.outcome === 'succeeded' ? '成功' : (OUTCOME_TEXT[last.outcome] ?? last.outcome)
          rowCache.set(last.id, { result, point: d.draft ? `草稿已出，待你拍板 ${d.count} 项` : d.head.replace(/^阻塞[:：]\s*/, '') })
          if (rowCache.size > 500) rowCache.delete(rowCache.keys().next().value)
        }
        row = { ...rowCache.get(last.id) }
      }
      if (open && !['completed', 'terminated'].includes(task.state)) {
        row = { result: STATE_TEXT[task.state] ?? '进行中', point: row ? `上一轮：${row.result}` : '' }
      }
      if (!row) continue
      rows.push({ ...row, stage: stage.title, round: visits.length, time: fmt(open?.startedAt ?? last?.closedAt ?? task.updatedAt).slice(5) })
    }
    return rows
  }
  // 工作副本里本卡已有的文档清单（在 dev/<ID> 分支的 docs/reqs/<ID>/）
  function docsLine(ws, task, card) {
    const id = idOf(card)
    if (!id || !ws.path) return ''
    try {
      const names = readdirSync(join(ws.path, '.dsh', 'workflow-artifacts', task.id, 'repo', 'docs', 'reqs', id)).filter(n => n.endsWith('.md')).sort()
      return names.length ? `📄 文档（分支 \`dev/${id}\` 的 \`docs/reqs/${id}/\`）：${names.map(n => `\`${n}\``).join(' · ')}` : ''
    } catch { return '' }
  }

  async function askHuman(ws, cardId, task, need, v) {
    const stage = task.currentStage
    let body, more = []
    if (need.kind === 'review') {
      const art = task.effectiveArtifacts.at(-1)
      const d = digest(art ? await artifactText(art) : '', 8)
      const accept = stage.id === 'g_accept'
      const back = { g_discuss: '「讨论」', g_test: '「编码」', g_accept: '「实施计划」' }[stage.id] ?? '上一个 AI 阶段'
      if (v.blocked) {
        body = `「${v.blocked.stageId}」阶段阻塞：${v.blocked.reason}`
          + '\n\n怎么处理：在本卡评论里写处理意见（比如补充信息、换个做法）；同步桥看到回复会自动去掉「待人工确认」标签并执行。'
          + `\n- 任何不以「终止」开头的内容：作为反馈打回到${back}重做，卡片会打「返工」`
          + '\n- 回复以「终止」开头：终止任务'
          + '\n- 阻塞时不接受「通过」'
      } else if (stage.id === 'g_test') {
        // 测试关卡平时由同步桥自动决定，走到这里说明需要人：到了轮数上限、首行认不出来，或自动提交失败。
        const info = await testGateInfo(task)
        const why = info?.kind === 'capped' ? `测试已连续 ${info.round} 轮未通过，同步桥不再自动打回。`
          : info?.kind === 'unknown' ? '测试阶段回复的首行认不出来（应该是「测试通过」或「测试未通过 N 项」），同步桥没有自动决定。'
          : '同步桥自动决定这个关卡时提交失败（详见 DSH 日志），需要你来决定。'
        body = `${why}\n结论：${info?.head || '（空）'}` + (d.points.length ? `\n${d.points.join('\n')}` : '')
          + '\n缺陷清单见上方测试报告和 defects.md 的评论。'
          + '\n\n怎么处理：在本卡评论里回复；同步桥看到回复会自动去掉「待人工确认」标签并执行。'
          + '\n- 回复以「通过」开头：放行，剩下的缺陷不修，进入验收准备（release.md 会如实列出未修的缺陷）'
          + '\n- 回复以「终止」开头：终止任务，卡片进「关闭」并打「已取消」'
          + `\n- 其他任何内容：作为反馈打回到「编码」继续修，自动打回重新从第 1 轮计（最多 ${TEST_ROUNDS} 轮）`
      } else {
        // 验收：原样贴出「测试环境」和「验收清单」两节（保留缩进和代码块），照着就能验。
        const lines = String(art ? await artifactText(art) : '').split('\n')
        const env = accept ? section(lines, '测试环境', 40, true) : null
        const list = accept ? section(lines, '验收清单', 120, true) : null
        const make = inline => (accept ? '测试已通过，等你验收。' : `${stage.title}：讨论稿已出，等你确认。`)
          + (d.asks.length ? `\n待你拍板：\n${d.asks.join('\n')}` : (d.head ? `\n结论：${d.head}` : ''))
          + (env || list
            ? (env ? `\n\n**测试环境**\n${env.join('\n')}` : '') + (list ? (inline ? `\n\n**验收清单**\n${list.join('\n')}` : '\n\n验收清单见下一条评论。') : '')
            : (d.points.length ? `\n${d.points.join('\n')}` : ''))
          + '\n\n怎么处理：在本卡评论里回复；同步桥看到回复会自动去掉「待人工确认」标签并执行。'
          + `\n- 回复以「通过」开头：${accept ? '验收通过，开始发布（后面的文字一并作为说明）' : '确认方案，进入实施（后面的文字一并作为说明）'}`
          + '\n- 回复以「终止」开头：终止任务，卡片进「关闭」并打「已取消」'
          + `\n- 其他任何内容：作为反馈打回到${accept ? '「实施计划」，先把反馈写进计划，再改代码、重新测试和验收' : '「讨论」重做'}，卡片会打「返工」`
          + (accept ? '\n注意：通过后发布阶段会申请一次提权，需要到 Workflow 任务详情点开「发布」节点 →「等待审批」→「允许一次」。' : '')
        // 清单并进提醒，合并后放得下（评论上限 2000，留 60 给开头的标签）就合并，放不下才另发
        body = list && make(true).length <= 2000 - 60 ? make(true) : make(false)
        if (list && body.includes('验收清单见下一条评论。')) more = chunks(list, 1800).map((c, i, all) => `**验收清单${all.length > 1 ? `（${i + 1}/${all.length}）` : ''}**\n${c}`)
      }
    } else if (need.kind === 'attention') {
      body = `${stage.title}阶段未能完成：${task.attention?.message ?? task.attention?.reason ?? '见 Workflow 任务详情'}`
        + '\n\n怎么处理：回复「重试」或「终止」；同步桥看到回复会自动去掉「待人工确认」标签并执行。也可以直接在 Workflow 页面操作。'
    } else if (need.kind === 'escalate') {
      body = `${stage.title}阶段正在运行，可能在等你批准提权。`
        + '\n这一步只能在 Workflow 任务详情点开「' + stage.title + '」节点 →「等待审批」→ 核对 `bash <ART>/release.sh` 后点「允许一次」。'
        + '\n处理完后回复一句「知悉」即可（同步桥会自动去掉标签；去标签或回复都不会批准提权）。'
    } else {
      body = `发布没有完成：${clip(await lastOutput(task), 80)}`
        + '\n\n怎么处理：先排除原因（例如主工作区有未提交改动、合并冲突），然后在评论里回复；同步桥看到回复会自动去掉「待人工确认」标签。'
        + '\n- 回复以「重试」开头：新建一个只重新发布的任务，沿用已验收的分支；两个审核关卡要你再回复一次「通过」'
        + '\n- 回复以「终止」开头：放弃发布，卡片进「关闭」并打「已取消」'
        + '\n- 回复以「知悉」开头：只去掉提醒，卡片留在原处'
    }
    await comment(ws, cardId, `【${stageLabel(stage)}｜${WAIT_TEXT}｜${fmt(Date.now())}】${body}`)
    for (const m of more) await comment(ws, cardId, m)
  }

  // ---- 启动任务：「开始」甬道的新卡，或发布失败后的重新发布 ----
  async function startTask(wsId, ws, board, card, { continueFrom, extra } = {}) {
    let flow = core.listWorkflows(wsId).find(w => w.name === FLOW)
    if (!flow) { await ensureWorkflows(core, wsId, {}); flow = core.listWorkflows(wsId).find(w => w.name === FLOW) }
    if (!flow) throw new Error(`工作区里没有「${FLOW}」流程，自动创建也没成功`)
    let id = idOf(card), title = id ? card.title.slice(id.length).trim() : card.title.trim()
    if (!id) id = nextId(board, TYPE_PREFIX[typeOf(card)], ws.path)
    const lines = [`${id} ${title}`]
    if (continueFrom) lines.push(`接续 ${continueFrom}`, '仅重新发布')
    if (extra) lines.push(`补充说明：${extra}`)
    const body = bodyOf(card.note)
    if (body) lines.push(body)
    const task = await core.createTask({ requestId: `kanban-${randomUUID()}`, workspaceId: wsId, workflowId: flow.id,
      title: clip(title, 120), text: clip(lines.join('\n'), 8000) }, ACTOR)
    const full = store.getTask(task.id)
    flowOf.set(task.id, true)
    const v = await view(full)
    await call(ws, 'updateCard', { id: card.id, title: clip(`${id} ${title}`, 120), note: clip(setFlowLine(card.note, v.flowLine), 2000) })
    state.tasks[task.id] = { cardId: card.id, posted: [], lastColumn: null, lastUpdated: full.updatedAt }
    dirty = true
    return task.id
  }

  const cancelCard = async (ws, board, card) => {
    const col = board.columns.find(c => c.title === LANE.closed)
    const kept = labelsOf(card).filter(n => !MANAGED.has(n))
    await call(ws, 'updateCard', { id: card.id, labels: [...kept, LBL.cancelled] })
    if (col && card.columnId !== col.id) await call(ws, 'moveCard', { id: card.id, columnId: col.id })
  }

  // ---- 人在看板上回复（或手动去掉「待人工确认」）：按回复执行 ----
  async function onLabelRemoved(wsId, ws, board, card, taskId) {
    const st = state.tasks[taskId]
    if (!st?.askedKey) return
    const task = store.getTask(taskId)
    const v = await view(task, st)
    if (!v.need || v.need.key !== st.askedKey) return // 早已不需要处理
    const handledKey = st.askedKey
    if (v.need.kind === 'escalate') {
      await comment(ws, card.id, `【看板同步｜已知悉｜${fmt(Date.now())}】已去掉「${WAIT_TEXT}」，同步桥不再提醒这一项。`)
      st.ackedKey = st.askedKey
      return
    }
    const reply = [...card.comments].reverse().find(c => c.source === 'human' && (!st.askedAt || c.createdAt >= st.askedAt))
    const restore = async msg => {
      await comment(ws, card.id, `【看板同步｜未执行｜${fmt(Date.now())}】${msg}已恢复「${WAIT_TEXT}」标签。`)
      await call(ws, 'updateCard', { id: card.id, labels: [...labelsOf(card).filter(n => n !== WAIT), WAIT] })
    }
    if (!reply) return restore('没有找到你在提醒之后的回复。请在卡片里回复（回复本身就会触发执行）。')
    const text = reply.content.trim()
    const requestId = `kanban-${randomUUID()}`
    let done, saved = false
    try {
      if (v.need.kind === 'review') {
        const r = task.review
        const decision = /^终止/.test(text) ? 'terminated'
          : /^(通过|同意|批准|ok\b|lgtm|approve)/i.test(text) ? 'approved' : 'returned'
        if (decision === 'approved' && v.blocked) return restore(`这个关卡处于阻塞（${clip(v.blocked.reason, 60)}），不能通过。请回复处理意见（打回重做）或「终止」。`)
        // 测试关卡人工打回也带上前缀，实施角色据此按「缺陷修复」处理，并把你的意见一并考虑。
        let feedback = decision === 'returned' && task.currentStage?.id === 'g_test' ? `【测试关卡打回｜人工】${text}` : text
        if (decision === 'returned') feedback = withHistory(task, feedback)
        // 先写 decisions.md 再提交：提交后下一阶段马上开跑，晚写可能读不到。提交失败就在文件里注明作废。
        if (decision !== 'terminated' && saveDecision(ws, task, card, text, decision)) saved = true
        try {
          await core.decideReview({ taskId, reviewId: r.id, subjectHash: r.subjectHash, expectedRevision: task.revision,
            requestId, decision, feedback }, ACTOR)
        } catch (error) {
          if (saved) saveDecision(ws, task, card, '（上一条没有提交成功，作废。）', 'void')
          throw error
        }
        const n = task.visits.filter(x => x.outcome === 'returned').length + 1
        done = { approved: '通过并继续', returned: `打回重做（返工 #${n}）`, terminated: '终止任务' }[decision]
      } else if (v.need.kind === 'completed') {
        if (/^终止/.test(text)) { await cancelCard(ws, board, card); st.cancelled = true; done = '取消发布' }
        else if (/^(知悉|已知悉)/.test(text)) { st.ackedKey = st.askedKey; done = '已知悉' }
        else if (/^(重试|重新发布|retry)/i.test(text)) {
          const nid = await startTask(wsId, ws, board, card, { continueFrom: taskId, extra: text.replace(/^(重试|重新发布|retry)[:：，,\s]*/i, '') })
          done = `新建只重新发布的任务 ${nid}`
        } else return restore('回复要以「重试」「终止」或「知悉」开头。')
      } else if (/^终止/.test(text)) {
        await core.terminateTask({ taskId, expectedRevision: task.revision, requestId }, ACTOR)
        done = '终止任务'
      } else if (/^(重试|继续|通过|retry)/i.test(text)) {
        if (!task.canRetry) return restore('这个任务现在不能直接重试（上次执行还没确认停止），请到 Workflow 页面核对。')
        await core.retryTask({ taskId, expectedRevision: task.revision, requestId }, ACTOR)
        done = '重试当前阶段'
      } else return restore('回复要以「重试」或「终止」开头。')
    } catch (error) {
      return restore(`提交失败：${error?.message ?? error}。`)
    }
    st.askedKey = null
    st.ackedKey = handledKey // 这个需求已经处理过：任务往下走之前不再提醒，也不自动把标签加回来
    await comment(ws, card.id, `【看板同步｜已提交：${done}｜${fmt(Date.now())}】依据你的回复：\n${clip(text, 600)}`
      + (saved ? '\n你的回复已存入工作副本的 `decisions.md`，后面的阶段（包括返工）都会读到。' : ''))
  }

  // ---- 人回复或去掉了「开始」甬道里新卡的「待人工确认」：启动或取消 ----
  async function onStartLabelRemoved(wsId, ws, board, card) {
    const cst = state.workspaces[wsId]?.cards?.[card.id]
    if (!cst?.prompted || cst.started) return
    const reply = [...card.comments].reverse().find(c => c.source === 'human' && (!cst.askedAt || c.createdAt >= cst.askedAt))
    const restore = async msg => {
      await comment(ws, card.id, `【看板同步｜未执行｜${fmt(Date.now())}】${msg}已恢复「${WAIT_TEXT}」标签。`)
      await call(ws, 'updateCard', { id: card.id, labels: [...labelsOf(card).filter(n => n !== WAIT), WAIT] })
    }
    if (!reply) return restore('没有找到你在提醒之后的回复。请回复「开始」（回复本身就会触发执行）。')
    const text = reply.content.trim()
    if (/^终止/.test(text)) {
      await cancelCard(ws, board, card)
      cst.started = true
      await comment(ws, card.id, `【看板同步｜已取消｜${fmt(Date.now())}】这张卡没有启动流程，已移到「${LANE.closed}」。`)
    } else if (/^(开始|启动|start)/i.test(text)) {
      if (!typeOf(card) && !idOf(card)) return restore('卡片还没有类型标签：请先选「需求」「改进」「缺陷」或「技术债」。')
      let nid
      try {
        nid = await startTask(wsId, ws, board, card, { extra: text.replace(/^(开始|启动|start)[:：，,\s]*/i, '') })
      } catch (error) { return restore(`启动失败：${error?.message ?? error}。`) }
      cst.started = true
      await comment(ws, card.id, `【看板同步｜已启动｜${fmt(Date.now())}】已创建 Workflow 任务 ${nid}，进入「${LANE.discuss}」。之后的状态、阶段结果和待你处理的事项都会自动同步到这张卡。`)
    } else return restore('回复要以「开始」或「终止」开头。')
  }

  // 接入失败不阻塞其他工作区；同一个错误只记一次，下一轮自动重试
  const kitFailed = (wsId, wst, what, error) => {
    const msg = `${what}失败：${error?.message ?? error}`
    if (wst.kitError !== msg) { wst.kitError = msg; dirty = true; log(wsId, msg) }
  }

  // ---- 单个工作区一轮同步 ----
  async function syncWorkspace(wsId, tasks) {
    const ws = workspaceRegistry.get(wsId)
    if (!ws?.path || existsSync(join(ws.path, '.dsh-devflow-off'))) return
    const onboarded = existsSync(join(ws.path, 'docs', 'process', 'WORKFLOW.md'))
    // 还没接入的项目：只有 git 项目、目录可用、没关自动接入才接入
    if (!onboarded && !(autoOnboard && KIT_HASH && existsSync(join(ws.path, '.git')) && await ws.status?.() === 'ok')) return
    const wst = state.workspaces[wsId] ??= {}
    wst.cards ??= {}
    const needKit = KIT_HASH && wst.kitHash !== KIT_HASH
    if (needKit) {
      try {
        const f = provisionFiles(ws.path)
        if (f.overwritten.length || f.created.length || f.gitignore.length) log('接入', ws.path, JSON.stringify(f))
      } catch (error) { return kitFailed(wsId, wst, '写入流程文件', error) }
    }
    let board = (await call(ws, 'get', {})).board
    board = await ensureBoard(ws, board)
    if (needKit) {
      try {
        // 套件之外的甬道：空的删掉（新项目的默认甬道），有卡片的保留在最后，绝不连卡片一起动
        for (const c of board.columns) {
          if (!COLUMNS.includes(c.title) && !board.cards.some(k => k.columnId === c.id)) await call(ws, 'deleteColumn', { id: c.id })
        }
        board = await refresh(ws)
        for (const m of laneMoves(board.columns, COLUMNS)) await call(ws, 'moveColumn', m)
        const w = await ensureWorkflows(core, wsId, { force: true })
        if (w.created.length || w.updated.length) log('流程', ws.path, JSON.stringify(w))
        wst.kitHash = KIT_HASH; wst.kitError = null; dirty = true
        board = await refresh(ws)
      } catch (error) { return kitFailed(wsId, wst, '创建流程或重排甬道', error) }
    }
    const taskFor = card => tasks.find(t => card.note.includes(t.id))
    const linked = id => board.cards.find(c => c.note.includes(id))

    // 1) 先处理人的操作：人回一条评论就自动去掉「待人工确认」再按回复执行；手动去标签仍然可用
    const lastAct = Math.max(0, ...board.activities.map(a => actNum(a.id)))
    if (wst.lastActivity === undefined) wst.lastActivity = lastAct
    for (const a of board.activities) {
      if (actNum(a.id) <= wst.lastActivity) continue
      const card = a.cardId ? board.cards.find(c => c.id === a.cardId) : null
      const act = humanAction(a, card)
      if (!act) continue
      // 回复触发时先确认这张卡确实在等人（有未处理的提醒），否则只是闲聊，不动标签
      const task0 = taskFor(card)
      const asked = task0
        ? isFlow(task0.id) && !!state.tasks[task0.id]?.askedKey
        : !!(wst.cards?.[card.id]?.prompted && !wst.cards?.[card.id]?.started)
      if (act === 'reply' && !asked) continue
      let target = card
      if (act === 'reply') {
        // 回复即处理：先去掉标签，卡片上立刻看不到「待人工确认」；回复不合规则时下面的 restore 会加回来
        await call(ws, 'updateCard', { id: card.id, labels: labelsOf(card).filter(n => n !== WAIT) })
        board = await refresh(ws)
        target = board.cards.find(c => c.id === card.id) ?? card
      }
      const task = taskFor(target)
      if (task) { if (isFlow(task.id)) await onLabelRemoved(wsId, ws, board, target, task.id) } else await onStartLabelRemoved(wsId, ws, board, target)
      board = await refresh(ws) // 处理过程中卡片可能已变
    }
    wst.lastActivity = lastAct
    dirty = true
    board = await refresh(ws)

    // 2)「开始」甬道里还没启动的卡：提醒怎么启动
    const startCol = board.columns.find(c => c.title === LANE.start)
    for (const card of board.cards) {
      if (card.columnId !== startCol?.id || taskFor(card)) continue
      const cst = wst.cards[card.id] ??= {}
      if (cst.prompted) continue
      await call(ws, 'updateCard', { id: card.id, labels: [...labelsOf(card).filter(n => n !== WAIT), WAIT] })
      await comment(ws, card.id, `【看板同步｜待启动｜${fmt(Date.now())}】这张卡还在「${LANE.start}」，没有启动流程。`
        + '\n启动：在评论里回复「开始」（后面可以接补充说明）即可，标签会自动去掉。'
        + '\n取消：回复「终止」即可。'
        + '\n启动前请确认：卡片有类型标签（需求、改进、缺陷、技术债），描述里写清楚要做什么。')
      cst.prompted = true
      cst.askedAt = new Date().toISOString()
      dirty = true
    }
    board = await refresh(ws)

    // 3) Workflow → 看板
    for (const summary of tasks) {
      if (flowOf.get(summary.id) === false) continue
      let st = state.tasks[summary.id]
      let card = linked(summary.id)
      if (st && card && st.lastSeen === summary.updatedAt) continue // 任务没变化
      if (!isFlow(summary.id)) continue
      let task = store.getTask(summary.id)
      if (!card) {
        if (st?.cardId) continue // 卡被人删了，或已改挂到新任务上：不再重建
        // 在 Workflow 页面创建的任务，首行编号已有卡片时认领它，不重复建卡；卡片仍挂着另一个在途任务时不抢。
        const m = ID_LINE.exec(String(task.input?.text ?? '').split('\n')[0]?.trim() ?? '')
        const same = m && board.cards.find(c => c.title.startsWith(`${m[1]} `)
          && !tasks.some(t => t.id !== task.id && c.note.includes(t.id) && !['completed', 'terminated'].includes(t.state)))
        if (same) {
          const v = await view(task)
          await call(ws, 'updateCard', { id: same.id, note: clip(setFlowLine(same.note, v.flowLine), 2000) })
          await comment(ws, same.id, `【看板同步｜关联｜${fmt(Date.now())}】已关联 Workflow 任务 ${task.id}。之后的状态、阶段结果和待你处理的事项都会自动同步到这张卡。`)
          board = await refresh(ws)
          card = board.cards.find(c => c.id === same.id)
          st = state.tasks[task.id] = { cardId: card.id, posted: [], lastColumn: null, lastUpdated: task.updatedAt }
        } else {
          const cardId = await createCard(ws, board, task)
          board = await refresh(ws)
          card = board.cards.find(c => c.id === cardId)
          st = state.tasks[task.id] = { cardId, posted: [], lastColumn: null, lastUpdated: null }
        }
      } else if (!st) {
        // 已有卡（同步桥状态文件被清过）：以当前为基线，不补发历史评论
        const v = await view(task)
        st = state.tasks[task.id] = { cardId: card.id, posted: task.visits.filter(x => x.closedAt).map(x => x.id),
          lastColumn: v.lane, lastUpdated: task.updatedAt, askedKey: labelsOf(card).includes(WAIT) ? v.need?.key ?? null : null, askedAt: null }
        dirty = true
        continue
      }
      st.cardId = card.id
      await postVisits(ws, card.id, task, st)
      // 测试关卡自动决定后，任务已往下走（通过或打回编码）：重新取任务，把关卡结果评论补上，再按新状态同步。
      if (await autoGate(task, st)) {
        task = store.getTask(summary.id)
        await postVisits(ws, card.id, task, st)
      }
      const v = await view(task, st)
      {
        // 描述：第 1 行流程状态 + 末尾「阶段成果」区块（只在内容变了时写，忽略更新时间）
        let note = st.lastUpdated !== task.updatedAt ? setFlowLine(card.note, v.flowLine) : padFlow(card.note)
        const rows = await resultRows(task)
        if (rows.length) {
          const next = withResults(note, rows, docsLine(ws, task, card))
          if (next && !sameResults(splitResults(next).block, splitResults(note).block)) note = next
        }
        if (note !== card.note) await call(ws, 'updateCard', { id: card.id, note: clip(note, 2000) })
        st.lastUpdated = task.updatedAt
      }
      if (st.lastColumn !== v.lane) {
        const col = board.columns.find(c => c.title === v.lane)
        if (col && card.columnId !== col.id) await call(ws, 'moveCard', { id: card.id, columnId: col.id })
        st.lastColumn = v.lane
      }
      // 标签：新出现的需求加「待人工确认」并提醒一次；已经提醒过的保持你当前的样子（去标签由上面的流程处理）
      const key = v.need?.key
      const fresh = Boolean(key) && st.askedKey !== key && st.ackedKey !== key
      const wait = Boolean(key) && st.ackedKey !== key && (fresh || labelsOf(card).includes(WAIT))
      const next = managedLabels(card, v, wait)
      if (!sameSet(next, labelsOf(card))) await call(ws, 'updateCard', { id: card.id, labels: next })
      if (fresh) {
        await askHuman(ws, card.id, task, v.need, v)
        st.askedKey = key
        st.askedAt = new Date().toISOString()
      } else if (!key && (st.askedKey || st.ackedKey)) {
        st.askedKey = null
        st.ackedKey = null
      }
      st.lastSeen = task.updatedAt
      dirty = true
    }
  }

  async function tick() {
    if (disposed) return
    if (running) { again = true; return }
    running = true
    try {
      if (!kanban()) return
      const byWs = new Map()
      for (const t of store.listTaskSummaries()) {
        if (!byWs.has(t.workspaceId)) byWs.set(t.workspaceId, [])
        byWs.get(t.workspaceId).push(t)
      }
      // 没有任务的工作区也要同步：「开始」甬道的新卡不需要任务就能被提醒。
      for (const wsId of Object.keys(state.workspaces)) if (!byWs.has(wsId)) byWs.set(wsId, [])
      // 工作区要从 workspaceRegistry 里找：state.workspaces 只记同步桥见过的，第一次运行时是空的，
      // 只靠它会漏掉从看板建的第一张卡。自动接入也靠这里：所有打开的工作区都过一遍（syncWorkspace 会筛掉不是 git 项目的）
      try { for (const w of workspaceRegistry.list?.() ?? []) if (w?.id && !byWs.has(w.id)) byWs.set(w.id, []) } catch (error) { log('registry', error?.message ?? error) }
      for (const [wsId, tasks] of byWs) {
        try { await syncWorkspace(wsId, tasks) } catch (error) { log(wsId, error?.message ?? error) }
      }
      save()
    } catch (error) {
      log(error?.message ?? error)
    } finally {
      running = false
      if (again && !disposed) { again = false; queueMicrotask(tick) }
    }
  }

  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  setTimeout(tick, 1000)
  log('started')
  return {
    poke() { clearTimeout(debounce); debounce = setTimeout(tick, 300) },
    tick,
    dispose() { disposed = true; clearInterval(timer); clearTimeout(debounce); try { save() } catch {} },
  }
}
