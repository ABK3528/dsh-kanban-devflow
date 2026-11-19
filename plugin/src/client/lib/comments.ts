// dsh-kanban-devflow: parsing helpers for the GitLab-style comment timeline.
//
// The dev-delivery sync bridge writes comments as "【<stage> #n｜<result>｜…】\n<markdown>", may append board images as
// "![alt](/api/kanban/image?…)" lines, and links task artifacts as relative "/api/file?path=…" URLs.
// The Chinese patterns below match what the bridge writes, so they are data, not UI text.
import type { Comment } from "./types"

/** Only this board's image endpoint is rendered as a gallery; other images are left to Markdown. */
const IMAGE_LINE = /^!\[([^\]\n]*)\]\((\/api\/kanban\/image\?[^)\s]+)\)$/
const TAG_HEAD = /^【([^】\n]{1,80})】[ \t]*\n?/
const FILE_LINK = /\]\((\/api\/file\?[^)\s]+)\)/g

export type CommentSegment = { markdown: string } | { images: { alt: string; src: string }[] }

export interface ParsedComment {
  tags: string[]
  segments: CommentSegment[]
}

/** Split the leading 【…｜…】 into tags, and group consecutive image lines into galleries. */
export function parseComment(content: string): ParsedComment {
  let text = String(content ?? "")
  let tags: string[] = []
  const head = TAG_HEAD.exec(text)
  if (head) {
    tags = head[1].split("｜").map((s) => s.trim()).filter(Boolean)
    text = text.slice(head[0].length)
  }
  const segments: CommentSegment[] = []
  let buffer: string[] = []
  let gallery: { images: { alt: string; src: string }[] } | null = null
  for (const line of text.split("\n")) {
    const image = IMAGE_LINE.exec(line.trim())
    if (image) {
      if (buffer.length) { segments.push({ markdown: buffer.join("\n") }); buffer = [] }
      if (!gallery) { gallery = { images: [] }; segments.push(gallery) }
      gallery.images.push({ alt: image[1], src: image[2] })
    } else {
      if (gallery && !line.trim()) continue
      gallery = null
      buffer.push(line)
    }
  }
  if (buffer.join("").trim()) segments.push({ markdown: buffer.join("\n") })
  return { tags, segments }
}

/** The host Markdown renderer drops relative hrefs, so make artifact links absolute against the current page. */
export function absolutizeFileLinks(markdown: string, base: string): string {
  return markdown.replace(FILE_LINK, (all, url: string) => {
    try { return "](" + new URL(url, base).href + ")" } catch { return all }
  })
}

export function tagTone(tag: string): "" | "is-ok" | "is-warn" | "is-bad" {
  if (/待人工确认|等你/.test(tag)) return "is-warn"
  if (/失败|阻塞|打回|终止|未执行|未通过|拒绝|错误/.test(tag)) return "is-bad"
  if (/成功|通过|已提交|已发布|完成/.test(tag)) return "is-ok"
  return ""
}

export type CommentRole = "" | "discuss" | "build" | "test" | "release" | "bridge"

/** Stage ids and display names (WORKFLOW.md section 2) → role. */
const STAGE_ROLE: Record<string, CommentRole> = {
  discuss: "discuss", plan: "build", code: "build", test: "test", prep: "test", release: "release",
  "讨论": "discuss", "实施计划": "build", "编码": "build", "测试": "test", "验收准备": "test", "发布": "release",
}

/**
 * Infer which agent wrote comment i. Data only records source (agent/human); the role follows from how the bridge writes:
 * 【<stage> #n｜…】 maps by stage, 【G:…】/【看板同步…】 is the bridge, "📄 **<stage> #n 报告**" maps by stage name,
 * and any other agent comment inherits the role of the agent comment right before it (within 60 s).
 */
export function commentRole(list: readonly Comment[], i: number): CommentRole {
  let next: Comment | null = null
  for (let j = i; j >= 0; j--) {
    const c = list[j]
    if (!c || c.source !== "agent") return ""
    if (next && Math.abs(Date.parse(next.createdAt) - Date.parse(c.createdAt)) > 60_000) return ""
    const s = String(c.content ?? "")
    const tag = /^【([^】｜\n]+)/.exec(s)
    if (tag) {
      const key = tag[1].trim().split(/\s+#/)[0]
      return /^(G:|看板同步)/.test(key) ? "bridge" : STAGE_ROLE[key] ?? ""
    }
    const report = /^📄 \*\*(\S+) #\d+ 报告\*\*/.exec(s)
    if (report) return STAGE_ROLE[report[1]] ?? ""
    next = c
  }
  return ""
}

export function relativeTime(iso: string, t: (key: string) => string, now = Date.now()): string {
  const date = new Date(iso)
  const s = (now - date.getTime()) / 1000
  if (!Number.isFinite(s)) return ""
  const fill = (key: string, n: number) => t(key).replace("{n}", String(Math.floor(n)))
  if (s < 60) return t("justNow")
  if (s < 3600) return fill("minutesAgo", s / 60)
  if (s < 86400) return fill("hoursAgo", s / 3600)
  if (s < 86400 * 30) return fill("daysAgo", s / 86400)
  return date.toLocaleDateString()
}

/** Short path for the artifact preview header (drops the task-artifact directory prefix). */
export function artifactDisplayPath(path: string): string {
  return path.replace(/^.*\/workflow-artifacts\/[^/]+\/(repo\/)?/, "")
}

/** Markdown for comment images uploaded as card images. */
export function commentImageMarkdown(workspaceId: string, cardId: string, attachmentIds: string[], alt: string): string {
  return attachmentIds.map((attachmentId, i) =>
    `![${alt} ${i + 1}](/api/kanban/image?${new URLSearchParams({ workspaceId, cardId, attachmentId })})`).join("\n")
}

/** Card attachment ids are "sha256:" + hex digest of the file bytes, so the id is known before upload. */
export async function attachmentIdOf(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
  return "sha256:" + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}
