# App Works — documentation publication plan

**Program:** [App Works](./README.md) (`app-works`) · **Status:** `Draft` · **Created:** 2026-09-17
**Scope:** every user-facing page this program publishes, where it is published, who owns it, when it may go
live, and how it is registered in the product's own Help manual.
**Companion documents:** [README.md](./README.md) (§4 waves, §7 rule 10 public hygiene) · [TRACKER.md](./TRACKER.md)
(merge order — the wave a page publishes in follows the epic that owns it) · [ACCEPTANCE.md](./ACCEPTANCE.md)
(the scenarios a page's status claim depends on) · [CONTRACTS.md](./CONTRACTS.md) §8 (the catalog repositories)
· [JIRA-DRAFT.md](./JIRA-DRAFT.md) · [`checklists/requirements.md`](./checklists/requirements.md)

**This plan is additive.** Two user-documentation drafts exist and **both are kept**: nothing in either is
deleted, shortened or superseded, and no page listed here removes a page that already ships. Where two drafts
overlap, they are given different owners and different scopes, and each keeps its own wording (§2).

---

## 0. The single decision this plan exists to make

Twelve epics each add a page under `docs/features/` and each independently edits
`apps/docs/sidebarsPlatform.ts`. Nothing names who publishes `docs/features/app-works.md`, nothing names a
sidebar category or order, nothing registers any App Works page in the product's in-product Help manual, and
two drafts claim the same path with different publication gates. This plan fixes all four, and leaves every
existing instruction in place.

---

## 1. Where user documentation is published

There are **two** publication surfaces, and an App Works page normally needs both.

| Surface                        | What it is                                                                                                                                                                                                          | Where it comes from                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The documentation site**     | `https://docs.ever.works` — a Docusaurus app in `apps/docs` (`apps/docs/docusaurus.config.ts:89`, `baseUrl: '/'` at `:92`). Pages are markdown files under `docs/`; the sidebar is `apps/docs/sidebarsPlatform.ts`. | Any `.md` under `docs/` that is listed in the sidebar. §4 fixes the category; §5 is the page register.                                                                                           |
| **The in-product Help manual** | The Help drawer's **Manual** tab, `/help` and `/help/<article>`. Its articles **are** documentation-site pages: the manual does not hold a second copy of the text.                                                 | `apps/web/src/content/help/manual.json` lists which `docs/` pages are articles; `apps/web/scripts/build-help-catalog.mjs` turns them into the rendered manual. §6 is the registration procedure. |

`docs/features/index.md` is the documentation site's own index and has a **Work types & templates** section
(`docs/features/index.md:64`), whose first row is `./work-kinds` (`:70`). Every new page gets one row there, in
that section.

**Pages that are drafts stay where they are until their gate passes.** `docs/specs/features/app-works/`
is a spec tree, not a published directory — nothing under it is served by the docs site — so a draft can live
there safely, which is exactly what both existing drafts do. _(Corrected 2026-09-26: the spec tree **is**
served, as orphan pages the sidebar does not list — see §10 item 9. The drafts are still unlisted and unpublished.)_

---

## 2. The two existing drafts — reconciled additively

Both drafts are kept exactly as written. They are given **different owners and different scopes**, and their
overlapping material is resolved by keeping both wordings and cross-linking, never by deleting one.

| Draft                                                                                                          | Front-matter id  | What it covers                                                                                                                                                                                                                                 | Its own publication instruction                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`user-docs/app-works.md`](./user-docs/app-works.md) (168 lines)                                               | `app-works`      | The **App Work** narrative: how it works end to end, the three relations, the deploy targets, the App spec, upstream sync, proposing changes, licences, the App Launcher, safety, the planned API table.                                       | `:8-14` — "Not published: do not add to `apps/docs/sidebarsPlatform.ts` until APW-01…APW-08 P1 ship and `ACCEPTANCE.md` ACC-E2E-01…07 and 11 are green on develop", then move to `docs/features/app-works.md`, add a row to `docs/features/index.md`, register after `features/work-kinds`. No single-sign-on copy until APW-12 ships (launch-parity G-09). |
| [`APW-03-app-spec-and-catalog/user-doc-draft.md`](./APW-03-app-spec-and-catalog/user-doc-draft.md) (140 lines) | `app-blueprints` | The **App Blueprint and licence** narrative: three ways a spec is obtained, browsing the catalog, how a Blueprint lands in a repository, the App spec page, Blueprint upgrades, licence classes and the attestation, contributing a Blueprint. | `:8-14` — not listed in `apps/docs/sidebarsPlatform.ts`; task **T50** moves it to `docs/features/app-blueprints.md` once the feature ships, fixes relative links, points "Apps catalog API" at the shipped API page, and lists it next to `features/work-blueprints`.                                                                                       |

**The conflict, stated plainly:** `APW-01-app-work-kind/tasks.md:601-609` (task **T29**) creates
`docs/features/app-works.md` and lists it in `apps/docs/sidebarsPlatform.ts` **when APW-01 merges** — while the
draft's own header forbids publishing that page until APW-01…APW-08 P1 have shipped and six end-to-end
scenarios are green.

**The additive resolution — both instructions survive, because they govern different things:**

1. **T29 governs the file and its sidebar entry.** The page is created and listed when APW-01 merges. T29's
   instruction is not weakened, moved or struck.
2. **The draft's header governs the page's claims.** While any of its conditions is unmet, the page carries
   the `:::note Status — **Planned.** … Nothing on it is available yet. :::` callout it already has
   (`user-docs/app-works.md:20`), and it may not claim single sign-on
   (`:14`; the same constraint is stated for APW-11 at `APW-11-app-launcher/spec.md:20-22`).
3. **The callout is removed additively**, by changing `Planned.` to the shipped wording when the last
   condition is met — the note, its conditions and the page all stay; only the tense changes. The comment
   block at `:8-14` is kept as the record of the gate that was applied.
4. **Nothing is republished, moved back or deleted.** `user-docs/app-works.md` is moved to
   `docs/features/app-works.md` once (T29 creates the destination; if T29 landed first, the draft's content is
   merged into it and the draft file is **kept in place** as the spec-tree record, exactly as
   `APW-03`'s `user-doc-draft.md` is kept after T50).

**Overlapping content.** Both drafts describe the App spec and the licence classes. Neither loses its version:
`docs/features/app-works.md` keeps the `app-works` narrative and links to `app-blueprints` for the licence
table, and `docs/features/app-blueprints.md` keeps the licence table and links back. Two paragraphs saying
similar things in two pages is acceptable; a deleted paragraph is not.

---

## 3. Publication gate and owner, per page

One owner per page. "Owner" means the epic whose task creates it and whose wave decides when it may be listed —
not the person.

| Gate                    | Meaning                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G-1 — draft**         | The page lives under `docs/specs/features/app-works/` with the `DRAFT` comment block and a `Status` note. Not in any sidebar, not in the manual.                             |
| **G-2 — listed**        | The page is at its `docs/features/` path, has a sidebar entry, a `docs/features/index.md` row, and resolves its relative links. Its `Status` note may still say **Planned**. |
| **G-3 — available**     | The epic's `Verified` scenarios are green on `develop` ([TRACKER.md](./TRACKER.md) implementation column). The `Status` note says so, or is removed by changing its tense.   |
| **G-4 — in the manual** | The page is an article in `apps/web/src/content/help/manual.json` (§6), which additionally requires every screen it names to exist in the same change or an earlier one.     |

An epic's page reaches **G-2 in the wave its epic first ships** and **G-3 when its own acceptance scenarios are
green**. A page is never held back to a later wave because a _different_ epic is late — that is how a program
ends up with no documentation. It is also never advanced past G-3 to claim something the acceptance suite has
not proven.

---

## 4. The sidebar category and order

Twelve epics editing one flat list in `apps/docs/sidebarsPlatform.ts` is a merge conflict on every wave, and it
leaves a reader unable to tell which pages belong together. The fix is **one new category block**, which is
additive: no existing entry moves, and every epic's edit becomes "add my page to the App Works block" instead
of "insert my page somewhere in the Features list".

**Requested shape** (the file's existing shape, `apps/docs/sidebarsPlatform.ts:50-52`, is
`{ type: 'category', label: 'Features', link: { type: 'doc', id: 'features/index' }, items: [ … ] }`):

| Position                                        | Entry                                                                               | Added by   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- |
| immediately after `features/work-kinds` (`:64`) | the new **`App Works`** category, `link: { type: 'doc', id: 'features/app-works' }` | APW-01 T29 |
| inside the category, 1st                        | `features/app-works`                                                                | APW-01 T29 |
| 2nd                                             | `features/app-runtime`                                                              | APW-06     |
| 3rd                                             | `features/app-builds`                                                               | APW-05     |
| 4th                                             | `features/app-env-and-dependencies`                                                 | APW-07     |
| 5th                                             | `features/app-blueprints`                                                           | APW-03 T50 |
| 6th                                             | `features/app-provisioner`                                                          | APW-04     |
| 7th                                             | `features/app-works-evolve`                                                         | APW-08     |
| 8th                                             | `features/app-works-upstream-pull-requests`                                         | APW-09     |
| 9th                                             | `features/ever-works-apps`                                                          | APW-10     |
| 10th                                            | `features/app-launcher`                                                             | APW-11     |
| 11th                                            | `features/ever-id`                                                                  | APW-12     |

The order is **task order, not alphabet**: a reader meets the create-and-run path before the hosting tier, and
the two cross-platform pages (launcher, identity) come last. An epic that ships a page in a later wave appends
its entry in the position above and does not renumber anything — the block is append-only in practice, and the
positions in this table are the target state, not a reordering of anything that already exists.

`docs/features/index.md` gets **one row per page** in the **Work types & templates** section
(`docs/features/index.md:64`), in the same order, in the same pull request that adds the sidebar entry.

Two pages are created outside the list above and are not APW-13's (which adds no `docs/features/` page at all —
its evidence lives in [ACCEPTANCE.md](./ACCEPTANCE.md) and the nightly lanes):

- `docs/features/creating-a-work.md` gets one **App** row in its creation-methods table
  (`APW-01-app-work-kind/tasks.md:606`).
- `docs/features/work-kinds.md` gets the **App** row (`APW-01-app-work-kind/tasks.md:116`), which is a hard
  gate: `packages/contracts/src/domain/__tests__/work-kind-docs-parity.spec.ts` fails without it.
- `docs/features/work-blueprints.md` gets one row for the Apps catalog (`APW-03-app-spec-and-catalog/tasks.md:762`),
  and `docs/features/managed-hosting.md`'s Related list gets one link (`APW-11-app-launcher/tasks.md:381`).

---

## 5. Page register — twelve pages, one owner each

Paths are the **destination** under `docs/` (the docs site renders `docs/` as written; there is no `docs/`
prefix in the published URL). "Source draft" is where the text starts life; a source draft is never deleted.

| #   | Destination page                                                  | Owner (task)                     | Wave | Source draft                                                                                       | Status note                                |
| --- | ----------------------------------------------------------------- | -------------------------------- | ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | `docs/features/app-works.md`                                      | APW-01 (T29)                     | 1    | [`user-docs/app-works.md`](./user-docs/app-works.md)                                               | **Planned** until G-3 (see §2)             |
| 2   | `docs/features/app-runtime.md`                                    | APW-06 (`tasks.md:734-736`)      | 1→3  | —                                                                                                  | Planned until G-3                          |
| 3   | `docs/features/app-builds.md`                                     | APW-05 (`tasks.md:661-663`)      | 1→3  | —                                                                                                  | Planned until G-3                          |
| 4   | `docs/features/app-env-and-dependencies.md`                       | APW-07 (`tasks.md:478-480`)      | 1→2  | —                                                                                                  | Planned until G-3                          |
| 5   | `docs/features/app-blueprints.md`                                 | APW-03 (T50, `tasks.md:759-762`) | 1    | [`APW-03-app-spec-and-catalog/user-doc-draft.md`](./APW-03-app-spec-and-catalog/user-doc-draft.md) | Planned until G-3                          |
| 6   | `docs/features/app-provisioner.md`                                | APW-04 (`tasks.md:687-689`)      | 1    | —                                                                                                  | Planned until G-3                          |
| 7   | `docs/features/app-works-evolve.md`                               | APW-08 (`tasks.md:643-645`)      | 1    | —                                                                                                  | Planned until G-3                          |
| 8   | `docs/features/app-works-upstream-pull-requests.md`               | APW-09 (`tasks.md:415-417`)      | 2    | —                                                                                                  | Planned until G-3                          |
| 9   | `docs/features/ever-works-apps.md`                                | APW-10 (`tasks.md:580-583`)      | 2    | —                                                                                                  | Planned until G-3                          |
| 10  | `docs/features/app-launcher.md`                                   | APW-11 (`tasks.md:379-383`)      | 1→3  | —                                                                                                  | **No sign-on claims** until APW-12 ships   |
| 11  | `docs/features/ever-id.md`                                        | APW-12 (`tasks.md:478-484`)      | 2    | —                                                                                                  | Listed only in the PR that enables Ever ID |
| 12  | _(none — APW-13 documents through `ACCEPTANCE.md` and the lanes)_ | APW-13                           | 1→2  | —                                                                                                  | —                                          |

Two of the epics already constrain their own page and the plan keeps both constraints as written:

- **APW-10** requires `docs/features/ever-works-apps.md` to contain no address, host name, cluster or node name
  and no infrastructure detail (`APW-10-apps-hosting-tier/tasks.md:583`) — program rule 10.
- **APW-12** lists `docs/features/ever-id.md` in the sidebar only in the pull request that enables Ever ID
  (`APW-12-ever-id/tasks.md:482`), which is stricter than G-2 and wins.

Every page is checked with `pnpm --filter ever-works-docs build`, and an epic's task is not done until that
build has no broken-link warning (this is what `APW-01-app-work-kind/tasks.md:608-609` and
`APW-04-app-provisioner/tasks.md` require, and what `.specify/templates/tasks-template.md:90` requires
program-wide).

---

## 6. In-app Help registration

**Nothing in the program registers an App Works page in the Help manual today.** Grepping the whole spec tree
for `manual.json`, `build-help-catalog` or `help-catalog` returns no match outside this plan — so the manual
would stay silent about the entire program even after the pages ship. This section is the procedure.

### 6.1 How the manual works (verify before relying on any of this)

| Piece                                             | Role                                                                                                                                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/content/help/manual.json`           | The list of articles. **This is the only file a page's registration adds.**                                                                                                                                      |
| `apps/web/scripts/build-help-catalog.mjs`         | The generator. Writes the committed catalogue and the runtime bodies. Never hand-edited.                                                                                                                         |
| `apps/web/src/lib/help/help-catalog.generated.ts` | Committed metadata; the `HelpTarget` type is derived from it, so a `HelpLink` to an article or heading this build does not have is a **`tsc` error**. It is generated — editing it by hand fails its drift test. |
| `apps/web/public/help-content/<id>.json`          | The rendered bodies, written on every build and `dev` start, served by the deployment. Gitignored.                                                                                                               |
| `apps/web/src/content/help/README.md`             | The rules, for whoever edits `manual.json`. Every constraint below is from it.                                                                                                                                   |

Commands and gates:

```bash
pnpm --filter ever-works-web help:build    # rewrite the catalogue after editing manual.json or a listed page
pnpm --filter ever-works-web help:check    # answer the same question locally, without writing
```

`apps/web/src/lib/help/help-catalog.unit.spec.ts` runs in CI and fails when the committed catalogue no longer
matches the documentation. **A page listed in `manual.json` may not contain raw HTML, JSX or images** — the
generator emits a closed block grammar (paragraphs, `##`/`###` headings, lists, callouts, tables, code blocks,
inline bold/emphasis/code/links) and reports anything else as a warning while the catalogue spec fails.

### 6.2 The rules each entry must satisfy

| Field        | Rule                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| article id   | The page's front-matter `id` (or its file name) — 3–64 lowercase letters, digits and hyphens, **never reused**. `app-works` and `app-blueprints` are already taken by the two drafts.                                                 |
| `source`     | The path of a markdown page under `docs/`.                                                                                                                                                                                            |
| `section`    | Exactly one of **`start-here`**, **`running-the-loop`**, **`your-agents`**, **`setup-and-connections`**, **`money-and-limits`**, **`when-something-goes-wrong`**. There is no seventh section and none may be added for this program. |
| `order`      | Integer position inside that section.                                                                                                                                                                                                 |
| `summary`    | One plain-language line, at most 200 characters.                                                                                                                                                                                      |
| `keywords`   | At most 12, each at most 32 characters — the words people type, not the words the page leads with.                                                                                                                                    |
| `documents`  | **Keys of `ROUTES`** in `apps/web/src/lib/constants.ts` — never literal paths. At most 8. `DASHBOARD_NOTIFICATIONS` is dead and is refused.                                                                                           |
| `related`    | At most 5 other article ids from this manual.                                                                                                                                                                                         |
| `reviewedAt` | `YYYY-MM-DD` — the day someone last checked the page against the product.                                                                                                                                                             |
| title        | At most 70 characters, from the page's front matter.                                                                                                                                                                                  |
| —            | **An article may only document a screen that exists in the same change or an earlier one.** (Emphasis added.)                                                                                                                         |

### 6.3 The `documents` problem, and what it means for sequencing

`documents` must name **existing** `ROUTES` keys. Checked today in `apps/web/src/lib/constants.ts`, the keys
an App Works manual would want **do not all exist yet**:

| Wanted key                     | Exists today? | Exists                                                                          |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------- |
| Works list / new Work / a Work | yes           | `DASHBOARD_WORKS` `:144`, `DASHBOARD_WORKS_NEW` `:145`, `DASHBOARD_WORK` `:146` |
| Work Activity                  | yes           | `DASHBOARD_WORK_ACTIVITY` `:147`                                                |
| Work pull requests             | yes           | `DASHBOARD_WORK_PULL_REQUESTS` `:149`                                           |
| Work Deploy                    | yes           | `DASHBOARD_WORK_DEPLOY` `:158`                                                  |
| Work Settings                  | yes           | `DASHBOARD_WORK_SETTINGS` `:160`                                                |
| Help                           | yes           | `DASHBOARD_HELP` `:305`, `DASHBOARD_HELP_ARTICLE` `:306`                        |
| Builds tab                     | **no**        | add with APW-05's Builds tab                                                    |
| Upstream tab                   | **no**        | add with APW-02's Upstream tab (`R-8`)                                          |
| App spec settings page         | **no**        | add with APW-03's App spec page                                                 |
| Apps catalog browser           | **no**        | add with APW-03's catalog browser                                               |
| App Launcher panel / settings  | **no**        | add with APW-11                                                                 |
| Connected identities settings  | **no**        | add with APW-12                                                                 |

**Consequence:** a **new `ROUTES` key is added in the same pull request as the screen it points at**, and the
manual entry that names it lands in that same pull request or a later one — never earlier. That constraint is
the help README's own rule (`:42-43`), not an addition by this plan.

### 6.4 The entries to add

An article is registered **once**, when its page is at least at G-2; its `documents` list may be extended
later as the screens it names come into existence (additively — an entry is never removed, and an article id
is never reused).

| Article id                         | Page                                                | Section                 | Registers in wave | `documents` (grows as keys are added)                                       |
| ---------------------------------- | --------------------------------------------------- | ----------------------- | ----------------- | --------------------------------------------------------------------------- |
| `app-works`                        | `docs/features/app-works.md`                        | `start-here`            | 1                 | `DASHBOARD_WORKS`, `DASHBOARD_WORKS_NEW`, `DASHBOARD_WORK`                  |
| `app-runtime`                      | `docs/features/app-runtime.md`                      | `running-the-loop`      | 1                 | `DASHBOARD_WORK`, `DASHBOARD_WORK_DEPLOY`                                   |
| `app-builds`                       | `docs/features/app-builds.md`                       | `running-the-loop`      | 1                 | `DASHBOARD_WORK` + the Builds-tab key APW-05 adds                           |
| `app-env-and-dependencies`         | `docs/features/app-env-and-dependencies.md`         | `setup-and-connections` | 1                 | `DASHBOARD_WORK_SETTINGS` + APW-07's settings key                           |
| `app-blueprints`                   | `docs/features/app-blueprints.md`                   | `start-here`            | 1                 | APW-03's catalog and App-spec keys                                          |
| `app-provisioner`                  | `docs/features/app-provisioner.md`                  | `running-the-loop`      | 1                 | `DASHBOARD_WORK`                                                            |
| `app-works-evolve`                 | `docs/features/app-works-evolve.md`                 | `running-the-loop`      | 1                 | `DASHBOARD_WORK`, `DASHBOARD_WORK_ACTIVITY`, `DASHBOARD_WORK_PULL_REQUESTS` |
| `app-works-upstream-pull-requests` | `docs/features/app-works-upstream-pull-requests.md` | `running-the-loop`      | 2                 | the Upstream-tab key APW-02 adds (`R-8`)                                    |
| `ever-works-apps`                  | `docs/features/ever-works-apps.md`                  | `money-and-limits`      | 2                 | `DASHBOARD_WORK_DEPLOY`                                                     |
| `app-launcher`                     | `docs/features/app-launcher.md`                     | `setup-and-connections` | 1                 | the launcher key APW-11 adds                                                |
| `ever-id`                          | `docs/features/ever-id.md`                          | `setup-and-connections` | 2                 | the connected-identities key APW-12 adds                                    |

Plus **one article on failure modes**, which is where a person actually needs the manual:

| Article id          | Page                                                      | Section                     | Registers in wave | Covers                                                                                                    |
| ------------------- | --------------------------------------------------------- | --------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| `app-works-trouble` | `docs/features/app-works.md` §"When something goes wrong" | `when-something-goes-wrong` | 1                 | A failed build, a failed deployment, an invalid App spec, a missing value, a fork that never became ready |

Two constraints on that last row, both additive: a second manual article may share a **page** with another
article (the id is the page's front-matter `id`, so the second article needs its own front matter or must be a
distinct page) — the simplest compliant reading is **a distinct page**, `docs/features/app-works-trouble.md`,
owned by APW-01 T29 in the same change. And a manual article's headings become link targets, so **no existing
heading is renamed** to fit a help link.

**One sentence for the epics:** each of the twelve tasks that creates a `docs/features/` page gains one line —
_"and add its `manual.json` entry per `DOCS-PLAN.md` §6.4, then run `pnpm --filter ever-works-web help:build`"_ —
and no task loses a line.

---

## 7. Versioning per wave

**There is no Docusaurus versioning in this repository, and this plan does not add any.** Verified:
`apps/docs` has **no `versioned_docs/` directory**, and `apps/docs/docusaurus.config.ts` sets no `version`,
`lastVersion` or `onlyIncludeVersions`. The site publishes one current state of `docs/`.

That is the correct shape for a pre-launch program, and it means wave versioning has to be carried by four
explicit things instead of by a version selector:

| Carrier                                | What it does                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The publication gate per page** (§3) | G-1 → G-2 → G-3 → G-4. A page appears in the wave its epic ships, and its `Status` note is what tells a reader whether the behaviour is live.                                                                                  |
| **The `Status` note's tense**          | `Planned.` → present tense when G-3 is reached. This is the only edit the note ever receives; the note is never deleted, and the `DRAFT` comment block at `user-docs/app-works.md:9-14` is kept as the record of the gate.     |
| **`reviewedAt` in `manual.json`**      | `YYYY-MM-DD`. Re-stamped when someone re-checks the page against the product, which is the manual's own drift signal.                                                                                                          |
| **Wave sections inside a page**        | Where a page spans waves (runtime, builds, env, launcher, Ever ID), the behaviour that arrives later is written as its own section marked with its wave — an **addition** to the page, never a rewrite of the earlier section. |

**Additive rule for a page that spans waves** (the same rule as `R-26`, applied to documentation): a Wave 2
behaviour is added as a new section or a new paragraph. Nothing written for Wave 1 is deleted, reworded away or
marked obsolete when Wave 2 lands; if a Wave 1 sentence becomes wrong, it is corrected in place with the
correction visible, not removed.

**When the program reaches Wave 3 and a reader needs "what worked in Wave 1"**, that question is answered by
[ACCEPTANCE.md](./ACCEPTANCE.md) and [TRACKER.md](./TRACKER.md), not by a second copy of the documentation —
which is the same principle the manual already applies to itself.

---

## 8. The Blueprint authoring guide (external contributors)

The Apps catalog's Blueprints are contributed by people outside this repository, and **no contributor-facing
guide is drafted anywhere**. The nearest thing is the "Contributing a Blueprint" section of
`APW-03-app-spec-and-catalog/user-doc-draft.md:124-134`, which is currently written for a **user** of the
product, not for a **contributor** to the catalog.

| What                                       | Where it belongs                                                                                                                                                                             | Owner        | Wave |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---- |
| **Normative contributor guide**            | `CONTRIBUTING.md` in the catalog repository `ever-works/templates` — the repository that holds `manifest.json`, `licenses.yml` and the CI validation.                                        | APW-03       | 1    |
| Repository layout and `overlay.yml` format | `APW-03-app-spec-and-catalog/catalog.md` §5 (normative, already drafted)                                                                                                                     | APW-03       | 1    |
| Blueprint repository requirements          | `ever-works/<app>-template`, topic `ever-works-app-blueprint`, a valid App spec, a `v<version>` release ([CONTRACTS §8](./CONTRACTS.md#8-catalog-repositories-outside-this-monorepo) `:524`) | APW-03       | 1    |
| Human-facing entry point                   | The "Contributing a Blueprint" section of `docs/features/app-blueprints.md`, pointing at the normative guide                                                                                 | APW-03 (T50) | 1    |
| Evidence and verification                  | `evidence/<id>/` in the catalog repository, written by APW-13                                                                                                                                | APW-13       | 1→2  |

The guide is a **catalog-repository** artifact, not a documentation-site page, because it describes a repository
outside this monorepo and its CI is what enforces it. The documentation site gets the pointer, as drafted.

---

## 9. Stale names and claims to correct — additively

Both drafts and [TRACKER.md](./TRACKER.md) name the Apps catalog repository as `ever-works/apps`. It was
renamed to **`ever-works/templates`** on 2026-09-17 ([README §1](./README.md#1-vocabulary-no-new-synonyms)
`:73`), and [CONTRACTS §8](./CONTRACTS.md#8-catalog-repositories-outside-this-monorepo) `:523` records both the

rename and the fact that `EVER_WORKS_APPS_CATALOG_REPO` accepts either name.

| `file:line`                                                    | Current text                                           | Additive correction                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `APW-03-app-spec-and-catalog/user-doc-draft.md:24`             | a link to `https://github.com/ever-works/apps`         | Point at `ever-works/templates`; keep the old name mentioned as the previous name, because the drafts and the tracker used it. |
| `APW-03-app-spec-and-catalog/user-doc-draft.md:131` and `:134` | "Add an entry to `manifest.json` in `ever-works/apps`" | Same: `ever-works/templates`, with the old name kept as "(previously `ever-works/apps`)".                                      |
| `TRACKER.md:16`                                                | "Needs the `ever-works/apps` catalog repository"       | `ever-works/templates` (kept as a shared-file request — the tracker is owned by the program lead).                             |
| `_build-artifacts/open-decisions/jira-tickets.md:202`          | same stale name, in the earlier Jira draft             | Left as it is: [JIRA-DRAFT.md](./JIRA-DRAFT.md) §5 records the correction and the artifact stays as the record of 2026-09-17.  |

Two further corrections that are **not** renames and must not become renames:

- `user-docs/app-works.md:106` links the full field reference to `../APW-03-app-spec-and-catalog/schema.md`,
  while `APW-03-app-spec-and-catalog/user-doc-draft.md:83` links it to
  `../../../../agent-services/works-yml-schema.md#app`. **Both are correct for their location** — a spec-tree
  draft and a published page resolve different paths. Keep both; the published pages should link the published
  reference and may additionally link the spec tree.
- `APW-03-app-spec-and-catalog/user-doc-draft.md:32` uses the term **"Unlisted Blueprint"**. It is consistent
  with README §2 D4's resolution order; it is not renamed and no synonym is introduced.

---

## 10. Open items in this plan

| #   | Item                                                                                                                                                                                | Owner             | Blocked by                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| 1   | Decide whether the failure-modes article is its own page (`docs/features/app-works-trouble.md`) or a section — §6.4 recommends its own page.                                        | APW-01            | the `start-here` / `when-something-goes-wrong` split |
| 2   | Confirm the **App Works** sidebar category name and position with the docs owner (§4).                                                                                              | program lead      | —                                                    |
| 3   | Add the missing `ROUTES` keys each screen needs (§6.3) in the same pull request as the screen.                                                                                      | the screen's epic | —                                                    |
| 4   | Name the person who walks the manual's `reviewedAt` re-checks per wave.                                                                                                             | program lead      | —                                                    |
| 5   | Draft the normative `CONTRIBUTING.md` in `ever-works/templates` (§8).                                                                                                               | APW-03            | the catalog repository, which already exists         |
| 6   | Correct the stale catalog repository name in [TRACKER.md](./TRACKER.md) `:16` (§9).                                                                                                 | program lead      | —                                                    |
| 7   | Decide the launcher web component's publication location, which changes where its documentation lives (README §8 question 7; [CLARIFICATIONS.md](./CLARIFICATIONS.md) `CL-48`).     | owner             | the owner's answer                                   |
| 8   | Decide whether the App Works pages join the manual's `start-here` section or a program-specific order — §6.4 places them by reader intent, and the manual's six sections are fixed. | program lead      | —                                                    |
| 9   | Decide whether `docs/specs/**` and `docs/internal/**` may stay URL-reachable on docs.ever.works (they are served as orphan pages today — see the note below this table).            | owner             | —                                                    |

**Item 9, the evidence (recorded 2026-09-26; nothing was changed).** The docs site serves every markdown file under
`docs/`, whether or not the sidebar lists it: `apps/docs/docusaurus.config.ts:128-143` sets `path: '../../docs/'` and
`routeBasePath: '/'` with no `exclude`, and `.deploy/docker/docs/Dockerfile:58` copies all of `docs/` into the image.
Only `_`-prefixed directories (`_build-artifacts/`, for example) are skipped, by Docusaurus's default exclude. Checked
live on 2026-09-26: `https://docs.ever.works/internal/COVERAGE-STATUS` (after a trailing-slash redirect) and
`https://docs.ever.works/specs/` answer `200`, and a made-up path answers `404`. So `docs/specs/**` and `docs/internal/**` are **reachable orphan pages** — hidden
from the navigation, not from the site — and once this branch reaches `main` the whole App Works spec tree and
`docs/internal/app-works-*.md` become URL-reachable. This corrects §1's sentence that nothing under the spec tree is
served. The owner decides whether that is acceptable, or whether the docs build should exclude those trees; this plan
does not act on it.

---

## 11. What this plan does not do

- **It does not delete, shorten or supersede either existing draft.** `user-docs/app-works.md` and
  `APW-03-app-spec-and-catalog/user-doc-draft.md` both keep their full content, their front matter, their
  `DRAFT` comment blocks and their own instructions; §2 reconciles the one instruction that conflicts with
  `APW-01` T29 by reading the two as governing different things.
- **It does not move a page itself.** Every move is an epic task's job (T29, T50, and the per-epic doc tasks in
  §5); this plan names the destination, the gate and the owner.
- **It does not add a Docusaurus version, a docs branch, or a second documentation site** (§7).
- **It does not add a Help section.** The manual's six sections are fixed; App Works pages are placed in the
  existing ones.
- **It does not change `apps/docs/sidebarsPlatform.ts`, `docs/features/index.md`, `manual.json` or any epic's
  `tasks.md`.** Each of those is another owner's file; the exact additions are listed here and in the
  shared-file requests delivered with this plan.
- **It does not publish anything.** Every page in §5, and every manual entry in §6.4, waits for its wave.
