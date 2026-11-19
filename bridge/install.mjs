#!/usr/bin/env node
// 一条命令装好：没有 @alpacachen/dsh-kanban 或版本不对就装适配版本（必要时授权当前 DSH 版本），再打补丁加载 kanban-bridge.mjs。
// 之后每个 git 项目在 DSH 里打开时，同步桥会自动接入（流程手册、角色、「研发交付」流程、看板甬道和标签）。
// 可重复执行；插件升级后再跑一次。
//   node install.mjs            安装/更新（插件、补丁）；装的是别的插件版本时换成适配版本
//   node install.mjs --check    只检查补丁状态，不改任何文件
//   node install.mjs --remove   还原（用安装时备份的原文件）
//   node install.mjs --force    不换插件版本，强行试打（插件改版后锚点可能对不上）
// 改完需重启 DSH 桌面版。
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const profile = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'desktop')
const pkg = join(profile, 'node_modules', '@alpacachen', 'dsh-kanban')
// 补丁锚点适配过的 dsh-kanban 版本（第一个是安装/升级时装的版本）。插件改版后打包产物的变量名会变，补丁要重新适配再放进来。
const SUPPORTED = ['1.13.1']
const MIN_DSH = '0.2.2-rc.5' // 1.13 起插件用到 rc.5 的接口
const args = new Set(process.argv.slice(2))
const remove = args.has('--remove')
const check = args.has('--check')
const force = args.has('--force')
const bridgeUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'kanban-bridge.mjs')).href
const MARK = '/* dsh-kanban-flow-kit bridge */'
const PLUGIN = '@alpacachen/dsh-kanban'
const PLUGIN_DECLARED = { '1.13.1': ['0.2.2-rc.5'] } // 各适配版本 package.json 里的 dsh.compatibility.dshReleases（还没装时用来判断要不要先授权）
const profileName = process.env.DSH_PROFILE || basename(profile)
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return d } }
const sh = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
// 比较 0.2.2-rc.5 这类版本号：预发布版小于正式版
const cmpVer = (x, y) => {
  const parse = v => { const [main, pre] = v.split('-'); return [...main.split('.').map(Number), pre ? Number(pre.replace(/\D+/g, '')) : Infinity] }
  const a = parse(x), b = parse(y)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

if (args.has('--help') || args.has('-h')) {
  console.log(`用法：node install.mjs [--check | --remove | --force]
  （无参数）  没装插件或版本不对就装 ${PLUGIN}@${SUPPORTED[0]}，DSH 版本不在插件声明里就授权，然后打补丁
  --check     只检查补丁状态，不改文件
  --remove    还原补丁（插件保留）
  --force     不换插件版本，强行试打
环境变量：DSH_PROFILE_DIR 指定 profile 目录（默认 ~/.dsh/profiles/desktop）；DSH_PROFILE 指定 dsh 命令用的 profile 名（默认取目录名）`)
  process.exit(0)
}

// 装插件、升级、授权都要改 profile 的 package.json 和依赖，DSH 运行时不动它：让用户先退出
function ensurePlugin() {
  const installed = readJson(join(pkg, 'package.json'), null)
  const dshVersion = sh('dsh', ['--version']).stdout?.trim() || ''
  if (!dshVersion) throw new Error('找不到 dsh 命令。请先安装 DeepSeek Harness 桌面版，并确认终端里能运行 dsh。')
  if (cmpVer(dshVersion, MIN_DSH) < 0) throw new Error(`DSH ${dshVersion} 太旧：看板插件 ${PLUGIN}@${SUPPORTED[0]} 需要 DSH ${MIN_DSH} 或更新版本。先升级 DeepSeek Harness 桌面版。`)
  // 装的是没适配的版本（旧版或更新的版本）：换成适配版本。--force 时保留现有版本强行试打
  const upgrade = installed && !SUPPORTED.includes(installed.version) && !force
  const ver = installed && !upgrade ? installed.version : SUPPORTED[0]
  const declared = installed && !upgrade ? Object.keys(installed.dsh?.compatibility?.dshReleases ?? {}) : PLUGIN_DECLARED[ver] ?? []
  const allowed = readJson(join(profile, 'compatibility.json'), {})[`${PLUGIN}@${ver}`] ?? []
  const needAllow = ![...declared, ...allowed].includes(dshVersion)
  if (installed && !upgrade && !needAllow) return
  const what = !installed ? `安装插件 ${PLUGIN}@${ver}` : upgrade ? `把插件从 ${installed.version} 换成 ${ver}` : `为 DSH ${dshVersion} 授权插件`
  if (!process.env.DSH_INSTALL_FORCE && sh('pgrep', ['-f', 'DeepSeek Harness.app/Contents/MacOS']).stdout.trim()) {
    throw new Error(`需要${what}，请先完全退出 DeepSeek Harness 桌面版，再重新运行本命令。`)
  }
  const bak = join(profile, 'workflow-poc', `install-backup-${Date.now()}`)
  mkdirSync(bak, { recursive: true })
  for (const f of ['package.json', 'pnpm-lock.yaml', 'compatibility.json']) if (existsSync(join(profile, f))) copyFileSync(join(profile, f), join(bak, f))
  console.log(`${what}（已备份 package.json、pnpm-lock.yaml、compatibility.json 到 ${bak}）…`)
  const dsh = a => { const r = spawnSync('dsh', ['plugin', '--profile', profileName, ...a], { stdio: 'inherit' }); if (r.status !== 0) throw new Error(`dsh plugin ${a.join(' ')} 失败（退出码 ${r.status}）`) }
  // dsh plugin add 会直接拒绝没声明当前 DSH 版本的插件，所以授权要在安装之前
  if (needAllow) {
    console.log(`${PLUGIN}@${ver} 没有声明兼容 DSH ${dshVersion}，授权这一对精确版本（DSH 提示可能崩溃或数据损坏）…`)
    dsh(['allow-version', `${PLUGIN}@${ver}`, '--dsh-version', dshVersion, '--accept-risk'])
  }
  // 换版本会整体替换插件目录，旧版本的补丁随之消失；旧版原文件备份留在 workflow-poc/kanban-bridge-orig-<旧版本>/
  if (!installed || upgrade) dsh(['add', `${PLUGIN}@${ver}`])
}
if (!remove && !check) {
  try { ensurePlugin() } catch (error) { console.error(error.message); process.exit(1) }
}

if (!existsSync(join(pkg, 'package.json'))) {
  console.error(`没有找到 ${pkg}。\n不带参数运行一次 node install.mjs 会自动装好看板插件 ${SUPPORTED[0]}。`)
  process.exit(1)
}
const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version
const supported = SUPPORTED.includes(version)
const backupDir = join(profile, 'workflow-poc', `kanban-bridge-orig-${version}`)
if (!supported && !force) {
  console.error(`dsh-kanban ${version} 不是这套补丁适配的版本（适配：${SUPPORTED.join('、')}）。\n`
    + `插件代码在版本之间变过，补丁锚点对不上，强行打会改坏插件。先完全退出 DSH，不带参数运行 node install.mjs，会自动换成 ${SUPPORTED[0]} 并打补丁。\n`
    + '只想还原原文件：加 --remove。确认要拿这个版本试打：加 --force。')
  process.exit(1)
}

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
const AUTOSAVE_STATUS = 's&&KST&&(0,ce.jsx)("span",{className:"kanban-muted-small",role:"status",style:{marginRight:"auto",alignSelf:"center"},' +
  'children:{saving:KZ("保存中…","Saving…"),saved:KZ("已自动保存","Saved"),error:KZ("保存失败","Save failed"),notitle:KZ("标题为空，未保存","Title required, not saved")}[KST]})'
// 把 start 到 end（含两端）之间的一段换成 replacement；两端锚点都必须唯一
const spliceOnce = (start, end, replacement) => (text) => {
  const a = text.indexOf(start), b = text.indexOf(end, a)
  if (a < 0 || b < 0 || text.indexOf(start, a + 1) >= 0 || text.indexOf(end, b + 1) >= 0) throw new Error(`lib/client.js: 锚点不唯一或不存在：${start.slice(0, 60)}`)
  return text.slice(0, a) + replacement + text.slice(b + end.length)
}
const files = {
  'index.js': [
    ['  for (const tool of tools) ctx.tools.register(tool);',
      `  ${MARK} globalThis[Symbol.for('dsh-kanban-flow-kit.kanban')] = { dispatch, workspaceOfId };\n  for (const tool of tools) ctx.tools.register(tool);`],
    // ---- 卡片多标签：card.labels 数组；card.label 保留为第一个标签，旧版插件仍可读 ----
    ['function validateBoard(data) {',
      `const cardLabels = (c) => (Array.isArray(c.labels) ? c.labels : c.label ? [c.label] : []); ${MARK}\nfunction validateBoard(data) {`],
    ['      if (c.label != null && !labelNames.has(c.label)) errors.push("card references missing label: " + c.id);',
      '      if (c.label != null && !labelNames.has(c.label)) errors.push("card references missing label: " + c.id);\n      if (c.labels != null && (!Array.isArray(c.labels) || c.labels.some((n) => !labelNames.has(n)))) errors.push("card references missing label: " + c.id);'],
    ['            board.cards = parsed.data.cards;\n',
      '            board.cards = parsed.data.cards;\n            for (const c of board.cards) { c.labels = cardLabels(c).slice(); c.label = c.labels[0]; }\n'],
    ['  const findLabel = (b, name2) => b.labels.find((l) => l.name === name2);\n',
      `  const findLabel = (b, name2) => b.labels.find((l) => l.name === name2);
  const wantLabels = (b, a) => {
    let list;
    if (Array.isArray(a.labels)) list = a.labels;
    else if (typeof a.label === "string") list = a.label ? [a.label] : [];
    else return { labels: void 0 };
    const out = [];
    for (const raw of list) {
      const n = typeof raw === "string" ? clampText(raw, LABEL_LIMIT, "Label", b) : "";
      if (!n) continue;
      if (!findLabel(b, n)) return { error: "Label not found: " + n };
      if (!out.includes(n)) out.push(n);
    }
    return { labels: out };
  };
`],
    ['      label: c.label ?? null,\n      priority: c.priority ?? null,\n      dueDate: c.dueDate,\n      completedAt: c.completedAt,\n      createdAt',
      '      label: c.label ?? null,\n      labels: cardLabels(c).slice(),\n      priority: c.priority ?? null,\n      dueDate: c.dueDate,\n      completedAt: c.completedAt,\n      createdAt'],
    ['      label: c.label ?? null,\n      priority: c.priority ?? null,\n      dueDate: c.dueDate,\n      completedAt: c.completedAt,\n      commentCount',
      '      label: c.label ?? null,\n      labels: cardLabels(c).slice(),\n      priority: c.priority ?? null,\n      dueDate: c.dueDate,\n      completedAt: c.completedAt,\n      commentCount'],
    ['        const label = typeof a.label === "string" ? clampText(a.label, LABEL_LIMIT, "Label", board) : void 0;\n        if (label && !findLabel(board, label)) return result({ error: "Label not found: " + label });\n',
      '        const wl = wantLabels(board, a);\n        if (wl.error) return result({ error: wl.error });\n        const labels = wl.labels ?? [];\n'],
    ['          note: clampText(a.note, NOTE_LIMIT, "Note", board),\n          label,\n',
      '          note: clampText(a.note, NOTE_LIMIT, "Note", board),\n          label: labels[0],\n          labels,\n'],
    ['            column: col.title,\n            label: card.label ?? null,\n',
      '            column: col.title,\n            label: labels.join(", ") || null,\n'],
    ['          const nextLabel = typeof a.label === "string" ? clampText(a.label, LABEL_LIMIT, "Label", board) : void 0;\n          if (nextLabel && !findLabel(board, nextLabel)) return result({ error: "Label not found: " + nextLabel });\n          const before = {\n            title: card.title,\n            note: card.note,\n            label: card.label ?? null,',
      '          const wl = wantLabels(board, a);\n          if (wl.error) return result({ error: wl.error });\n          const before = {\n            title: card.title,\n            note: card.note,\n            labelList: cardLabels(card).slice(),\n            label: cardLabels(card).join(", ") || null,'],
    ['          if (typeof a.label === "string") card.label = nextLabel || void 0;\n',
      '          if (wl.labels) { card.labels = wl.labels; card.label = wl.labels[0]; }\n'],
    ['          const after = {\n            title: card.title,\n            note: card.note,\n            label: card.label ?? null,',
      '          const after = {\n            title: card.title,\n            note: card.note,\n            labelList: cardLabels(card).slice(),\n            label: cardLabels(card).join(", ") || null,'],
    ['field: "label", from: before.label, to: after.label });',
      'field: "label", from: before.label, to: after.label, meta: { title: card.title, added: after.labelList.filter((n) => !before.labelList.includes(n)), removed: before.labelList.filter((n) => !after.labelList.includes(n)) } });'],
    ['            if (card.label === name2) {\n              card.label = newName;\n',
      '            if (cardLabels(card).includes(name2)) {\n              card.labels = cardLabels(card).map((n) => (n === name2 ? newName : n));\n              card.label = card.labels[0];\n'],
    ['          if (card.label === name2) {\n            card.label = void 0;\n',
      '          if (cardLabels(card).includes(name2)) {\n            card.labels = cardLabels(card).filter((n) => n !== name2);\n            card.label = card.labels[0];\n'],
    ['(card.label ? "[" + card.label + "] " : "") +',
      '(cardLabels(card).length ? "[" + cardLabels(card).join(", ") + "] " : "") +'],
    ['if (c.label) lines.push("Label: " + c.label);',
      'if (cardLabels(c).length) lines.push("Labels: " + cardLabels(c).join(", "));'],
    ['          label: { type: "string", description: `Label name (optional;',
      '          labels: { type: "array", items: { type: "string" }, description: "Label names (optional, several allowed; takes precedence over label)" },\n          label: { type: "string", description: `Label name (optional;'],
    ['          label: { type: "string", description: `New label name (optional;',
      '          labels: { type: "array", items: { type: "string" }, description: "Replace all labels with these names (optional, several allowed; [] clears; takes precedence over label)" },\n          label: { type: "string", description: `New label name (optional;'],
  ],
  // 看板界面：标签改为可多选（chip 按钮）。表单里用 \u0001 拼接多个标签名，沿用原有的字符串比较逻辑。
  'lib/client.js': [
    (text) => text.replace('"use strict";', () => '"use strict";' + TOP_SRC), // 注入组件（函数替换，避免 $ 被当成替换模式）
    ['label:s?.label??""', `label:(s?.labels??(s?.label?[s.label]:[])).join(${SEP}) ${MARK}`],
    spliceOnce('(0,ce.jsxs)(Hs,{disabled:ne||!!R,value:L.label||"__none__"', 'u.map(ae=>(0,ce.jsx)(qo,{value:ae.name,children:ae.name},ae.name))]})]})',
      `(0,ce.jsx)(KLP,{disabled:ne||!!R,labels:u,ariaLabel:v("fieldLabel"),value:L.label?L.label.split(${SEP}):[],onChange:l=>le({label:l.join(${SEP})})})`),
    ['label:N.label||void 0,priority:N.priority||void 0',
      `labels:N.label?N.label.split(${SEP}):void 0,priority:N.priority||void 0`],
    ['N.label!==(z.label??"")&&(Z.label=N.label)',
      `N.label!==(z.labels??(z.label?[z.label]:[])).join(${SEP})&&(Z.labels=N.label?N.label.split(${SEP}):[])`],
    // 卡片详情实时保存：字段改动后自动调用 onSave（文本 800ms 防抖，标签/优先级/截止日期立即）；
    // 关闭前先把未保存的改动存掉；已有卡片去掉「保存」按钮，新建卡片仍保留。
    // 同一处还挂了：看板实时卡片同步（同步桥回写描述后弹窗跟着更新，自动保存不覆盖）、评论图片上传和发送。
    [',[R]);let Q=te||!!I.trim()', () => `,[R]);${HOOKS}let Q=te||KPI.length>0||!!I.trim()`],
    ['onDelete:g,onChatWithAgent:x}){let v=Ie()', 'onDelete:g,onChatWithAgent:x,liveCard:KLC}){let v=Ie()'],
    ['comments:Q?.comments??[],activities:', 'comments:Q?.comments??[],liveCard:Q,activities:'],
    // 上传图片后把服务端返回（含最新看板）交给调用方，评论据此拿到新图片的 attachmentId
    ['throw new Error(a("actionRetry"));H(be,e,le)}', 'throw new Error(a("actionRetry"));H(be,e,le);return be}'],
    ['be=async()=>{let ae=I.trim();!s||!ae||ae.length>2e3||await z(()=>m(s.id,ae))&&E("")}', 'be=()=>KSD()'],
    ['if(!ae&&Q){A("discard");return}',
      'if(!ae&&Q){if(s){KAS.current.run().then(ok=>{ok&&!te&&!KAS.current.KPI.length&&!I.trim()?p(ae):A("discard")});return}A("discard");return}'],
    ['(0,ce.jsx)(de,{disabled:ne||!L.title.trim(),onClick:async()=>{b.current?.reportValidity()',
      '!s&&(0,ce.jsx)(de,{disabled:ne||!L.title.trim(),onClick:async()=>{b.current?.reportValidity()'],
    ['(0,ce.jsxs)(ce.Fragment,{children:[s&&g&&(0,ce.jsxs)(de,{variant:"ghost",className:"kanban-dialog-delete"',
      `(0,ce.jsxs)(ce.Fragment,{children:[${AUTOSAVE_STATUS},s&&g&&(0,ce.jsxs)(de,{variant:"ghost",className:"kanban-dialog-delete"`],
    ['r=(e.label??"").trim()', `r=(e.label??"").split(${SEP}).join(", ").trim()`],
    ['(e.label||u)&&', '(e.label||e.labels?.length||u)&&'],
    ['children:[e.label&&(0,ht.jsxs)(sf,{variant:"secondary",className:"kanban-card-badge",children:[(0,ht.jsx)("span",{className:"kanban-label-dot",style:{background:c},"aria-hidden":"true"}),e.label]}),',
      'children:[...(e.labels?.length?e.labels:e.label?[e.label]:[]).map(nm=>(0,ht.jsxs)(sf,{variant:"secondary",className:"kanban-card-badge",title:nm,children:[(0,ht.jsx)("span",{className:"kanban-label-dot",style:{background:Ob(t,nm)},"aria-hidden":"true"}),KVAL(nm)]},nm)),'],
    ['(P===null||(N.label??"")===P)', '(P===null||(N.labels?.length?N.labels:[N.label??""]).includes(P))'],
    ['(P===null||(Z.label??"")===P)', '(P===null||(Z.labels?.length?Z.labels:[Z.label??""]).includes(P))'],
    // 评论改成 GitLab 风格：头像 + 时间线 + 气泡（KCM），正文按 Markdown 渲染，【阶段｜结果】拆成标签片，图片可放大
    spliceOnce('c.map(ae=>{let me=ae.source==="agent";return(0,ce.jsxs)("li",{className:"kanban-comment-item"', 'children:ae.content})]},ae.id)})',
      `c.map((ae,ki)=>(0,ce.jsx)(KCM,{c:ae,list:c,i:ki,MD:Gb.MarkdownText,full:di(ae.createdAt),mdLabels:{code:{copyLabel:v("copyCode"),copiedLabel:v("copiedCode")},footnotes:v("footnotes")}},ae.id)) ${MARK}`),
    // 卡片详情不再展示「活动记录」（数据仍照常记录，同步桥靠它识别人的操作）
    spliceOnce('s&&(0,ce.jsxs)("div",{className:"kanban-activity-box"', '(0,ce.jsx)($b,{activities:f})})]})', 'null'),
    // 评论输入框（KCC）：插入/粘贴/拖入图片，缩略图可删除
    spliceOnce('(0,ce.jsxs)("div",{className:"kanban-comment-composer",children:[', 'v("sendComment")]})]})',
      '(0,ce.jsx)(KCC,{id:`${w}-comment`,value:I,onChange:E,placeholder:v("commentPlaceholder"),disabled:ne||!!R,canUpload:!!o,pending:KPI,onFiles:KUP,onRemove:KRM,onSend:()=>{be()},sendLabel:v("sendComment"),Textarea:fo,Button:de,SendIcon:as})'),
    ['  font: var(--dsw-font-xxs-12);\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n}\n',
      '  font: var(--dsw-font-xxs-12);\n  white-space: normal;\n  overflow-wrap: anywhere;\n}\n.kanban-comment-content p { margin: 0 0 6px; }\n.kanban-comment-content > :last-child { margin-bottom: 0; }\n.kanban-comment-content { font-size: 13px; line-height: 1.6; }\n.kanban-comment-content, .kanban-comment-content :where(p, li, td, th, h1, h2, h3, h4, strong, em, span, blockquote) { color: var(--dsw-alias-label-primary) !important; opacity: 1 !important; }\n.kanban-comment-meta { opacity: .9; }\n' + COMMENT_CSS],
  ],
  'workflow/index.js': [
    ['  let executor, runner, scheduler, apiFiber, removeTools;\n',
      `  let executor, runner, scheduler, apiFiber, removeTools;\n  let bridge; ${MARK}\n`],
    ['    removeTools?.();\n',
      `    removeTools?.();\n    bridge?.dispose(); ${MARK}\n`],
    ['      onError: (error) => console.warn("Workflow:", error?.code ?? "WF_INTERNAL")\n    });',
      `      onChange: () => bridge?.poke(), ${MARK}\n      onError: (error) => console.warn("Workflow:", error?.code ?? "WF_INTERNAL")\n    });`],
    ['    removeTools = mountWorkflowManagementTools(ctx, core);\n',
      `    removeTools = mountWorkflowManagementTools(ctx, core);\n    try { ${MARK}\n      const { startBridge } = await import(${JSON.stringify(bridgeUrl)} + '?t=' + Date.now());\n      bridge = startBridge({ core, store, attachments: ctx.attachments, workspaceRegistry: ctx.workspaceRegistry, readArtifactText, profileDir: ctx.profileContext.dir });\n    } catch (error) { console.warn('kanban-bridge: not started', error?.message ?? error); }\n`],
  ],
}

const patchOf = (rel, text) => {
  const edits = files[rel]
  for (const edit of edits) {
    if (typeof edit === 'function') { text = edit(text); continue }
    const [anchor, replacement] = edit
    const n = text.split(anchor).length - 1
    if (n !== 1) throw new Error(`锚点出现 ${n} 次（应为 1 次）\n${anchor}`)
    text = text.replace(anchor, typeof replacement === 'function' ? replacement : () => replacement)
  }
  return text
}

if (check) {
  let patched = 0, pristine = 0, broken = 0
  for (const rel of Object.keys(files)) {
    const file = join(pkg, rel)
    const backup = join(backupDir, rel.replace('/', '__'))
    const text = readFileSync(file, 'utf8')
    if (text.includes(MARK)) { console.log('已打补丁 ', rel); patched++; continue }
    if (existsSync(backup)) { console.log('未打补丁 ', rel); pristine++; continue }
    // 没打补丁也没有备份：可能是补丁被插件升级覆盖了，也可能文件被改过
    try { patchOf(rel, text); console.log('可打补丁 ', rel); pristine++ }
    catch (error) { console.log('锚点不匹配', rel, '\n ', error.message.split('\n')[0]); broken++ }
  }
  console.log(`dsh-kanban ${version}${supported ? '' : '（不在适配列表里）'}：已打补丁 ${patched}，未打 ${pristine}，锚点不匹配 ${broken}。`)
  process.exit(broken || (patched > 0 && pristine > 0) ? 1 : 0)
}

if (remove) {
  let restored = 0
  for (const rel of Object.keys(files)) {
    const file = join(pkg, rel)
    const backup = join(backupDir, rel.replace('/', '__'))
    if (existsSync(backup)) { copyFileSync(backup, file); console.log('还原', rel); restored++; continue }
    if (readFileSync(file, 'utf8').includes(MARK)) console.warn(`跳过 ${rel}：找不到备份（${backup}），文件里还留着补丁，建议重装插件`)
  }
  console.log(restored ? `已还原 ${restored} 个文件。重启 DSH 桌面版后生效。` : '没有需要还原的文件。')
  process.exit(0)
}

// 先在内存里把三个文件全部打完，任何一处锚点对不上就整体放弃，不留半打补丁的状态。
const plan = [], errors = []
for (const rel of Object.keys(files)) {
  const file = join(pkg, rel)
  const backup = join(backupDir, rel.replace('/', '__'))
  const text = readFileSync(file, 'utf8')
  const already = text.includes(MARK)
  if (already && !existsSync(backup)) {
    errors.push(`${rel}: 文件里已经有补丁，但找不到备份（${backup}）。\n  先重装插件（dsh plugin --profile desktop add @alpacachen/dsh-kanban@${version}）再重跑本脚本。`)
    continue
  }
  const base = already ? readFileSync(backup, 'utf8') : text // 从原文件重新打，保证幂等
  try { plan.push({ rel, file, backup, base, text: patchOf(rel, base) }) }
  catch (error) { errors.push(`${rel}: ${error.message}`) }
}
if (errors.length) {
  console.error(`没有修改任何文件：dsh-kanban ${version} 的代码和补丁锚点对不上，需要先适配补丁。\n\n`
    + errors.join('\n\n') + '\n\n'
    + `适配的版本是 ${SUPPORTED.join('、')}；不带 --force 运行 node install.mjs 会自动换成 ${SUPPORTED[0]}。`)
  process.exit(1)
}

mkdirSync(backupDir, { recursive: true })
for (const item of plan) {
  if (!existsSync(item.backup)) copyFileSync(item.file, item.backup)
  writeFileSync(item.file, item.text)
  console.log('已打补丁', item.rel)
}
console.log(`dsh-kanban ${version}，原文件备份在 ${backupDir}。\n`
  + '完全退出并重新打开 DSH 桌面版后生效；之后在 DSH 里打开的 git 项目会自动接入（甬道、标签、流程、文档），不需要再发提示词。\n'
  + '不想接入某个项目：在它根目录建空文件 .dsh-devflow-off。')
