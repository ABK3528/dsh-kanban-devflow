// dsh-kanban-devflow: multi-label helpers.
//
// Labels may be scoped as "group::name" (GitLab style). Within one scope a card carries at most one label.
// The groups in SYSTEM_GROUPS are maintained by the dev-delivery sync bridge, so the picker shows them read-only —
// except WAITING_LABEL, which a person removes to let the workflow continue.
import type { Card, Label } from "./types"

export const SYSTEM_GROUPS = ["状态", "原因", "标记", "结果"]
export const WAITING_LABEL = "状态::待人工确认"

/** Every label on a card; falls back to the single `label` from older boards and hosts. */
export function cardLabels(card: Pick<Card, "label" | "labels"> | null | undefined): string[] {
  if (!card) return []
  if (Array.isArray(card.labels)) return card.labels
  return card.label ? [card.label] : []
}

/** "group::name" → "group" (empty when unscoped). */
export function labelScope(name: string): string {
  const i = name.indexOf("::")
  return i > 0 ? name.slice(0, i) : ""
}

/** "group::name" → "name". */
export function shortLabel(name: string): string {
  const i = name.indexOf("::")
  return i > 0 ? name.slice(i + 2) : name
}

export function isSystemLabel(name: string): boolean {
  return SYSTEM_GROUPS.includes(labelScope(name))
}

/** Whether a person may take this label off a card. */
export function canRemoveLabel(name: string): boolean {
  return !isSystemLabel(name) || name === WAITING_LABEL
}

/** Whether the picker refuses to toggle this label (given whether the card has it). */
export function isLabelLocked(name: string, selected: boolean): boolean {
  return isSystemLabel(name) && !(selected && name === WAITING_LABEL)
}

/** Toggle one label; picking a scoped label replaces any other label of the same scope. */
export function toggleLabel(selected: string[], name: string): string[] {
  if (selected.includes(name)) return selected.filter((n) => n !== name)
  const scope = labelScope(name)
  return [...selected.filter((n) => !scope || labelScope(n) !== scope), name]
}

export type LabelRow = { header: string } | Label

/** Group labels by scope, keeping first-seen order; unscoped labels get no header. */
export function groupLabels(labels: Label[]): LabelRow[] {
  const order: string[] = []
  const byScope = new Map<string, Label[]>()
  for (const label of labels) {
    const scope = labelScope(label.name)
    if (!byScope.has(scope)) { byScope.set(scope, []); order.push(scope) }
    byScope.get(scope)!.push(label)
  }
  return order.flatMap((scope) => [...(scope ? [{ header: scope }] : []), ...byScope.get(scope)!])
}

/** Label filter: "" means unlabeled; otherwise any of the card's labels may match. */
export function matchesLabelFilter(card: Pick<Card, "label" | "labels">, filter: string): boolean {
  const own = cardLabels(card)
  return own.length ? own.includes(filter) : filter === ""
}

export function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}
