# Task Breakdown: Memory, context files & the load meter

> Ordered tasks derived from [`plan.md`](./plan.md). Each task names the files to
> create or modify, what "done" means, and its phase. Execute top to bottom.
> Every task ships with its tests (Constitution VI).

**Feature ID**: `AW-07-memory-context`
**Spec**: [`./spec.md`](./spec.md) · **Plan**: [`./plan.md`](./plan.md)
**Status**: `Draft`
**Last updated**: 2026-09-06

---

## How to use

- Tasks are sequential unless marked `(parallel)`.
- Repo root is the monorepo root; every path below is relative to it.
- Commands run from the directory named in the task.
- `develop` must be green after each **phase**, not each task — but no task may
  leave a type error or a failing existing test behind.
- Add new tasks at the bottom rather than renumbering.

---

## Phase P1 — Memory facts, end to end (no prompt changes)

> P1 touches nothing an agent receives. It adds a table, a service, a controller
> and a page section. If P1 shipped alone, users could curate memory before
> anything read it.

### P1.a — Contracts and data model

- [ ] **T1. Fact + context-file + load-report contracts.**
      Create `packages/contracts/src/memory/memory-fact.types.ts`,
      `packages/contracts/src/memory/context-file.types.ts`,
      `packages/contracts/src/memory/context-load.types.ts` and
      `packages/contracts/src/memory/index.ts`; re-export from
      `packages/contracts/src/index.ts`.
      Constants exactly as listed in plan §3.7 — `MEMORY_FACT_BODY_MAX = 500`,
      `MEMORY_FACT_ACTIVE_MAX = 2000`, `MEMORY_FACT_PROPOSED_MAX = 200`,
      `MEMORY_FACT_PINNED_MAX = 20`, `MEMORY_FACT_RECALL_TOP_K = 8`,
      `MEMORY_FACT_RECALL_MIN_SCORE = 0.72`, `MEMORY_FACT_SEARCH_TOP_K = 50`,
      `MEMORY_FACT_SEARCH_MIN_SCORE = 0.55`,
      `MEMORY_FACT_RECALL_MAX_TOKENS = 1200`,
      `MEMORY_FACT_FORGET_RETENTION_DAYS = 30`,
      `WORKSPACE_CONTEXT_FILE_SLUGS`, `CONTEXT_FILE_LOAD_MODES`,
      `MAX_ALWAYS_LOADED_WORKSPACE_FILES = 3`,
      `CONTEXT_FILE_REVISION_KEEP = 20`, `CONTEXT_FILE_REVISION_KEEP_DAYS = 30`.
      **Done when**: `pnpm --filter @ever-works/contracts build` emits
      declarations with no conditional-spread DTS failure, and the constants are
      importable from `@ever-works/contracts`.

- [ ] **T2. `MemoryFact` entity.**
      Create `packages/agent/src/entities/memory-fact.entity.ts`; export from
      `packages/agent/src/entities/index.ts`.
      Columns and constraints per plan §3.1, including `scope`/`agentId` CHECK,
      the 500-char CHECK, `embedding` declared `simple-json` `number[] | null`,
      `embeddingModel`, `embeddingDims`, `pinned`, `recallCount`,
      `lastRecalledAt`, `supersedesFactId`, `forgottenAt`, and the
      `tenantId`/`organizationId` scope pair matching sibling entities.
      **Done when**: `pnpm --filter @ever-works/agent build` passes and the
      entity is picked up by the TypeORM entity list.

- [ ] **T3. Context-file shared types module.**
      Create `packages/agent/src/entities/context-file-types.ts` holding the slug
      union, default load modes per slug, and the always-loaded cap — the same
      role `packages/agent/src/entities/kb-types.ts` plays for the Knowledge
      Base. Re-export the contract constants rather than redeclaring the numbers.
      **Done when**: no numeric literal for a limit appears twice in the repo.

- [ ] **T4. Migration — `memory_facts`.**
      From `apps/api/`, author
      `apps/api/src/migrations/<timestamp>-CreateMemoryFacts.ts`.
      Branch on `queryRunner.connection.options.type === 'postgres'` for
      `vector(1536)` vs `TEXT`, and create the `ivfflat … vector_cosine_ops WITH
      (lists = 100)` index on Postgres only — copy the shape from
      `apps/api/src/migrations/1779975000000-CreateWorkKnowledgeChunks.ts`.
      Create `idx_memory_facts_owner_status`, `idx_memory_facts_agent`,
      `idx_memory_facts_forgotten_at`, and the partial unique
      `uq_memory_facts_body`.
      **Done when**: `pnpm typeorm migration:run` applies cleanly on Postgres and
      on SQLite, `down()` drops indexes then the table, and the generated SQL
      contains no `DROP COLUMN` and no rename.

- [ ] **T5. `MemoryFactRepository`.**
      Create
      `packages/agent/src/database/repositories/memory-fact.repository.ts`
      beside `memory-folder.repository.ts`.
      Methods: `listForOwner`, `countByStatus`, `findOwned`, `create`,
      `update`, `setStatus`, `forgetAll`, `searchSemantic` (ANN with the score
      threshold, always `WHERE user_id = … AND organization_id IS NOT DISTINCT
      FROM …`), `searchLiteral`, `dueForPurge`, `dueForReembed`.
      **Done when**: every query is owner-scoped and there is no code path that
      can read a row outside the caller's workspace.
      **Test**: `packages/agent/src/database/repositories/__tests__/memory-fact.repository.spec.ts`
      plus a Postgres integration spec proving the scope predicate is present in
      the emitted SQL, mirroring
      `agent.repository.organization-scope-sql.integration.spec.ts`.

### P1.b — Service layer

- [ ] **T6. `MemoryFactService`.**
      Create `packages/agent/src/services/memory-fact.service.ts`; export from
      `packages/agent/src/services/index.ts`.
      Enforces: body trim + 1–500 chars; 2,000 active cap; 200 proposal cap;
      20 pin cap; `origin`-driven initial status (human → `active`, agent →
      `proposed`); `scope`/`agentId` coherence; soft forget with `forgottenAt`;
      restore inside 30 days; `forgetAll` requiring the caller to have already
      passed the confirm gate; and an activity row on every mutation.
      Enqueues embedding through `MEMORY_FACT_EMBED_DISPATCHER` (T13) and
      tolerates a `null` return.
      **Done when**: `forgetAll` provably touches only `memory_facts`.
      **Test**: `packages/agent/src/services/__tests__/memory-fact.service.spec.ts`
      covering every bound and both status paths.

- [ ] **T7. `MemoryFactSearchService`.**
      Create `packages/agent/src/services/memory-fact-search.service.ts`.
      Embeds the query through `AiFacadeService.embed()`; runs the ANN leg and
      the literal leg; fuses, dedupes by id, floors literal hits at the
      threshold so they always survive; returns `{ results, semantic }`.
      Probes embedding availability and vector support and returns
      `semantic: false` rather than throwing.
      **Done when**: with the AI facade mocked to throw, search still returns
      literal results.
      **Test**: `packages/agent/src/services/__tests__/memory-fact-search.spec.ts`.

- [ ] **T8. Activity action types.**
      Append to `packages/agent/src/entities/activity-log.types.ts`:
      `MEMORY_FACT_CREATED`, `MEMORY_FACT_UPDATED`, `MEMORY_FACT_FORGOTTEN`,
      `MEMORY_FACT_RESTORED`, `MEMORY_FACT_ACCEPTED`, `MEMORY_FACT_DISCARDED`,
      `MEMORY_FACTS_CLEARED`, `CONTEXT_FILE_UPDATED`, `CONTEXT_FILE_RESTORED`,
      `CONTEXT_FILE_MODE_CHANGED`, `CONTEXT_BUDGET_EXCEEDED`.
      Append only — reorder nothing, remove nothing.
      **Done when**: no migration is required (the column is `varchar(50)`), and
      a comment in the file says so.

### P1.c — API

- [ ] **T9. `MemoryFactsController` + module.**
      Create `apps/api/src/memory-facts/memory-facts.module.ts`,
      `apps/api/src/memory-facts/memory-facts.controller.ts` and
      `apps/api/src/memory-facts/dto/` (`create-memory-fact.dto.ts`,
      `update-memory-fact.dto.ts`, `list-memory-facts.query.dto.ts`,
      `forget-all.dto.ts`). Register the module in
      `apps/api/src/api.module.ts`.
      Routes, throttles and error codes exactly as plan §4.1. Organization comes
      from `ScopeContextService`; `@UseGuards(AuthSessionGuard)`;
      `@CurrentUser()`; full Swagger decorators.
      **Done when**: `POST /api/memory/facts/forget-all` with any confirm string
      other than `FORGET ALL` returns 422 and changes nothing.
      **Test**: `apps/api/src/memory-facts/memory-facts.controller.spec.ts` —
      auth, scoping, 404 on a cross-workspace id, 409 at the caps, 410 on a
      too-late restore, 422 on a bad confirm, throttle metadata asserted.

- [ ] **T10. Web API client + server actions.**
      Create `apps/web/src/lib/api/memory-facts.ts` (mirroring
      `apps/web/src/lib/api/memory.ts`) and
      `apps/web/src/app/actions/memory-facts.ts` (mirroring
      `apps/web/src/app/actions/skills.ts`).
      **Done when**: the client is server-only and stamps the workspace selector
      header like its sibling.

- [ ] **T11. BFF proxy routes.**
      Create `apps/web/src/app/api/memory/facts/route.ts`,
      `.../facts/[id]/route.ts`, `.../facts/[id]/forget/route.ts`,
      `.../facts/[id]/restore/route.ts`, `.../facts/[id]/accept/route.ts`,
      `.../facts/[id]/discard/route.ts`, `.../facts/forget-all/route.ts`,
      `.../facts/stats/route.ts`, copying the header/scope handling in
      `apps/web/src/app/api/memory/route.ts`.
      **Done when**: each has a `route.unit.spec.ts` beside it, as the existing
      memory proxies do.

### P1.d — Background work

- [ ] **T12. Embed dispatcher symbol.**
      Create `packages/agent/src/tasks/memory-fact-embed-dispatcher.ts` and
      `packages/agent/src/tasks/memory-fact-embed.types.ts` following
      `packages/agent/src/tasks/kb-embed-document-dispatcher.ts`. Export from the
      package's tasks barrel.
      **Done when**: the interface returns `Promise<string | null>` and its
      docblock states that `null` means "stays unembedded, sweep will catch it".

- [ ] **T13. Embed task.**
      Create `packages/tasks/src/tasks/trigger/memory-fact-embed.task.ts`;
      register in `packages/tasks/src/tasks/trigger/index.ts`; implement the
      producer side in `packages/tasks/src/trigger/trigger.service.ts` next to
      `dispatchKbEmbedDocument`. Give it a `queue:` config so a bulk import
      cannot saturate the runtime.
      **Done when**: re-running the task for the same fact is a no-op, and no
      file outside `packages/tasks` imports a runtime SDK.

- [ ] **T14. GC / sweep task.**
      Create `packages/agent/src/tasks/memory-fact-gc-dispatcher.ts` and
      `packages/tasks/src/tasks/trigger/memory-fact-gc.task.ts` as a scheduled
      task on cron `13 4 * * *`; register it in the trigger index.
      Purges facts forgotten more than 30 days ago, prunes context-file revisions
      past the keep rule (a no-op until P2), and re-embeds up to 500 facts per
      tick whose `embeddingModel` differs from the resolved default.
      **Done when**: the cadence does not collide with the existing `42 3`,
      `23 */2` or `37 8` crons in that folder.
      **Test**: `packages/agent/src/services/__tests__/memory-fact-gc.spec.ts`.

### P1.e — Web surface

- [ ] **T15. Memory rail.**
      Create `apps/web/src/components/memory/MemoryRail.tsx` (+
      `MemoryRail.unit.spec.tsx`); export from
      `apps/web/src/components/memory/index.ts`.
      Sections `Facts`, `Context files`, `Agents`, `Also here`; counts; the ⟳
      always-loaded marker (inert until P2); `g f` / `g c` / `g a` jumps.
      **Done when**: every existing panel is still reachable, now under
      "Also here".

- [ ] **T16. `FactsPanel` + `FactRow` + `FactComposer`.**
      Create `apps/web/src/components/memory/FactsPanel.tsx`, `FactRow.tsx`,
      `FactComposer.tsx` (+ a `.unit.spec.tsx` each).
      All states from spec §6.2–§6.3: loaded, searching (semantic and degraded),
      empty, no results, over capacity, loading skeletons (six rows), pagination.
      Relevance bar in search mode. Provenance line. Row actions and the `⋯`
      menu. Optimistic pin/forget/restore with rollback; **non**-optimistic
      edits.
      **Done when**: the search box is focusable and accepts typing before the
      first page resolves, and nothing shifts layout when it lands.

- [ ] **T17. `ForgetAllDialog`.**
      Create `apps/web/src/components/memory/ForgetAllDialog.tsx` (+ spec).
      Blast-radius paragraph before the field; the confirm button disabled until
      the field contains exactly `FORGET ALL`; `Esc` cancels and never confirms;
      focus returns to the trigger on close.

- [ ] **T18. Wire the Memory page.**
      Modify `apps/web/src/app/[locale]/(dashboard)/memory/page.tsx` to add a
      `.catch()`-guarded facts fetch, and
      `apps/web/src/components/memory/MemoryShell.tsx` to render the rail and
      route the section body. Existing panels move under "Also here" with **no
      change to their internals**.
      **Done when**: `flow-memory-ui-journey.spec.ts`,
      `flow-org-memory-page-deep.spec.ts` and
      `flow-memory-consolidation-deep.spec.ts` still pass unmodified.

- [ ] **T19. Chat capture tool (human turn).**
      Create `apps/web/src/lib/ai/tools/memory-facts.tools.ts` with a
      `rememberFact` tool; register it in
      `apps/web/src/lib/ai/tools/tool-selection.ts`.
      The tool writes an **active** fact (origin `user`) because the author is
      the human in their own conversation, and returns the stored wording so the
      assistant can read it back in one line.
      **Done when**: `tool-selection.unit.spec.ts` shows the tool is offered for
      "remember…" phrasings and not for unrelated turns.

### P1.f — i18n and tests

- [ ] **T20. i18n keys for P1.**
      Add `dashboard.memoryPage.facts` and
      `dashboard.memoryPage.forgetAllDialog` to `apps/web/messages/en.json` with
      every key listed in plan §8. Mirror the keys into the 20 sibling locale
      files in `apps/web/messages/`.
      **Done when**: no leaf key name contains a literal `.`, every leaf is
      camelCase, and no component in T15–T19 contains a literal English string.

- [ ] **T21. End-to-end — facts journey.** `(parallel with T22)`
      Create `apps/web/e2e/flow-memory-facts-journey.spec.ts`: add → search →
      edit → forget → undo → restore from **Forgotten**, plus the empty and
      no-result states.
      Prefer container-scoped `getByRole` queries — unscoped `*ByRole` is the
      known flake family in this app.

- [ ] **T22. End-to-end — forget all.**
      Create `apps/web/e2e/flow-memory-forget-all.spec.ts`: the typed confirm
      gate, the blast-radius copy, and an assertion that a context file body and
      an agent file body are byte-identical after the wipe.

- [ ] **T23. End-to-end — degraded search.**
      Create `apps/web/e2e/flow-memory-facts-degraded-search.spec.ts`: with the
      embedding provider unavailable, literal search returns results, the note
      renders with its settings link, and no console error is raised (the
      hydration-error assertion in the shared spec helper stays green).

- [ ] **T24. P1 gate.**
      Run from the repo root: `pnpm format && pnpm lint && pnpm type-check &&
      pnpm test && pnpm build`.
      **Done when**: green, and `docs/specs/features/agent-workspace/TRACKER.md`
      row AW-07 reads `Spec: Draft` / `Impl: In progress` with the branch link.

---

## Phase P2 — Context files, the load meter, injection

> P2 changes what agents receive. Land it behind the telemetry in T40 and watch
> for a week before starting P3.

### P2.a — Data model

- [ ] **T25. `WorkspaceContextFile` entity + migration.**
      Create `packages/agent/src/entities/workspace-context-file.entity.ts`
      (export from the entities barrel) and
      `apps/api/src/migrations/<timestamp>-CreateWorkspaceContextFiles.ts`.
      Columns per plan §3.2; unique `(userId, organizationId, slug)`. No seed
      migration — rows are created lazily on first read.

- [ ] **T26. `ContextFileRevision` entity + migration.**
      Create `packages/agent/src/entities/context-file-revision.entity.ts` and
      `apps/api/src/migrations/<timestamp>-CreateContextFileRevisions.ts`.
      Columns per plan §3.3; index
      `(targetType, targetId, fileKey, createdAt DESC)`.

- [ ] **T27. `agents.notes_md` + migration.**
      Modify `packages/agent/src/entities/agent.entity.ts` to add `notesMd`
      beside `agentYml`; create
      `apps/api/src/migrations/<timestamp>-AddAgentNotesMd.ts`
      (`ADD COLUMN "notes_md" text NULL`).

- [ ] **T28. Repositories.** `(parallel with T27)`
      Create
      `packages/agent/src/database/repositories/workspace-context-file.repository.ts`
      and `.../context-file-revision.repository.ts` with owner-scoped queries and
      the retention prune (`keep newest 20 OR younger than 30 days`).
      **Test**: a spec each under the repositories' `__tests__/` folder.

### P2.b — The assembler and the meter

- [ ] **T29. `truncateMiddleOut`.**
      Modify `packages/agent/src/agents/prompt-assembler.service.ts` to add and
      export `truncateMiddleOut(text, capTokens)` returning
      `{ text, skipped: { startChar, endChar, chars } | null }` with the 70/30
      split and the marker line. **Do not touch `truncateTailFirst`.**
      **Test**: `packages/agent/src/agents/__tests__/truncate-middle-out.spec.ts`
      — under cap, exactly at cap, one char over, far over, empty, marker length
      counted inside the cap, idempotence.

- [ ] **T30. Extract `measureSegments`.**
      Modify `prompt-assembler.service.ts` to hoist the pure segment-measurement
      logic into an exported `measureSegments(input): SegmentMeasurement[]`, and
      make `assemble()` call it. Behaviour must be unchanged for every existing
      input.
      **Done when**: `packages/agent/src/agents/__tests__/prompt-assembler.service.spec.ts`
      and `prompt-assembler-file-manifest.spec.ts` pass without edits.

- [ ] **T31. New segments and caps.**
      Modify `prompt-assembler.service.ts`: add `notes`, `workspace-context` and
      `memory-facts` to `PROMPT_SEGMENTS` in the order given in plan §2.3; set
      `SEGMENT_TOKEN_CAPS` to the FR-47 numbers (`identity` 1200, `role` 1200,
      `notes` 1500, `capabilities` 400, `operating-loop` 800,
      `workspace-context` 1500, `memory-facts` 1200,
      `scope-advanced-prompts` 600); raise `TOTAL_SYSTEM_TOKEN_TARGET` to
      `17_000`; route the authored-file segments through `truncateMiddleOut` and
      leave the feed-shaped ones on `truncateTailFirst`. Fence the two new
      untrusted segments with `neutralizeInjectedBlock` exactly as the skills
      segment is fenced.
      **Test**: `packages/agent/src/agents/__tests__/prompt-assembler-budgets.spec.ts`
      asserting each cap, the total, and that the sum of caps (16,850) is below
      the total.

- [ ] **T32. `ContextFileService`.**
      Create `packages/agent/src/services/context-file.service.ts`; export from
      the services barrel.
      `getOrCreate(slug)`, `write(slug, body, expectedHash?)`,
      `setLoadMode(slug, mode)`, `listRevisions`, `restoreRevision`.
      Enforces the 64 KB bound (reuse `MAX_FILE_BYTES`'s value),
      `assertNoSecrets` from `packages/agent/src/utils/secret-scan.ts` in
      hard-reject mode, the `expectedHash` conflict returning the current hash
      **and** the current body, the three-always-loaded cap, the proportional
      split of the shared 1,500-token budget, and a revision row on every write.
      **Test**: `packages/agent/src/services/__tests__/context-file.service.spec.ts`.

- [ ] **T33. `ContextBudgetService`.**
      Create `packages/agent/src/agents/context-budget.service.ts`.
      Builds a `ContextLoadReport` for one agent from saved bodies by calling
      `measureSegments` — **no second implementation of the budget maths.**
      States: `under` (<90 %), `near` (90–100 %), `over` (>100 %).
      **Test**: `packages/agent/src/agents/__tests__/context-budget.service.spec.ts`
      including an equivalence test that the report equals `assemble()`'s own
      numbers for identical inputs (spec FR-50), and boundary tests at 89.9 /
      90 / 100.1 %.

- [ ] **T34. `NOTES.md` in the agent-file service.**
      Modify `packages/agent/src/agents/agent-file.service.ts`: add `'NOTES.md'`
      to `AgentFileName` and to `AGENT_FILE_NAMES` (position 3), map it to
      `notesMd` in the column switch, and append it to `hashOf`'s concat at the
      **end** with a new sentinel.
      **Test**: `packages/agent/src/agents/__tests__/agent-file-notes.spec.ts` —
      read/write round trip, path allow-list unchanged for every other value,
      cross-agent write rejected, and the ETag-stability regression from plan
      §3.4 (a read before the change and a write after it must not conflict).
      The existing `packages/agent/src/agents/__tests__/agent-file.service.spec.ts`
      must stay green unmodified.

- [ ] **T35. Facts recall into the run.**
      Create `packages/agent/src/services/memory-fact-recall.service.ts` and wire
      it into `packages/agent/src/agents/agent-run.service.ts` as the
      `memory-facts` segment input (the provider-backed `resolveMemoryRecall`
      call at line 398 stays exactly as it is — both blocks may be present).
      Pinned first, then top-8 above 0.72, capped at 1,200 tokens dropping whole
      facts lowest-score-first, loud-empty note when recall is on and nothing
      matched, nothing at all when `agent.memoryRecallEnabled === false`, and a
      2,000 ms best-effort timeout that logs and continues.
      **Test**: `packages/agent/src/services/__tests__/memory-fact-recall.spec.ts`.

- [ ] **T36. `agent_runs.context_load`.**
      Modify `packages/agent/src/entities/agent-run.entity.ts` to add
      `contextLoad?: RunContextLoad | null` (`simple-json`, nullable); create
      `apps/api/src/migrations/<timestamp>-AddAgentRunContextLoad.ts`; write it
      from `AgentRunService` after assembly.
      **Done when**: existing runs read back `null` with no error.

### P2.c — API and tools

- [ ] **T37. `ContextFilesController` + module.**
      Create `apps/api/src/context-files/context-files.module.ts`,
      `context-files.controller.ts` and `dto/`; register in
      `apps/api/src/api.module.ts`. Routes per plan §4.2.
      **Test**: `apps/api/src/context-files/context-files.controller.spec.ts` —
      unknown slug 404s (never 500s), conflict response carries `currentHash` and
      the current body, load-mode 422 names the current three always-loaded
      files, revision restore creates a new revision.

- [ ] **T38. Agent-file endpoint extensions.**
      Modify `apps/api/src/agents/agents.controller.ts`: accept `NOTES.md`; add
      `GET /api/agents/:id/files/:name/revisions`,
      `POST /api/agents/:id/files/:name/revisions/:revisionId/restore`,
      `GET /api/agents/:id/context-load`,
      `GET /api/agents/:id/files/:name/load-report`.
      **Test**: create `apps/api/src/agents/agents.controller.context.spec.ts`
      — the module uses topic-scoped controller specs
      (`agents.controller.environment.spec.ts`, `.runtime.spec.ts`,
      `.session-detail.spec.ts`); there is no single `agents.controller.spec.ts`
      to extend.

- [ ] **T39. Agent tools for context files.**
      Modify `packages/agent/src/agents/agent-tool.service.ts` beside the pushes
      at lines 412–413: add `getContextFile({ slug })` (on-demand slugs only;
      always-loaded slugs return a pointer note; body neutralised and fenced) and
      `updateContextFile({ slug, body })` gated on
      `AgentPermissions.canEditAgentFiles` — not offered at all without the
      grant. Add a `rememberFact` run-time tool that writes **proposed** facts
      only.
      **Test**: extend the agent-tool suite under
      `packages/agent/src/agents/__tests__/` — unknown slug returns a typed
      refusal rather than throwing; the write tool is absent without the grant;
      the remember tool can never produce an `active` fact.

- [ ] **T40. Truncation telemetry.**
      Modify `packages/agent/src/agents/agent-run.service.ts` to write one
      `AgentRunLog` row per truncating run (level `WARN`, step
      `context-budget`, metadata `{ segment, capTokens, originalTokens,
      truncatedTokens, skippedChars }`) and the `memory-recall` /
      `memory-capture` lines from plan §9.2. Emit the analytics events from plan
      §9.3 through `packages/monitoring`.
      **Done when**: a run with an over-budget Notes file produces exactly one
      `context-budget` row, not one per segment pass.

### P2.d — Web surface

- [ ] **T41. `LoadMeter`.**
      Create `apps/web/src/components/memory/LoadMeter.tsx` (+
      `LoadMeter.unit.spec.tsx`). The **only** place the three states are styled.
      Renders used / budget / percentage / skipped tokens, the authoring rule
      line, and an assistive-technology text summary
      (*"Notes: 1,500 of 1,500 tokens used, 2,600 tokens skipped"*).

- [ ] **T42. `ContextFilePanel`, `ContextFileEditor`, `ContextFilePreview`.**
      Create the three components under `apps/web/src/components/memory/` (+ a
      spec each).
      Write/Preview toggle, load-mode control, save, history link, conflict
      banner with **Compare** / **Reload** / **Keep**, and the marked skipped
      block — hatched fill plus strike-through plus label, never colour alone
      (WCAG 2.2 AA 1.4.1). `n` / `N` jump between skipped blocks.
      **Done when**: the marked block states its character count and line range.

- [ ] **T43. `AgentContextReport`.**
      Create `apps/web/src/components/memory/AgentContextReport.tsx` (+ spec)
      rendering the fourteen segments of spec §6.7 with empty and error states.

- [ ] **T44. Web clients, actions and BFF routes for context files.**
      Create `apps/web/src/lib/api/context-files.ts`,
      `apps/web/src/app/actions/context-files.ts`, and the routes
      `apps/web/src/app/api/context-files/route.ts`,
      `.../[slug]/route.ts`, `.../[slug]/load-mode/route.ts`,
      `.../[slug]/revisions/route.ts`,
      `.../[slug]/revisions/[revisionId]/restore/route.ts`,
      `apps/web/src/app/api/agents/[id]/context-load/route.ts` — each with a
      `route.unit.spec.ts`.

- [ ] **T45. Memory page — context files and agents sections.**
      Modify `apps/web/src/components/memory/MemoryShell.tsx` and
      `apps/web/src/app/[locale]/(dashboard)/memory/page.tsx` to render the six
      workspace files and the per-agent file tree in the rail, with
      `ContextFilePanel` as the section body.

- [ ] **T46. Agent instructions tab.**
      Modify
      `apps/web/src/components/agents/AgentInstructionsEditor.tsx` and
      `apps/web/src/app/[locale]/(dashboard)/agents/[id]/instructions/page.tsx`:
      add the **Notes** pill (sixth), the `LoadMeter` under the textarea, the
      Write/Preview toggle, and `AgentContextReport` above the pills. Keep the
      800 ms autosave; fetch the load report on a separate 400 ms debounce.
      Relabel pills to captions (`Identity`, `Role`, `Notes`, `Operating loop`,
      `Tools`, `Manifest`) with the filename as secondary text — **filenames
      themselves do not change**.
      **Done when**: `apps/web/e2e/agent-instruction-files-ui.spec.ts` still
      passes, adjusted only for the added pill.

- [ ] **T47. i18n keys for P2.**
      Add `dashboard.memoryPage.contextFiles`,
      `dashboard.memoryPage.loadMeter`, `dashboard.memoryPage.agentContext` and
      the `dashboard.agentsPage.instructions.*` additions to
      `apps/web/messages/en.json` and the 20 sibling locale files, per plan §8.

- [ ] **T48. End-to-end — load meter.** `(parallel with T49)`
      Create `apps/web/e2e/flow-context-files-load-meter.spec.ts`: small file →
      meter under; oversized body → meter over with the skipped-token count;
      Preview shows the marked block with its character count and line range;
      `n` / `N` navigate between blocks.

- [ ] **T49. End-to-end — agent context report.**
      Create `apps/web/e2e/flow-agent-context-report.spec.ts`: fourteen segments
      with their budgets, the Notes pill present, and the report agreeing with
      the single-file meter for the same file.

- [ ] **T50. End-to-end — conflict.**
      Create `apps/web/e2e/flow-context-file-conflict.spec.ts`: two contexts save
      the same file; the second is refused and the typed text survives in the
      editor.

- [ ] **T51. P2 gate.**
      `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`
      from the root, plus a manual check that
      `flow-agent-memory-lifecycle.spec.ts` and the other four
      must-stay-green suites listed in plan §10.3 are untouched and passing.

---

## Phase P3 — Ask an agent, revisions UI, agent-written facts

- [ ] **T52. `composeMessage` on the chat context.**
      Modify `apps/web/src/components/ai/ChatProvider.tsx` to add
      `composeMessage(text, attachments?)` to `ChatContextValue` — sets the
      composer draft **without sending**. Existing callers are untouched
      (`sendMessage` keeps its signature).
      **Test**: extend `apps/web/src/components/ai/ChatProvider.unit.spec.ts`.

- [ ] **T53. `'context-file'` attachment kind.**
      Modify `apps/web/src/lib/ai/attachments.ts` to widen
      `ChatAttachmentRef['kind']`, and
      `apps/web/src/components/ai/ChatAttachments.tsx` to render the chip and, on
      click, open the existing preview overlay with the file's **budgeted** text
      rendered by `ContextFilePreview` — reused, not reimplemented.
      **Done when**: `formatAttachmentsBlock`'s sanitiser is unchanged and its
      existing spec still passes.

- [ ] **T54. `AskAnAgentButton`.**
      Create `apps/web/src/components/memory/AskAnAgentButton.tsx` (+ spec) and
      mount it in `ContextFilePanel` and `AgentInstructionsEditor`.
      Calls `useChatPanel()?.setOpen(true)` then `composeMessage(...)`.
      Pre-fill: agent file → `@{agent-slug} update your {File} file: `;
      workspace file → `Update the {File} context file: ` with an optional agent
      picker and no agent addressed by default.
      **Done when**: the message is composed and **not** sent.

- [ ] **T55. Chat tools for context files.**
      Create `apps/web/src/lib/ai/tools/context-files.tools.ts`
      (`readContextFile`, `updateContextFile`); register in
      `apps/web/src/lib/ai/tools/tool-selection.ts`.
      When the addressed agent lacks `canEditAgentFiles`, the assistant returns
      the proposed change as a diff with **Apply** / **Discard** instead of
      writing.
      **Test**: `context-files.tools.unit.spec.ts` plus a case in
      `tool-selection.unit.spec.ts`.

- [ ] **T56. Revision history dialog.**
      Create `apps/web/src/components/memory/ContextFileHistoryDialog.tsx` (+
      spec); mount from `ContextFilePanel` and `AgentInstructionsEditor`.
      Lists revisions with author and time; restore writes a new revision.

- [ ] **T57. Proposed-fact review surface.**
      Extend `apps/web/src/components/memory/FactsPanel.tsx` with the
      **Proposed** filter body: the proposal card, its
      *"Proposed by {agent} during run {id}"* line linking to the run, and
      **Accept** / **Discard**. Surface the backlog-full state.
      **Done when**: a proposed fact is provably never returned by recall
      (asserted in T35's suite).

- [ ] **T58. i18n keys for P3.**
      Add `dashboard.memoryPage.askAnAgent` to `apps/web/messages/en.json` and
      the 20 sibling locale files, per plan §8.

- [ ] **T59. End-to-end — ask an agent.**
      Create `apps/web/e2e/flow-ask-an-agent-update-file.spec.ts`: the button
      opens the panel, the chip is present, the message is pre-filled and not
      sent, and the chip expands to exactly the budgeted text including the
      marked skipped block.

- [ ] **T60. P3 gate + docs.**
      `pnpm format && pnpm lint && pnpm type-check && pnpm test && pnpm build`.
      Add the user-facing page `docs/features/memory-and-context.md` and link it
      from `docs/features/index.md` and `apps/docs/sidebarsPlatform.ts`.
      Add the **Context file** row to the vocabulary table in
      `docs/specs/features/agent-workspace/README.md` §1.
      Update `docs/specs/features/agent-workspace/TRACKER.md` row AW-07 and set
      this spec's status to `Implemented`, the plan and tasks to `Done`.

---

## Definition of done

- Every checkbox above ticked.
- Every acceptance criterion in [`spec.md` §8](./spec.md#8-acceptance-criteria)
  demonstrated by a named test.
- `pnpm format:check`, `pnpm lint`, `pnpm type-check`, `pnpm test` and
  `pnpm build` green from the repo root.
- `pnpm --filter ever-works-docs build` produces no broken-link warning.
- The five must-stay-green suites in plan §10.3 pass unmodified — the proof that
  the additive rule held.
- No leaf i18n key contains a literal `.`; no component carries a literal English
  string.
- Every constitution gate in [`plan.md` §12](./plan.md#12-constitution-compliance)
  confirmed against the merged code.
