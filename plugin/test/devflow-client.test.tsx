import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { CommentItem } from "../src/client/components/CardComments"
import { LabelPicker } from "../src/client/components/LabelPicker"
import {
  absolutizeFileLinks, artifactDisplayPath, attachmentIdOf, commentImageMarkdown, commentRole, parseComment, relativeTime, tagTone,
} from "../src/client/lib/comments"
import { t } from "../src/client/lib/i18n"
import {
  canRemoveLabel, cardLabels, groupLabels, isLabelLocked, labelScope, matchesLabelFilter, sameLabels, shortLabel, toggleLabel, WAITING_LABEL,
} from "../src/client/lib/labels"
import type { Comment, Label } from "../src/client/lib/types"

describe("devflow label helpers", () => {
  it("reads labels from new and legacy cards", () => {
    expect(cardLabels({ label: "a", labels: ["a", "b"] })).toEqual(["a", "b"])
    expect(cardLabels({ label: "a" })).toEqual(["a"])
    expect(cardLabels({ label: null })).toEqual([])
    expect(cardLabels(null)).toEqual([])
  })

  it("splits scoped names and keeps one label per scope when toggling", () => {
    expect(labelScope("类型::功能")).toBe("类型")
    expect(shortLabel("类型::功能")).toBe("功能")
    expect(labelScope("frontend")).toBe("")
    expect(toggleLabel(["类型::功能", "frontend"], "类型::缺陷")).toEqual(["frontend", "类型::缺陷"])
    expect(toggleLabel(["frontend"], "backend")).toEqual(["frontend", "backend"])
    expect(toggleLabel(["frontend", "backend"], "frontend")).toEqual(["backend"])
  })

  it("protects system labels except the waiting label", () => {
    expect(canRemoveLabel("状态::已完成")).toBe(false)
    expect(canRemoveLabel(WAITING_LABEL)).toBe(true)
    expect(canRemoveLabel("类型::功能")).toBe(true)
    expect(isLabelLocked(WAITING_LABEL, true)).toBe(false)
    expect(isLabelLocked(WAITING_LABEL, false)).toBe(true)
    expect(isLabelLocked("原因::阻塞", true)).toBe(true)
  })

  it("groups by scope, filters unlabeled cards, and compares lists in order", () => {
    const labels: Label[] = [{ name: "a::1", color: "#000000" }, { name: "plain", color: "#000000" }, { name: "a::2", color: "#000000" }]
    expect(groupLabels(labels)).toEqual([{ header: "a" }, labels[0], labels[2], labels[1]])
    expect(matchesLabelFilter({ label: null }, "")).toBe(true)
    expect(matchesLabelFilter({ label: "x", labels: ["x", "y"] }, "y")).toBe(true)
    expect(matchesLabelFilter({ label: "x", labels: ["x"] }, "")).toBe(false)
    expect(sameLabels(["a", "b"], ["a", "b"])).toBe(true)
    expect(sameLabels(["a", "b"], ["b", "a"])).toBe(false)
  })
})

describe("devflow comment helpers", () => {
  it("splits the stage tag head and groups board images into a gallery", () => {
    const parsed = parseComment("【编码 #1｜成功｜已提交】\nDone.\n![s 1](/api/kanban/image?cardId=k&attachmentId=x)\n\n![s 2](/api/kanban/image?cardId=k&attachmentId=y)\nAfter")
    expect(parsed.tags).toEqual(["编码 #1", "成功", "已提交"])
    expect(parsed.segments).toEqual([
      { markdown: "Done." },
      { images: [{ alt: "s 1", src: "/api/kanban/image?cardId=k&attachmentId=x" }, { alt: "s 2", src: "/api/kanban/image?cardId=k&attachmentId=y" }] },
      { markdown: "After" },
    ])
    expect(parseComment("plain").tags).toEqual([])
  })

  it("makes artifact links absolute and shortens artifact paths", () => {
    expect(absolutizeFileLinks("[plan](/api/file?path=%2Fa%2Fplan.md)", "http://127.0.0.1:4000/x"))
      .toBe("[plan](http://127.0.0.1:4000/api/file?path=%2Fa%2Fplan.md)")
    expect(artifactDisplayPath("/w/.dsh/workflow-artifacts/t1/repo/docs/plan.md")).toBe("docs/plan.md")
  })

  it("colors result tags and infers the agent role", () => {
    expect(tagTone("待人工确认")).toBe("is-warn")
    expect(tagTone("测试未通过")).toBe("is-bad")
    expect(tagTone("成功")).toBe("is-ok")
    const at = (s: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, s)).toISOString()
    const list: Comment[] = [
      { id: "1", source: "agent", content: "【测试 #2｜通过】", createdAt: at(0) },
      { id: "2", source: "agent", content: "follow-up", createdAt: at(10) },
      { id: "3", source: "agent", content: "【看板同步】", createdAt: at(20) },
      { id: "4", source: "human", content: "ok", createdAt: at(30) },
      { id: "5", source: "agent", content: "📄 **发布 #1 报告**", createdAt: at(40) },
    ]
    expect(list.map((_, i) => commentRole(list, i))).toEqual(["test", "test", "bridge", "", "release"])
  })

  it("formats relative times and comment image markdown", async () => {
    const now = Date.UTC(2026, 10, 19, 12)
    expect(relativeTime(new Date(now - 5_000).toISOString(), t, now)).toBe(t("justNow"))
    expect(relativeTime(new Date(now - 3 * 3600_000).toISOString(), t, now)).toBe(t("hoursAgo").replace("{n}", "3"))
    expect(commentImageMarkdown("ws", "k1", ["sha256:ab"], "img")).toBe("![img 1](/api/kanban/image?workspaceId=ws&cardId=k1&attachmentId=sha256%3Aab)")
    expect(await attachmentIdOf(new Blob(["abc"]))).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  it("renders a tagged agent comment with its role and Markdown body", () => {
    const comments: Comment[] = [{ id: "1", source: "agent", content: "【编码 #1｜成功】\n**done**", createdAt: new Date().toISOString() }]
    render(<ul><CommentItem comments={comments} index={0} /></ul>)
    expect(screen.getByText(t("roleBuild"))).toBeTruthy()
    expect(screen.getByText("成功").className).toContain("is-ok")
    // MarkdownText is stubbed to plain text in test/setup.ts; the body after the tag head reaches it unchanged.
    expect(screen.getByText("**done**")).toBeTruthy()
  })
})

describe("LabelPicker", () => {
  const labels: Label[] = [
    { name: "类型::功能", color: "#1f75cb" },
    { name: "类型::缺陷", color: "#dd2b0e" },
    { name: WAITING_LABEL, color: "#e9be74" },
    { name: "状态::已完成", color: "#108548" },
    { name: "frontend", color: "#6699cc" },
  ]
  function Harness({ initial, onChange }: { initial: string[]; onChange: (next: string[]) => void }) {
    const [value, setValue] = useState(initial)
    return <LabelPicker labels={labels} value={value} ariaLabel="labels" onChange={(next) => { setValue(next); onChange(next) }} />
  }

  it("multi-selects, swaps within a scope, and keeps system labels read-only", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Harness initial={[WAITING_LABEL]} onChange={onChange} />)
    await user.click(screen.getByRole("button", { name: "labels" }))
    const list = screen.getByRole("listbox")
    await user.click(within(list).getByRole("option", { name: /功能/ }))
    await user.click(within(list).getByRole("option", { name: /frontend/ }))
    await user.click(within(list).getByRole("option", { name: /缺陷/ }))
    expect(onChange).toHaveBeenLastCalledWith([WAITING_LABEL, "frontend", "类型::缺陷"])
    const done = within(list).getByRole("option", { name: /已完成/ })
    expect(done.getAttribute("aria-disabled")).toBe("true")
    await user.click(done)
    expect(onChange).toHaveBeenCalledTimes(3)
    await user.type(within(list).getByRole("textbox"), "front")
    expect(within(list).getAllByRole("option")).toHaveLength(1)
  })

  it("removes a chip with its ✕ only for removable labels, and Esc closes only the menu", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onKey = vi.fn()
    document.addEventListener("keydown", onKey)
    render(<Harness initial={["状态::已完成", WAITING_LABEL]} onChange={onChange} />)
    expect(screen.queryByRole("button", { name: t("removeLabel").replace("{label}", "状态::已完成") })).toBeNull()
    await user.click(screen.getByRole("button", { name: t("removeLabel").replace("{label}", WAITING_LABEL) }))
    expect(onChange).toHaveBeenLastCalledWith(["状态::已完成"])
    await user.click(screen.getByRole("button", { name: "labels" }))
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("listbox")).toBeNull()
    expect(onKey).not.toHaveBeenCalled()
    document.removeEventListener("keydown", onKey)
  })
})
