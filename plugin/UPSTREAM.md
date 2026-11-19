# Upstream

`dsh-kanban-devflow` is a fork of [`@alpacachen/dsh-kanban`](https://github.com/alpacachen/dsh-kanban) by alpacachen, released under the MIT license (see `LICENSE`, kept unchanged).

- Base: `@alpacachen/dsh-kanban` **1.13.1**, upstream commit `ec7486b676a60bdc3860a3a408d917afada6c722`.
- Package name: `dsh-kanban-devflow` (unscoped, `private`, never published to npm). Versions are `<upstream version>-devflow.<n>`.
- The Cordis plugin ids stay `dsh-kanban` / `dsh-kanban-workflow` and the board file stays `.dsh-kanban.json` (schemaVersion 6), so a profile can switch between upstream and the fork without losing data. Install only one of the two in a profile.

## What the fork changes

Everything the dsh-kanban-devflow kit used to patch into the bundled upstream output (`bridge/install.mjs`, up to kit commit `a3ff457`) now lives in source:

| Change | Files |
| --- | --- |
| Several labels per card: `card.labels[]`, with `card.label` kept as `labels[0]`; `labels` parameter on `kanban_add_card` / `kanban_update_card`; rename/delete of a label updates every card; `card_label_changed` activity carries `meta.added` / `meta.removed` | `index.ts`, `src/client/lib/labels.ts`, `src/client/KanbanView.tsx`, `src/client/components/SortableCard.tsx` |
| Label picker: multi-select, grouped `group::name` labels, one label per group, read-only system groups (状态/原因/标记/结果) except `状态::待人工确认` | `src/client/components/LabelPicker.tsx` |
| GitLab-style comment timeline: role avatars, stage/result tags, Markdown body, image gallery with lightbox, pasted/dropped comment images stored as card images | `src/client/components/CardComments.tsx`, `src/client/lib/comments.ts`, `src/client/devflow.css` |
| Artifact preview: `/api/file?path=…` links in comments open inside the card | `src/client/components/CardComments.tsx` |
| Card details autosave (labels, priority and date at once; title and description after 800 ms; flush on close); the Save button remains for new cards only; activity box hidden | `src/client/components/CardDialog.tsx` |
| Loads the kit's dev-delivery sync bridge from `<profile>/dsh-devflow-bridge.json` and exposes `globalThis[Symbol.for('dsh-kanban-flow-kit.kanban')]` | `workflow/devflow-bridge.ts`, `workflow/index.ts`, `index.ts` |

Search for `dsh-kanban-devflow` / `devflow` comments to find the fork's code.

## Taking a new upstream release

1. Fetch the upstream tag into a scratch clone, and diff it against the base commit above (`git diff ec7486b <new tag>`).
2. Apply that diff to `plugin/` (for example `git apply --3way` with `--directory=plugin`), resolve conflicts in the files listed above, and keep the fork's package name and version scheme (`<new upstream version>-devflow.1`).
3. Update `dsh.compatibility` in `package.json` if the new release targets another DSH version.
4. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` and `node build.mjs` (the repo pins pnpm 11; `npx -y pnpm@11.8.0 …` works when a different pnpm is installed).
5. Commit the rebuilt `index.js`, `workflow/index.js` and `lib/client.js` (like upstream, the build output is tracked so installing needs no build tools), then update the base commit and version in this file. `bridge/install.mjs` packs this directory with `npm pack` at install time.
