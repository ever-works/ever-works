# App Works — status tracker

Updated as work lands. Two independent axes per epic: **spec** and **implementation**.

- **Spec**: `—` not started · `Draft` written · `Reviewed` · `Approved`
- **Impl**: `—` not started · `In progress` · `PR open` · `Merged` · `Verified` (its [ACCEPTANCE.md](./ACCEPTANCE.md) scenarios green on develop)

Last refreshed **2026-09-17**, verified against `develop` @ `873274c9f` (2026-09-17; previously `e5f43f44d`, authored against `a655b53ca`). No pull request exists for any epic
yet. Jira tickets do not exist yet: every epic carries `EW-TBD` until the owner files the program epic and
one story per epic (the newest id on 2026-09-17 was EW-816). The draft bodies to file are
[JIRA-DRAFT.md](./JIRA-DRAFT.md) (current) and
[`_build-artifacts/open-decisions/jira-tickets.md`](./_build-artifacts/open-decisions/jira-tickets.md) (the
2026-09-17 draft, kept unchanged). Jira assigns the keys: file the program epic first, then the thirteen stories,
then replace every `EW-TBD` in the table below with the returned keys and keep the epic → story mapping. Never
put a guessed number in this column.

| ID     | Epic                                           | Wave      | Spec  | Impl | Jira   | Branch / PR | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------- | --------- | ----- | ---- | ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| APW-01 | App Work kind & create from any repository URL | 1         | Draft | —    | EW-TBD | —           | Needs APW-03 P2, APW-06 T2–T3 and APW-13 P0 first (R-38)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| APW-02 | Fork lifecycle                                 | 0 · 1     | Draft | —    | EW-TBD | —           | P0 (checkout keys, fork readiness) unblocks APW-01                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| APW-03 | App spec, Apps catalog, license gate           | 1 · 2 · 3 | Draft | —    | EW-TBD | —           | Needs **`ever-works/templates`** (the listing repository, created 2026-09-17) — the earlier drafts called it `ever-works/apps` (R-29)                                                                                                                                                                                                                                                                                                                                                                                                      |
| APW-04 | App Provisioner                                | 1         | Draft | —    | EW-TBD | —           | Needs agent + skill entries in `ever-works/agents`, `skills`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| APW-05 | Builds                                         | 1 · 3     | Draft | —    | EW-TBD | —           | PR-lane specs run in the APW-13 P0 harness (R-38)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| APW-06 | App runtime on Kubernetes                      | 1–3       | Draft | —    | EW-TBD | —           | Managed target stays off until APW-10 gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| APW-07 | App env & dependencies                         | 1 · 2     | Draft | —    | EW-TBD | —           | P1a (contracts, entities, providers) lands with the foundations; P1b needs APW-01/APW-06 (R-38)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| APW-08 | Evolve loop                                    | 0 · 1     | Draft | —    | EW-TBD | —           | P0 = agent git tool fix (independent PR). The audit round added FR-69…FR-76, S32…S36, **ACC-08-33…ACC-08-47** and **T47–T56** (tool policy, Fleet containment admission, operator switches, checks backfill/notification, accessibility, size limits, keyed thread posts, follow-up key, cost rollup); P1 therefore carries ACC-08-01…ACC-08-47                                                                                                                                                                                            |
| APW-09 | Upstream pull requests                         | 1 · 2     | Draft | —    | EW-TBD | —           | Its own spec puts **P1 in Wave 1** and P2–P3 in Wave 2; the earlier cell read `2` alone                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| APW-10 | Ever Works Apps hosting tier (launch gate)     | 2 · 3     | Draft | —    | EW-TBD | —           | Infra specifics in the private operations repository                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| APW-11 | App Launcher & Apps registry API               | 1 · 3     | Draft | —    | EW-TBD | —           | Reads `ever-works/platforms` (exists 2026-09-17). The audit round added FR-55…FR-66, S23…S26, ACC-11-41…ACC-11-54 and **T31–T33** (operator switch in the three deploy manifests, `app_launcher` Activity badge/i18n, non-production seed route) plus drafted catalog content in `APW-11-app-launcher/catalog-draft/`. Two owner items remain: the **visibility/token** of `ever-works/platforms` (R-29 — private at creation, while the reader fetches over the raw host) and the Wave 3 extraction repository + npm scope (EXT-30/CL-48) |
| APW-12 | Ever ID                                        | 2 · 3     | Draft | —    | EW-TBD | —           | Cross-repository (Ever Works, Teams, Gauzy)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| APW-13 | Golden paths & acceptance suite                | 0 · 1 · 2 | Draft | —    | EW-TBD | —           | Fixture app → Umami → Cal.diy; **P0 is the harness other epics' PR lanes need, so it lands in Wave 0** (SK-13, R-38)                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Merge order

1. **Wave 0 (independent, small):** APW-08 P0 (agent git tools) · APW-02 P0 (checkout keys, fork readiness) ·
   **APW-13 P0** (the test harness other epics' PR-lane specs run against: fake GitHub, the
   `EVER_WORKS_E2E_FAKES` non-production switch, helpers, `playwright.app-works.config.ts` — see
   [`APW-13/plan.md`](./APW-13-golden-paths/plan.md) §12).
2. **Wave 1 foundations (parallel):** APW-03 P1 · APW-02 P1 · APW-07 P1a · APW-11 P1 · **APW-09 P1** (its own
   spec and ACCEPTANCE both place APW-09 P1 in Wave 1; this row previously omitted it — see the note below).
3. **Wave 1 prerequisites for creation:** **APW-03 P2** (T22 `commitFiles`, T26 resolver + AppSourceCatalogAdapter,
   T28 apply job, T32 AppsCatalogBrowser — the pieces APW-01 P1 compiles against) · **APW-06 T2–T3**
   (`packages/agent/src/app-runtime/ports.ts` and `APPS_TIER_POLICY`, which APW-01 T12–T14 inject). These are
   small dependency PRs, not whole phases; they land before APW-01 P1 because APW-01 cannot build without them.
4. **Wave 1 creation and running:** APW-01 P1 → APW-05 P1 → APW-06 P1 → APW-04 P1.
5. **Wave 1 loop:** APW-08 P1 → APW-13 P1 (the owner's example green on a user cluster).
6. **Wave 2:** APW-10 P1–P2 → APW-06 P2 · **APW-07 P1b** (controllers, web, live acceptance) and APW-07 P2 →
   **APW-09 P2 · APW-09 P3** (both are Wave 2 per `APW-09/spec.md` and its plan §11 — P1 is the Wave 1 half,
   already in step 2) · APW-12 P1 → APW-13 P2.
7. **Wave 3:** APW-05 P3 · APW-06 P3 · APW-10 P3 · APW-11 P2 · APW-12 P2–P3.

**Revised 2026-09-17** (resolution R-38): the previous step 2 read "APW-03 P1 · APW-02 P1 · APW-07 P1 · APW-11 P1 ·
APW-09 P1", step 3 read "APW-01 P1 → APW-05 P1 → APW-06 P1 → APW-04 P1" and step 1 read "APW-08 P0 · APW-02 P0".
APW-13 P0 and the APW-03 P2 / APW-06 T2–T3 prerequisites were missing from every step, and APW-07 P1 was placed
before two of the epics its P1 needs; the order above adds them and moves nothing backwards, so no epic that was
already mergeable becomes blocked. The dependency columns in [README](./README.md) §5 and each epic's own
`Depends on` line are the other half of this rule — an epic's own spec wins over the table.

**Two ordering issues to settle before Wave 1 starts** (both discovered 2026-09-17; neither blocks Wave 0):

- **APW-06 ↔ APW-07 declare each other.** `APW-06/spec.md:14` depends on APW-07 ("env values, App dependencies")
  and `APW-07/spec.md:13-14` depends on APW-06 ("deploy target, cluster access, domains"). The merge order above
  lands APW-07 P1a first, so one direction must be softened. Recommended: **APW-07 owns the env/dependency
  contracts and lands first; APW-06 consumes them** — and APW-07's stated dependency on APW-06 becomes a
  dependency on APW-06's _ports/interfaces_ only, which APW-07 defines against in P1a. The half of APW-07 P1 that
  genuinely needs APW-06 (controllers, web, live acceptance) is **P1b** and lands after APW-06 P1: the phase
  split is recorded in [`APW-07/tasks.md`](./APW-07-app-env-and-dependencies/tasks.md).
- **README's dependency column** was corrected on 2026-09-17 to match each epic's own `Depends on` line
  (APW-04 +07, APW-05 +02/+07, APW-06 +10, APW-08 +03, APW-11 +12). Keep the two in step: an epic's own spec wins.

## Spec status criteria (what `Reviewed` and `Approved` mean)

The `Spec` column's `Reviewed` and `Approved` states are earned against a repeatable checklist, not a reading:
[`checklists/requirements.md`](./checklists/requirements.md) is that checklist, run per epic at its recorded
baseline commit.

- **`Reviewed`** — every item in `checklists/requirements.md` ticked by a **second reviewer**, with the
  unresolved items listed in the epic's own `plan.md` "known gaps" section rather than silently absorbed.
- **`Approved`** — `Reviewed`, plus the owner's sign-off and, for a wave, **no open blocking `[NEEDS
CLARIFICATION]` marker for that wave** ([`CLARIFICATIONS.md`](./CLARIFICATIONS.md) carries one row per marker
  with the wave it blocks; a marker whose default the specs already assume may be `default accepted` and does not
  block).
- The mechanical half of `Reviewed` is `node docs/specs/features/app-works/tools/verify-spec-tree.mjs`
  (links resolve, every ACC id is defined by an epic and indexed in [ACCEPTANCE](./ACCEPTANCE.md)) — it is
  necessary and not sufficient.

## Owner and operator actions the epics cannot take

These are tracked here because no epic owns them; each is a prerequisite for the wave named.

- **APW-12 P0 — Ever ID provider.** Owner decisions recorded 2026-09-17 (provider **ZITADEL**, self-hosted as-is,
  one instance for every platform at **`auth.ever.co`** — resolution R-28); the operator then stands the provider up
  in three environments, registers the clients, scopes, audiences and back-channel logout URIs of
  [`APW-12/idp-options.md`](./APW-12-ever-id/idp-options.md) §6.1, and records the development **Test connection**
  run (APW-12 T2 + T47).
- **GitHub App registrations per environment (EXT-15).** Before APW-02 P1 and APW-05 P1 merge, the owner updates
  the Ever Works GitHub App in **dev, stage and production** with the permissions and events of
  [`GITHUB-PERMISSIONS.md`](./GITHUB-PERMISSIONS.md), notifies every installation owner, and plans the
  **re-approval** GitHub requires from each of them when permissions grow — until an installation owner accepts,
  calls fail with `403` and the APW-02 permission-missing message is what users see. The APW-02 T42 contract probe
  is the confirmation.
- **Legal review (EXT-19).** README D13 makes the licence registry legal-reviewed before launch and
  [`APW-03/catalog.md`](./APW-03-app-spec-and-catalog/catalog.md) §7 rule 3 enforces a named reviewer through
  `ever-works/apps` CODEOWNERS, with amber entries requiring a filed upstream agreement. The owner names the legal
  reviewers and the GitHub team used in CODEOWNERS, commissions the review of `licenses.yml` and the policy drafts,
  and records outcomes and agreements in the private operations repository. Until then the registry ships marked
  "draft — legal review required" and no amber entry is published.
- **Test estate (EXT-04).** The organizations, machine user, long-lived repositories, test cluster(s), DNS zone,
  mail and canary sinks, and the `app-works-dev` / `app-works-stage` GitHub environments of
  [ACCEPTANCE](./ACCEPTANCE.md) §0.3–§0.4 are owner actions (APW-13 T20/T21); addresses live only in the private
  operations repository.

## Migration timestamp blocks

`1792` + two-digit epic + two-digit slot + `00000` (see README §7 rule 6; stamping rule: Resolution R-39). Newest
migration on `develop` when authored: `1791200100000-CreateOnboardingChecklists.ts`; on `ee45946e5` (re-verified
2026-09-17): `1791240000000-AddSafetyRailsCore.ts`; re-checked against `873274c9f` (2026-09-17, 21 commits later):
unchanged, so every reserved `1792…` timestamp is still above it. AW-24 P2 has reserved
`1791240100000-AddHeldActionExecution.ts`, also below the block.

**Stamp in merge order, not authoring order (R-39).** The merge order above is the sequence the values must
follow: a migration that lands later sorts above one that landed earlier **inside its own epic's slot**, and the
two-digit slot is chosen so that the epic order in the merge order is monotonic. The audit's concrete finding was
that APW-11 P1 (`1792110000000`) and APW-07 P1 (`1792070000000`) were scheduled _before_ APW-01/05/06
(`1792 01…`, `1792 05…`, `1792 06…`), which would have forced those epics to re-stamp out of their blocks; the
revised order in this file removes that inversion, and any future reordering re-checks this section. A contract
test reserves the `1792` prefix for App Works filenames and reports a foreign file inside the block, so unrelated
`develop` work cannot take a value here unnoticed.
