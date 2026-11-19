// dsh-kanban-devflow: GitLab-style comment timeline (CommentItem) and composer with image paste/drop (CommentComposer).
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import { Send } from "lucide-react"
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { formatTime } from "@/lib/activity"
import { absolutizeFileLinks, artifactDisplayPath, commentRole, parseComment, relativeTime, tagTone, type CommentRole } from "@/lib/comments"
import { useT } from "@/lib/i18n"
import type { Comment } from "@/lib/types"

const ROLE_KEYS: Record<Exclude<CommentRole, "">, { name: string; avatar: string; badge: string }> = {
  discuss: { name: "roleDiscuss", avatar: "avatarDiscuss", badge: "" },
  build: { name: "roleBuild", avatar: "avatarBuild", badge: "" },
  test: { name: "roleTest", avatar: "avatarTest", badge: "" },
  release: { name: "roleRelease", avatar: "avatarRelease", badge: "" },
  bridge: { name: "roleBridge", avatar: "avatarBridge", badge: "badgeSystem" },
}

interface ArtifactDoc { name: string; path: string; text: string | null; error?: string }

export function CommentItem({ comments, index }: { comments: readonly Comment[]; index: number }) {
  const t = useT()
  const comment = comments[index]
  const agent = comment.source === "agent"
  const role = agent ? commentRole(comments, index) : ""
  const roleKeys = role ? ROLE_KEYS[role] : null
  const [zoom, setZoom] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [doc, setDoc] = useState<ArtifactDoc | null>(null)
  const mdLabels = { code: { copyLabel: t("copyCode"), copiedLabel: t("copiedCode") }, footnotes: t("footnotes") }

  useEffect(() => {
    if (!zoom && !doc) return
    // Capture phase: Esc closes the preview, not the card drawer.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setZoom(null); setDoc(null) } }
    document.addEventListener("keydown", onKey, true)
    return () => document.removeEventListener("keydown", onKey, true)
  }, [zoom, doc])

  // Artifact links written by the sync bridge (/api/file?path=…) open in an in-card preview instead of navigating away.
  const openArtifact = (e: ReactMouseEvent) => {
    const anchor = (e.target as Element | null)?.closest?.("a[href]")
    let url: URL | null = null
    try { url = anchor ? new URL(anchor.getAttribute("href") ?? "", location.href) : null } catch { url = null }
    if (!anchor || !url || url.href.split("?")[0] !== new URL("/api/file", location.href).href) return
    e.preventDefault()
    e.stopPropagation()
    const path = url.searchParams.get("path") ?? ""
    setDoc({ name: anchor.textContent || path.split("/").pop() || path, path, text: null })
    const update = (patch: Partial<ArtifactDoc>) => setDoc((d) => (d && d.path === path ? { ...d, ...patch } : d))
    fetch(url.href, { credentials: "same-origin" })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text() })
      .then((text) => update({ text }))
      .catch(() => update({ error: t("fileUnavailable") }))
  }

  const copy = () => {
    void navigator.clipboard?.writeText(String(comment.content ?? "")).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }).catch(() => {})
  }

  const { tags, segments } = parseComment(comment.content)
  const actorClass = (agent ? "is-agent" : "is-human") + (role ? " is-" + role : "")
  return (
    <li className="kanban-comment-item kcm">
      <div className={"kcm-avatar " + actorClass} aria-hidden="true">
        {roleKeys ? t(roleKeys.avatar) : agent ? "AI" : t("commentHumanAvatar")}
      </div>
      <div className="kcm-bubble">
        <div className="kcm-head">
          <span className="kcm-name">{roleKeys ? t(roleKeys.name) : agent ? t("commentAgentName") : t("commentHumanName")}</span>
          <time className="kcm-time" dateTime={comment.createdAt} title={formatTime(comment.createdAt)}>{relativeTime(comment.createdAt, t)}</time>
          {tags.length > 0 && <span className="kcm-tags">{tags.map((tag, i) => (
            <span key={i} className={["kcm-tag", i === 0 ? "is-stage" : "", tagTone(tag)].filter(Boolean).join(" ")}>{tag}</span>
          ))}</span>}
          <span className="kcm-actions">
            <span className={"kcm-role " + actorClass}>
              {roleKeys ? (roleKeys.badge ? t(roleKeys.badge) : role) : agent ? t("commentAgentBadge") : t("commentHumanBadge")}
            </span>
            <button type="button" className="kcm-btn" title={t("copyComment")} aria-label={t("copyComment")} onClick={copy}>{copied ? "✓" : "⧉"}</button>
          </span>
        </div>
        <div className="kcm-body" onClickCapture={openArtifact}>
          {segments.length ? segments.map((segment, i) => "images" in segment ? (
            <div key={i} className="kcm-gallery">
              {segment.images.map((image, j) => (
                <img key={j} src={image.src} alt={image.alt} loading="lazy" title={t("clickToZoom")} onClick={() => setZoom(image.src)} />
              ))}
            </div>
          ) : (
            <div key={i} className="kanban-comment-content">
              <MarkdownText text={absolutizeFileLinks(segment.markdown, location.href)} variant="compact" labels={mdLabels} />
            </div>
          )) : <div className="kanban-comment-content kcm-empty">{tags.join(" · ")}</div>}
        </div>
      </div>
      {zoom && (
        <div className="kcm-lightbox" role="dialog" onClick={(e) => { e.stopPropagation(); setZoom(null) }}>
          <img src={zoom} alt="" />
        </div>
      )}
      {doc && (
        <div className="kcm-doc-mask" role="dialog" aria-label={doc.name}
          onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setDoc(null) }}>
          <div className="kcm-doc">
            <div className="kcm-doc-head">
              <strong>{doc.name}</strong>
              <span className="kcm-doc-path" title={doc.path}>{artifactDisplayPath(doc.path)}</span>
              <button type="button" className="kcm-btn" title={t("closeEsc")} aria-label={t("closeEsc")} onClick={() => setDoc(null)}>✕</button>
            </div>
            <div className="kcm-doc-body kanban-comment-content">
              {doc.error ? <p role="alert">{doc.error}</p>
                : doc.text == null ? <p>{t("loading")}</p>
                : /\.(md|markdown)$/i.test(doc.path) ? <MarkdownText text={doc.text.replace(/<!--[\s\S]*?-->[ \t]*\n?/g, "")} labels={mdLabels} />
                : <pre>{doc.text}</pre>}
            </div>
          </div>
        </div>
      )}
    </li>
  )
}

export interface PendingCommentImage {
  key: string
  url: string
  cardId: string
  status: "up" | "ok" | "err"
  attachmentId?: string
  /** The card already had this image before the comment upload, so discarding must not remove it. */
  existed?: boolean
  error?: string
}

interface CommentComposerProps {
  id: string
  value: string
  placeholder: string
  disabled: boolean
  canUpload: boolean
  pending: PendingCommentImage[]
  onChange: (value: string) => void
  onFiles: (files: File[]) => void
  onRemove: (key: string) => void
  onSend: () => void
}

const pickImages = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => f && /^image\//.test(f.type))

export function CommentComposer({ id, value, placeholder, disabled, canUpload, pending, onChange, onFiles, onRemove, onSend }: CommentComposerProps) {
  const t = useT()
  const [drag, setDrag] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploading = pending.some((p) => p.status === "up")
  const ready = pending.some((p) => p.status === "ok")
  const canSend = !disabled && !uploading && (Boolean(value.trim()) || ready)
  const allowFiles = canUpload && !disabled
  return (
    <div className={"kcc" + (drag ? " is-drag" : "")}
      onDragOver={(e) => { if (allowFiles && Array.from(e.dataTransfer.types ?? []).includes("Files")) { e.preventDefault(); setDrag(true) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false) }}
      onDrop={(e) => {
        setDrag(false)
        const files = pickImages(e.dataTransfer.files)
        if (files.length && allowFiles) { e.preventDefault(); e.stopPropagation(); onFiles(files) }
      }}>
      <Textarea id={id} value={value} placeholder={placeholder} rows={3} maxLength={2000} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (canSend) onSend() } }}
        // Images pasted here belong to the comment; stop the drawer's paste handler from adding them as card images.
        onPaste={(e) => {
          const files = pickImages(e.clipboardData?.files)
          if (files.length && allowFiles) { e.preventDefault(); e.stopPropagation(); onFiles(files) }
        }} />
      {pending.length > 0 && (
        <div className="kcc-thumbs">
          {pending.map((p) => (
            <div key={p.key} className={"kcc-thumb is-" + p.status} title={p.error ?? ""}>
              <img src={p.url} alt="" />
              {p.status !== "ok" && <span className="kcc-thumb-st">{t(p.status === "up" ? "uploading" : "uploadFailed")}</span>}
              <button type="button" className="kcc-thumb-x" aria-label={t("removeImage")} title={t("remove")} onClick={() => onRemove(p.key)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="kcc-bar">
        {canUpload && <button type="button" className="kcm-btn" disabled={disabled} title={t("insertImageHint")}
          onClick={() => fileRef.current?.click()}>{t("insertImage")}</button>}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden
          onChange={(e) => { const files = pickImages(e.target.files); e.target.value = ""; if (files.length) onFiles(files) }} />
        <span className="kcc-hint">{t("commentHint")}</span>
        <Button type="button" variant="outline" disabled={!canSend} onClick={() => onSend()}>
          <Send className="kanban-icon" />
          {t("sendComment")}
        </Button>
      </div>
    </div>
  )
}
