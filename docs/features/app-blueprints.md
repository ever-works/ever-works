---
id: app-blueprints
title: App Blueprints
sidebar_label: App Blueprints
description: Ready-made App specs for known open-source apps — the ever-works/templates listing, the ever-works/<name>-template repositories that hold them, the Cal and Umami Blueprints, how the platform recognises one, and why none is applied yet in this preview.
---

# App Blueprints

An **App Blueprint** is a ready-made [App spec](./app-works.md#the-app-spec) for a known open-source app: how to build it, which components and dependencies it needs, which settings it reads and how to tell that it is healthy. With a Blueprint, an [App Work](./app-works.md) can skip working out how to run the app. Every Blueprint that exists today is **metadata-only**: it holds no application source code, only a description of how to run the upstream project and a pointer to it. (The format also allows a `code-bearing` Blueprint, whose repository is a fork of the upstream; there is none yet.)

App Blueprints are a separate catalog from [Work Blueprints](./work-blueprints.md). Work Blueprints come from `ever-works/works`; App Blueprints are not listed there and are never offered as Work Blueprints.

:::note App Blueprints are not website templates
The Create-Work **Template** picker finds website templates among the `ever-works` organization's repositories whose name ends in `template`. Repositories tagged with the `ever-works-app-blueprint` topic are skipped, so `cal-template` and `umami-template` are never offered as website templates. A website template row saved for one of them before this rule existed is retired: it no longer appears in the picker and cannot be chosen for a new Work, while a Work that already uses it keeps working.
:::

:::warning Preview — off by default
App Works are a **preview**, switched off on every installation until an operator turns them on. **In this preview no Blueprint is applied to an App Work** — see [Status](#status-no-blueprint-is-applied-yet).

| Switch                            | Read by                                      | Default          | What it does                                                                                                        |
| --------------------------------- | -------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `EVER_WORKS_APP_WORKS_ENABLED`    | API (and the web app when it has no PostHog) | `false`          | Only the exact value `true` turns App Works on.                                                                     |
| `works-app` (PostHog flag)        | Web app                                      | Off when missing | Gates the dashboard's **App** chip (not shipped yet). Fails closed: only a strict `true` shows it.                  |
| `EVER_WORKS_APP_LAUNCHER_ENABLED` | API                                          | `false`          | Turns on the [App Launcher](./app-launcher.md), where live App Works appear.                                        |
| `APP_WORKS_CLOUD_PUSH_ENABLED`    | API                                          | `false`          | Lets cloud agent runs push App Work branches — see [Evolving the app](./app-works.md#evolving-the-app-with-agents). |

Reading Blueprints needs a platform GitHub credential — see [How the platform recognises a Blueprint](#how-the-platform-recognises-a-blueprint).
:::

## Where Blueprints live

Two kinds of public repository, both under the `ever-works` GitHub organization:

- **[`ever-works/templates`](https://github.com/ever-works/templates)** is the **listing**: a human index of the templates Ever Works keeps. It holds `manifest.json` (one row per template repository), `licenses.yml` (the license registry), the schemas both are checked against, and the CI that validates them. It contains **no application code and no copy of any template**. Besides the App Blueprints, it lists the four Website/Work Templates.
- **`ever-works/<name>-template`** — one repository per Blueprint, and the only place its content lives:

| File                  | What it is                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `.works/works.yml`    | The App spec, with root `kind: app`. **The only file the platform reads.**                                                               |
| `.works/template.yml` | The repository's shape — `metadata-only` (no application source at all) or `code-bearing` (a fork of the upstream) — and its app source. |
| `README.md`           | What the Blueprint decides, the facts behind it and where they were read, and what is still unverified.                                  |

The platform does not read the listing at run time. The license registry it classifies with is a copy of the listing's `licenses.yml` bundled into the platform.

## The Blueprints that exist today

| Blueprint             | Repository                                                                  | Upstream project                                                                              | Id and version  | License | How it runs                                                                                       |
| --------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------- | ------- | ------------------------------------------------------------------------------------------------- |
| Cal (community build) | [`ever-works/cal-template`](https://github.com/ever-works/cal-template)     | [`calcom/cal.diy`](https://github.com/calcom/cal.diy), the scheduling app's community edition | `cal` · 0.1.0   | MIT     | Built from the upstream's Dockerfile; needs Postgres.                                             |
| Umami                 | [`ever-works/umami-template`](https://github.com/ever-works/umami-template) | [`umami-software/umami`](https://github.com/umami-software/umami), web analytics              | `umami` · 0.1.0 | MIT     | Runs the upstream's published container image, pinned by digest — no Build, so no runner minutes. |

Both repositories are public, carry the topic `ever-works-app-blueprint` and are `metadata-only`. Both are **drafts**: the listing marks them `placeholder`, because neither has been released (tagged) or verified on a cluster yet. The Cal Blueprint carries the upstream project's trademark notice and names the app "Cal (community build)", and the listing does not offer it for managed hosting.

## How the platform recognises a Blueprint

A repository is accepted as a Blueprint only when **all** of these hold:

1. it is in the `ever-works` organization — a repository renamed or transferred out of it is refused;
2. it is **public**;
3. it carries the topic `ever-works-app-blueprint`;
4. its `.works/works.yml`, on the default branch, validates as a Blueprint with no errors, has root `kind: app`, and its `spec.blueprint.repo` names that very repository;
5. the license it declares does not classify **red**.

Two ways of finding one are implemented:

- **By id.** A `blueprintId` names `ever-works/<id>-template`, whose `spec.blueprint.id` must equal that id.
- **By probe.** For a pasted `owner/repo`, the platform tries `ever-works/<repo>-template`, then `ever-works/<owner>-<repo>-template` — names lower-cased, with every run of other characters turned into `-` — in at most three reads and never by searching. So `umami-software/umami` finds `ever-works/umami-template`, while `calcom/cal.diy` is looked up as `ever-works/cal-diy-template`, the Cal Blueprint's former name; its id, `cal`, names it directly.

Looking a repository up through the listing's manifest, through a project's former names, or through its fork network is **not implemented yet**. A match found by id or by probe is never marked verified.

The lookups use a **platform** credential, never yours: the Ever Works GitHub App's installation on `ever-works`, else `EVER_WORKS_APPS_CATALOG_TOKEN`, else `GITHUB_TOKEN`. With none of them, the preview reports the catalog as unavailable. A found Blueprint is remembered for an hour and a miss for ten minutes.

## Status: no Blueprint is applied yet

Applying a Blueprint — adding its App spec to your repository — is the step that has not been built. Until it is, the platform **holds every match back** rather than record a Blueprint it cannot apply:

- The inspect preview reports the catalog as **unavailable** for a repository that has a Blueprint, and its license as **unknown**. A repository with no Blueprint previews `none`, with its detected license classified as usual.
- A create request that names a `blueprintId` is refused with `400 blueprint_mismatch`, and nothing is written.
- Every App Work is therefore created without a Blueprint: the platform records only where the repository came from in `.works/works.yml`, and the rest of the App spec is yours to write. The **App Provisioner**, the agent meant to write it for you when no Blueprint exists, is not built either.

## Licenses in a Blueprint

A Blueprint declares its app's license in the App spec's `license` block — the SPDX id, the source `blueprint`, and a `notice` when the upstream requires one. The platform recomputes the class from the SPDX id and ignores any class the Blueprint writes itself, and a Blueprint whose license classifies **red** is never accepted. How classes are assigned, and what each allows, is in [Licenses](./app-works.md#licenses).

## Contributing a Blueprint

Blueprints are contributed by pull request; [`CONTRIBUTING.md`](https://github.com/ever-works/templates/blob/main/CONTRIBUTING.md) in the listing has the full procedure. In short: open an issue describing the project first, create the public `ever-works/<name>-template` repository with the topic, the App spec, `.works/template.yml` and a README, then open one pull request against `ever-works/templates` that adds its row to `manifest.json` as a `placeholder` (and its license to `licenses.yml` when that license is new). Releasing a tag and a green verification run on a cluster are what move a row on from `placeholder`.

## Related

- [App Works](./app-works.md) — creating an App Work, the App spec and licenses.
- [App Builds & Deployments](./app-runtime.md) — what a Blueprint's `build` block leads to.
- [Work Blueprints](./work-blueprints.md) — the separate catalog behind the Create-Work Template picker.
- [works.yml schema](../agent-services/works-yml-schema.md#app) — every App spec block.
