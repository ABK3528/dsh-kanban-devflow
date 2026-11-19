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

const KLP_SRC = "var KLP=function(p){var R=require(\"react\"),h=R.createElement,st=R.useState(false),open=st[0],setOpen=st[1],qs=R.useState(\"\"),q=qs[0],setQ=qs[1],ref=R.useRef(null);R.useEffect(function(){if(!open)return;var f=function(e){if(ref.current&&!ref.current.contains(e.target))setOpen(false)},k=function(e){if(e.key===\"Escape\")setOpen(false)};document.addEventListener(\"mousedown\",f);document.addEventListener(\"keydown\",k);return function(){document.removeEventListener(\"mousedown\",f);document.removeEventListener(\"keydown\",k)}},[open]);var sel=p.value,sc=p.labels.filter(function(l){return sel.includes(l.name)}),dis=!!p.disabled;var chip=function(l){return h(\"span\",{key:l.name,style:{display:\"inline-flex\",alignItems:\"center\",gap:5,padding:\"1px 8px\",borderRadius:999,fontSize:12,border:\"1px solid \"+l.color,background:l.color+\"33\"}},h(\"span\",{style:{width:8,height:8,borderRadius:\"50%\",background:l.color}}),l.name,dis?null:h(\"span\",{role:\"button\",\"aria-label\":\"移除标签 \"+l.name,title:\"移除\",onMouseDown:function(e){e.preventDefault();e.stopPropagation()},onClick:function(e){e.preventDefault();e.stopPropagation();p.onChange(sel.filter(function(x){return x!==l.name}))},onMouseEnter:function(e){e.currentTarget.style.opacity=1;e.currentTarget.style.background=\"rgba(255,255,255,.18)\"},onMouseLeave:function(e){e.currentTarget.style.opacity=.65;e.currentTarget.style.background=\"transparent\"},style:{display:\"inline-flex\",alignItems:\"center\",justifyContent:\"center\",width:14,height:14,marginLeft:1,marginRight:-4,borderRadius:\"50%\",fontSize:10,lineHeight:1,cursor:\"pointer\",opacity:.65}},\"✕\"))};var shown=p.labels.filter(function(l){return !q||l.name.toLowerCase().includes(q.toLowerCase())});return h(\"div\",{ref:ref,style:{position:\"relative\"}},h(\"button\",{type:\"button\",\"aria-label\":p.ariaLabel,\"aria-haspopup\":\"listbox\",\"aria-expanded\":open,disabled:dis,onClick:function(){setOpen(!open);setQ(\"\")},style:{display:\"flex\",flexWrap:\"wrap\",alignItems:\"center\",gap:6,width:\"100%\",minHeight:34,padding:\"4px 28px 4px 8px\",textAlign:\"left\",borderRadius:6,border:\"1px solid var(--dsw-alias-border-l2)\",background:\"var(--dsw-alias-bg-layer-1)\",color:\"inherit\",cursor:dis?\"default\":\"pointer\",opacity:dis?.5:1,position:\"relative\"}},sc.length?sc.map(chip):h(\"span\",{style:{opacity:.6,fontSize:12}},\"选择标签\"),h(\"span\",{\"aria-hidden\":\"true\",style:{position:\"absolute\",right:10,top:\"50%\",transform:\"translateY(-50%)\",opacity:.6,fontSize:10}},\"▾\")),open&&h(\"div\",{role:\"listbox\",\"aria-multiselectable\":\"true\",style:{position:\"absolute\",zIndex:1000,left:0,right:0,top:\"calc(100% + 4px)\",maxHeight:260,overflow:\"auto\",padding:6,borderRadius:8,border:\"1px solid var(--dsw-alias-border-l2)\",background:\"var(--dsw-alias-bg-layer-2)\",boxShadow:\"0 8px 24px rgba(0,0,0,.35)\"}},h(\"input\",{autoFocus:true,placeholder:\"搜索标签\",value:q,onChange:function(e){setQ(e.target.value)},style:{width:\"100%\",boxSizing:\"border-box\",padding:\"4px 8px\",marginBottom:6,borderRadius:6,border:\"1px solid var(--dsw-alias-border-l2)\",background:\"transparent\",color:\"inherit\",fontSize:12,outline:\"none\"}}),shown.length?shown.map(function(l){var on=sel.includes(l.name);return h(\"div\",{key:l.name,role:\"option\",\"aria-selected\":on,onClick:function(){p.onChange(on?sel.filter(function(x){return x!==l.name}):sel.concat([l.name]))},onMouseEnter:function(e){e.currentTarget.style.background=\"var(--dsw-alias-interactive-bg-hover)\"},onMouseLeave:function(e){e.currentTarget.style.background=\"transparent\"},style:{display:\"flex\",alignItems:\"center\",gap:8,padding:\"5px 8px\",borderRadius:6,cursor:\"pointer\",fontSize:13}},h(\"span\",{style:{width:14,textAlign:\"center\",opacity:on?1:0}},\"✓\"),h(\"span\",{style:{width:10,height:10,borderRadius:\"50%\",background:l.color,flex:\"none\"}}),h(\"span\",null,l.name))}):h(\"div\",{style:{padding:\"6px 8px\",opacity:.6,fontSize:12}},\"没有匹配的标签\")))};"
const SEP = '"\\u0001"' // 源码里的 "\u0001"
// 卡片详情实时保存（插在卡片弹窗组件的 hooks 区，引用组件内的 C/F/s/n/I/g/T/ee）
const AUTOSAVE = `${MARK} let KAS=(0,ot.useRef)({}),[KST,KSS]=(0,ot.useState)(""),KZ=(a,b)=>/^zh/i.test(document.documentElement.lang||navigator.language||"")?a:b;` +
  'KAS.current.C=C;KAS.current.s=s;KAS.current.dirty=c=>Object.keys(c).some(k=>c[k]!==F.current[k]);' +
  'KAS.current.run=()=>{let r=KAS.current;return r.p=(r.p||Promise.resolve(!0)).then(async()=>{let cur=r.C;if(!r.s||!r.dirty(cur))return!0;' +
  'if(!cur.title.trim()){ee.current&&KSS("notitle");return!1}ee.current&&KSS("saving");' +
  'try{let res=await g(cur);if(res===!1){ee.current&&KSS("error");return!1}F.current=cur;ee.current&&KSS(r.dirty(r.C)?"saving":"saved");return!0}' +
  'catch(e2){ee.current&&(KSS("error"),T(v("actionFailed")+String(e2 instanceof Error?e2.message:e2)));return!1}})};' +
  '(0,ot.useEffect)(()=>{let r=KAS.current,pv=r.prev;r.prev=C;if(!n||!s||I||!r.dirty(C))return;' +
  'let quick=pv&&["label","priority","dueDate"].some(k=>pv[k]!==C[k]),t=setTimeout(()=>{r.run()},quick?0:800);return()=>clearTimeout(t)},[C,n,s?.id,I]);' +
  '(0,ot.useEffect)(()=>{KSS("")},[n,s?.id]);'
const AUTOSAVE_STATUS = 's&&KST&&(0,le.jsx)("span",{className:"kanban-muted-small",role:"status",style:{marginRight:"auto",alignSelf:"center"},' +
  'children:{saving:KZ("保存中…","Saving…"),saved:KZ("已自动保存","Saved"),error:KZ("保存失败","Save failed"),notitle:KZ("标题为空，未保存","Title required, not saved")}[KST]})'
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
    (text) => text.replace('"use strict";', '"use strict";' + KLP_SRC), // 标签下拉多选组件
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
    [',[I]);let j=ae||!!R.trim()', `,[I]);${AUTOSAVE}let j=ae||!!R.trim()`],
    ['if(!te&&j){A("discard");return}',
      'if(!te&&j){if(s){KAS.current.run().then(ok=>{ok&&!ae&&!R.trim()?p(te):A("discard")});return}A("discard");return}'],
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
    // 卡片详情里的评论改用 Markdown 渲染（描述本来就是 Markdown，评论原来是纯文本 <p>）
    ['(0,le.jsx)("p",{className:"kanban-comment-content",children:te.content})',
      `(0,le.jsx)("div",{className:"kanban-comment-content",children:(0,le.jsx)(zb.MarkdownText,{text:te.content,variant:"compact",labels:{code:{copyLabel:v("copyCode"),copiedLabel:v("copiedCode")},footnotes:v("footnotes")}})}) ${MARK}`],
    ['  font: var(--dsw-font-xxs-12);\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n}\n',
      '  font: var(--dsw-font-xxs-12);\n  white-space: normal;\n  overflow-wrap: anywhere;\n}\n.kanban-comment-content p { margin: 0 0 6px; }\n.kanban-comment-content > :last-child { margin-bottom: 0; }\n.kanban-comment-content { font-size: 13px; line-height: 1.6; }\n.kanban-comment-content, .kanban-comment-content :where(p, li, td, th, h1, h2, h3, h4, strong, em, span, blockquote) { color: var(--dsw-alias-label-primary) !important; opacity: 1 !important; }\n.kanban-comment-meta { opacity: .9; }\n'],
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
    text = text.replace(anchor, replacement)
  }
  writeFileSync(file, text)
  console.log('已打补丁', rel)
}
console.log(`dsh-kanban ${version}，原文件备份在 ${backupDir}。重启 DSH 桌面版后生效。`)
