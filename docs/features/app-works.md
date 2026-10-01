---
id: app-works
title: 'App Works: Run and Evolve a GitHub Repository'
sidebar_label: App Works
description: An App Work runs an existing GitHub repository as a Work — linked, forked or privately copied into your account — and lets your agents keep changing it. A preview, off by default; this page says exactly what works today.
---

# App Works

An **App Work** is a Work whose code is a repository that already exists on GitHub — yours, or someone else's open-source project. Ever Works links it, forks it or makes a private copy of it in your own GitHub account, records where it came from in `.works/works.yml`, and lets your agents keep changing it through Tasks. How the app is built and run, and the rules agents must follow, go in the **App spec** in that same file, which you write yourself in this preview.

:::warning Preview — off by default
App Works are a **preview**. Every installation ships with them switched off, and several parts described on this page are not built yet — each section says what works today, and [What works today](#what-works-today) sums it up. Four operator switches control the surface:

| Switch                            | Read by                                      | Default          | What it does                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVER_WORKS_APP_WORKS_ENABLED`    | API (and the web app when it has no PostHog) | `false`          | Only the exact value `true` turns App Works on. Off, the API refuses to inspect a repository for an App Work or to create one (`app_works_disabled`).                                                                                         |
| `works-app` (PostHog flag)        | Web app                                      | Off when missing | Gates the dashboard's **App** chip, which has not shipped yet. It fails **closed**: only a flag that resolves strictly to `true` shows the chip; a missing flag, an error or a timeout hides it. Without PostHog, the variable above decides. |
| `EVER_WORKS_APP_LAUNCHER_ENABLED` | API                                          | `false`          | Turns on the [App Launcher](./app-launcher.md), where live App Works appear. Only the exact value `true` turns it on.                                                                                                                         |
| `APP_WORKS_CLOUD_PUSH_ENABLED`    | API                                          | `false`          | Lets a cloud (API-side) agent run push an App Work branch and open its pull request. Off, only [Fleet](./fleet.md) runs publish changes — see [Evolving the app](#evolving-the-app-with-agents). Read when the API starts.                    |

Set `EVER_WORKS_APP_WORKS_ENABLED` on the API and web deployments alike, and keep the `works-app` flag in step with it. The other App Works variables are listed in the [Environment Variables reference](../environment-variables.md#app-works-preview).
:::

## What an App Work is

A Work of kind `app`. Its **Work Repository** is the repository you linked, forked or copied — nothing is generated into it, because the code was already there. That makes it different from the kinds you already know:

|                           | Website, blog, directory, landing page …                    | App Work (`app`)                                                                |
| ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Where the code comes from | Generated from a [website template](./website-templates.md) | An existing GitHub repository you point at                                      |
| Items, taxonomy, pipeline | Yes (per kind)                                              | None — no Items tab, no categories or tags, no content generation               |
| Deploy                    | Yes                                                         | Yes, through its own runtime — see [App Builds & Deployments](./app-runtime.md) |
| Knowledge base            | Yes                                                         | Yes                                                                             |
| What agents change        | The generated site and its data                             | The app's own source, under the rules in its [App spec](#the-app-spec)          |
| Overview tiles            | Per kind                                                    | Agents · Open Tasks · Deploy Status · Days Active                               |

It also differs from a **Repository Work** (`repo`): a Repository Work only attaches agents to a code repository and never deploys it, while an App Work exists to run the app. See [Work Kinds & Capabilities](./work-kinds.md).

## What works today

| Part                                                                                            | Status in this preview                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inspecting a repository before creating                                                         | **Available** through the API.                                                                                                                                               |
| Creating an App Work (link, fork, private copy)                                                 | **Available** through the API. There is no create form or **App** chip in the dashboard yet.                                                                                 |
| Recording the source in `.works/works.yml`                                                      | **Available where Trigger.dev runs background jobs** — a commit, or a setup pull request, once the repository is ready. See [What happens next](#what-happens-next).         |
| The App spec page and its validation                                                            | **Available** under the Work's **Settings → App spec**, once the readiness job has run.                                                                                      |
| The **Upstream** tab                                                                            | **Available** for forks and private copies (relation, readiness, workflow state). Syncing itself is not running yet, so the divergence reading and the last sync stay empty. |
| Agent changes through Tasks, with the change guard                                              | **Available**. Cloud runs do not push unless an operator allows it.                                                                                                          |
| Deleting an App Work                                                                            | **Available**, with the repository protections below.                                                                                                                        |
| License classification                                                                          | **Available** in the inspect preview. The owner's license confirmation is not built.                                                                                         |
| [App Blueprints](./app-blueprints.md)                                                           | Recognised, but **not applied** — a matching Blueprint is held back.                                                                                                         |
| [Builds](./app-runtime.md#builds)                                                               | The GitHub Actions build pipeline exists, but **nothing starts a Build** yet, and there is no Builds tab.                                                                    |
| [Deployments](./app-runtime.md#deploying)                                                       | The deploy request and its checks exist, but a Deployment **cannot complete** yet.                                                                                           |
| **Ever Works Apps** (managed hosting for App Works)                                             | **Not available.**                                                                                                                                                           |
| The App Provisioner agent, proposing changes upstream, App environment and dependencies screens | **Not built.**                                                                                                                                                               |

## Creating an App Work

Creating an App Work is an API call today; the dashboard form that will wrap these two calls has not shipped. Both calls need a signed-in session (or an [API key](./api-keys.md)) and a connected GitHub account — GitHub is the only provider App Works read.

### 1. Inspect the repository

```bash
curl -X POST https://api.ever.works/api/works/app-source/inspect \
  -H "Authorization: Bearer $EVER_WORKS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "repositoryUrl": "https://github.com/example/scheduler" }'
```

Inspect **writes nothing** — no repository, no Work, no Activity entry. It answers everything the create call will decide: the repository's facts, whether you can push to it, which of **Link**, **Fork** and **Private copy** are available (with a reason code whenever one is not), the GitHub accounts and organizations you can fork into, the [Blueprint](./app-blueprints.md) and license previews, the deploy targets, and your own existing App Work for the same repository, if any. Problems on GitHub's side — a missing repository, an SSO wall, a rate limit, an empty repository — come back as reason codes in a `200` answer, because they are things to show, not errors. It is limited to 30 calls a minute.

### 2. Create it

```bash
curl -X POST https://api.ever.works/api/works \
  -H "Authorization: Bearer $EVER_WORKS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Scheduler",
        "kind": "app",
        "repositoryUrl": "https://github.com/example/scheduler",
        "repositoryMode": "fork",
        "targetOwner": "my-org"
      }'
```

| Field            | Required                      | Meaning                                                                                                                                              |
| ---------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`           | Yes                           | `"app"`.                                                                                                                                             |
| `repositoryUrl`  | Yes                           | The GitHub repository to run (`https://github.com/<owner>/<repo>`).                                                                                  |
| `repositoryMode` | Yes                           | `link`, `fork` or `private-copy` — see below.                                                                                                        |
| `targetOwner`    | For `fork` and `private-copy` | The GitHub account or organization the fork or copy is created in. It must be one inspect listed for you.                                            |
| `deployProvider` | No                            | The deploy target. Leave it out for **None — don't deploy yet**. See [Deploy targets](./app-runtime.md#deploy-targets).                              |
| `blueprintId`    | No                            | A Blueprint id to use. Refused today with `blueprint_mismatch`, because no Blueprint can be applied yet — see [App Blueprints](./app-blueprints.md). |

The answer carries the Work and an `appSource` block: the relation, the readiness (`preparing` at first), the Work Repository, the upstream (absent for a link) and the deploy target.

Creating is safe to retry. The same request within **10 minutes** returns the App Work it already created, with `alreadyExisted: true`, and two identical requests sent at once are serialised — the second is refused with `409 create_in_progress` rather than making a second fork. The checks below are all decided before anything is written on GitHub or in the database. The codes you are most likely to meet:

| Code                                                 | What it means                                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `app_works_disabled`                                 | The installation has App Works switched off.                                                               |
| `invalid_url`                                        | The URL does not parse as a GitHub repository.                                                             |
| `target_owner_unavailable`, `target_owner_forbidden` | The account in `targetOwner` is not one you can create the fork or copy in.                                |
| `in_use_by_another_account` (409)                    | Someone else already runs this repository as a Work.                                                       |
| `app_work_exists` (409)                              | You already have an App Work for this repository, and this is not a repeat of the request that created it. |
| `cluster_target_unavailable`                         | The `deployProvider` you named is not a deployment plugin enabled for your account.                        |
| `managed_hosting_unavailable`                        | You asked for **Ever Works Apps**, which is not open on this installation.                                 |
| `rate_limited`                                       | GitHub's rate limit for your account is spent; try again later.                                            |

### Link, fork or private copy

All three are made with **your own** GitHub connection, in an account or organization you choose — never in a shared platform account.

- **Link** uses the repository where it is. It is offered when you can push to it, and it is the default when you can push to a repository that is not itself a fork. It is not available for an archived repository or one another account already runs as a Work.
- **Fork** forks it into `targetOwner`. It is the default when you cannot push. A fork of a public repository is public on GitHub. If you already have a fork in that account, it is adopted rather than duplicated. Not available when the repository disables forking, is empty, or is already your own.
- **Private copy** creates a private duplicate in `targetOwner`, with no fork link back to the original. Not available for a repository over 500 MB, one that uses Git LFS, or a private repository that disallows forking.

### What happens next

A background job waits for the repository to be ready — a fresh fork can take a moment. Its readiness is one of **preparing**, **ready**, **waiting for the setup pull request**, **timed out** or **failed**. A timed-out or failed App Work can be retried — **Try again** on the Upstream tab of a fork or private copy, or `POST /api/works/:id/upstream/readiness/retry` for any App Work — at most three times in a rolling hour. A retry never requests a second fork.

:::caution The readiness job needs Trigger.dev
The readiness job is dispatched only through Trigger.dev. On an installation where Trigger.dev is not configured (see [Trigger.dev variables](../environment-variables.md#triggerdev-background-jobs) and [Job Runtimes](./job-runtimes.md)), a new App Work stays **preparing**, with the reason `dispatch_unavailable`, and none of the steps below happen: the source is not recorded, the inherited workflows are not switched off, and **Settings → App spec** shows a not-found page, because the App spec record is created by this job. **Try again** cannot help, because it is refused while an App Work is preparing, and nothing re-dispatches the job later.
:::

When the repository is ready, the platform records where it came from in `.works/works.yml`:

- A repository **this App Work created** — a new fork or private copy — gets **one commit**, `chore(ever-works): record App source`.
- A **linked** repository, or a fork you already had, gets a **pull request** instead, titled _Add Ever Works App source_, from the branch `ever-works/app-setup`. Nothing is pushed to your default branch; the Work waits for you to merge it.

On a fork or a private copy, the workflows inherited from the original project are switched off, except the Ever Works build workflow — they are somebody else's CI pointed at your repository. A workflow you turn back on yourself stays on. A linked repository is never touched.

## The App spec

Everything the platform needs to build, run and police an App Work lives in your repository, in the `spec` block of `.works/works.yml` with `kind: app`. You edit it like any other file; an agent changes it through a pull request, under the guard described [below](#evolving-the-app-with-agents).

```yaml
version: 2
kind: app
name: Scheduler
spec:
    source:
        relation: fork
        upstream: { repo: example/scheduler, defaultBranch: main }
        branch: main
    build: { strategy: dockerfile, dockerfile: Dockerfile }
    components:
        - name: web
          role: web
          port: 3000
          probes: { readiness: { http: /healthz } }
    dependencies:
        postgres: { version: '16' }
    env:
        - { name: DATABASE_URL, secret: true, from: deps.postgres.url }
        - { name: APP_URL, from: domains.primary.url }
        - { name: SESSION_SECRET, secret: true, generate: { kind: hex, bytes: 32, rotate: never } }
    smoke:
        - { name: home, http: { method: GET, path: / }, expect: { status: [200] } }
    checks:
        - { name: unit, command: 'npm test', required: true }
    display:
        protectedPaths: [LICENSE, 'public/logo*']
```

Its blocks are `source` (where the repository came from), `blueprint`, `license`, `display`, `build`, `components` (up to 10), `dependencies`, `env` (up to 200 entries), `jobs`, `cron`, `domains`, `smoke`, `checks`, `agents`, `upstreamSync`, `upstreamPullRequests` and `provisioning`. The field reference is on the [works.yml schema](../agent-services/works-yml-schema.md#app) page, and the machine-readable schema is served at `https://api.ever.works/api/schema/app-spec.schema.json` — add `# yaml-language-server: $schema=https://api.ever.works/api/schema/works.yml.schema.json` to the top of the file for completion in your editor.

**Work → Settings → App spec** (`/works/:id/settings/app-spec`) is shown for App Works only. It reads the file on the Work's tracked branch and shows whether it is valid, has warnings, has errors, is missing or cannot be read, with each problem located in the file and an **Open in repository** link. Anyone who can see the Work can read the page; editors also get **Re-check now**. The page re-checks by itself when you open it and the branch has a new commit.

- **A file with errors never replaces the last valid spec.** The page says which commit's spec is still in effect, and nothing new is built or deployed from a commit whose spec has errors.
- **Secrets stay out of the file and off the page.** Each `env` entry names where its value comes from — generated once, derived from a dependency or the domain, a template, asked at setup, or a fixed value written in the file. The page lists every variable by name with that source and a **Secret** mark where it applies; the only values it shows are non-secret fixed values, cut at 80 characters.

## Licenses

The inspect preview classifies the repository's license into one of four classes. The classification is automated reading of what GitHub reports, **not legal advice**.

- **Green**, **amber** and **red** come from a license registry; anything the registry does not list is **unknown**. The built-in registry is a small, not yet legal-reviewed seed: `MIT`, `Apache-2.0` and `AGPL-3.0-only` are green, `BUSL-1.1` is amber, and `PolyForm-Noncommercial-1.0.0` is red. Every other license is unknown for now.
- An SPDX expression takes the **best** class of an `OR` and the **worst** of an `AND`, on the order green, amber, unknown, red.
- **`NOASSERTION` is red.** That is what GitHub reports when it finds a license file it cannot name — terms nobody has identified — so it is treated as the strictest class rather than as unknown. A repository with **no** license file is unknown.
- When the Apps catalog cannot answer — including, today, whenever a Blueprint would match (see [App Blueprints](./app-blueprints.md#status-no-blueprint-is-applied-yet)) — the preview says the license is unknown rather than guessing.

What each class will allow, per [deploy target](./app-runtime.md#deploy-targets):

| Class   | None          | Your cluster                    | Ever Works Apps (not available yet)     |
| ------- | ------------- | ------------------------------- | --------------------------------------- |
| Green   | Never refused | Allowed                         | Allowed                                 |
| Amber   | Never refused | After the Work's owner confirms | Only with a recorded upstream agreement |
| Unknown | Never refused | After the Work's owner confirms | No                                      |
| Red     | Never refused | After the Work's owner confirms | Never                                   |

**Today:** the owner's confirmation is not built, so a deploy to your own cluster is not refused over its license — it carries a `license_eligibility_unavailable` warning instead — while Ever Works Apps refuses in the same state. **None** runs nothing, so no license can refuse it.

## Staying in sync with the original project

A fork or a private copy has an **Upstream** tab (`/works/:id/upstream`); a linked App Work has none, because it has no upstream. The tab shows the relation (_Fork of …_ or _Private copy of …_), the readiness, how far your copy has diverged, the last sync, the state of the inherited workflows and any warnings. Once the repository is ready or waiting for its setup pull request, the same card also appears on the Work's Overview.

The sync rules the platform implements:

- It **never pushes to the original project, never force-moves a branch, and never resolves a conflict itself.**
- Upstream changes arrive as **one pull request** from the branch `ever-works/upstream-sync` into your tracked branch, reused and updated on later syncs. A conflicting pull request becomes a **Task** for your agents.
- Syncs are scheduled **weekly, on Mondays at 06:00 UTC** by default, each Work shifted by a stable delay of up to five minutes. **Sync now** (`POST /api/works/:id/upstream/sync`) is limited to six times in a rolling hour.

**Today:** the sync job itself is not wired to a worker. **Sync now** is accepted (`202`), but no sync runs, and no scheduled sync runs either. The divergence reading and the last-sync time come from that same job, so they stay empty — the tab shows _Divergence unknown_ and _Not synced yet_. Syncing a private copy additionally needs a provider capability that does not exist yet. The `upstreamSync` block of your App spec is validated but not yet read by the sync.

## Evolving the app with agents

[Tasks](./tasks.md) on an App Work act on its real repository, exactly like Tasks on any other Work: each runs on its own branch ([Task Isolation](./task-isolation.md)) and ends in a pull request. What is different is that every change is judged before it can become one.

**The change guard** reads the diff — not what the agent says it did — against the rules in `.works/works.yml` **at the tip of the base branch**, so an agent can never be judged by rules it just loosened. It refuses a change that:

1. is too big to read whole — 300 files or more, or a diff GitHub truncated;
2. touches a path in `display.protectedPaths` (a rename counts as touching the old path too) — this is how an app's branding files stay read-only to agents;
3. touches `.github/workflows/**`, always, whatever the spec says;
4. changes the `source`, `license` or `blueprint` blocks of the App spec, or **removes** entries from `display.protectedPaths` or `agents.requireHumanMergePaths` — adding entries is always allowed;
5. is more than three times the size guidance, `agents.maxPullRequestChangedLines` (default 500 lines; lockfiles are not counted). Between the guidance and three times it, the change goes through with a note.

A refused change opens no pull request; the Task is **blocked** with the reason.

**Where a run may publish from.** A Task that runs on one of your [Fleet](./fleet.md) nodes pushes with the node's own credential, and the platform judges the branch afterwards. A **cloud** run — one the API executes — does not publish an App Work change by default: it commits locally, pushes nothing, opens no pull request, and the Task is blocked with a message saying so. The agent tools that commit to a repository or open a pull request refuse an App Work the same way. An operator can set `APP_WORKS_CLOUD_PUSH_ENABLED=true`; cloud runs then have their exact commit judged by the guard **before** it is pushed, and the pushed branch judged again. Every other kind of Work ignores the switch.

## Deleting an App Work

Delete it from the Work's **Settings**, or with `POST /api/works/:id/delete`. The repository rules are fixed:

- The **original project** is never deleted.
- A **linked** repository, and a fork you already had before the App Work adopted it, are never deleted — asking for it is refused, not ignored.
- A fork or private copy that **this App Work created** is deleted only when you explicitly ask. Leaving the option out always means _keep it_, for every client.
- Deleting the app's stored data needs the Work's slug typed exactly.

## Builds, deployments and addresses

How an App Work is meant to be built (in your repository's GitHub Actions, with the image published to GitHub's container registry and its digest confirmed), where it can run (**None**, **Your cluster**, **Ever Works Apps**), and what address it gets (a verified custom domain, else a managed subdomain) are on their own page: [App Builds & Deployments](./app-runtime.md). In this preview none of it runs end to end yet.

## The App Launcher

An App Work appears in the [App Launcher](./app-launcher.md) as soon as it is **live** — no switch to turn on. Because an App Work cannot complete a Deployment in this preview, none is live yet, so none appears there today.

## Related

- [App Builds & Deployments](./app-runtime.md) — build strategies, deploy targets, addresses and what the cluster receives.
- [App Blueprints](./app-blueprints.md) — ready-made App specs, and the `ever-works/templates` listing.
- [App Launcher](./app-launcher.md) — the top-bar tiles live App Works appear in.
- [Work Kinds & Capabilities](./work-kinds.md) — the `app` row, and the fail-closed chip.
- [Creating a Work](./creating-a-work.md) — every other way to create a Work.
- [works.yml schema](../agent-services/works-yml-schema.md#app) — the App spec block.
- [Tasks](./tasks.md) · [Task Isolation](./task-isolation.md) · [Fleet](./fleet.md) — how agent changes are made and where they run.
