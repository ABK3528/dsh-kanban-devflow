#!/usr/bin/env node
// 给本机 DSH 的 @alpacachen/dsh-kanban 打补丁，加载 kanban-bridge.mjs。可重复执行；插件升级后再跑一次。
//   node install.mjs            安装/更新补丁
//   node install.mjs --remove   还原（用安装时备份的原文件）
// 改完需重启 DSH 桌面版。
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const profile = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop')
const pkg = join(profile, 'node_modules', '@alpacachen', 'dsh-kanban')
const bridgeUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'kanban-bridge.mjs')).href
const MARK = '/* dsh-kanban-flow-kit bridge */'
const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version
const backupDir = join(profile, 'workflow-poc', `kanban-bridge-orig-${version}`)

const UI = join(dirname(fileURLToPath(import.meta.url)), 'ui')
const uiText = (name) => readFileSync(join(UI, name), 'utf8')
// 插在 lib/client.js 顶部的组件：标签多选（KLP）、GitLab 风格评论（KCM/KCC）
const TOP_SRC = `\n${uiText('label-picker.js')}\n${uiText('comments.js')}\n`
// 卡片弹窗内的 hooks：实时保存、实时卡片同步、评论图片（引用组件内的压缩变量，见文件头注释）
const HOOKS = `\n${MARK}\n${uiText('dialog-hooks.js')}\n`
// 评论样式会插进插件的 CSS 模板字符串，不能含反引号、反斜杠、美元符
const COMMENT_CSS = uiText('comments.css')
if (/[`\\$]/.test(COMMENT_CSS)) throw new Error('ui/comments.css 不能含反引号、反斜杠或 $')
const SEP = '"\\u0001"' // 源码里的 "\u0001"
const AUTOSAVE_STATUS = 's&&KST&&(0,le.jsx)("span",{className:"kanban-muted-small",role:"status",style:{marginRight:"auto",alignSelf:"center"},' +
  'children:{saving:KZ("保存中…","Saving…"),saved:KZ("已自动保存","Saved"),error:KZ("保存失败","Save failed"),notitle:KZ("标题为空，未保存","Title required, not saved")}[KST]})'
// 把 start 到 end（含两端）之间的一段换成 replacement；两端锚点都必须唯一
const spliceOnce = (start, end, replacement) => (text) => {
  const a = text.indexOf(start), b = text.indexOf(end, a)
  if (a < 0 || b < 0 || text.indexOf(start, a + 1) >= 0 || text.indexOf(end, b + 1) >= 0) throw new Error(`lib/client.js: 锚点不唯一或不存在：${start.slice(0, 60)}`)
  return text.slice(0, a) + replacement + text.slice(b + end.length)
}
const files = {
  'index.js': [
    ['  // ---- Tool registration ----',
      `  ${MARK} globalThis[Symbol.for('dsh-kanban-flow-kit.kanban')] = { dispatch, workspaceOfId }\n  // ---- Tool registration ----`],
    // ---- 卡片多标签：card.labels 数组；card.label 保留为第一个标签，旧版插件仍可读 ----
    ['export function validateBoard(data) {',
      `const cardLabels = (c) => (Array.isArray(c.labels) ? c.labels : c.label ? [c.label] : []) ${MARK}\nexport function validateBoard(data) {`],
    ["      if (c.label != null && !labelNames.has(c.label)) errors.push('card references missing label: ' + c.id)",
      "      if (c.label != null && !labelNames.has(c.label)) errors.push('card references missing label: ' + c.id)\n      if (c.labels != null && (!Array.isArray(c.labels) || c.labels.some((n) => !labelNames.has(n)))) errors.push('card references missing label: ' + c.id)"],
    ['            board.cards = parsed.data.cards\n',
      '            board.cards = parsed.data.cards\n            for (const c of board.cards) { c.labels = cardLabels(c).slice(); c.label = c.labels[0] }\n'],
    ['  const findLabel = (b, name) => b.labels.find((l) => l.name === name)\n',
      `  const findLabel = (b, name) => b.labels.find((l) => l.name === name)
  const wantLabels = (b, a) => {
    let list
    if (Array.isArray(a.labels)) list = a.labels
    else if (typeof a.label === 'string') list = a.label ? [a.label] : []
    else return { labels: undefined }
    const out = []
    for (const raw of list) {
      const n = typeof raw === 'string' ? clampText(raw, LABEL_LIMIT, 'Label', b) : ''
      if (!n) continue
      if (!findLabel(b, n)) return { error: 'Label not found: ' + n }
      if (!out.includes(n)) out.push(n)
    }
    return { labels: out }
  }
`],
    ['      label: c.label ?? null,\n      priority: c.priority ?? null,\n      dueDate: c.dueDate,\n      completedAt: c.completedAt,\n      createdAt',
      '      label: c.label ?? null,\n      labels: cardLabels(c).slice(),\n      priority: c.priority ?? null,\n      dueDate: c.dueDate,\n      completedAt: c.completedAt,\n      createdAt'],
    ['      label: c.label ?? null,\n      priority: c.priority ?? null,\n      dueDate: c.dueDate,\n      completedAt: c.completedAt,\n      commentCount',
      '      label: c.label ?? null,\n      labels: cardLabels(c).slice(),\n      priority: c.priority ?? null,\n      dueDate: c.dueDate,\n      completedAt: c.completedAt,\n      commentCount'],
    ["        const label = typeof a.label === 'string' ? clampText(a.label, LABEL_LIMIT, 'Label', board) : undefined\n        if (label && !findLabel(board, label)) return result({ error: 'Label not found: ' + label })\n",
      "        const wl = wantLabels(board, a)\n        if (wl.error) return result({ error: wl.error })\n        const labels = wl.labels ?? []\n"],
    ["          note: clampText(a.note, NOTE_LIMIT, 'Note', board),\n          label,\n",
      "          note: clampText(a.note, NOTE_LIMIT, 'Note', board),\n          label: labels[0],\n          labels,\n"],
    ['            column: col.title,\n            label: card.label ?? null,\n',
      "            column: col.title,\n            label: labels.join(', ') || null,\n"],
    ["          const nextLabel = typeof a.label === 'string' ? clampText(a.label, LABEL_LIMIT, 'Label', board) : undefined\n          if (nextLabel && !findLabel(board, nextLabel)) return result({ error: 'Label not found: ' + nextLabel })\n          const before = {\n            title: card.title,\n            note: card.note,\n            label: card.label ?? null,",
      "          const wl = wantLabels(board, a)\n          if (wl.error) return result({ error: wl.error })\n          const before = {\n            title: card.title,\n            note: card.note,\n            labelList: cardLabels(card).slice(),\n            label: cardLabels(card).join(', ') || null,"],
    ["          if (typeof a.label === 'string') card.label = nextLabel || undefined\n",
      "          if (wl.labels) { card.labels = wl.labels; card.label = wl.labels[0] }\n"],
    ['          const after = {\n            title: card.title,\n            note: card.note,\n            label: card.label ?? null,',
      "          const after = {\n            title: card.title,\n            note: card.note,\n            labelList: cardLabels(card).slice(),\n            label: cardLabels(card).join(', ') || null,"],
    ["field: 'label', from: before.label, to: after.label })",
      "field: 'label', from: before.label, to: after.label, meta: { title: card.title, added: after.labelList.filter((n) => !before.labelList.includes(n)), removed: before.labelList.filter((n) => !after.labelList.includes(n)) } })"],
    ['            if (card.label === name) {\n              card.label = newName\n',
      '            if (cardLabels(card).includes(name)) {\n              card.labels = cardLabels(card).map((n) => (n === name ? newName : n))\n              card.label = card.labels[0]\n'],
    ['          if (card.label === name) {\n            card.label = undefined\n',
      '          if (cardLabels(card).includes(name)) {\n            card.labels = cardLabels(card).filter((n) => n !== name)\n            card.label = card.labels[0]\n'],
    ["(card.label ? '[' + card.label + '] ' : '') +",
      "(cardLabels(card).length ? '[' + cardLabels(card).join(', ') + '] ' : '') +"],
    ["if (c.label) lines.push('Label: ' + c.label)",
      "if (cardLabels(c).length) lines.push('Labels: ' + cardLabels(c).join(', '))"],
    ["          label: { type: 'string', description: `Label name (optional;",
      "          labels: { type: 'array', items: { type: 'string' }, description: 'Label names (optional, several allowed; takes precedence over label)' },\n          label: { type: 'string', description: `Label name (optional;"],
    ["          label: { type: 'string', description: `New label name (optional;",
      "          labels: { type: 'array', items: { type: 'string' }, description: 'Replace all labels with these names (optional, several allowed; [] clears; takes precedence over label)' },\n          label: { type: 'string', description: `New label name (optional;"],
  ],
  // 看板界面：标签改为可多选（chip 按钮）。表单里用 \u0001 拼接多个标签名，沿用原有的字符串比较逻辑。
  'lib/client.js': [
    (text) => text.replace('"use strict";', () => '"use strict";' + TOP_SRC), // 注入组件（函数替换，避免 $ 被当成替换模式）
    ['label:s?.label??""', `label:(s?.labels??(s?.label?[s.label]:[])).join(${SEP}) ${MARK}`],
    (text) => {
      const start = '(0,le.jsxs)(Ns,{disabled:re||!!I,value:C.label||"__none__"'
      const endMark = 'u.map(te=>(0,le.jsx)(qo,{value:te.name,children:te.name},te.name))]})]})'
      const a = text.indexOf(start), b = text.indexOf(endMark)
      if (a < 0 || b < a || text.indexOf(start, a + 1) >= 0) throw new Error('lib/client.js: 标签选择框锚点不唯一或不存在')
      const chips = `(0,le.jsx)(KLP,{disabled:re||!!I,labels:u,ariaLabel:v("fieldLabel"),value:C.label?C.label.split(${SEP}):[],onChange:l=>ce({label:l.join(${SEP})})})`
      return text.slice(0, a) + chips + text.slice(b + endMark.length)
    },
    ['label:N.label||void 0,priority:N.priority||void 0',
      `labels:N.label?N.label.split(${SEP}):void 0,priority:N.priority||void 0`],
    ['N.label!==(z.label??"")&&(Q.label=N.label)',
      `N.label!==(z.labels??(z.label?[z.label]:[])).join(${SEP})&&(Q.labels=N.label?N.label.split(${SEP}):[])`],
    // 卡片详情实时保存：字段改动后自动调用 onSave（文本 800ms 防抖，标签/优先级/截止日期立即）；
    // 关闭前先把未保存的改动存掉；已有卡片去掉「保存」按钮，新建卡片仍保留。
    // 同一处还挂了：看板实时卡片同步（同步桥回写描述后弹窗跟着更新，自动保存不覆盖）、评论图片上传和发送。
    [',[I]);let j=ae||!!R.trim()', () => `,[I]);${HOOKS}let j=ae||KPI.length>0||!!R.trim()`],
    ['onDelete:h,onChatWithAgent:x}){let v=Pe()', 'onDelete:h,onChatWithAgent:x,liveCard:KLC}){let v=Pe()'],
    ['comments:j?.comments??[],activities:', 'comments:j?.comments??[],liveCard:j,activities:'],
    // 上传图片后把服务端返回（含最新看板）交给调用方，评论据此拿到新图片的 attachmentId
    ['throw new Error(a("actionRetry"));H(ye,e,ce)}', 'throw new Error(a("actionRetry"));H(ye,e,ce);return ye}'],
    ['ye=async()=>{let te=R.trim();!s||!te||te.length>2e3||await z(()=>m(s.id,te))&&P("")}', 'ye=()=>KSD()'],
    ['if(!te&&j){A("discard");return}',
      'if(!te&&j){if(s){KAS.current.run().then(ok=>{ok&&!ae&&!KAS.current.KPI.length&&!R.trim()?p(te):A("discard")});return}A("discard");return}'],
    ['(0,le.jsx)(de,{disabled:re||!C.title.trim(),onClick:async()=>{b.current?.reportValidity()',
      '!s&&(0,le.jsx)(de,{disabled:re||!C.title.trim(),onClick:async()=>{b.current?.reportValidity()'],
    ['(0,le.jsxs)(le.Fragment,{children:[s&&h&&(0,le.jsxs)(de,{variant:"ghost",className:"kanban-dialog-delete"',
      `(0,le.jsxs)(le.Fragment,{children:[${AUTOSAVE_STATUS},s&&h&&(0,le.jsxs)(de,{variant:"ghost",className:"kanban-dialog-delete"`],
    ['r=(e.label??"").trim()',`r=(e.label??"").split(${SEP}).join(", ").trim()`],
    ['(e.label||u)&&', '(e.label||e.labels?.length||u)&&'],
    ['children:[e.label&&(0,mt.jsxs)(tf,{variant:"secondary",className:"kanban-card-badge",children:[(0,mt.jsx)("span",{className:"kanban-label-dot",style:{background:c},"aria-hidden":"true"}),e.label]}),',
      'children:[...(e.labels?.length?e.labels:e.label?[e.label]:[]).map(nm=>(0,mt.jsxs)(tf,{variant:"secondary",className:"kanban-card-badge",children:[(0,mt.jsx)("span",{className:"kanban-label-dot",style:{background:Eb(t,nm)},"aria-hidden":"true"}),nm]},nm)),'],
    ['(E===null||(N.label??"")===E)', '(E===null||(N.labels?.length?N.labels:[N.label??""]).includes(E))'],
    ['(E===null||(Q.label??"")===E)', '(E===null||(Q.labels?.length?Q.labels:[Q.label??""]).includes(E))'],
    // 评论改成 GitLab 风格：头像 + 时间线 + 气泡（KCM），正文按 Markdown 渲染，【阶段｜结果】拆成标签片，图片可放大
    spliceOnce('c.map(te=>{let pe=te.source==="agent";return(0,le.jsxs)("li",{className:"kanban-comment-item"', 'children:te.content})]},te.id)})',
      `c.map((te,ki)=>(0,le.jsx)(KCM,{c:te,list:c,i:ki,MD:zb.MarkdownText,full:ii(te.createdAt),mdLabels:{code:{copyLabel:v("copyCode"),copiedLabel:v("copiedCode")},footnotes:v("footnotes")}},te.id)) ${MARK}`),
    // 评论输入框（KCC）：插入/粘贴/拖入图片，缩略图可删除
    spliceOnce('(0,le.jsxs)("div",{className:"kanban-comment-composer",children:[', 'v("sendComment")]})]})',
      '(0,le.jsx)(KCC,{id:`${w}-comment`,value:R,onChange:P,placeholder:v("commentPlaceholder"),disabled:re||!!I,canUpload:!!o,pending:KPI,onFiles:KUP,onRemove:KRM,onSend:()=>{ye()},sendLabel:v("sendComment"),Textarea:uo,Button:de,SendIcon:Qi})'),
    ['  font: var(--dsw-font-xxs-12);\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n}\n',
      '  font: var(--dsw-font-xxs-12);\n  white-space: normal;\n  overflow-wrap: anywhere;\n}\n.kanban-comment-content p { margin: 0 0 6px; }\n.kanban-comment-content > :last-child { margin-bottom: 0; }\n.kanban-comment-content { font-size: 13px; line-height: 1.6; }\n.kanban-comment-content, .kanban-comment-content :where(p, li, td, th, h1, h2, h3, h4, strong, em, span, blockquote) { color: var(--dsw-alias-label-primary) !important; opacity: 1 !important; }\n.kanban-comment-meta { opacity: .9; }\n' + COMMENT_CSS],
  ],
  'workflow/index.js': [
    ['  let executor, runner, apiFiber, removeTools\n',
      `  let executor, runner, apiFiber, removeTools\n  let bridge ${MARK}\n`],
    ['    removeTools?.()\n',
      `    removeTools?.()\n    bridge?.dispose() ${MARK}\n`],
    ["      onError: error => console.warn('Workflow:', error?.code ?? 'WF_INTERNAL') })",
      `      onChange: () => bridge?.poke(), ${MARK}\n      onError: error => console.warn('Workflow:', error?.code ?? 'WF_INTERNAL') })`],
    ['    removeTools = mountWorkflowManagementTools(ctx, core)\n',
      `    removeTools = mountWorkflowManagementTools(ctx, core)\n    try { ${MARK}\n      const { startBridge } = await import(${JSON.stringify(bridgeUrl)} + '?t=' + Date.now())\n      bridge = startBridge({ core, store, attachments: ctx.attachments, workspaceRegistry: ctx.workspaceRegistry, readArtifactText, profileDir: ctx.profileContext.dir })\n    } catch (error) { console.warn('kanban-bridge: not started', error?.message ?? error) }\n`],
  ],
}

mkdirSync(backupDir, { recursive: true })
for (const [rel, edits] of Object.entries(files)) {
  const file = join(pkg, rel)
  const backup = join(backupDir, rel.replace('/', '__'))
  let text = readFileSync(file, 'utf8')
  if (!text.includes(MARK) && !existsSync(backup)) copyFileSync(file, backup)
  if (process.argv.includes('--remove')) {
    if (existsSync(backup)) { copyFileSync(backup, file); console.log('还原', rel) }
    continue
  }
  if (text.includes(MARK)) text = readFileSync(backup, 'utf8') // 从原文件重新打，保证幂等
  for (const edit of edits) {
    if (typeof edit === 'function') { text = edit(text); continue }
    const [anchor, replacement] = edit
    const n = text.split(anchor).length - 1
    if (n !== 1) throw new Error(`${rel}: 锚点出现 ${n} 次，插件版本 ${version} 可能已变化，未修改：\n${anchor}`)
    text = text.replace(anchor, typeof replacement === 'function' ? replacement : () => replacement)
  }
  writeFileSync(file, text)
  console.log('已打补丁', rel)
}
console.log(`dsh-kanban ${version}，原文件备份在 ${backupDir}。重启 DSH 桌面版后生效。`)
