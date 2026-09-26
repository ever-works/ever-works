# App Works — requirement-quality checklist

**Program:** [App Works](../README.md) (`app-works`) · **Status:** `Draft` · **Created:** 2026-09-17
**Backed by:** [README.md](../README.md) §7 (the twelve program rules) · [CONTRACTS.md](../CONTRACTS.md) (§0
Resolutions `R-1`…`R-39`, and the name tables in §1–§9) · [ACCEPTANCE.md](../ACCEPTANCE.md) ·
[CLARIFICATIONS.md](../CLARIFICATIONS.md) · [TRACKER.md](../TRACKER.md) (whose `:65-79` states the
`Reviewed`/`Approved` criterion this checklist implements)
**Upstream form:** Spec Kit keeps this artifact as `checklists/requirements.md` — "unit tests for
requirements"; `.specify/templates/spec-template.md:86-91` is the marker convention it checks.

This is a **repeatable** review, not a one-off audit. It exists because the program's consistency rules were
enforced once, by hand, in [CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5),
and that audit still found drift a standing checklist would catch — and because
[TRACKER.md](../TRACKER.md) defines the spec ladder `— → Draft → Reviewed → Approved`. **The two top rungs now
have a written criterion** — TRACKER `:65-79` ("Spec status criteria") names this file as the checklist and
carries the rule; §2 below is the fuller statement of the same rule, and the two are kept in step.

Nothing here replaces an epic's own §7 acceptance criteria or [ACCEPTANCE.md](../ACCEPTANCE.md) — those are
about the _software_. This checklist is about the _documents_, and it is what makes the word `Reviewed` mean
something.

---

## 1. Scope and what "the document" means

One review covers one epic **folder**: `docs/specs/features/app-works/<APW-nn-slug>/`, including every
companion file the epic owns (`plan.md`, `tasks.md`, and any of `schema.md`, `catalog.md`, `deploy-shapes.md`,
`cross-platform.md`, `idp-options.md`, `user-doc-draft.md`, `blueprints/`, `skill-draft/`,
`mission-templates/`, `agent-templates/`). The programme-level documents
([README.md](../README.md), [CONTRACTS.md](../CONTRACTS.md), [ACCEPTANCE.md](../ACCEPTANCE.md),
[TRACKER.md](../TRACKER.md), [BUILD-READINESS.md](../BUILD-READINESS.md), [CLARIFICATIONS.md](../CLARIFICATIONS.md),
this checklist, `JIRA-DRAFT.md`, `DOCS-PLAN.md`) are reviewed by the program lead, not epic by epic; items
that say "programme document" apply to them.

The reviewer writes findings, never edits. A finding is either **fixed by the epic's owner**, or **raised as a
clarification row** in [CLARIFICATIONS.md](../CLARIFICATIONS.md) — which is additive and never deletes the
marker it came from.

---

## 2. The status ladder this checklist backs

For [TRACKER.md](../TRACKER.md)'s spec column. The implementation column (`— · In progress · PR open ·
Merged · Verified`) is untouched by this file.

| Status         | Means                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `—`            | No `spec.md` in the folder.                                                                                                                                                                                                                                                                                                                               |
| `Draft`        | `spec.md`, `plan.md` and `tasks.md` exist and carry a `**Status**:` line. Nothing has been checked.                                                                                                                                                                                                                                                       |
| **`Reviewed`** | **Every blocking item in §3 is ticked for the wave the epic ships in, on the epic's current revision, by a reviewer who is not the epic's author.** Open clarifications are allowed only where §4 says a default covers them, and each one has a row in [CLARIFICATIONS.md](../CLARIFICATIONS.md) with a non-`open` status or an explicit wave exemption. |
| **`Approved`** | `Reviewed`, **plus** the owner's sign-off, **plus** no open clarification that blocks that wave, **plus** the baseline commit recorded per §3.6. `Approved` is per wave: an epic whose P1 is Approved and whose P3 is not yet specified reads `Approved (P1)`.                                                                                            |

A wave is never approved with an open blocking clarification: that is `.specify/templates/spec-template.md:86-91`
("Markers that block approval"), and it is why [CLARIFICATIONS.md](../CLARIFICATIONS.md) exists. An epic whose
markers all sit in a later wave can be `Approved` for the earlier one — the REVIEWER records the wave
explicitly, because [CLARIFICATIONS.md §4](../CLARIFICATIONS.md) is what makes that judgement checkable.

**Where unresolved items are written down.** [TRACKER.md](../TRACKER.md) `:71-72` requires the unresolved
items to be listed in the epic's **own `plan.md` "known gaps" section** "rather than silently absorbed". This
checklist adds the two other destinations a finding can have, and keeps all three:

| Finding kind                                                               | Where it goes                                                                                               |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A decision the epic cannot make                                            | a row in [CLARIFICATIONS.md](../CLARIFICATIONS.md), citing the marker it came from                          |
| A gap in the epic's own documents                                          | the epic's `plan.md` "known gaps" section, per TRACKER `:71-72`                                             |
| A gap in a **programme** document (README, CONTRACTS, ACCEPTANCE, TRACKER) | the program lead, listed in the review's findings — never fixed by the reviewer inside another owner's file |

---

## 3. The checklist

Item ids are stable (`RQ-nn`). Each item is a question with a yes/no answer, evidence the reviewer must be
able to point at, and a severity if the answer is no. **`Blocking`** items gate `Reviewed`; **`Advisory`**
items are recorded and do not.

### 3.1 Content quality (behaviour-first)

| Id    | Item                                                                                                                                                                                                      | Severity | Evidence a reviewer checks                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| RQ-01 | Does `spec.md` describe **what the system does for the user**, with no class names, file paths, table or column names, migration timestamps or endpoint handlers? (README §7 rule 3; Constitution IX)     | Blocking | A read-through; the verifier's code-span scan (§5) narrows this but cannot decide it. |
| RQ-02 | Is every new user-visible behaviour stated as an outcome a person can observe — including the unhappy path (refusal, timeout, conflict, permission denial)? (`.specify/templates/spec-template.md:27-40`) | Blocking | `spec.md` §2 scenarios and the epic's FR list.                                        |
| RQ-03 | Is each FR atomic — one behaviour per requirement, no "and" list hiding two? (`.specify/templates/spec-template.md:44-46`)                                                                                | Blocking | The FR list, read one line at a time.                                                 |
| RQ-04 | Do the NFRs state numbers a test could assert (percentile, rate, deadline, poll interval, cap), not adjectives? (`.specify/templates/spec-template.md:52-59`)                                             | Blocking | `spec.md` §4.                                                                         |
| RQ-05 | Are the deliberate exclusions written down, so a reviewer does not ask for them? (`.specify/templates/spec-template.md:70-75`)                                                                            | Advisory | `spec.md` §6.                                                                         |
| RQ-06 | Does every implementation detail live in `plan.md`/`tasks.md` and every cited path exist **at the recorded baseline commit**? (README §7 rule 3)                                                          | Blocking | Open each cited path at the commit in `README.md:6` / the epic's `plan.md` header.    |

### 3.2 Completeness and traceability

| Id    | Item                                                                                                                                                                 | Severity | Evidence a reviewer checks                                                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RQ-07 | Does every FR map to at least one `ACC-nn-nn` id, and does every `ACC-nn-nn` id name at least one test? (`.specify/templates/spec-template.md:84`; README §7 rule 7) | Blocking | The epic's `spec.md` §7 ids against [ACCEPTANCE.md](../ACCEPTANCE.md) §3 and its `### Coverage gaps` section (`:1295-1329`).                                        |
| RQ-08 | Is every id the epic defines present in [ACCEPTANCE.md](../ACCEPTANCE.md), and every id ACCEPTANCE.md indexes for this epic defined here?                            | Blocking | `node docs/specs/features/app-works/tools/verify-spec-tree.mjs` — the `ids` group (§5).                                                                             |
| RQ-09 | Does every id's test name a **runnable lane**, and never `apps/api/test/*.e2e-spec.ts`? (`R-22`)                                                                     | Blocking | The `**Test**:` lines in `tasks.md`; controller/service specs under `apps/api/src/**`, or Playwright under `apps/web/e2e/`.                                         |
| RQ-10 | Are every fixture branch and fixture repository the epic's tests need owned by APW-13, with no new fixture invented here? (`R-23`)                                   | Blocking | Grep the epic's `tasks.md` for `variant/` and for repository names; cross-check [CONTRACTS §8](../CONTRACTS.md#8-catalog-repositories-outside-this-monorepo).       |
| RQ-11 | Does the epic's §9 account for every clarification it raises, with the row it maps to in [CLARIFICATIONS.md](../CLARIFICATIONS.md)?                                  | Blocking | Grep the epic for `NEEDS CLARIFICATION`, then the register. `_build-artifacts/open-decisions/decision-sheet.md` is the older index and may lag — the register wins. |
| RQ-12 | Are the epic's new scenarios wired into [ACCEPTANCE.md](../ACCEPTANCE.md), including the traceability matrix? (README §7 rule 7)                                     | Advisory | [ACCEPTANCE.md](../ACCEPTANCE.md) §3–§4.                                                                                                                            |

### 3.3 Consistency with the programme contracts

| Id    | Item                                                                                                                                                                                                                            | Severity | Evidence a reviewer checks                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| RQ-13 | Does every shared noun come from README §1, with no synonym introduced? (README §7 rule 2)                                                                                                                                      | Blocking | README §1 table; the epic's own vocabulary.                                                                                                  |
| RQ-14 | Is every entity, route, capability interface, job, Activity event, flag and environment variable the epic touches owned or consumed exactly as [CONTRACTS.md](../CONTRACTS.md) §1–§9 says — no re-declaration, no second owner? | Blocking | The epic's `plan.md` name tables against CONTRACTS §2–§7.                                                                                    |
| RQ-15 | Are the epic's Activity `action`/`actionType` values exactly the §6 names? (`R-2`)                                                                                                                                              | Blocking | CONTRACTS §6.                                                                                                                                |
| RQ-16 | Are error and refusal codes drawn from the append-only catalogs (`APP_SPEC_ISSUE_CODES`, the merge-policy refusal codes) rather than invented?                                                                                  | Blocking | CONTRACTS §2; the epic's `plan.md`.                                                                                                          |
| RQ-17 | Are the epic's routes present in the OpenAPI fragments the program declares, and internal-only routes marked as such?                                                                                                           | Blocking | CONTRACTS §4; `_build-artifacts/apw-03-schema/`.                                                                                             |
| RQ-18 | If the epic drafts App specs, do they validate against the corpus, with no `reference_unresolved` and no unknown key? (`C1`, `C2`)                                                                                              | Blocking | `_build-artifacts/apw-03-schema/` validators and fixtures.                                                                                   |
| RQ-19 | Does the epic cite the `R-n` resolutions that shape it, in its own header or body, instead of restating the rule loosely?                                                                                                       | Blocking | The epic's `spec.md` header block; [CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5). |
| RQ-20 | If the epic needs a shared name that CONTRACTS does not list, is it added there **with an owner** in the same change? (CONTRACTS preamble)                                                                                      | Blocking | CONTRACTS diff.                                                                                                                              |

### 3.4 The twelve program rules (README §7)

| Id    | Rule                   | Item                                                                                                                                                                                                      | Severity | Evidence                                                                                                                                    |
| ----- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| RQ-21 | 1 · Additive only      | Nothing in the epic deletes, removes, renames, weakens or narrows an existing kind, route, entity, column, default or behaviour — and no existing behaviour is called "not applicable" or "obsolete".     | Blocking | The epic's own "Additive-only" header block plus a read of every `Modify` path in `tasks.md`.                                               |
| RQ-22 | 1 · Additive only      | Does the epic's change survive the `R-26` test — if it looks like a removal, is it written as an addition, with the removal escalated instead?                                                            | Blocking | [`R-26`](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5); any `Modify` line that drops something. |
| RQ-23 | 2 · No duplicate nouns | A new entity is justified in the epic's §5.2 and added to README §1 in the same PR.                                                                                                                       | Blocking | README §1; the epic's §5.2.                                                                                                                 |
| RQ-24 | 4 · Plugin-first       | New capabilities resolve through facades and generic capability interfaces; no hard-coded plugin id outside the plugin.                                                                                   | Blocking | `plan.md` capability tables.                                                                                                                |
| RQ-25 | 5 · Job runtime        | Background work is dispatched through the job-runtime provider, endpoints return `202`, overlapping runs are guarded (CAS or `DistributedTaskLockService.runExclusive`).                                  | Blocking | `plan.md` job table; `.specify/templates/tasks-template.md:69-73`.                                                                          |
| RQ-26 | 6 · Migrations         | Every migration timestamp is inside the epic's reserved `1792` block, is forward-only, and is re-stamped if `develop` moved past it.                                                                      | Blocking | `tasks.md` migration tasks; `README.md:408-414`; `R-39`; [TRACKER.md](../TRACKER.md) §"Migration timestamp blocks".                         |
| RQ-27 | 7 · Tests first        | Unit for logic, controller spec for endpoints, Playwright for every new user-visible flow.                                                                                                                | Blocking | `tasks.md` `**Test**:` lines.                                                                                                               |
| RQ-28 | 8 · Secrets            | App env values, kubeconfigs, registry and Git tokens are `x-secret`, encrypted, never logged or returned; Activity records field names only.                                                              | Blocking | `plan.md`; `spec.md` §4 Security.                                                                                                           |
| RQ-29 | 9 · Untrusted input    | Repository content is treated as untrusted: agents reading it run without secrets, repository-declared checks run sandboxed, nothing from a repository runs on platform infrastructure outside a sandbox. | Blocking | `spec.md`; `plan.md` sandbox section.                                                                                                       |
| RQ-30 | 10 · Public hygiene    | No competitor names, no infrastructure addresses, no internal hostnames, no undisclosed third-party vulnerability detail. (`R-14`)                                                                        | Blocking | A grep of the epic's files against `docs/internal/launch-parity-backlog.md`.                                                                |
| RQ-31 | 11 · i18n              | Every user-visible string is a camelCase key in `apps/web/messages/en.json` with no literal `.`, added to all locale files in the same PR.                                                                | Blocking | `tasks.md` i18n tasks.                                                                                                                      |
| RQ-32 | 12 · Money is visible  | Every action that spends money (runner minutes, agent tokens, managed compute) produces a receipt linked from Activity.                                                                                   | Blocking | `spec.md`; the `app.*` Activity entries in CONTRACTS §6.                                                                                    |

### 3.5 Programme-wide additions the audit produced

| Id    | Item                                                                                                                                                                                                                                 | Severity | Evidence                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------- |
| RQ-33 | Is every table the epic adds classified for the workspace backup — a file in a `BACKUP_DOMAIN_SPECS` domain, or a `BACKUP_DROPPED_ENTITIES` entry with its reason — and is the epic's `collectors.spec.ts` extension named? (`R-25`) | Blocking | `R-25`; `packages/agent/src/account-transfer/backup/collectors/`.                |
| RQ-34 | Is secret-bearing data explicitly excluded from export (values, connection outputs, `external_identities`, tier credential fingerprints)? (`R-25`)                                                                                   | Blocking | The epic's backup task block.                                                    |
| RQ-35 | Does the epic keep every deploy shape in the family, adding at most, never narrowing? (`R-27`; README D15)                                                                                                                           | Blocking | [`APW-06-app-runtime/deploy-shapes.md`](../APW-06-app-runtime/deploy-shapes.md). |
| RQ-36 | If the epic touches a tier state, does it use the Resolution's name — **Quarantine** for APW-10's per-App-Work stop, never the platform stop flag or an Agent pause? (`R-20`)                                                        | Blocking | `R-20`; the epic's `spec.md`.                                                    |
| RQ-37 | Does the epic honour the kind-switch contract — API gate `EVER_WORKS_APP_WORKS_ENABLED` default `false`, web chip flag failing **closed** for `app` only, other kinds' semantics untouched? (`R-6`)                                  | Blocking | `R-6`; `apps/web/src/lib/feature-flags/work-kinds.ts`.                           |
| RQ-38 | Does the epic ask the tier whether it is open through its policy (`AppsTierPolicy.isOpen()`) rather than reading `EVER_WORKS_APPS_MANAGED_ENABLED` directly? (`R-5`)                                                                 | Blocking | `R-5`.                                                                           |

### 3.6 Readiness

| Id    | Item                                                                                                                                                                                                                                                              | Severity | Evidence                                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| RQ-39 | Is the baseline commit recorded — the commit the epic was **authored against** and the commit it was **verified against** — with its date? (README §1 header of every programme document)                                                                         | Blocking | The epic's header block; `README.md:6`; `TRACKER.md:8`.        |
| RQ-40 | Does every path the epic says it will **Modify** exist at that recorded commit?                                                                                                                                                                                   | Blocking | Open each one at the baseline commit, not on the working tree. |
| RQ-41 | Does every relative link in the epic's folder resolve, and does every anchor match a real heading?                                                                                                                                                                | Blocking | The verifier (§5).                                             |
| RQ-42 | Is the epic's `**Status**:` line consistent with [TRACKER.md](../TRACKER.md)'s spec column for the same epic?                                                                                                                                                     | Blocking | Both files side by side.                                       |
| RQ-43 | Does the epic's stated wave and dependency set match the README §4 wave table and the README §5 dependency column, with the epic's own `Depends on` line winning where they disagree? (TRACKER §"Merge order", `:62-63`; `R-38` makes that merge order normative) | Blocking | README §4–§5; [TRACKER.md](../TRACKER.md) §"Merge order".      |
| RQ-44 | Does `plan.md` cite every path it relies on, and every cited path get opened? (README §7 rule 3)                                                                                                                                                                  | Blocking | `plan.md`, path by path.                                       |
| RQ-45 | Does `tasks.md` follow the house task shape — ordered, granular, explicit paths, a `**Test**:` line, a `**Done when**:` line, and new tasks appended rather than renumbered? (`.specify/templates/tasks-template.md:13-19, 85-91`)                                | Blocking | `tasks.md`.                                                    |

---

## 4. Open clarifications, and when they do not block a review

An `open` row in [CLARIFICATIONS.md](../CLARIFICATIONS.md) blocks `Reviewed` **for the wave it names** and only
for that wave. The reviewer's test, applied to each marker in the epic's §9:

1. Find the row. If the epic raises a marker the register does not have, that is a finding (RQ-11) — the
   register, not the epic, is what the lead converts.
2. Read the row's `Blocks` column. If the wave under review is earlier, the marker does not block.
3. If the row's status is `default accepted` or `resolved-by R-n`, the epic's stated default is the answer and
   the marker does not block **provided** the epic actually builds against that default — the reviewer confirms
   the default appears in the epic's FRs or plan, not only in §9.
4. If the row is `open` for the wave under review, `Reviewed` waits, or the wave's scope is narrowed by the
   epic's owner — the reviewer records which, and nothing is deleted.

The `R-26` additive rule applies to the conversion itself: converting a marker adds a `Resolved (…)` line and
**keeps the question**. Removing the question, or dropping the marker without recording the answer, fails
RQ-21/RQ-22.

---

## 5. What is machine-checked, and what is not

### 5.1 `tools/verify-spec-tree.mjs`

`node docs/specs/features/app-works/tools/verify-spec-tree.mjs`, from the repository root. Zero dependencies,
writes nothing, exit code `0` = clean and `1` = findings.

**What it covers — two properties, and only two:**

| Check                  | How                                                                                                                                                                                                                                                                                                                  | Feeds |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Relative links resolve | Every relative markdown link target in every `.md` file under `docs/specs/features/app-works/` (fenced code blocks stripped, inline code spans masked, GFM angle-bracket form honoured). If the target carries an `#anchor`, the anchor must match a heading in the target file, slugified the same way GitHub does. | RQ-41 |
| Acceptance-id parity   | Every `- [ ] **ACC-nn-nn**` (or `ACC-E2E-nn`) defined by an epic's `spec.md` appears in [ACCEPTANCE.md](../ACCEPTANCE.md), and every id ACCEPTANCE.md indexes is defined by some epic spec.                                                                                                                          | RQ-08 |

Its output is intentionally two groups — `links` and `ids` — with a file-count and link-count header, and it
caps each group at 40 lines so a broken tree cannot bury the first failure.

**What it explicitly does NOT cover** — a reviewer must not read a clean run as anything more than "links and
ids are consistent":

- **Nothing about meaning.** It cannot tell whether an FR is atomic (RQ-03), whether an NFR is measurable
  (RQ-04), whether a scenario has an unhappy path (RQ-02), or whether a default is honoured in the plan (RQ-14).
- **Nothing about behaviour-first.** It does not scan `spec.md` for class names, file paths, column names or
  migration timestamps — RQ-01 is a read-through, and the only support it gives is that a file path written as
  inline code is _masked_ before the link scan, so an ordinary citation never appears as a link finding.
- **Nothing about the `[NEEDS CLARIFICATION]` markers.** It does not count them, does not read them, and does
  not know [CLARIFICATIONS.md](../CLARIFICATIONS.md) exists. RQ-11 and §4 are manual.
- **Nothing about tests actually existing or running.** It checks that ids are _indexed_, never that a named
  test file exists, that it is in a runnable lane, or that it passes — RQ-07 and RQ-09 are manual.
- **Nothing about `plan.md` paths.** It checks links, so a path cited in prose without a markdown link is
  invisible to it — RQ-06, RQ-40 and RQ-44 are manual.
- **Nothing about CONTRACTS ownership.** It does not parse [CONTRACTS.md](../CONTRACTS.md) or compare an
  epic's declared names against it — RQ-14, RQ-15, RQ-16, RQ-17 and RQ-20 are manual.
- **Nothing about the twelve program rules.** Additive-only, migrations, secrets, i18n, receipts, public
  hygiene, backup classification: all manual (RQ-21…RQ-38).
- **Nothing outside `docs/specs/features/app-works/`.** It never opens a source path, a migration, a workflow,
  `apps/web/messages/en.json` or `apps/docs/sidebarsPlatform.ts`, so it cannot confirm any claim about them.
- **No exit-code granularity.** `1` means "at least one finding in either group"; the reviewer reads the group
  headings. A finding in `ids` belonging to an epic still in flight is not a defect in the epic under review —
  record it and attribute it.

### 5.2 The other gates worth running with it

| Gate                                  | Command                                                                 | Checks                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Docs build (broken links, MDX)        | `pnpm --filter ever-works-docs build`                                   | README §7 rule 7's "no broken-link warnings" for anything under `docs/`.                                                       |
| In-product manual consistency (AW-25) | `pnpm --filter ever-works-web help:check`                               | The committed help catalog matches the docs; run it whenever a page listed in `apps/web/src/content/help/manual.json` changes. |
| Work-kind docs parity                 | `packages/contracts/src/domain/__tests__/work-kind-docs-parity.spec.ts` | Fails unless every Work kind appears in `docs/features/work-kinds.md` — APW-01 T29's gate.                                     |
| Format                                | `npx prettier --check <the epic's files>`                               | Only for files a reviewer adds; the sister programme documents are hand-formatted and not prettier-clean.                      |

---

## 6. Epic × item matrix

Walk the items in §3; record `✓` (met), `✗` (not met — with the finding) or `n/a` (with the reason, never
blank). `n/a` is a judgement about **this epic's scope**, not a statement that a rule does not apply to the
program — the twelve rules in RQ-21…RQ-32 always apply.

| Epic   | Reviewed | RQ-01…06 | RQ-07…12 | RQ-13…20 | RQ-21…32 | RQ-33…38 | RQ-39…45 | Reviewer | Date |
| ------ | -------- | -------- | -------- | -------- | -------- | -------- | -------- | -------- | ---- |
| APW-01 |          |          |          |          |          |          |          |          |      |
| APW-02 |          |          |          |          |          |          |          |          |      |
| APW-03 |          |          |          |          |          |          |          |          |      |
| APW-04 |          |          |          |          |          |          |          |          |      |
| APW-05 |          |          |          |          |          |          |          |          |      |
| APW-06 |          |          |          |          |          |          |          |          |      |
| APW-07 |          |          |          |          |          |          |          |          |      |
| APW-08 |          |          |          |          |          |          |          |          |      |
| APW-09 |          |          |          |          |          |          |          |          |      |
| APW-10 |          |          |          |          |          |          |          |          |      |
| APW-11 |          |          |          |          |          |          |          |          |      |
| APW-12 |          |          |          |          |          |          |          |          |      |
| APW-13 |          |          |          |          |          |          |          |          |      |

The empty matrix is the honest starting state: [TRACKER.md](../TRACKER.md) records all thirteen epics as
`Draft`, and no review has been run. The matrix is filled in place as reviews happen — it is never reset, and a
later review adds a new dated row rather than overwriting the previous one.

---

## 7. The review procedure (repeatable, in order)

1. **Freeze the revision.** Note the commit you are reviewing. Everything below is against that commit.
2. **Run the verifier.** `node docs/specs/features/app-works/tools/verify-spec-tree.mjs`. Record the raw output
   — the header counts, the `links` group, the `ids` group and the exit code — even when clean.
3. **Run the clarification check.** Grep the epic for `NEEDS CLARIFICATION`; for each hit find its
   [CLARIFICATIONS.md](../CLARIFICATIONS.md) row; apply §4. Record every marker with no row as a finding
   (RQ-11).
4. **Walk RQ-01…RQ-06** against `spec.md` alone. Then **RQ-07…RQ-12** against `spec.md` §7,
   [ACCEPTANCE.md](../ACCEPTANCE.md) and `tasks.md`'s `**Test**:` lines.
5. **Walk RQ-13…RQ-20** with [CONTRACTS.md](../CONTRACTS.md) open beside the epic's `plan.md`.
6. **Walk RQ-21…RQ-38** with README §7 and [CONTRACTS §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)
   open. For RQ-21/RQ-22 read every `**Modify**` line in `tasks.md` and ask what it takes away; if the answer
   is "nothing", it passes.
7. **Walk RQ-39…RQ-45** at the recorded baseline commit, path by path.
8. **Write the findings.** Each one: item id, `file:line`, what is wrong, and the smallest additive fix. A
   finding that needs a decision becomes a [CLARIFICATIONS.md](../CLARIFICATIONS.md) row, not a deletion; a gap
   inside the epic's own documents goes in that epic's `plan.md` "known gaps" section, per
   [TRACKER.md](../TRACKER.md) `:71-72`; a gap in a programme document is reported to the program lead instead.
9. **Fill the matrix row** in §6 with the reviewer's name and the date, and update
   [TRACKER.md](../TRACKER.md)'s spec column to `Reviewed` — or leave it `Draft` and say which blocking item
   failed.
10. **For `Approved`**, record the owner's sign-off and confirm §2's four conditions. A review that produced
    findings is not a failed review: the epic is `Reviewed` with findings, and `Approved` once they are fixed
    or explicitly waived by the owner.

Suggested cadence: **once per epic per wave**, plus a re-review whenever a `Modify` list, an `ACC-nn-nn` id set
or a wave assignment changes. Re-reviews are additive — a new dated row, never an edit of the previous one.

---

## 8. What this checklist is not

- **Not a spec template.** It does not restate `.specify/templates/spec-template.md`'s sections; it checks
  whether the epic filled them.
- **Not [ACCEPTANCE.md](../ACCEPTANCE.md).** That file is the end-to-end suite for the software; this one is
  about documents. Confusing them is how "all tests pass" comes to mean "the spec is right".
- **Not a gate on implementation.** An epic can be `Approved` and unbuilt, and
  [TRACKER.md](../TRACKER.md)'s implementation column is what tracks that, with `Verified` reserved for a
  green [ACCEPTANCE.md](../ACCEPTANCE.md) run on `develop`.
- **Not a licence to remove.** `n/a` records that an item does not apply to an epic's **scope**; it never marks
  an existing behaviour, capability, default, deploy shape or resolution "not applicable" or "obsolete" — that
  is [`R-26`](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5) and it
  needs the owner.
- **Not a substitute for the verifier.** §5.1 is deliberately explicit about what the machine cannot see; a
  clean verifier run is evidence for exactly two items out of forty-five.
