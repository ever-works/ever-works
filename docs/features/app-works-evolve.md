---
id: app-works-evolve
title: 'Evolving an App Work: changes, checks and delivery'
sidebar_label: Evolving the app
description: How an App Work changes over time — asking for a change, where agent runs are allowed to execute, the checks a change must pass, how a merged change is built, deployed and closed, what it costs, and the operator switches that pause it.
---

# Evolving an App Work

An [App Work](./app-works.md) keeps changing after it is created: you ask for a change, an agent makes it on its own branch, the change is checked, merged, built, deployed — and the Task closes when the change is **live**. This page describes that loop as it works today. The rules every change must pass — the change guard, protected paths and the size guidance — are on the [App Works](./app-works.md#evolving-the-app-with-agents) page.

:::info Preview
App Works are off by default. Everything below applies only to Works of kind `app`; every other kind of Work behaves exactly as described in [Tasks](./tasks.md) and [Task Isolation](./task-isolation.md).
:::

## Asking for a change

Ask in the chat with the Work's agent, or use **Request a change** on the App Work's Overview or its Tasks tab: one field, one Task. The Task's thread then tells the story of the change in plain lines — *Run started.*, *Opened pull request #12.*, *Checks passed.*, *Merged into main.*, *Build #7 started.*, *Live at …* — each posted once, when it happens, in your language.

## Where an agent run may execute

An App Work's code is your repository, so a run that changes it starts only somewhere that can be trusted with it:

- **On one of your [Fleet](./fleet.md) machines**, when the machine reports an **isolated home** for the run (its own working directory, not your real home). A machine that declined isolation — or never reported — is a *downgrade*: the Task asks you once, **Allow on this machine** (on the Task's Cost section), and that allowance holds for that machine and that App Work until you withdraw it. A machine that is disabled never takes the run.
- **In an isolated cloud sandbox** that receives no platform secret and only reaches the repository host and package registries. No cloud executor offers that today, so App Work runs go to your machines.

Before the first run, the platform also checks it can mint a **push credential** for the repository's owner (the GitHub App must be installed there); without one, the run is refused with the owner named, instead of failing at the push. A repository larger than the shared limit for the checkout stage is refused with its size and the limit; no limit is set for this stage yet.

The same check is made when a parked or resumed run is handed to the Fleet, and again by the machine that actually picks the job up — so a machine enrolled later, or unpaused later, never runs an App Work change you did not allow.

## Branches and isolation

Every Task on an App Work runs on its own branch and ends in a pull request; a Task cannot opt out, and an agent that may not commit is refused before it starts. The branch is cut from — and the pull request targets — the branch the app is built from: the App spec's `source.branch`, else the branch the App spec is read from, else the repository's default branch. The Work keeps those settings in step with the App spec each time the spec changes.

## Checks

The App spec's `checks` are the commands a change must pass.

- **On your machines**, a check runs only once you **admit** its exact command (*App checks* card in the Work's Quality gates settings, **Admit for my machines**). You are notified once each time the spec's checks change. A check you have not admitted is reported **Not admitted** and never counts as passed.
- **In the repository's CI**, each check runs as its own `Ever Works check: {name}` job on pull requests and on pushes to the tracked branch.
- A **required** check that fails holds the merge; an **advisory** one (`required: false`) is reported but never holds it. Only legs reported by GitHub Actions count as App checks.
- A check whose tool is missing on the machine (`command not found`) reads **Error — a tool this check needs is missing on this machine**, and that machine is not offered the same Task again for a day.

When a required check fails, the agent is resumed to fix it, up to the Work's gate-attempt budget; after the last attempt the Task is **blocked** and you are asked what to do.

## From merge to live

A merged change is tracked until it is running:

| State | Meaning |
| --- | --- |
| `merged` | The change is in the tracked branch. |
| `building` / `build_failed` / `built` | The Build for that commit. |
| `deploying` / `deploy_failed` | The deployment of that Build. |
| `live` | The change is running. The Task closes. |
| `closed_without_deploy` | You closed it without deploying (**Close anyway** / **Close without deploying**). |

The Task's **Delivery** section shows the timeline, links to the Build and the deployment, the live address and any warnings. **Deploy now** deploys a built change when auto-deploy is off; **Try once more** retries a failed step; **Create a fix Task** opens a follow-up for a failure by hand.

When a build or deployment fails, the platform opens a **follow-up Task** on the original agent, with the failing log quoted as untrusted input — at most **2 per merged change** and **3 open per App Work** (operator settings `EVER_WORKS_APP_FOLLOW_UPS_PER_CHANGE` and `EVER_WORKS_APP_FOLLOW_UPS_OPEN_PER_WORK`). A change that goes live **with warnings** closes its Task by default and offers a manual fix Task (`EVER_WORKS_APP_DELIVERY_LIVE_WITH_WARNINGS_CLOSES`).

## Cost and budget

Each Task's **Cost** section shows what its runs cost (an unpriced run reads *unknown*, never $0). The App Work's Overview shows this month's spend against the Work's own budget, with its costliest Tasks. Runs on an App Work are booked against that budget: when it is spent, a new run **waits** — it uses no gate attempt and opens no follow-up — and starts once the budget allows (a new period, a raised cap, or the budget removed).

## When the operator pauses changes

An operator can stop new changes to every App Work (`EVER_WORKS_APP_CHANGES_ENABLED=false`) or stop changes deploying themselves (`EVER_WORKS_APP_AUTO_DEPLOY_ENABLED=false`). With changes off, no new change run starts, a request is refused, and the Overview says **"Changes to apps are paused by the operator."** Boards, delivery chains and history stay readable, running deployments keep running, and turning the switch back on resumes.

## Not yet

- **Goals and Missions scoped to an App Work**, and a Mission that files Tasks on one.
- **Templates** that propose App Work rules.
- **Safety-rail holds** that block a Task with the rail's reason when a guardrail refuses an action mid-run.
- Parking a refused Task and resuming it automatically when the operator switch comes back on.

## Related

- [App Works](./app-works.md) — creating one, the App spec, the change guard.
- [App runtime](./app-runtime.md) — Builds, deployments and addresses.
- [Fleet](./fleet.md) — your machines, and how runs reach them.
- [Tasks](./tasks.md) and [Task Isolation](./task-isolation.md).
