# Feature Specification: App spec, Apps catalog and license gate

> Behaviour-first spec per [Constitution Principle IX](https://github.com/ever-works/ever-works/blob/develop/.specify/memory/constitution.md#ix-specs-are-behaviour-first).
> Describes **what** the system does for the user. Implementation lives in [`plan.md`](./plan.md); the
> field-level contract lives in [`schema.md`](./schema.md) and [`catalog.md`](./catalog.md).

**Feature ID**: `APW-03-app-spec-and-catalog`
**Program**: [App Works](../README.md) — Wave 1
**Branch**: `feat/apw-03-app-spec-and-catalog`
**Status**: `Draft`
**Created**: 2026-09-17
**Last updated**: 2026-09-17
**Owner**: Product
**Size**: L · **Depends on**: — · **Depended on by**: APW-01, 02, 04, 05, 06, 07, 08, 09, 11, 13

> **Additive-only (program rule #1).** Every existing Work kind validates `.works/works.yml` exactly as it
> does today; unknown keys are still never deleted from a user's file. The Work Blueprints catalog, its
> endpoint and its picker are untouched. Everything below is new surface for App Works.

---

## 1. Overview

An App Work is only as good as its description of how to build and run the software. This epic makes that
description — the **App spec** — a first-class, validated file in the user's own Work Repository, and
gives it three things around it. First, **validation that explains itself**: every problem names the
exact field by its component or variable name, the line and column, and how to fix it — for a person in
Settings and for the App Provisioner agent writing the file. An invalid file never takes a running app
down; the last valid spec stays in effect. Second, the **Apps catalog**: a curated list of **App
Blueprints** — ready-made App specs for known open-source projects — browsable when creating an App Work
and matched automatically when a user pastes a repository URL, including repositories that were renamed.
A Blueprint is applied as a commit to a freshly created fork, or as a pull request anywhere else, and newer
Blueprint versions arrive as pull requests that keep the user's own edits. Third, a **license gate** that
reads the repository's license, classifies it, and decides where the app may run: permissive and copyleft
licenses anywhere; source-available and non-commercial licenses on the user's own cluster only after the owner
confirms the terms; source-available licenses on the managed tier only under a recorded agreement with the
app's authors; non-commercial and no-hosting licenses never on the managed tier and never in the catalog.
Licenses that require offering source to network users produce a visible source link; trademarked names carry
"(community build)".

> **Program audit resolutions applied (2026-09-17).** [CONTRACTS.md §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)
> is binding: R-1 (shared types in the program's one contracts folder), R-2 (Activity naming), R-3 (red and amber
> licenses), R-4 (first write into the Work Repository), R-5 (managed-tier availability comes from the tier's own
> open state), R-11 (key pair formats), R-13 (`auto` zero-config builds) and R-22 (runnable test locations). Where
> this spec's earlier text disagreed, it was changed to match.

## 2. Why now

### 2.1 The user's question

> _"How does Ever Works know how to run this repository — and how do I know it's right, and allowed?"_

### 2.2 What they do today instead

| The need                                         | What Ever Works offers today                                                                                            | What the user actually does                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Describe how to build and run arbitrary software | `.works/works.yml` has typed specs for content kinds and for Repository Works — nothing for running software.           | Writes Dockerfiles and manifests by hand, outside the product. |
| Find out a config file is wrong                  | Validation is advisory and logged server-side; a typo in a spec field produces a Work that quietly ignores it.          | Discovers it when a deploy behaves strangely.                  |
| Start from something known to work               | Work Blueprints list platform templates only; there is no catalog of open-source apps and nothing matches a pasted URL. | Searches the web for a compose file.                           |
| Know whether hosting is allowed                  | Nothing reads a repository's license.                                                                                   | Guesses, or does not think about it.                           |

### 2.3 The gaps

1. **No contract for "how to run it".** Five epics (builds, runtime, env, evolve loop, upstream) need the
   same answers from one file. Without one strict schema, each would parse its own subset and drift.
2. **Silent misconfiguration is expensive here.** A misspelled probe or an unresolved database reference
   does not fail a render — it fails a production boot hours later, after a paid build.
3. **Hosting other people's software has legal edges**, and licenses change: a gate that runs once at
   creation is not enough.

### 2.4 What this epic changes

```
   BEFORE: paste URL ──► nothing knows how to run it
   AFTER:  paste URL ─► catalog match? ─yes─► Blueprint (commit or PR) ─┐
                              └─no─► App Provisioner (APW-04) ─► PR ────┤
                                                                        ▼
           App spec in .works/works.yml ─► validated on every push ─┬─ valid ─► effective spec ─► builds, deploys
                                                                    └─ invalid ─► problems with lines; last valid kept
           license gate ─► where it may run (None · Your cluster · Ever Works Apps)
```

## 3. User scenarios

### 3.1 Primary

- **S1 — Pick an app from the catalog.** **Given** the App creation step, **when** the user opens
  **Browse the Apps catalog** and types `cal`, **then** the grid narrows to the Cal.diy card showing its
  icon, summary, **Beta**, `MIT · Open license`, and **Runs on: Your cluster**; **Use this app** fills the
  repository URL with `calcom/cal.diy` and marks the Blueprint as matched.
- **S2 — A renamed repository still matches.** **Given** a user pastes `https://github.com/calcom/cal.com`,
  **when** the repository is inspected, **then** the match reads **App Blueprint found: Cal.diy** because
  the old name is an alias and GitHub reports the repository under its new name.
- **S3 — A fresh fork gets the Blueprint as a commit.** **Given** the user creates a Fork App Work with the
  Cal.diy Blueprint, **when** the fork is ready, **then** one commit titled
  `chore(ever-works): apply App Blueprint cal 1.0.0` adds `.works/works.yml` — the recorded source and the
  Blueprint's App spec together — and the Blueprint's overlay files, made without cloning the repository; Activity
  records **Blueprint matched** before **Blueprint applied**; and Settings → App spec shows **App spec is valid.**
  within 60 seconds.
- **S4 — A linked repository gets a pull request.** **Given** a Link App Work on the user's own
  repository, **when** a Blueprint is applied, **then** nothing is pushed to the default branch; a pull
  request from `ever-works/blueprint/cal-1.0.0` is opened and linked from the App spec page.
- **S5 — A hand edit is checked on push.** **Given** a valid effective spec, **when** the user pushes a
  commit that renames `port` to `replica` on the `web` component, **then** within 60 seconds the page reads **The App
  spec on main has 2 errors.**, lists `unknown_field` at `components › web › replica` (line 41, "Did you
  mean `replicas`?") and `web_component_needs_port`, each with **Open in repository** at that line — and
  the running app is untouched.
- **S6 — An agent validates its draft.** **Given** the App Provisioner has drafted a spec, **when** it
  submits the text for validation, **then** it receives structured problems (code, path, line, hint) in
  under 2 seconds and nothing is stored.
- **S7 — Upgrade a Blueprint.** **Given** an App Work on Cal.diy Blueprint 1.0.0 whose owner changed
  `replicas`, **when** the catalog publishes 1.1.0, **then** within 2 hours the page shows **Blueprint
  1.1.0 is available.**; **Review upgrade** opens a pull request that updates the spec and keeps
  `replicas` as the owner set it.
- **S8 — A network copyleft license needs a source link.** **Given** an App Work whose license is
  `AGPL-3.0-only`, **when** the license is classified, **then** the License card reads **Source link
  required** and every Deployment of a modified commit exposes a Source link to that commit.
- **S9 — A source-available license needs confirmation.** **Given** a repository licensed `BUSL-1.1` whose
  catalog entry records no agreement with its authors, **when** the owner opens deploy targets, **then** Ever
  Works Apps is unavailable with its reason, Your cluster needs confirmation, and **Review and confirm** records
  who confirmed, when, for which license text and commit. The same repository under an entry that records an
  agreement with its authors may also run on Ever Works Apps, subject to the managed tier's other conditions.

### 3.2 Unhappy paths

- **S10 — The catalog is down.** **Given** the catalog repository is unreachable, **when** the user opens
  the browse tab, **then** it reads **The Apps catalog is unavailable right now.** and the paste-URL tab
  keeps working; a pasted URL resolves to "no Blueprint" and continues to the App Provisioner.
- **S11 — The ref is excluded.** **Given** a Blueprint whose upstream excludes tags `v6.*`, **when** a user
  pastes a URL pointing at tag `v6.2.0`, **then** the match reads **This Blueprint doesn't cover that
  version.** and nothing is applied automatically.
- **S12 — No spec yet.** **Given** an App Work whose Work Repository has no `.works/works.yml`, **then** the
  page reads **No App spec yet.** with **Browse Blueprints** and **Run the App Provisioner**.
- **S13 — Broken or oversized YAML.** An unclosed quote yields exactly one `yaml_syntax` error at its line; a
  300 KiB file yields one `file_too_large`. Either way the effective spec stays on the previous commit.
- **S14 — A literal secret in build arguments.** **Given** `build.args` contains a pasted API key, **then**
  the error `literal_secret_in_build_args` names the argument, never shows the value, and the spec is not
  applied.
- **S15 — Approval cannot be switched off.** **Given** `upstreamPullRequests.requireApproval: false`,
  **then** the error reads **Upstream pull requests always need a person's approval.**
- **S16 — Upstream relicenses.** **Given** an App Work classified `MIT`, **when** an Upstream sync brings a
  source-available license, **then** the owner is notified, **The license changed from MIT to BUSL-1.1**
  appears, the running Deployment keeps running, and the next Deployment waits for confirmation.
- **S17 — Unlisted Blueprint.** **Given** no manifest match but `ever-works/<repo>-template` exists with the
  Blueprint topic and a valid spec, **then** it is offered as **Unlisted Blueprint**, never **Verified**,
  never eligible for Ever Works Apps.
- **S18 — The pinned Blueprint commit is gone.** **Given** a manifest entry whose sha no longer exists,
  **when** applying, **then** the apply fails with **This Blueprint's pinned version is missing. Try again
  later or run the App Provisioner.** and nothing is written.
- **S19 — A non-commercial license.** **Given** a repository whose license the registry classifies `red`, **then**
  the Apps catalog never lists it, Ever Works Apps is never offered for it, and Your cluster is allowed only after the
  Work owner confirms the restriction; a manager pressing **Review and confirm** is refused.

### 3.3 Race and permission edges

- **S20 — Two pushes seconds apart.** **Given** pushes A then B, **when** A's evaluation finishes after
  B's, **then** the page shows B's result; A never overwrites it.
- **S21 — Re-check during an evaluation.** **Given** an evaluation in flight, **when** the owner presses
  **Re-check now**, **then** no second evaluation starts; the button reads **Checking…**.
- **S22 — A viewer / a stranger.** A member with view access sees the spec, problems and license without
  **Re-check now**, **Review upgrade** or **Review and confirm**; another account's Work answers **not found**.
- **S23 — Upgrade PR already open.** **Given** an open upgrade pull request for 1.1.0, **when** 1.2.0 is
  published, **then** the same pull request is updated to 1.2.0; no second one is opened.
- **S24 — A Task edits guarded blocks.** **Given** an agent's Task pull request changes `license.class` or
  removes a `display.protectedPaths` entry, **then** the change is flagged as needing a person and does not
  pass the quality gate on its own.
- **S25 — A Blueprint chosen for a repository no entry lists.** **Given** a repository generated moments ago
  (for example a per-run test upstream) that no manifest entry or alias names, **when** the App Work is created
  with an explicit Blueprint id, **then** that Blueprint is applied exactly as a matched one would be, Activity
  records **Blueprint matched** with match source "explicit", and the App Work is never treated as running a
  verified Blueprint for Ever Works Apps.
- **S26 — A fork of a fork.** **Given** a user pastes a fork of someone else's fork of `calcom/cal.diy`, **when**
  the repository is inspected, **then** the Git provider's root repository of that fork network matches the
  Cal.diy entry and the match is offered with **This repository is a fork of calcom/cal.diy. Use the Cal.diy
  Blueprint?**

---

## 4. Functional requirements

### 4.1 The App spec: schema and validation

- **FR-1.** The system MUST treat the `spec` block of `.works/works.yml` with kind `app` as the App spec and
  validate it against the reference in `schema.md`, with one definition driving both editor completion and
  server validation.
- **FR-2.** An unknown key inside `spec` MUST be an error that suggests the nearest defined key within edit
  distance 2; keys starting with `x-` MUST be accepted and ignored; a file declaring a newer
  `appSpecVersion` than the platform supports MUST downgrade unknown-key errors to warnings.
- **FR-3.** The system MUST NOT delete, reorder or rewrite any key of a user's file as a side effect of
  validation.
- **FR-4.** The system MUST enforce the cross-field rules R1–R26 of `schema.md` §22, including: a web
  component declares a port; every `from:`, `template:` and `fromEnv:` reference resolves; a generated
  value and its declared validation agree on length and pattern; build arguments contain no literal
  secret; `upstreamPullRequests.requireApproval` is never `false`.
- **FR-5.** Every problem MUST carry a stable code, a severity (`error` or `warning`), a machine path, a
  display path using component, job and variable names, a 1-based line and column, a message and a hint.
- **FR-6.** No problem message, hint, log line, Activity entry or API response MUST contain the value of a
  secret entry, a build argument or a prompt example.
- **FR-7.** Files over 256 KiB, YAML expanding more than 100 aliases, or nesting deeper than 12 levels MUST
  produce one error each and stop parsing; at most 200 problems MUST be returned, flagged when truncated.
- **FR-8.** Validation MUST never throw to its caller and MUST never make a Work unavailable; errors only
  prevent a spec from becoming effective.
- **FR-9.** Validating draft text without saving MUST return within 2 seconds for a 256 KiB file, store
  nothing, and be limited to 30 requests per minute per member.
- **FR-10.** Validation MUST support a `blueprint` mode for Blueprint repositories, in which `source` and
  `blueprint` are forbidden and `license` is optional.
- **FR-11.** Rules that need platform state (recorded source relation, catalog membership, detected license,
  available build and dependency providers, tracked branch existence) MUST run on the server and be
  labelled as such in the reference.
- **FR-12.** A file whose kind is not `app` MUST produce exactly the validation result it produces today.
- **FR-13.** The published editor schema MUST flag an unknown key in an `app` spec (an escape branch must not
  swallow it) and a stand-alone App spec schema MUST be publicly readable, cached for 5 minutes.
- **FR-14.** Problem codes MUST be append-only; removing or renaming one is a breaking change.

### 4.2 Reading the spec and the App spec state

- **FR-15.** The system MUST read the App spec from the App Work's Work Repository at the head of its
  **tracked branch**, using the App Work's own Git connection; the database MUST hold derived state only.
- **FR-16.** The tracked branch MUST start as the branch recorded at creation and MUST move only when a valid
  spec declares a different `source.branch` that exists and whose own spec declares the same branch.
- **FR-17.** For each App Work the system MUST keep one App spec state: tracked branch; head commit, head
  spec hash, validation status, problems and counts; effective commit, effective hash and when it became
  effective; Blueprint reference; license identifier, class, source, mixed flag and evidence; hosting
  eligibility; attestation; source-offer requirement; display name and protected paths; last evaluation
  time and trigger.
- **FR-18.** Validation status MUST be one of `valid`, `valid_with_warnings`, `invalid`, `missing`,
  `unreadable`, and the state MUST say whether an evaluation is pending.
- **FR-19.** The spec MUST be re-evaluated: (a) on a push to the tracked branch, within 60 seconds of the
  delivery at the 95th percentile; (b) on a pull request merged into the tracked branch; (c) on **Re-check
  now**, within 30 seconds at the 95th percentile; (d) when the App spec page is opened and the live branch
  head differs from the stored head, checked at most once per 60 seconds per Work; (e) after a Blueprint is
  applied; (f) on App Work creation; (g) on demand for a specific commit before a Build of that commit.
- **FR-20.** Only an evaluation with zero errors MUST become the effective spec. No Build or Deployment MUST
  start from a commit whose own spec has errors, and a spec error MUST never stop a running Deployment.
- **FR-21.** The "spec applied" event MUST fire only when the effective spec hash changes; re-evaluating the
  same content MUST emit nothing.
- **FR-22.** An evaluation started earlier MUST never overwrite the result of one started later; triggers
  for the same Work arriving within 5 seconds MUST coalesce into one evaluation.
- **FR-23.** The spec hash MUST be computed over the `spec` block only, in a canonical form independent of
  key order and whitespace.
- **FR-24.** Pushes to other branches MUST be ignored; a push that does not touch `.works/works.yml` MUST
  still advance the evaluated head commit.
- **FR-25.** Other epics MUST obtain the App spec only through the effective-spec read this epic provides,
  never by parsing the file themselves.
- **FR-26.** A Task pull request that changes `source`, `blueprint`, `license`, `display.protectedPaths`,
  `upstreamPullRequests` or `provisioning` MUST be reported to the quality gate as needing a person.

### 4.3 Apps catalog

- **FR-27.** The catalog MUST be read from the configured catalog repository and ref (default
  **`ever-works/templates`** at `main` — CONTRACTS §7 and Resolution **R-29**; the drafts named
  `ever-works/apps` and an installation still carrying that value keeps working), and a warning MUST be logged on
  every uncached read of a ref that is not a 40-character commit or a version tag.
- **FR-28.** The primary read MUST be tokenless with an 8-second timeout, falling back to an authenticated
  read; successes MUST be cached for 1 hour and failures for 30 seconds.
- **FR-29.** An unavailable catalog MUST yield an empty result flagged unavailable — never an error — and the
  paste-URL path MUST keep working.
- **FR-30.** Every catalog row MUST be validated and sanitized per `catalog.md` §3 (HTML stripped, strings
  capped, icon path pattern); an invalid row MUST be dropped on its own without dropping the catalog. A row whose
  license classifies `red` MUST be dropped the same way, so the catalog never lists it (R-3).
- **FR-31.** The catalog service MUST fetch only the configured catalog repository and Blueprint repositories
  named `ever-works/<name>`; upstream repositories and links in the manifest MUST never be fetched by it.
- **FR-32.** The public list MUST support search (minimum 2 characters, over name, summary, tags and
  upstream repository), category, tag, status, license class and hosting availability; 24 rows per page by
  default, at most 100; ordered featured, then verified, then name. Placeholders MUST be listed and marked
  not selectable.
- **FR-33.** The public detail MUST add the Blueprint's README (first 64 KiB, sanitized) and a summary of its
  App spec (components, dependencies, number of variables asked at setup), read at the pinned commit and
  cached for 1 hour.
- **FR-34.** **Verified** MUST be shown only while the entry's evidence is unexpired and matches its pinned
  commit.
- **FR-35.** Each entry MUST state managed-hosting availability as `available` or the first failing reason, in
  this order: `licenseNotGreen` (the class is `red` or `unknown`), `upstreamAgreementMissing` (the class is `amber`
  and the entry records no agreement with the upstream's authors), `entryDisallows`, `blueprintNotVerified` (the
  managed tier admits verified Blueprints only and this one is not verified), `managedTierDisabled` (the managed
  tier is not open). Whether the tier is open, and which Blueprints it admits, MUST come from the managed tier's own
  state — never from reading an instance setting directly (R-5).
- **FR-36.** A public licenses read MUST return the registry's identifiers, names, classes, obligations and
  attestation text identifiers.
- **FR-37.** An hourly refresh MUST detect manifest and registry changes and fan out upgrade notices and
  license re-classification, at most 500 Works each per run, continuing on the next run.
- **FR-38.** When the registry cannot be read, the last good copy MUST be used for up to 7 days; after that,
  new classifications MUST use the snapshot shipped with the platform, which MUST never grant managed-hosting
  eligibility.

### 4.4 Blueprint resolution

- **FR-39.** Resolution MUST follow D4: (1) manifest match; (2) Blueprint repository probe; (3) none, handed
  to the App Provisioner.
- **FR-40.** A manifest match MUST compare the pasted `owner/repo`, case-insensitively, with each entry's
  upstream and aliases, and also with the repository's current name as the Git provider reports it after a
  rename or transfer. When the pasted repository is a fork, the match MUST also compare the **root** repository of
  its fork network as the Git provider reports it (falling back to the immediate parent when the provider reports
  no root), so a fork of a fork still matches. A fork match MUST be offered only with explicit confirmation.
- **FR-41.** A match whose branch or tag fails the entry's ref constraints MUST NOT be applied automatically
  and MUST show its reason.
- **FR-42.** When several entries match, the one marked default MUST be chosen and at most 5 others offered.
- **FR-43.** The probe MUST try at most 2 names (`ever-works/<repo>-template`,
  `ever-works/<owner>-<repo>-template`, slugified), use at most 3 Git provider reads, accept a repository
  only with the Blueprint topic and a spec valid in `blueprint` mode, label it **Unlisted Blueprint**, and
  never mark it verified or managed-hosting eligible. No free-text search MUST be used.
- **FR-44.** Resolutions MUST be cached per canonical upstream for 1 hour when found and 10 minutes when not,
  return within 5 seconds at the 95th percentile, and resolve to "none" with reason `lookupFailed` on a
  provider error without blocking creation.

### 4.5 Applying and upgrading a Blueprint

- **FR-45.** When the Work Repository was created by this App Work's creation (Fork or Private copy) and its
  `.works/works.yml` is absent or its App spec holds nothing beyond `source`, applying MUST write the source recorded
  at creation and the Blueprint's App spec **together**, with the overlay files, as one commit to the tracked branch
  through the Git provider's multi-file commit — never a clone — with the App Work owner's Git connection (R-4).
- **FR-46.** In every other case (Link, an existing spec, or a `replace` overlay) applying MUST open a pull
  request from `ever-works/blueprint/<id>-<version>` and MUST NOT push to the tracked branch. A linked repository
  always receives a pull request; the platform never pushes to a default branch it did not create (R-4).
- **FR-47.** The written spec MUST be the Blueprint's spec plus the creation `source`, a `blueprint` block
  (id, version, repository, commit), the evaluated `license`, and `display` derived from the entry's
  trademark rules.
- **FR-48.** Overlay files MUST be read at the pinned commit, limited to 50 files, 1 MiB each and 5 MiB in
  total, never placed under `.github/`, `.git/` or `.works/`, and `add-only` files MUST never overwrite an
  existing file. A missing pinned commit MUST refuse the apply and write nothing.
- **FR-49.** When the catalog lists a higher Blueprint version, the system MUST show an upgrade notice within
  2 hours of publication, once per version, and label a major-version upgrade **Breaking**.
- **FR-50.** An upgrade MUST be a pull request that three-way merges the applied version, the current spec
  and the new version: fields the user changed keep the user's value, conflicts are listed in the pull
  request description, `source` never changes.
- **FR-51.** At most one upgrade pull request MUST be open per Work; a newer version MUST update it; dismissing
  a notice MUST hide that version only.
- **FR-52.** Applying and upgrading MUST require edit access and be limited to 5 requests per hour per Work;
  a failure MUST be recorded with a reason and write nothing partial.

### 4.6 License gate

- **FR-53.** The system MUST detect the license at the effective commit from root license files (`LICENSE`,
  `LICENCE`, `COPYING`, `UNLICENSE`, with or without `.md`/`.txt`) and root package manifests
  (`package.json`, `pyproject.toml`, `Cargo.toml`, `composer.json`), matching texts to registry licenses at
  ≥ 90 % similarity and resolving registry aliases.
- **FR-54.** The system MUST flag a repository as **mixed** when it finds directories named `ee`,
  `enterprise`, `premium` or `commercial` at depth ≤ 4, nested license files with a different identifier, or
  license headers reported by the App Provisioner or a Build from their checkout; at most 20 evidence paths
  MUST be kept, and a scan cut short by a repository of more than 100,000 entries MUST be flagged incomplete.
- **FR-55.** Classification MUST apply the registry's expression rules (OR takes the best class, AND the
  worst, on the fixed rank `green < amber < unknown < red`); a mixed repository MUST take the worst class of its
  parts and at least `amber` when a part is unidentified; no identifiable license MUST take the registry's
  `unknown` class, which is never `green`. The `unknown` class is the platform's own computation — detection found
  nothing, or an operand is not listed — and it is **not** read from the registry's `unknown.class` key, which is
  advisory display metadata: an implementer stores `class: 'unknown'`, so a repository without a license can never
  be recorded as `amber` and can never carry an upstream agreement (catalog.md §4, ACC-03-30, ACC-03-47).
- **FR-56.** The license MUST be evaluated on App Work creation before a deploy target can be chosen, when the
  effective spec moves to a commit that changes license-relevant files, on every Upstream sync, when the
  registry changes, and on **Re-check now** — within 20 seconds at the 95th percentile, using at most 12 file
  reads and 1 repository listing.
- **FR-57.** Hosting eligibility MUST be (R-3): **None** always; **Your cluster** for `green`, and for `amber`,
  `red` and `unknown` only after the Work owner's attestation; **Ever Works Apps** for `green`, and for `amber` only
  when the App Work's catalog entry records an agreement with the upstream's authors — in both cases only when the
  managed tier is open, the catalog entry (when there is one) allows it and, while the tier admits verified
  Blueprints only, the applied Blueprint is verified for this repository. `red` and `unknown` are never eligible for
  Ever Works Apps.
- **FR-58.** Eligibility MUST be enforced by the server when a Deployment starts, not only in the interface,
  and every refusal MUST name its reason.
- **FR-59.** An attestation MUST show the registry text, be given by the Work owner only (any other member,
  including a manager, MUST be refused as forbidden), and record the
  Work, the person, the time, the license identifier and class, the text identifier, a hash of the text and
  the commit; it MUST remain valid until any of identifier, class or text identifier changes.
- **FR-60.** When the class worsens, the system MUST notify the owner, keep running Deployments running, and
  require (re-)attestation for the next Deployment; when it improves, the requirement MUST lift and the
  record stay.
- **FR-61.** When a license obligation requires offering source to network users and the deployed commit is
  not an upstream commit, the Deployment MUST expose a visible Source link to that commit of a public data
  repository; a private Work Repository MUST declare `license.sourceOfferUrl` or the Deployment MUST be
  refused with `sourceOfferMissing`.
- **FR-62.** Before merging an Upstream sync, the system MUST be able to classify the upstream commit, so a
  worsened class can pause the merge and ask the owner.
- **FR-63.** A trademark rule MUST make the display name `"<name> <suffix>"` the default Work name and the
  name on every Ever Works surface, and show the notice on the App spec page.
- **FR-64.** The declared `license` block MUST never override detection; a mismatch MUST be a warning.
- **FR-65.** The License card MUST state that the classification is an automated reading, not legal advice.

### 4.7 Web

- **FR-66.** Settings of an App Work MUST gain an **App spec** tab, hidden for every other kind.
- **FR-67.** The tab MUST show one status banner (valid, valid with warnings, invalid while running the last
  valid spec, invalid with nothing effective, missing, unreadable, checking) with the evaluated commit and
  "Checked {ago}".
- **FR-68.** The tab MUST render the sections Source, Blueprint, License, Build, Components, Dependencies,
  Env, Jobs, Cron, Domains, Smoke tests, Checks, Agents and Upstream, marking defaulted values **default**.
- **FR-69.** The Env section MUST list names, secret flag, phase and source kind only; non-secret literal
  values MUST be truncated at 80 characters.
- **FR-70.** The problems list MUST order errors before warnings, then by line; each row MUST show severity as
  text and icon, display path, `line:column`, message, hint and **Open in repository** at the evaluated
  commit and line; it MUST filter by severity.
- **FR-71.** The create flow MUST offer an Apps catalog browser: a responsive grid (3, 2, 1 columns), search
  debounced 300 ms, category chips, cards, a details drawer and **Use this app**, which fills the repository
  URL with the entry's primary upstream and records the match.
- **FR-72.** Each card MUST show icon, name, summary, **Verified** or **Beta**, license chip, dependencies and
  where the app can run; placeholders MUST be visible and not selectable.
- **FR-73.** Unavailable, empty and no-results states MUST each have their own copy and recovery action.
- **FR-74.** Every string MUST be translatable and never concatenated; every control MUST be keyboard
  operable, and no state MUST be conveyed by colour alone.

### 4.8 API, permissions, limits and observability

- **FR-75.** Catalog reads MUST be public, limited to 120 requests per minute per client address, and
  cacheable for 300 seconds.
- **FR-76.** App spec and license reads of another account's Work MUST answer **not found**; viewers MUST
  read; re-check, apply and upgrade MUST require edit access; attestation MUST require the Work owner.
- **FR-77.** **Re-check now** MUST be limited to 6 requests per minute per Work and attestation to 10 per
  minute per member.
- **FR-78.** The system MUST record Activity for spec validated, spec invalid, spec applied, Blueprint matched,
  applied, apply failed and upgrade available, license classified, changed, attested and attestation
  required — with identifiers, codes and counts only.
- **FR-79.** Product telemetry MUST carry counters and identifiers only — never file content, variable values
  or search text.
- **FR-80.** Every new endpoint MUST be documented in the public API reference.

### 4.9 Explicit Blueprint choice and the "Blueprint matched" record (added by the program audit)

- **FR-81.** A Blueprint id sent explicitly with the App Work create request (or the apply request) MUST be honoured
  for any repository, including one no manifest entry, alias or fork network names — for example a repository
  generated per test run; this is the supported way to give such a repository a Blueprint. The id MUST name a listed,
  selectable entry or a probe hit, the entry's ref constraints apply only when the entry also lists the repository,
  and the match source MUST be recorded as `explicit`. An explicit choice for a repository the entry does not list
  MUST never count as a verified Blueprint for Ever Works Apps.
- **FR-82.** **Blueprint matched** MUST be recorded exactly once per App Work and Blueprint version when an apply is
  requested — whatever produced the match (manifest, alias, rename, fork network, probe, catalog pick or explicit id)
  — before **Blueprint applied** or **Blueprint apply failed**, with the Blueprint id, version and match source only.
  Inspecting a repository before creation MUST record nothing.

### 4.10 Validation completeness, wiring and the Blueprint's own repository (added by the 2026-09-17 ordering pass)

- **FR-83.** The rule set MUST run whenever the document parses: only an unparseable document, one over the size
  limit, one over the alias limit and one over the depth limit may suppress R1–R26. Every other structural problem is
  reported **together with** the rules, so one `unknown_field` never hides the five other problems the same
  document has. A problem that makes one subtree unreadable MAY suppress only the rules that read that subtree, and
  the response MUST say which.
- **FR-84.** The inputs the server-only rules read MUST be defined as one context — the recorded source relation,
  catalog membership, the enabled build strategies, the dependency providers available for the Work's target and
  whether the tracked branch exists — and a field the platform cannot answer yet MUST be treated as **unknown**, so
  its rule is skipped rather than reported. A deploy-strategy rule MUST apply only to strategies that need a
  builder.
- **FR-85.** A Blueprint repository's own `.works/works.yml` MUST be validatable with the same rules the platform
  runs, so a draft can be proof-read before it is listed: blueprint mode allows and expects `source` and
  `blueprint` (schema.md §3, corrected 2026-09-17), and catalog CI MUST exercise exactly that mode through one
  published artifact rather than a re-implementation, so a Blueprint cannot pass CI and fail the platform.
- **FR-86.** A push delivery MUST find every App Work whose Work Repository it concerns — including one whose
  repository has no platform GitHub App installed, which is the normal case for a member's own fork — and MUST be
  scoped to the account the delivery is bound to, so no delivery ever requests work for another account's App Work.
- **FR-87.** When a Blueprint is applied to a **linked** repository, its relation-dependent blocks MUST be adapted
  before the composed spec is validated: `upstreamSync` is dropped and external upstream pull requests are turned
  off, because a linked repository has no upstream. What was dropped MUST be listed for the member; nothing is
  discarded silently and the Blueprint repository's own file is never edited.
- **FR-88.** A Blueprint that carries a trademark notice MUST give the App Work its display name, and that name
  MUST be used on the Work's surfaces while the Work still carries its creation default. A Work the member renamed
  MUST keep the member's name, and the display name MUST be recorded on the App spec state whether or not the Work
  was renamed.
- **FR-89.** The platform MUST be able to answer, for one commit, whether that commit already carries a usable App
  spec — meaning a spec with at least one key beyond the source block — without waiting for the asynchronous
  evaluation, so "there is no App spec yet, start the App Provisioner" is decided from the commit itself and a
  source-only file never counts as an App spec.
- **FR-90.** Every background job this epic dispatches MUST be wired end to end — a dispatcher, the runtime task, the
  worker's remote proxy and the service's registration for remote calls — and the evaluation, its database writes
  and its in-process events MUST happen in the API process, so the events other epics listen for are actually
  delivered.

---

## 5. Key entities

### 5.1 Already in Ever Works — extended here

| Entity                                | Today                                                                                 | This epic adds                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **`.works/works.yml`**                | Versioned envelope with typed specs for content kinds and Repository Works; advisory. | A strict, typed spec for kind `app`, line-accurate problems, and a published stand-alone schema. |
| **Work** (App Work)                   | A Work of kind `app` (APW-01).                                                        | One App spec state; a license classification and hosting eligibility.                            |
| **Work Blueprint** (concept)          | Ready-made Work definitions in a runtime catalog.                                     | **App Blueprint** entries in the Apps catalog, matched to upstream repositories.                 |
| **Activity**                          | The account's record of significant operations.                                       | App spec, Blueprint and license events.                                                          |
| **Deployment** / deploy target choice | Deploy targets and deployments (APW-06).                                              | Reads eligibility and the source-offer requirement before starting.                              |

### 5.2 New

| Entity             | Why it must exist                                                                                                                                                                                                                                                                                                                                                      | Shape                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App spec state** | The file is the source of truth, but five epics need an answer to "what is the effective spec, at which commit, and may it run there?" without re-reading and re-validating GitHub content on every request — and the answer must survive a later invalid push. A problem list with lines, an attestation record and an eligibility verdict have nowhere else to live. | One row per App Work. Derived from the repository and the catalog; rebuilt from them if lost, except the attestation record, which is also in Activity. |

> **No other new noun.** An App Blueprint is catalog data, not a stored entity. An attestation is a record on
> the App spec state. A problem is a value in a validation result.

### 5.3 States and transitions

**Validation status** (per head commit):

```
   (created) ──► evaluating ──┬─► valid ─────────────────────┐
                              ├─► valid_with_warnings ───────┼──► becomes effective (hash changed ⇒ applied event)
                              ├─► invalid ── effective stays on the last valid commit
                              ├─► missing  (no .works/works.yml on the tracked branch)
                              └─► unreadable (provider error; previous result kept, retried on next trigger)
```

**Hosting eligibility** (per effective commit):

```
   classify ─► green ─────────► None ✓  Your cluster ✓  Ever Works Apps ✓ if tier open + entry allows (+ verified while required)
           ├─► amber ─────────► None ✓  Your cluster: owner attestation ─attest─► ✓
           │                             Ever Works Apps ✓ only with a recorded upstream agreement (+ the green conditions)
           ├─► red / unknown ─► None ✓  Your cluster: owner attestation ─attest─► ✓   Ever Works Apps ✗ (reason)
           │                             red: never listed in the Apps catalog
           └─► class changes ─► worse: attestation cleared for new deployments · better: requirement lifted
```

**Blueprint**:

```
   matched ─► applying ─┬─► applied (commit on a fresh repository | pull request elsewhere)
                        └─► apply_failed (reason; nothing written)
   applied ─► higher version listed ─► upgrade_available ─┬─ dismiss ─► hidden (this version only)
                                                          └─ review ─► upgrade PR ─merged─► applied (new version)
                                                                          └─ newer version ─► same PR updated
```

---

## 6. UX

All copy is final English copy, keyed for translation.

### 6.1 Apps catalog browser (create flow)

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  [ Paste a repository URL ]  [ Browse the Apps catalog ]                     ║
║  ┌────────────────────────────────────────────────┐                          ║
║  │ 🔍 Search apps by name, tag or repository       │                          ║
║  └────────────────────────────────────────────────┘                          ║
║  (All) (Scheduling) (Analytics) (Support) (CRM) (+6)                         ║
║  ┌──────────────────────────┐ ┌──────────────────────────┐ ┌───────────────┐ ║
║  │ [icon] Cal.diy      Beta │ │ [icon] Analytics Verified│ │ [icon] Helpdesk│ ║
║  │ Open-source scheduling   │ │ Web analytics            │ │ Coming soon   │ ║
║  │ MIT · Open license       │ │ MIT · Open license       │ │               │ ║
║  │ Needs: Postgres, SMTP    │ │ Needs: Postgres          │ │               │ ║
║  │ Runs on: Your cluster    │ │ Runs on: Your cluster ·  │ │               │ ║
║  │ [Details] [Use this app] │ │ Ever Works Apps          │ │ [Details]     │ ║
║  └──────────────────────────┘ └──────────────────────────┘ └───────────────┘ ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

| Element                   | Copy                                                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs (rendered by APW-01) | `Paste a repository URL` · `Browse the Apps catalog`                                                                                                                                                                                                              |
| Search placeholder        | `Search apps by name, tag or repository`                                                                                                                                                                                                                          |
| Category "all"            | `All`                                                                                                                                                                                                                                                             |
| Badges                    | `Verified` · `Beta` · `Coming soon` · `Unlisted Blueprint`                                                                                                                                                                                                        |
| License class labels      | green `Open license` · amber `Restricted hosting` · red `Hosting not allowed` · unknown `License unclear`                                                                                                                                                         |
| Dependencies line         | `Needs: {list}` (`Postgres`, `Redis`, `Object storage`, `SMTP`) · none: `No extra services`                                                                                                                                                                       |
| Runs on                   | `Runs on: Your cluster` · `Runs on: Your cluster · Ever Works Apps`                                                                                                                                                                                               |
| Managed reasons (tooltip) | `Ever Works Apps isn't available for this license.` · `Ever Works Apps needs an agreement with this app's authors.` · `Ever Works Apps isn't offered for this app.` · `Ever Works Apps needs a verified Blueprint.` · `Ever Works Apps is coming soon.`           |
| Actions                   | `Details` · `Use this app`                                                                                                                                                                                                                                        |
| Unavailable               | `The Apps catalog is unavailable right now.` / `You can still paste a repository URL — we'll work out how to run it.` · `Paste a URL instead`                                                                                                                     |
| No results                | `No apps match “{query}”.` · `Clear search` · `Can't find it? Paste its repository URL instead.`                                                                                                                                                                  |
| Empty                     | `No apps in the catalog yet.`                                                                                                                                                                                                                                     |
| Match (paste tab)         | `App Blueprint found: {name}` · fork: `This repository is a fork of {upstream}. Use the {name} Blueprint?` · refs: `This Blueprint doesn't cover that version.` · none: `No App Blueprint for this repository — the App Provisioner will work out how to run it.` |

**Details drawer**: name, badges, summary, README (rendered, sanitized), **Requirements** (`At least {cpu}
CPU and {memory} memory` · `Asks you for {count, plural, =1 {1 value} other {# values}} at setup`), **License**
(`{spdx} — {classLabel}` and the trademark notice), **Verified on {date}** or **Not verified yet**, and
**Use this app**.

### 6.2 Settings → App spec

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  [General] [Members] [Budgets] [App spec]                                    ║
║ ┌──────────────────────────────────────────────────────────────────────────┐ ║
║ │ ✗ The App spec on main has 2 errors.                  [ Re-check now ]   │ ║
║ │   Still running the last valid spec from commit 4f1c2ab. Nothing new is  │ ║
║ │   built or deployed until the errors are fixed. Checked 2 minutes ago.   │ ║
║ └──────────────────────────────────────────────────────────────────────────┘ ║
║  PROBLEMS   [All (2)] [Errors (2)] [Warnings (0)]                            ║
║  ✗ Error  components › web › replica                        41:7             ║
║           Unknown field `replica`. Did you mean `replicas`?                  ║
║           Fix: rename it to `replicas`.            [ Open in repository ↗ ]  ║
║  ✗ Error  components › web › port                           38:5             ║
║           Web components must declare the port they listen on.               ║
║           Fix: add `port: <number>` under `web`.   [ Open in repository ↗ ]  ║
║  ─────────────────────────────────────────────────────────────────────────── ║
║  APP BLUEPRINT  Cal.diy 1.0.0 · Beta           Blueprint 1.1.0 is available. ║
║                                                [ Review upgrade ] [ Not now ]║
║  LICENSE        MIT — Open license · Detected from LICENSE · Your cluster: allowed ║
║                 Cal.diy® is a trademark of Cal.com, Inc.   (disclaimer, §6.3) ║
║  ▸ Source ▸ Build ▸ Components (1) ▸ Dependencies (2) ▸ Env (11) ▸ Jobs (1) … ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

| State / element             | Copy                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab                         | `App spec`                                                                                                                                                                                           |
| Valid                       | `App spec is valid.` · `Commit {sha} · Checked {ago}`                                                                                                                                                |
| Valid with warnings         | `App spec is valid, with {count, plural, =1 {1 warning} other {# warnings}}.`                                                                                                                        |
| Invalid, running last valid | `The App spec on {branch} has {count, plural, =1 {1 error} other {# errors}}.` · `Still running the last valid spec from commit {sha}. Nothing new is built or deployed until the errors are fixed.` |
| Invalid, nothing effective  | same title · `Nothing can be built or deployed until the errors are fixed.`                                                                                                                          |
| Missing                     | `No App spec yet.` · `Apply a Blueprint or let the App Provisioner write one.` · `Browse Blueprints` · `Run the App Provisioner`                                                                     |
| Unreadable                  | `We couldn't read .works/works.yml from {branch}.` · `We'll try again on the next push, or you can re-check now.`                                                                                    |
| Checking                    | `Checking the App spec…` (button: `Checking…`)                                                                                                                                                       |
| Buttons / links             | `Re-check now` · `Open in repository`                                                                                                                                                                |
| Problems header / filters   | `Problems` · `All ({count})` · `Errors ({count})` · `Warnings ({count})` · truncated: `Showing the first 200 problems.`                                                                              |
| Severity text / hint prefix | `Error` · `Warning` · `Fix:`                                                                                                                                                                         |
| Default marker              | `default`                                                                                                                                                                                            |
| Env source kinds            | `Generated once` · `From {reference}` · `Template` · `Asked at setup` · `Fixed value` · `Secret`                                                                                                     |

### 6.3 License card, attestation and refusals

| Element                  | Copy                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headline                 | `{spdx} — {classLabel}` · `Detected from {files}` · unknown: `No license we recognise was found.`                                                                                                                                                                      |
| Mixed                    | `Parts of this repository use a different license.` + evidence paths · incomplete: `This repository is too large to scan completely.`                                                                                                                                  |
| Eligibility              | `Your cluster: allowed` · `Your cluster: allowed after you confirm the license terms` · `Ever Works Apps: allowed` · `Ever Works Apps: allowed under an agreement with the app's authors` · `Ever Works Apps: not allowed for this license`                            |
| Action / done            | `Review and confirm` · `Confirmed by {name} on {date}.`                                                                                                                                                                                                                |
| Disclaimer               | `This is an automated reading of the repository's license files, not legal advice.`                                                                                                                                                                                    |
| Source link              | `Source link required` · `This license requires offering the running version's source to its users. Each deployment shows a Source link to the deployed commit.` · private: `Your repository is private. Add license.sourceOfferUrl to the App spec before deploying.` |
| License changed          | `The license changed from {from} to {to}.` · `Running deployments keep running. New deployments need your confirmation.`                                                                                                                                               |
| Refusal (deploy, APW-06) | `Ever Works Apps can't host {name}: its license ({spdx}) doesn't allow it.` · `{name} needs the license terms confirmed before it can run on your cluster.` · `{name} needs a source link before it can be deployed.`                                                  |

**Attestation dialog** — title `Confirm the license terms`; body `{spdx} restricts how this software may be
hosted. Ever Works Apps is not available for it. To run it on your own cluster, confirm:` followed by the
registry's attestation text as a quotation; checkbox `I confirm the statement above.`; footer `We record who
confirmed, when, and for which license and commit.`; buttons `Cancel` · `Confirm` (disabled until the box is
ticked). Non-owners see `Only the Work's owner can confirm license terms.` instead of the button.

### 6.4 Blueprint card and upgrade

| Element              | Copy                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card                 | `App Blueprint` · `{name} {version}` · chips `Verified` / `Beta` / `Unlisted Blueprint` / `No longer listed` / `Chosen for this repository` (explicit choice, FR-81)                           |
| Upgrade notice       | `Blueprint {version} is available.` · breaking: `Blueprint {version} is available — it includes breaking changes.` · `Review upgrade` · `Not now`                                              |
| Upgrade dialog       | `Upgrade to {name} {version}` · `We'll open a pull request that updates the App spec. Your own changes are kept; anything that conflicts is listed in the pull request.` · `Open pull request` |
| Upgrade pending      | `Upgrade to {version} is waiting for review.` · `View pull request`                                                                                                                            |
| Apply (missing spec) | `Apply the {name} Blueprint` · `We'll open a pull request that adds the App spec and {count, plural, =0 {no other files} =1 {1 file} other {# files}}.`                                        |
| Apply failed         | `This Blueprint's pinned version is missing. Try again later or run the App Provisioner.` · `We couldn't write to your repository. Check the Git connection and try again.`                    |

**Keyboard.** Catalog browser: `/` focuses search (not while a text field has focus); arrow keys move between cards,
`Enter` opens Details, `Space` selects. Problems list: `Enter` opens the row's line in the repository in a
new tab. App spec banner: `R` re-checks while focused. Dialogs: `Esc` closes, `Enter` fires the primary
action, focus returns to the opener.

---

## 7. Out of scope

- **Building, rendering, env storage, dependency provisioning, the evolve loop and upstream flows** — APW-05,
  06, 07, 08, 02 and 09 consume the effective spec; this epic only defines and validates it.
- **Writing an App spec with an agent** (APW-04) and **the create-from-URL form** (APW-01). This epic supplies
  the resolver, the catalog browser component and the validation endpoint they use.
- **Editing the App spec in the browser.** The page reads; changes happen in the repository or by pull request.
- **Importing third-party compose or template formats.**
- **Automatic relicensing decisions or legal advice.** The registry is legal-reviewed; the platform applies it.
- **Managed-tier enablement** (APW-10). This epic only reports whether a license and entry allow it.
- **Publishing a Blueprint from inside Ever Works.** Contribution is by pull request to the catalog.

---

## 8. Acceptance criteria

**App spec validation**

- [ ] **ACC-03-01** Each of the three `schema.md` §24 examples validates with zero errors; §24.4 reports exactly the six listed codes with their display paths.
- [ ] **ACC-03-02** An unknown key reports `unknown_field` with a suggestion; an `x-` key reports nothing; `appSpecVersion: 2` turns it into a warning.
- [ ] **ACC-03-03** Every rule R1–R26 has a failing fixture that reports its code, line and column.
- [ ] **ACC-03-04** No response, log line or Activity entry produced by §24.4 contains the build argument's value.
- [ ] **ACC-03-05** A 300 KiB file, a 101-alias file and a 13-level file each report one error.
- [ ] **ACC-03-06** Every existing `works-config` schema fixture for other kinds returns the same result before and after.
- [ ] **ACC-03-07** The published envelope schema rejects `replica` under an `app` component in an editor; the stand-alone schema answers publicly with a 5-minute cache.
- [ ] **ACC-03-08** Draft validation of a 256 KiB file returns in under 2 seconds, stores nothing, and the 31st request in a minute is refused.

**State and evaluation**

- [ ] **ACC-03-09** A push changing the spec updates the page within 60 seconds; a push to another branch changes nothing.
- [ ] **ACC-03-10** An invalid push keeps the effective commit unchanged; a Build requested for that commit is refused.
- [ ] **ACC-03-11** Re-evaluating identical content emits no Activity.
- [ ] **ACC-03-12** Out-of-order completion of two evaluations leaves the newer result.
- [ ] **ACC-03-13** Three Re-check presses within 5 seconds run one evaluation; the 7th press in a minute is refused.
- [ ] **ACC-03-14** With no webhook delivered, opening the page after a push schedules an evaluation, at most once per minute.
- [ ] **ACC-03-15** A Task pull request changing `license.class` is reported to the gate as needing a person.

**Apps catalog**

- [ ] **ACC-03-16** With the catalog repository unreachable, the list answers 200 with an empty unavailable result within 9 seconds, and a second request within 30 seconds does not refetch.
- [ ] **ACC-03-17** A manifest row with an `upstreams[].repo` outside the format, a Blueprint repository outside `ever-works/`, or HTML in `name` is dropped or stripped while other rows are served.
- [ ] **ACC-03-18** No request to an upstream repository or a `links` URL leaves the catalog service during any catalog test.
- [ ] **ACC-03-19** Search `ca` returns the Cal.diy entry; `c` is ignored; category, status, license class and availability filters each narrow the result.
- [ ] **ACC-03-20** An entry with expired evidence is served unverified.
- [ ] **ACC-03-21** Each managed-hosting reason is produced by its fixture.
- [ ] **ACC-03-22** A registry change fans out re-classification to at most 500 Works per run.

**Resolution, apply, upgrade**

- [ ] **ACC-03-23** `calcom/cal.com` and `CALCOM/CAL.DIY` both resolve to `cal`.
- [ ] **ACC-03-24** A fork of a listed upstream resolves only with confirmation; an excluded tag resolves with the ref reason.
- [ ] **ACC-03-25** The probe finds a topic-carrying template repository as Unlisted and ignores one without the topic, using at most 3 provider reads.
- [ ] **ACC-03-26** A fresh Fork App Work receives exactly one commit with the spec and add-only overlays; a Link App Work receives a pull request and no push to its default branch.
- [ ] **ACC-03-27** An overlay targeting `.github/workflows/x.yml` is refused; an existing file is never overwritten by an add-only overlay.
- [ ] **ACC-03-28** A missing pinned commit refuses the apply and writes nothing.
- [ ] **ACC-03-29** A new catalog version produces one notice; the upgrade pull request keeps a user-changed field and lists a conflict; a newer version updates the same pull request.

**License gate**

- [ ] **ACC-03-30** MIT, Apache-2.0 and AGPL-3.0-only fixtures classify `green`; BUSL-1.1 `amber`; a no-license repository `unknown` (amber-like).
- [ ] **ACC-03-31** `MIT OR BUSL-1.1` is green; `MIT AND BUSL-1.1` is amber.
- [ ] **ACC-03-32** A repository with an `ee/` directory is mixed and at least amber, with the path in evidence.
- [ ] **ACC-03-33** A Deployment to Ever Works Apps for an amber App Work is refused by the server with its reason even when the interface is bypassed.
- [ ] **ACC-03-34** Attestation by a manager is refused; by the owner it is recorded with text hash and commit; changing the registry text identifier invalidates it.
- [ ] **ACC-03-35** An Upstream sync that relicenses MIT → BUSL-1.1 notifies the owner, leaves the running Deployment untouched and requires confirmation for the next one.
- [ ] **ACC-03-36** An AGPL App Work on a private copy without `license.sourceOfferUrl` is refused with `sourceOfferMissing`.
- [ ] **ACC-03-37** A trademark suffix entry creates the Work named `Cal.diy (community build)`.
- [ ] **ACC-03-38** With the registry unreachable for 8 days, a new App Work classifies from the bundled snapshot and is never eligible for Ever Works Apps.

**Web and cross-cutting**

- [ ] **ACC-03-39** The App spec tab is absent on a `website` Work and present on an App Work.
- [ ] **ACC-03-40** Every banner state of §6.2 renders from its fixture; every problem row links to the evaluated commit and line.
- [ ] **ACC-03-41** A viewer sees no Re-check, upgrade or attestation controls; another account's Work id answers not found on every endpoint.
- [ ] **ACC-03-42** The catalog browser, problems list and attestation dialog are keyboard operable and pass an automated accessibility check with no new violations.
- [ ] **ACC-03-43** Every string on these surfaces resolves through translation in all locales.

**Added by the program audit (2026-09-17)**

- [ ] **ACC-03-44** An App Work created from a repository no entry lists, with an explicit Blueprint id, receives that Blueprint (one commit on a fresh fork); Activity holds exactly one **Blueprint matched** with match source `explicit` before **Blueprint applied**; its managed-hosting availability is never `available` through that Blueprint's verification.
- [ ] **ACC-03-45** A fork of a fork of a listed upstream resolves to that entry through the root repository the Git provider reports, and only with confirmation.
- [ ] **ACC-03-46** A manifest row whose license classifies `red` is absent from the list and detail responses; a registry that changes `classes.red.catalog` or loosens any class is rejected in favour of the last good copy.
- [ ] **ACC-03-47** An amber entry without a recorded upstream agreement reports `upstreamAgreementMissing`; with one (and the other conditions met) it reports `available`; a red or unknown classification reports `licenseNotGreen`.
- [ ] **ACC-03-48** With the instance setting that enables the managed tier switched on and the managed tier itself closed, availability reports `managedTierDisabled`; with the tier open and admitting verified Blueprints only, an unverified entry reports `blueprintNotVerified`.
- [ ] **ACC-03-49** Each of the key pair formats `pem`, `base64url-raw` and `pkcs12` validates with its examples; `rsa-4096` with `base64url-raw` reports `keypair_format_unsupported`; `pkcs12` without a generated password entry reports `keypair_password_invalid`; `build.strategy: auto` validates and reports `build_strategy_unavailable` when no enabled build plugin supports it.
- [ ] **ACC-03-50** Each of the three jobs runs through a runtime dispatcher and a worker remote proxy, the worker compiles with no database module, and an event one of them emits reaches an API-side listener for it (FR-90).
- [ ] **ACC-03-51** The published validator artifact validates the schema.md examples and reports the same codes the platform reports, its committed schema equals the generator's output, and the catalog repository pins its exact version (FR-85).
- [ ] **ACC-03-52** A Blueprint repository draft carrying `source` and `blueprint` validates in blueprint mode with zero errors, and catalog CI runs that same mode through the published artifact (FR-85).
- [ ] **ACC-03-53** Applying a Blueprint that declares `upstreamSync` to a linked repository composes a valid spec, drops that block, turns external upstream pull requests off and lists what it dropped (FR-87).
- [ ] **ACC-03-54** A Blueprint apply on a fork resolves against its upstream and never against the fork itself, reuses the match source recorded at creation, and falls back to the Work owner when no caller is present (FR-87).
- [ ] **ACC-03-55** An apply reports `commit`, `pull_request` or `failed` back to the App Work's readiness exactly once, and an upgrade reports nothing (FR-81, FR-90).
- [ ] **ACC-03-56** A push delivery finds an App Work whose repository has no platform GitHub App installed and matches nothing for another account's binding (FR-86).
- [ ] **ACC-03-57** The "does this commit already carry a usable App spec?" predicate answers false for an absent file, a source-only file and a source-plus-extension-key file; true for a valid spec with a build and components; false for the same spec with an error — all while the evaluation state still reads missing (FR-89).
- [ ] **ACC-03-58** Every input of the server-only rules left unknown skips its rule, and only strategies that need a builder report `build_strategy_unavailable` (FR-84).
- [ ] **ACC-03-59** A document with one structural error still reports the rule problems it also has, and only an unparseable, oversized, alias-heavy or too-deep document suppresses the rule set (FR-83).

---

## 9. Open questions

**Resolved by the program audit** ([CONTRACTS.md §0](../CONTRACTS.md#0-program-audit-resolutions-binding-2026-09-17-against-develop-ee45946e5)):

- ~~Red licenses on Your cluster~~ — **R-3**: allowed after the owner's attestation; never on Ever Works Apps; never
  in the Apps catalog.
- ~~Who may attest~~ — **R-3**: the Work owner only; a manager is refused (forbidden).
- ~~Where the attestation lives~~ — **R-3 / C3**: one record on the App spec state, owned by this epic; the App
  runtime reads eligibility and stores no copy.
- ~~Link mode direct commit~~ — **R-4**: a linked repository always receives a pull request.
- ~~Blueprint matching for a freshly generated repository~~ — FR-81: the create request's explicit Blueprint id is
  the supported path; manifest matching additionally follows a fork's root repository (FR-40).

**Still open**

- **[NEEDS CLARIFICATION: Cal.diy on the managed tier.]** The upstream recommends personal, non-production use.
  The example catalog entry sets managed hosting to not offered. Is Cal.diy meant to be a Wave 2 managed
  demo (APW-13), or a Your-cluster flagship only?
- **[NEEDS CLARIFICATION: bundled registry snapshot.]** ADR-014 keeps catalog content out of platform code;
  this spec ships a license-registry snapshot as an outage fallback only, mirroring the Work Blueprints
  built-in list. Acceptable?
- **[NEEDS CLARIFICATION: recording an upstream agreement.]** R-3 lets an amber app run on Ever Works Apps under a
  recorded agreement with its authors. This spec records only a reference in the catalog entry (legal-reviewed);
  the agreement itself lives in the private operations repository. Is a per-entry record enough, or must an
  agreement be scoped to specific versions?
