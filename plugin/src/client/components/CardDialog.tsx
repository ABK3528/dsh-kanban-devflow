import { useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { Check, MessageSquare, Pencil, Trash2 } from "lucide-react"
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { DrawerContent } from "@/components/ui/drawer"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { PRIORITY_OPTIONS, PRIORITY_META } from "@/lib/constants"
import { localDate } from "@/lib/due-date"
import { formatTime } from "@/lib/activity"
import { attachmentIdOf, commentImageMarkdown } from "@/lib/comments"
import { cardLabels, sameLabels } from "@/lib/labels"
import { useT } from "@/lib/i18n"
import type { Activity, Card, Comment, ImageLimits, ImageRef, KanbanResponse, Label as LabelType, Priority } from "@/lib/types"
import { CardImages, type CardImagesHandle } from "./CardImages"
import { CommentComposer, CommentItem, type PendingCommentImage } from "./CardComments"
import { LabelPicker } from "./LabelPicker"

export interface CardFormValues {
  id?: string
  title: string
  note: string
  labels: string[]
  priority: Priority | ""
  dueDate: string
}

// dsh-kanban-devflow: existing cards save automatically. Text fields wait for a pause in typing; the rest save at once.
const FORM_FIELDS = ["title", "note", "labels", "priority", "dueDate"] as const
type FormField = typeof FORM_FIELDS[number]
const QUICK_FIELDS: FormField[] = ["labels", "priority", "dueDate"]
const TEXT_SAVE_DELAY = 800
const COMMENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"]
type SaveStatus = "" | "saving" | "saved" | "error" | "notitle" | "invalid"

function sameField(a: CardFormValues[FormField], b: CardFormValues[FormField]): boolean {
  return Array.isArray(a) && Array.isArray(b) ? sameLabels(a, b) : a === b
}

/** Form fields of a card as shown on the board right now. */
function formOf(card: Card | null | undefined): Pick<CardFormValues, FormField> | null {
  return card ? { title: card.title ?? "", note: card.note ?? "", labels: cardLabels(card).slice(), priority: card.priority ?? "", dueDate: card.dueDate ?? "" } : null
}

type SaveResult = boolean | void | { cardId: string }

interface CardDialogProps {
  workspaceId?: string
  imageLimits?: ImageLimits | null
  images?: ImageRef[]
  onUploadImage?: (cardId: string, file: File, signal: AbortSignal) => Promise<KanbanResponse | void>
  onRemoveImage?: (cardId: string, attachmentId: string) => Promise<boolean>
  open: boolean
  error?: string | null
  card: Card | null
  /** The same card as currently on the board (follows sync-bridge and agent edits while the dialog is open). */
  liveCard?: Card | null
  completed: boolean
  completedAt: string | null
  labels: LabelType[]
  comments: Comment[]
  activities: Activity[]
  onOpenChange: (open: boolean) => void
  onSave: (values: CardFormValues) => SaveResult | Promise<SaveResult>
  onAddComment: (cardId: string, content: string) => boolean | void | Promise<boolean | void>
  onDelete?: (card: Card) => boolean | void | Promise<boolean | void>
  onChatWithAgent: (values: CardFormValues) => boolean | void | Promise<boolean | void>
}

export function CardDialog({ workspaceId = "default", imageLimits = null, images = [], onUploadImage, onRemoveImage, open, error, card, liveCard = null, completed, completedAt, labels, comments, onOpenChange, onSave, onAddComment, onDelete, onChatWithAgent }: CardDialogProps) {
  const t = useT()
  const formId = useId()
  const dueDateRef = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const [editingNote, setEditingNote] = useState(!card)
  const [values, setValues] = useState<CardFormValues>({
    id: "", title: "", note: "", labels: [], priority: "", dueDate: "",
  })
  const [comment, setComment] = useState("")
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [failure, setFailure] = useState("")
  const [confirm, setConfirm] = useState<"discard" | "delete" | "chat" | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const initialValues = useRef(values)
  const imagesRef = useRef<CardImagesHandle>(null)
  const [imagesBusy, setImagesBusy] = useState(false)
  const [hasPendingImages, setHasPendingImages] = useState(false)
  const [imageDraftKey, setImageDraftKey] = useState(0)
  const previousCardId = useRef<string | undefined>(undefined)
  const creatingCard = useRef(false)
  const createdCardId = useRef<string | undefined>(undefined)
  const locked = pending || imagesBusy
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  // Reset before the newly visible form can accept files or text.
  useLayoutEffect(() => {
    const previousId = previousCardId.current
    previousCardId.current = open ? card?.id ?? "" : undefined
    // Saving a new card changes its identity while uploads still belong to this draft.
    if (previousId === "" && card && (creatingCard.current || createdCardId.current === card.id)) return
    if (open) {
      const next: CardFormValues = {
        id: card?.id ?? "",
        title: card?.title ?? "",
        note: card?.note ?? "",
        labels: cardLabels(card).slice(),
        priority: card?.priority ?? "",
        dueDate: card?.dueDate ?? "",
      }
      initialValues.current = next
      setValues(next)
      setComment("")
      setFailure("")
      setConfirm(null)
      setHasPendingImages(false)
      setImagesBusy(false)
      setImageDraftKey((key) => key + 1)
      createdCardId.current = undefined
      setEditingNote(!card)
    }
  }, [open, card?.id])

  useEffect(() => { if (confirm) cancelRef.current?.focus() }, [confirm])

  // ---- dsh-kanban-devflow: autosave, live-card sync, comment images ----
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("")
  const [commentImages, setCommentImages] = useState<PendingCommentImage[]>([])
  const latest = useRef({ values, card, liveCard, commentImages, onSave, onRemoveImage })
  latest.current = { values, card, liveCard, commentImages, onSave, onRemoveImage }
  const saveChain = useRef<Promise<boolean>>(Promise.resolve(true))
  const previousValues = useRef(values)
  const uploadAbort = useRef<AbortController | null>(null)
  const fieldsDirty = (v: CardFormValues) => FORM_FIELDS.some((key) => !sameField(v[key], initialValues.current[key]))

  /** Save the fields the user changed. Untouched fields take the board's latest value so a bridge edit is not overwritten. */
  const flushSave = (): Promise<boolean> => {
    saveChain.current = saveChain.current.then(async () => {
      const { values: current, card: snapshot, liveCard: live, onSave: save } = latest.current
      if (!snapshot || !fieldsDirty(current)) return true
      if (!current.title.trim()) { if (alive.current) setSaveStatus("notitle"); return false }
      // An out-of-range date stays in the form for the user to fix; it is never sent.
      if (dueDateRef.current && !dueDateRef.current.checkValidity()) { if (alive.current) setSaveStatus("invalid"); return false }
      if (alive.current) setSaveStatus("saving")
      const board = formOf(live && live.id === snapshot.id ? live : null)
      const out: CardFormValues = { ...current }
      if (board) for (const key of FORM_FIELDS) {
        if (sameField(current[key], initialValues.current[key])) (out as any)[key] = board[key]
      }
      try {
        if (await save(out) === false) { if (alive.current) setSaveStatus("error"); return false }
        const base = { ...initialValues.current }
        for (const key of FORM_FIELDS) if (!sameField(current[key], base[key])) (base as any)[key] = current[key]
        initialValues.current = base
        if (alive.current) setSaveStatus(fieldsDirty(latest.current.values) ? "saving" : "saved")
        return true
      } catch (cause) {
        if (alive.current) {
          setSaveStatus("error")
          setFailure(t("actionFailed") + String(cause instanceof Error ? cause.message : cause))
        }
        return false
      }
    })
    return saveChain.current
  }

  useEffect(() => {
    const previous = previousValues.current
    previousValues.current = values
    if (!open || !card || confirm || !fieldsDirty(values)) return
    const quick = QUICK_FIELDS.some((key) => !sameField(previous[key], values[key]))
    const timer = setTimeout(() => { void flushSave() }, quick ? 0 : TEXT_SAVE_DELAY)
    return () => clearTimeout(timer)
  }, [values, open, card?.id, confirm])
  useEffect(() => { setSaveStatus("") }, [open, card?.id])

  // The card changed elsewhere (sync bridge wrote the description, an agent changed labels…): follow fields the user has not touched.
  useEffect(() => {
    const board = formOf(liveCard)
    if (!open || !card || !board || liveCard!.id !== card.id) return
    const current = latest.current.values
    const base = initialValues.current
    const changed: Partial<CardFormValues> = {}
    for (const key of FORM_FIELDS) {
      if (!sameField(board[key], base[key]) && sameField(current[key], base[key])) (changed as any)[key] = board[key]
    }
    if (!Object.keys(changed).length) return
    initialValues.current = { ...base, ...changed }
    setValues((v) => {
      const next = { ...v }
      for (const key of Object.keys(changed) as FormField[]) if (sameField(v[key], current[key])) (next as any)[key] = changed[key]
      return next
    })
  }, [liveCard, open, card?.id])

  // Comment images upload as card images; the comment links them as Markdown images when sent.
  const removeCardImage = (cardId: string, attachmentId: string) =>
    latest.current.onRemoveImage ? latest.current.onRemoveImage(cardId, attachmentId) : Promise.resolve(false)
  const addCommentImages = async (files: File[]) => {
    if (!card || !onUploadImage) return
    const cardId = card.id
    const controller = uploadAbort.current ??= new AbortController()
    for (const file of files) {
      if (!COMMENT_IMAGE_TYPES.includes(file.type)) { setFailure(t("commentImageType")); continue }
      const key = Math.random().toString(36).slice(2)
      const url = URL.createObjectURL(file)
      setCommentImages((list) => [...list, { key, url, cardId, status: "up" }])
      try {
        const attachmentId = await attachmentIdOf(file)
        const live = latest.current.liveCard
        const existed = (live && live.id === cardId ? live.images ?? [] : images).some((image) => image.attachmentId === attachmentId)
        const res = await onUploadImage(cardId, file, controller.signal)
        const saved = res?.board?.cards?.find((c) => c.id === cardId)?.images
        if (saved && !saved.some((image) => image.attachmentId === attachmentId)) throw new Error(t("commentImageNotSaved"))
        setCommentImages((list) => list.map((p) => p.key === key ? { ...p, status: "ok", attachmentId, existed } : p))
      } catch (cause) {
        setCommentImages((list) => list.map((p) => p.key === key
          ? { ...p, status: "err", error: String(cause instanceof Error ? cause.message : cause) } : p))
      }
    }
  }
  const removeCommentImage = (key: string) => {
    const item = commentImages.find((p) => p.key === key)
    if (!item) return
    URL.revokeObjectURL(item.url)
    setCommentImages((list) => list.filter((p) => p.key !== key))
    // Keep the card image while another pending thumbnail still uses it, or when the card had it before.
    if (item.attachmentId && !item.existed && !commentImages.some((p) => p.key !== key && p.attachmentId === item.attachmentId)) {
      void removeCardImage(item.cardId, item.attachmentId)
    }
  }
  // Closing or switching cards drops unsent comment images from the card (images it already had stay).
  useEffect(() => () => {
    uploadAbort.current?.abort()
    uploadAbort.current = null
    const removed = new Set<string>()
    for (const p of latest.current.commentImages) {
      URL.revokeObjectURL(p.url)
      if (p.attachmentId && !p.existed && !removed.has(p.attachmentId)) {
        removed.add(p.attachmentId)
        void removeCardImage(p.cardId, p.attachmentId)
      }
    }
    setCommentImages([])
  }, [open, card?.id])

  const dirty = hasPendingImages || commentImages.length > 0 || Boolean(comment.trim()) || fieldsDirty(values)
  const changeOpen = (next: boolean) => {
    if (pendingRef.current || imagesBusy) return
    if (!next && confirm) { setConfirm(null); return }
    if (!next && dirty) {
      if (card) {
        // Existing card: save edits first; only an unsent comment or images still need confirmation.
        void flushSave().then((ok) => {
          if (ok && !hasPendingImages && !latest.current.commentImages.length && !comment.trim()) onOpenChange(false)
          else if (alive.current) setConfirm("discard")
        })
        return
      }
      setConfirm("discard")
      return
    }
    onOpenChange(next)
  }
  const run = async (action: () => boolean | void | Promise<boolean | void>) => {
    if (pendingRef.current || imagesBusy) return false
    pendingRef.current = true
    setPending(true)
    setFailure("")
    try {
      const ok = await action()
      if (ok === false) setFailure(t("actionRetry"))
      return ok !== false
    } catch (cause) {
      setFailure(t("actionFailed") + String(cause instanceof Error ? cause.message : cause))
      return false
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  const chat = async () => {
    if (!dueDateRef.current?.reportValidity()) return
    if (comment.trim() || hasPendingImages) { setConfirm("chat"); return }
    if (await run(() => onChatWithAgent(values))) onOpenChange(false)
  }
  const set = (patch: Partial<CardFormValues>) => setValues((v) => ({ ...v, ...patch }))
  const submitComment = async () => {
    const text = comment.trim()
    const ready = commentImages.filter((p) => p.status === "ok" && p.attachmentId)
    if (!card || (!text && !ready.length) || commentImages.some((p) => p.status === "up")) return
    const gallery = commentImageMarkdown(workspaceId, card.id, ready.map((p) => p.attachmentId!), t("commentImageAlt"))
    const body = text ? (gallery ? text + "\n\n" + gallery : text) : gallery
    if (body.length > 2000) { setFailure(t("commentTooLong")); return }
    if (await run(() => onAddComment(card.id, body))) {
      setComment("")
      commentImages.forEach((p) => URL.revokeObjectURL(p.url))
      setCommentImages([])
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DrawerContent open={open} onClose={() => changeOpen(false)} title={t(card ? "taskDetails" : "addCard")}
        aria-describedby={undefined}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files)
          if (files.length && imageLimits && !locked && !confirm) {
            event.preventDefault()
            imagesRef.current?.addFiles(files)
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{card ? t("taskDetails") : t("addCard")}</DialogTitle>
          {card && <span className="kanban-field-id">{t("fieldId")}: {card.id}</span>}
        </DialogHeader>
        <DialogBody className="kanban-form-stack">
          {(error || failure) && <p className="kanban-dialog-error" role="alert">{error || failure}</p>}
          <div className="kanban-form-field">
            <Label htmlFor={`${formId}-title`} className="kanban-field-label">
              {t("fieldTitle")}
            </Label>
            <Input
              data-modal-autofocus
              id={`${formId}-title`}
              value={values.title}
              placeholder={t("titlePlaceholder")}
              maxLength={120}
              disabled={locked || Boolean(confirm)}
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>
          <div className="kanban-form-row">
            <div className="kanban-form-field">
              <Label htmlFor={`${formId}-label`}>{t("fieldLabel")}</Label>
              <LabelPicker id={`${formId}-label`} labels={labels} value={values.labels} ariaLabel={t("fieldLabel")}
                disabled={locked || Boolean(confirm)} onChange={(next) => set({ labels: next })} />
            </div>
            <div className="kanban-form-field">
              <Label htmlFor={`${formId}-priority`}>{t("fieldPriority")}</Label>
              <Select disabled={locked || Boolean(confirm)} value={values.priority || "__none__"} onValueChange={(v) => set({ priority: v === "__none__" ? "" : (v as Priority) })}>
                <SelectTrigger id={`${formId}-priority`}>
                  <SelectValue placeholder={t("noPriority")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t("noPriority")}</SelectItem>
                  {PRIORITY_OPTIONS.map((p) => {
                    const meta = PRIORITY_META[p]
                    return (
                      <SelectItem key={p} value={p}>
                        <span className="kanban-inline-priority">
                          <span className="kanban-priority-dot" style={{ background: meta.color }} />
                          {meta.label}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className={card ? "kanban-form-row kanban-date-fields" : undefined}>
            <div className="kanban-form-field">
              <Label htmlFor={`${formId}-due-date`}>{t("fieldDueDate")}</Label>
              <div className="kanban-due-date-controls">
                <Input ref={dueDateRef} id={`${formId}-due-date`} type="date" min="0001-01-01" max="9999-12-31"
                  value={values.dueDate} disabled={locked || Boolean(confirm)}
                  onChange={(e) => set({ dueDate: e.target.value })} />
                <div className="kanban-date-shortcuts">
                  {([["today", 0], ["tomorrow", 1], ["nextWeek", 7]] as const).map(([key, offset]) => (
                    <Button key={key} type="button" variant="ghost" size="sm" disabled={locked || Boolean(confirm)}
                      onClick={() => set({ dueDate: localDate(new Date(), offset) })}>{t(key)}</Button>
                  ))}
                  <Button type="button" variant="ghost" size="sm" disabled={locked || Boolean(confirm) || !values.dueDate}
                    onClick={() => set({ dueDate: "" })}>{t("clearDate")}</Button>
                </div>
              </div>
            </div>
            {card && <div className="kanban-form-field">
              <Label htmlFor={`${formId}-completed-date`}>{t("fieldCompletedDate")}</Label>
              <output id={`${formId}-completed-date`} className="kanban-completed-date"
                aria-describedby={completed && !completedAt ? `${formId}-completed-date-hint` : undefined}>
                {!completed ? "—" : completedAt
                  ? <time dateTime={completedAt}>{formatTime(completedAt)}</time>
                  : t("completedDateUnknown")}
              </output>
              {completed && !completedAt &&
                <p id={`${formId}-completed-date-hint`} className="kanban-muted-small">{t("completedDateUnknownHint")}</p>}
            </div>}
          </div>
          <div className="kanban-form-field">
            <div className="kanban-field-label">
              <Label id={`${formId}-note-label`} htmlFor={editingNote ? `${formId}-note` : undefined}>{t("fieldNote")}</Label>
              <Button
                variant="ghost"
                size="sm"
                disabled={locked || Boolean(confirm)}
                aria-controls={`${formId}-description`}
                onClick={() => {
                  setEditingNote(!editingNote)
                  if (!editingNote) requestAnimationFrame(() => noteRef.current?.focus())
                }}
              >
                {editingNote ? <Check /> : <Pencil />}
                {t(editingNote ? "finishEditingNote" : "editNote")}
              </Button>
            </div>
            <div id={`${formId}-description`}>
              {editingNote ? <>
                <Textarea
                  ref={noteRef}
                  id={`${formId}-note`}
                  className="kanban-markdown-source"
                  value={values.note}
                  placeholder={t("notePlaceholder")}
                  rows={12}
                  maxLength={2000}
                  disabled={locked || Boolean(confirm)}
                  onChange={(e) => set({ note: e.target.value })}
                />
                <p className="kanban-note-hint">{t("markdownEditHint")} <span className="kanban-tabular">{values.note.length}/2000</span></p>
              </> : (
                <div className="kanban-markdown-preview" role="region" aria-labelledby={`${formId}-note-label`}>
                  {values.note.trim() ? <MarkdownText
                    text={values.note}
                    labels={{ code: { copyLabel: t("copyCode"), copiedLabel: t("copiedCode") }, footnotes: t("footnotes") }}
                  /> : <p className="kanban-muted-small">{t("emptyNote")}</p>}
                </div>
              )}
            </div>
          </div>
          <CardImages key={imageDraftKey} ref={imagesRef} workspaceId={workspaceId} cardId={values.id || card?.id} images={images} limits={imageLimits}
            disabled={locked || Boolean(confirm)}
            onUpload={onUploadImage ?? (async () => { throw new Error(t("imagesUnavailable")) })}
            onRemove={onRemoveImage ?? (async () => false)}
            onBusyChange={setImagesBusy} onPendingChange={(hasPending) => {
              setHasPendingImages(hasPending)
              if (!hasPending) setFailure((current) => current === t("imageUploadPartial") ? "" : current)
            }} />
          {card && (
            <div className="kanban-comments-box">
              <Label htmlFor={`${formId}-comment`}>
                {t("commentsTitle")} <span className="kanban-tabular">({comments.length})</span>
              </Label>
              <div className="kanban-comments-scroll" aria-live="polite">
                {comments.length === 0 ? (
                  <p className="kanban-muted-small">{t("commentEmpty")}</p>
                ) : (
                  <ol className="kanban-comment-list">
                    {comments.map((item, index) => <CommentItem key={item.id} comments={comments} index={index} />)}
                  </ol>
                )}
              </div>
              <CommentComposer id={`${formId}-comment`} value={comment} placeholder={t("commentPlaceholder")}
                disabled={locked || Boolean(confirm)} canUpload={Boolean(onUploadImage)} pending={commentImages}
                onChange={setComment} onFiles={(files) => void addCommentImages(files)} onRemove={removeCommentImage}
                onSend={() => void submitComment()} />
            </div>
          )}
          {/* Activity box hidden in dsh-kanban-devflow: activities are still recorded (the sync bridge reads them). */}
        </DialogBody>
        <DialogFooter>
          {confirm ? (
            <div className="kanban-dialog-confirm">
              <p role="alert">{t(confirm === "discard" ? "discardChangesDesc" : confirm === "delete" ? "deleteCardDesc" : hasPendingImages ? "discardImagesDesc" : "discardCommentDesc")}</p>
              <div className="kanban-confirm-actions">
                <Button ref={cancelRef} variant="outline" disabled={locked} onClick={() => setConfirm(null)}>{t("cancel")}</Button>
                <Button variant="destructive" disabled={locked} onClick={async () => {
                  if (confirm === "discard") { onOpenChange(false); return }
                  if (confirm === "delete") {
                    if (card && onDelete && await run(() => onDelete(card))) onOpenChange(false)
                    return
                  }
                  if (await run(() => onChatWithAgent(values))) onOpenChange(false)
                }}>{t(confirm === "discard" ? "discardChanges" : confirm === "delete" ? "confirmDelete" : "discardAndContinue")}</Button>
              </div>
            </div>
          ) : <>
            {card && saveStatus && (
              <span className="kanban-muted-small kanban-autosave-status" role="status">
                {t({ saving: "autosaving", saved: "autosaved", error: "autosaveFailed", notitle: "autosaveNoTitle", invalid: "autosaveInvalid" }[saveStatus])}
              </span>
            )}
            {card && onDelete && (
              <Button
                variant="ghost"
                className="kanban-dialog-delete"
                disabled={locked}
                onClick={() => setConfirm("delete")}
              >
                <Trash2 className="kanban-icon" />
                {t("delete")}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={locked || (!values.title.trim() && !values.note.trim())}
              onClick={() => void chat()}
            >
              <MessageSquare className="kanban-icon" />
              {t("chatWithAgent")}
            </Button>
            {!card && <Button
              disabled={locked || !values.title.trim()}
              onClick={async () => {
                if (!dueDateRef.current?.reportValidity()) return
                await run(async () => {
                  creatingCard.current = !values.id
                  let result: SaveResult
                  try {
                    result = await onSave(values)
                    if (creatingCard.current && typeof result === "object") createdCardId.current = result.cardId
                  } finally {
                    creatingCard.current = false
                  }
                  if (!alive.current || result === false) return false
                  const next = { ...values, ...(typeof result === "object" ? { id: result.cardId } : {}) }
                  setValues(next)
                  initialValues.current = next
                  if (hasPendingImages) {
                    if (!next.id || !await imagesRef.current?.uploadPending(next.id)) {
                      if (alive.current) setFailure(t("imageUploadPartial"))
                      return
                    }
                  }
                  if (alive.current && !comment.trim()) onOpenChange(false)
                })
              }}
            >
              {t("save")}
            </Button>}
          </>}
        </DialogFooter>
      </DrawerContent>
    </Dialog>
  )
}
