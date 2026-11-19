/* dsh-kanban-flow-kit bridge: 卡片弹窗组件内的 hooks，由 install.mjs 插在 "(0,ot.useEffect)(()=>{I&&O.current?.focus()},[I]);" 之后。
   插件压缩后的局部变量：e=workspaceId a=卡片图片 o=上传图片 r=删除图片 n=open s=打开时的卡片（快照） g=onSave m=onAddComment
   C/D=表单 F=已保存基线 R/P=评论草稿 T=错误提示 I=确认态 ee=已挂载 KLC=看板里的实时卡片（补丁传入） */
let KAS = (0, ot.useRef)({}), [KST, KSS] = (0, ot.useState)(""), [KPI, KSP] = (0, ot.useState)([]), KZ = KZL;
KAS.current.C = C; KAS.current.s = s; KAS.current.live = KLC; KAS.current.KPI = KPI;
KAS.current.rm = (cid, id) => r ? r(cid, id) : Promise.resolve(!1);
KAS.current.dirty = c0 => Object.keys(c0).some(k => c0[k] !== F.current[k]);
/* 实时卡片 → 表单字段 */
KAS.current.lf = x => x ? { title: x.title ?? "", note: x.note ?? "", label: (x.labels ?? (x.label ? [x.label] : [])).join("\u0001"), priority: x.priority ?? "", dueDate: x.dueDate ?? "" } : null;
/* 实时保存：只发用户改过的字段；没改过的字段取看板最新值，避免把同步桥刚写的描述冲掉 */
KAS.current.run = () => {
  let q = KAS.current;
  return q.p = (q.p || Promise.resolve(!0)).then(async () => {
    let cur = q.C;
    if (!q.s || !q.dirty(cur)) return !0;
    if (!cur.title.trim()) { ee.current && KSS("notitle"); return !1 }
    ee.current && KSS("saving");
    let L = q.lf(q.live && q.live.id === q.s.id ? q.live : null), out = { ...cur };
    if (L) for (let k in L) cur[k] === F.current[k] && (out[k] = L[k]);
    try {
      let res = await g(out);
      if (res === !1) { ee.current && KSS("error"); return !1 }
      let nf = { ...F.current };
      for (let k in cur) cur[k] !== nf[k] && (nf[k] = cur[k]);
      F.current = nf;
      ee.current && KSS(q.dirty(q.C) ? "saving" : "saved");
      return !0
    } catch (e2) { ee.current && (KSS("error"), T(v("actionFailed") + String(e2 instanceof Error ? e2.message : e2))); return !1 }
  })
};
/* 防抖：标签/优先级/截止日期立即保存，标题/描述停 800ms 后保存 */
(0, ot.useEffect)(() => {
  let q = KAS.current, pv = q.prev; q.prev = C;
  if (!n || !s || I || !q.dirty(C)) return;
  let quick = pv && ["label", "priority", "dueDate"].some(k => pv[k] !== C[k]), tm = setTimeout(() => { q.run() }, quick ? 0 : 800);
  return () => clearTimeout(tm)
}, [C, n, s?.id, I]);
(0, ot.useEffect)(() => { KSS("") }, [n, s?.id]);
/* 看板里卡片被别处改了（同步桥回写描述、AI 改标签……）：用户没动过的字段跟着更新 */
(0, ot.useEffect)(() => {
  let q = KAS.current, L = q.lf(KLC);
  if (!n || !s || !L || KLC.id !== s.id) return;
  let cur = q.C, ch = {};
  for (let k in L) L[k] !== F.current[k] && cur[k] === F.current[k] && (ch[k] = L[k]);
  if (!Object.keys(ch).length) return;
  F.current = { ...F.current, ...ch };
  D(x => { let y = { ...x }; for (let k in ch) x[k] === cur[k] && (y[k] = ch[k]); return y })
}, [KLC, n, s?.id]);
/* 评论里的图片：先传成卡片图片，发送时拼成 Markdown 图片链接。
   attachmentId 就是 "sha256:" + 文件内容的哈希，所以先算哈希当编号；几张同时上传也不会对错号。
   dup=上传前卡片上已经有这张图（移除/放弃时不能删它） */
let KUP = async files => {
  if (!s || !o) return;
  let cid = s.id;
  for (let f of files) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) { T(KZ("评论图片只支持 PNG、JPEG、WebP", "Only PNG, JPEG or WebP images")); continue }
    let key = Math.random().toString(36).slice(2), url = URL.createObjectURL(f);
    KSP(x => [...x, { key, url, cid, st: "up" }]);
    try {
      let hb = await crypto.subtle.digest("SHA-256", await f.arrayBuffer()), id = "sha256:" + Array.from(new Uint8Array(hb), b0 => b0.toString(16).padStart(2, "0")).join("");
      let lv = KAS.current.live, had = (lv && lv.id === cid ? lv.images ?? [] : a).some(i => i.attachmentId === id);
      let res = await o(cid, f), imgs = res?.board?.cards?.find(c0 => c0.id === cid)?.images;
      if (imgs && !imgs.some(i => i.attachmentId === id)) throw new Error(KZ("图片没存进卡片，请重试", "Image not saved, retry"));
      KSP(x => x.map(p0 => p0.key === key ? { ...p0, st: "ok", id, dup: had } : p0));
    } catch (e2) {
      KSP(x => x.map(p0 => p0.key === key ? { ...p0, st: "err", err: String(e2 instanceof Error ? e2.message : e2) } : p0));
    }
  }
};
let KRM = key => {
  let it = KPI.find(x => x.key === key);
  if (!it) return;
  URL.revokeObjectURL(it.url);
  KSP(x => x.filter(x0 => x0.key !== key));
  /* 同一张图还挂在别的待发缩略图上时先不删 */
  it.id && !it.dup && !KPI.some(x => x.key !== key && x.id === it.id) && KAS.current.rm(it.cid, it.id);
};
let KSD = async () => {
  let txt = R.trim(), ims = KPI.filter(x => x.st === "ok");
  if (!s || (!txt && !ims.length) || KPI.some(x => x.st === "up")) return;
  let md = ims.map((x, i) => "![" + KZ("图片", "image") + " " + (i + 1) + "](/api/kanban/image?" + new URLSearchParams({ workspaceId: e, cardId: s.id, attachmentId: x.id }) + ")").join("\n");
  let body = txt ? (md ? txt + "\n\n" + md : txt) : md;
  if (body.length > 2e3) { T(KZ("评论超过 2000 字（含图片链接），请删减", "Comment exceeds 2000 characters including image links")); return }
  await z(() => m(s.id, body)) && (P(""), KPI.forEach(x => URL.revokeObjectURL(x.url)), KSP([]));
};
/* 关闭或换卡时还没发出去的评论图片：从卡片上删掉（原本就在卡片上的不删） */
(0, ot.useEffect)(() => () => {
  let q = KAS.current;
  let gone = new Set();
  (q.KPI || []).forEach(x => { URL.revokeObjectURL(x.url); x.id && !x.dup && !gone.has(x.id) && (gone.add(x.id), q.rm(x.cid, x.id)) });
  KSP([]);
}, [n, s?.id]);
