// dsh-kanban-devflow: multi-select label picker with scoped ("group::name") labels.
import { useEffect, useRef, useState, type CSSProperties } from "react"
import { useT } from "@/lib/i18n"
import { FALLBACK_LABEL_COLOR } from "@/lib/constants"
import {
  canRemoveLabel, groupLabels, isLabelLocked, isSystemLabel, labelScope, shortLabel, toggleLabel,
} from "@/lib/labels"
import type { Label } from "@/lib/types"

/** Label text with a dimmed "group" prefix for scoped labels. */
export function LabelText({ name }: { name: string }) {
  const scope = labelScope(name)
  if (!scope) return <>{name}</>
  return <><span className="kanban-label-scope">{scope}</span>{shortLabel(name)}</>
}

const colorVar = (color: string | undefined) => ({ "--klp-color": color ?? FALLBACK_LABEL_COLOR }) as CSSProperties

interface LabelPickerProps {
  id?: string
  labels: Label[]
  value: string[]
  disabled?: boolean
  ariaLabel?: string
  onChange: (next: string[]) => void
}

export function LabelPicker({ id, labels, value, disabled = false, ariaLabel, onChange }: LabelPickerProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      // Close the menu only; keep the drawer open.
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  const colorOf = (name: string) => labels.find((l) => l.name === name)?.color
  const needle = query.trim().toLowerCase()
  const shown = labels.filter((l) => !needle || l.name.toLowerCase().includes(needle))

  return (
    <div ref={ref} className="klp">
      <button id={id} type="button" className="klp-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        disabled={disabled} onClick={() => { setOpen(!open); setQuery("") }}>
        {value.length ? value.map((name) => (
          <span key={name} className="klp-chip" style={colorVar(colorOf(name))} title={name}>
            <span className="klp-dot" aria-hidden="true" />
            <LabelText name={name} />
            {!disabled && canRemoveLabel(name) && (
              <span role="button" tabIndex={-1} className="klp-chip-x" aria-label={t("removeLabel").replace("{label}", name)} title={t("remove")}
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(value.filter((n) => n !== name)) }}>✕</span>
            )}
          </span>
        )) : <span className="klp-placeholder">{t("chooseLabels")}</span>}
        <span className="klp-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="klp-menu" role="listbox" aria-multiselectable="true" aria-label={ariaLabel}>
          <input autoFocus className="klp-search" placeholder={t("searchLabels")} aria-label={t("searchLabels")} value={query}
            onChange={(e) => setQuery(e.target.value)} />
          {shown.length ? groupLabels(shown).map((row) => {
            if ("header" in row) return <div key={"g-" + row.header} className="klp-group">{row.header}</div>
            const selected = value.includes(row.name)
            const locked = isLabelLocked(row.name, selected)
            return (
              <div key={row.name} role="option" aria-selected={selected} aria-disabled={locked} className="klp-option" title={row.name}
                style={colorVar(row.color)}
                onClick={() => { if (!locked) onChange(toggleLabel(value, row.name)) }}>
                <span className="klp-check" aria-hidden="true">✓</span>
                <span className="klp-dot" aria-hidden="true" />
                <span>{shortLabel(row.name)}</span>
                {isSystemLabel(row.name) && <span className="klp-note">{t(locked ? "labelAuto" : "labelRemovable")}</span>}
              </div>
            )
          }) : <div className="klp-empty">{t("noMatchingLabels")}</div>}
        </div>
      )}
    </div>
  )
}
