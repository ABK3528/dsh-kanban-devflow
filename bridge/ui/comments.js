/* dsh-kanban-flow-kit: GitLab 风格评论（KCM 单条评论 / KCC 评论输入框）。
   由 install.mjs 原样插入 lib/client.js 顶部（"use strict"; 之后），只依赖 react。 */
var KZL = function (zh, en) { return /^zh/i.test(document.documentElement.lang || navigator.language || '') ? zh : en }
var KRT = function (iso) {
  var d = new Date(iso), s = (Date.now() - d.getTime()) / 1000
  if (!isFinite(s)) return ''
  if (s < 60) return KZL('刚刚', 'just now')
  if (s < 3600) return Math.floor(s / 60) + KZL(' 分钟前', ' min ago')
  if (s < 86400) return Math.floor(s / 3600) + KZL(' 小时前', ' h ago')
  if (s < 86400 * 30) return Math.floor(s / 86400) + KZL(' 天前', ' d ago')
  return d.toLocaleDateString()
}
/* 只把本看板的图片接口当图片渲染，其他链接交给 Markdown */
var KIMG = /^!\[([^\]\n]*)\]\((\/api\/kanban\/image\?[^)\s]+)\)$/
/* 同步桥评论开头的【阶段 #n｜结果｜时间】拆成标签片 */
var KTAG = /^【([^】\n]{1,80})】[ \t]*\n?/
var ktone = function (s) {
  if (/待人工确认|等你/.test(s)) return 'is-warn'
  if (/失败|阻塞|打回|终止|未执行|未通过|拒绝|错误/.test(s)) return 'is-bad'
  if (/成功|通过|已提交|已发布|完成/.test(s)) return 'is-ok'
  return ''
}
/* 评论作者按角色显示。数据里只有 source（agent/human），角色从同步桥的写法推出来，历史评论同样适用：
   【<阶段> #n｜…】按阶段对应角色（与 WORKFLOW.md 第 2 节角色指针表一致），【G:…】【看板同步…】是同步桥；
   「📄 **<阶段名> #n 报告**」按阶段名；其余 AI 评论（文档原文、验收清单等）沿用 60 秒内上一条 AI 评论的角色。 */
var KROLES = {
  discuss: { name: KZL('讨论 agent', 'Discuss agent'), av: KZL('讨', 'D'), badge: 'discuss' },
  build: { name: KZL('实施 agent', 'Build agent'), av: KZL('实', 'B'), badge: 'build' },
  test: { name: KZL('测试 agent', 'Test agent'), av: KZL('测', 'T'), badge: 'test' },
  release: { name: KZL('发布 agent', 'Release agent'), av: KZL('发', 'R'), badge: 'release' },
  bridge: { name: KZL('同步桥', 'Sync bridge'), av: KZL('桥', 'S'), badge: KZL('系统', 'System') },
}
var KSTAGE = {
  discuss: 'discuss', plan: 'build', code: 'build', test: 'test', prep: 'test', release: 'release',
  '讨论': 'discuss', '实施计划': 'build', '编码': 'build', '测试': 'test', '验收准备': 'test', '发布': 'release',
}
var krole = function (list, i) {
  var next = null
  for (var j = i; j >= 0; j--) {
    var c = list[j]
    if (!c || c.source !== 'agent') return ''
    if (next && Math.abs(new Date(next.createdAt) - new Date(c.createdAt)) > 60000) return ''
    var s = String(c.content || ''), m = /^【([^】｜\n]+)/.exec(s)
    if (m) {
      var k = m[1].trim().split(/\s+#/)[0]
      return /^(G:|看板同步)/.test(k) ? 'bridge' : (KSTAGE[k] || '')
    }
    var d = /^📄 \*\*(\S+) #\d+ 报告\*\*/.exec(s)
    if (d) return KSTAGE[d[1]] || ''
    next = c
  }
  return ''
}
var KCM = function (p) {
  var R = require('react'), h = R.createElement, c = p.c, agent = c.source === 'agent'
  var rk = agent && p.list ? krole(p.list, p.i) : '', role = KROLES[rk]
  var zs = R.useState(null), zoom = zs[0], setZoom = zs[1], cs = R.useState(false), copied = cs[0], setCopied = cs[1]
  R.useEffect(function () {
    if (!zoom) return
    var k = function (e) { if (e.key === 'Escape') { e.stopPropagation(); setZoom(null) } }
    document.addEventListener('keydown', k, true)
    return function () { document.removeEventListener('keydown', k, true) }
  }, [zoom])
  var text = String(c.content || ''), tags = [], m = KTAG.exec(text)
  if (m) { tags = m[1].split('｜').map(function (s) { return s.trim() }).filter(Boolean); text = text.slice(m[0].length) }
  /* 正文切段：连续的图片行合成一个图库，其余按 Markdown 渲染 */
  var segs = [], buf = [], gal = null
  text.split('\n').forEach(function (line) {
    var im = KIMG.exec(line.trim())
    if (im) { if (buf.length) { segs.push({ md: buf.join('\n') }); buf = [] } if (!gal) { gal = { imgs: [] }; segs.push(gal) } gal.imgs.push({ alt: im[1], src: im[2] }) }
    else { if (gal && !line.trim()) return; gal = null; buf.push(line) }
  })
  if (buf.join('').trim()) segs.push({ md: buf.join('\n') })
  var copy = function () {
    try { navigator.clipboard.writeText(String(c.content || '')).then(function () { setCopied(true); setTimeout(function () { setCopied(false) }, 1200) }) } catch (e) {}
  }
  return h('li', { className: 'kanban-comment-item kcm' },
    h('div', { className: 'kcm-avatar ' + (agent ? 'is-agent' : 'is-human') + (rk ? ' is-' + rk : ''), 'aria-hidden': 'true' }, role ? role.av : agent ? 'AI' : KZL('我', 'Me')),
    h('div', { className: 'kcm-bubble' },
      h('div', { className: 'kcm-head' },
        h('span', { className: 'kcm-name' }, role ? role.name : agent ? KZL('AI 助手', 'AI agent') : KZL('我', 'You')),
        h('time', { className: 'kcm-time', dateTime: c.createdAt, title: p.full || c.createdAt }, KRT(c.createdAt)),
        tags.length ? h('span', { className: 'kcm-tags' }, tags.map(function (t, i) {
          return h('span', { key: i, className: 'kcm-tag ' + (i === 0 ? 'is-stage ' : '') + ktone(t) }, t)
        })) : null,
        h('span', { className: 'kcm-actions' },
          h('span', { className: 'kcm-role ' + (agent ? 'is-agent' : 'is-human') + (rk ? ' is-' + rk : '') }, role ? role.badge : agent ? KZL('智能体', 'Agent') : KZL('负责人', 'Owner')),
          h('button', { type: 'button', className: 'kcm-btn', title: KZL('复制原文', 'Copy'), onClick: copy }, copied ? '✓' : '⧉'))),
      h('div', { className: 'kcm-body' }, segs.length ? segs.map(function (s, i) {
        if (s.imgs) return h('div', { key: i, className: 'kcm-gallery' }, s.imgs.map(function (im, j) {
          return h('img', { key: j, src: im.src, alt: im.alt, loading: 'lazy', title: KZL('点击放大', 'Click to zoom'), onClick: function () { setZoom(im.src) } })
        }))
        return h('div', { key: i, className: 'kanban-comment-content' }, h(p.MD, { text: s.md, variant: 'compact', labels: p.mdLabels }))
      }) : h('div', { className: 'kanban-comment-content kcm-empty' }, tags.join(' · ')))),
    zoom ? h('div', { className: 'kcm-lightbox', role: 'dialog', onClick: function (e) { e.stopPropagation(); setZoom(null) } }, h('img', { src: zoom, alt: '' })) : null)
}
var KCC = function (p) {
  var R = require('react'), h = R.createElement, ds = R.useState(false), drag = ds[0], setDrag = ds[1], fi = R.useRef(null)
  var pick = function (list) { return Array.from(list || []).filter(function (f) { return f && /^image\//.test(f.type) }) }
  var up = p.pending.some(function (x) { return x.st === 'up' }), ok = p.pending.some(function (x) { return x.st === 'ok' })
  var can = !p.disabled && !up && (!!p.value.trim() || ok), allow = p.canUpload && !p.disabled
  return h('div', {
    className: 'kcc' + (drag ? ' is-drag' : ''),
    onDragOver: function (e) { if (allow && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0) { e.preventDefault(); setDrag(true) } },
    onDragLeave: function (e) { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false) },
    onDrop: function (e) { setDrag(false); var f = pick(e.dataTransfer.files); if (f.length && allow) { e.preventDefault(); e.stopPropagation(); p.onFiles(f) } },
  },
  h(p.Textarea, {
    id: p.id, value: p.value, placeholder: p.placeholder, rows: 3, maxLength: 2000, disabled: p.disabled,
    onChange: function (e) { p.onChange(e.target.value) },
    onKeyDown: function (e) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); can && p.onSend() } },
    /* 粘贴图片进评论，并阻止冒泡到弹窗（弹窗的粘贴会把图片加成卡片附件） */
    onPaste: function (e) { var f = pick(e.clipboardData && e.clipboardData.files); if (f.length && allow) { e.preventDefault(); e.stopPropagation(); p.onFiles(f) } },
  }),
  p.pending.length ? h('div', { className: 'kcc-thumbs' }, p.pending.map(function (x) {
    return h('div', { key: x.key, className: 'kcc-thumb is-' + x.st, title: x.err || '' },
      h('img', { src: x.url, alt: '' }),
      x.st !== 'ok' ? h('span', { className: 'kcc-thumb-st' }, x.st === 'up' ? KZL('上传中…', 'Uploading…') : KZL('失败', 'Failed')) : null,
      h('button', { type: 'button', className: 'kcc-thumb-x', 'aria-label': KZL('移除图片', 'Remove image'), title: KZL('移除', 'Remove'), onClick: function () { p.onRemove(x.key) } }, '✕'))
  })) : null,
  h('div', { className: 'kcc-bar' },
    p.canUpload ? h('button', { type: 'button', className: 'kcm-btn', disabled: p.disabled, title: KZL('插入图片（也可以粘贴或拖进来）', 'Insert image (or paste / drop)'), onClick: function () { fi.current && fi.current.click() } }, KZL('🖼 插入图片', '🖼 Image')) : null,
    h('input', { ref: fi, type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true, onChange: function (e) { var f = pick(e.target.files); e.target.value = ''; f.length && p.onFiles(f) } }),
    h('span', { className: 'kcc-hint' }, KZL('支持 Markdown · ⌘/Ctrl+Enter 发送', 'Markdown · ⌘/Ctrl+Enter to send')),
    h(p.Button, { type: 'button', variant: 'outline', disabled: !can, onClick: function () { p.onSend() } }, h(p.SendIcon, { className: 'kanban-icon' }), p.sendLabel)))
}
