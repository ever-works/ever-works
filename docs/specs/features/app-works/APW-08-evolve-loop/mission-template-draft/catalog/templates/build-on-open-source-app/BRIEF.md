---
name: Build on an open-source app
description: >-
    Build my own {product} for {business} on top of {appWork}: a weekly, budgeted, approval-gated Mission that
    keeps filing small, reviewable changes on an App Work and follows each one until it is live.
---

# Build on an open-source app

> **Catalog brief** (added 2026-09-17 — EXT-13). This is the `BRIEF.md` the `ever-works/missions` catalog expects
> beside `mission.yml`. The template's **runtime** manifest and its human-facing README live in the standalone seed
> repository `ever-works/build-on-open-source-app-mission-template`
> (`mission-template-draft/.works/mission.yml` and `mission-template-draft/README.md` in this repo, published by
> APW-08 T41), because that is the layout the platform reads. Nothing here replaces either file.

**For:** someone who already runs an open-source application as an App Work and wants it to become _their_ product
for _their_ business, without a rewrite and without an open-ended budget.

**What it does.** Every Monday at 08:00 UTC the Mission looks at what the business needs from the product, files up
to two small Tasks on the attached App Work, and — once the owner approves them — an Agent implements each one as a
pull request against the branch the app deploys from. Each Task stays open until its change is live, and a failed
build or deployment opens at most two follow-up Tasks before a person is asked.

**What it creates.** A scheduled Mission with output **Tasks on attached App Works**, an _Improves_ relation to the
chosen App Work, **2** Tasks per tick, an open-Tasks cap of **4**, approval before creating Tasks, a **$15.00**
per-run budget, and two delivery Goals in _Draft_ scoped to the App Work.

**What it recommends for the app** (proposed as a pull request, never written directly): schema and migration paths
merged by a person, 400-line pull requests, and `LICENSE*` / `NOTICE*` protected.

**What the platform always enforces** regardless of the template: branch-per-Task, the App spec's checks, protected
paths, the merge policy (by default agents never merge), and follow-up Tasks when a merged change fails to build or
deploy.

**Before you start.** Fill in the Mission's product brief, make sure the App Work has a Fleet node or an isolated run
environment set up, and review the App spec's checks so you can admit them for your own machines.

**Full detail:** the template's `README.md` in `ever-works/build-on-open-source-app-mission-template` (source:
`docs/specs/features/app-works/APW-08-evolve-loop/mission-template-draft/README.md`).
