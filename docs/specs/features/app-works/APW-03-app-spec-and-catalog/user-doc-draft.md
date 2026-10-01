---
id: app-blueprints
title: App Blueprints
sidebar_label: App Blueprints
description: Ready-made App specs for open-source apps, published in the Apps catalog, matched when you paste a repository URL, and checked against the app's license.
---

<!--
DRAFT — APW-03 user documentation. Not listed in apps/docs/sidebarsPlatform.ts.
Task T50 moves this file to docs/features/app-blueprints.md once the feature ships and corrects anything
that changed during implementation. Everything below describes planned behaviour.
Relative links are written for this draft's current location so the docs build resolves them; T50 rewrites
them for docs/features/ and points "Apps catalog API" at the shipped API page.
-->

# App Blueprints

An **App Work** runs software from a GitHub repository — yours, or a fork of someone else's. To run it, Ever
Works needs to know how to build it, which services it needs, which settings it reads and how to tell that
it is healthy. That description is the **App spec**, and it lives in your repository in
`.works/works.yml`.

An **App Blueprint** is a ready-made App spec for a known open-source app, reviewed by the Ever Works team
and published in the **Apps catalog** ([`ever-works/apps`](https://github.com/ever-works/apps)). When a
Blueprint exists, you skip the guesswork: Ever Works adds it to your repository and you can deploy.

## Three ways an App Work gets its App spec

| Situation                                             | What happens                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| The repository is listed in the Apps catalog          | Its Blueprint is applied automatically.                                                                  |
| An `ever-works/<name>-template` repository matches it | It is offered as an **Unlisted Blueprint** — usable, but not reviewed.                                   |
| Nothing matches                                       | The **App Provisioner** agent studies the repository and opens a pull request with an App spec it wrote. |

## Browse the Apps catalog

When you create an App Work, open **Browse the Apps catalog**. Search by name, tag or repository, filter by
category, and open **Details** to read the Blueprint's notes, what it needs (for example Postgres or an SMTP
server), and its license. Each card tells you:

- **Verified** — the Blueprint was built, booted and smoke-tested on Ever Works at its current version within
  the last 180 days. **Beta** entries work but have not been verified yet. **Coming soon** entries are not
  selectable.
- **License** — the app's license and what it means for hosting (see [Licenses](#licenses)).
- **Runs on** — where this app can run: **Your cluster**, and **Ever Works Apps** when the managed tier is
  available for it.

Choose **Use this app**, or paste the repository URL instead — a pasted URL is matched to the same
Blueprint, even if the repository was renamed since. A fork (even a fork of a fork) of a listed app is matched through
the original project it was forked from, and Ever Works asks you to confirm before using that Blueprint.

## How a Blueprint gets into your repository

- **A new fork or private copy** created for this App Work gets **one commit** named
  `chore(ever-works): apply App Blueprint <id> <version>`, made with your own Git connection. It adds
  `.works/works.yml` — where the repository came from and the App spec, together — and any extra files the Blueprint
  needs (for example a `Dockerfile` the project does not ship). Existing files are never overwritten.
- **A repository you linked** gets a **pull request** instead. Nothing is pushed to your default branch
  until you merge it.

Blueprints never copy the app's source code. They describe how to run it and reference the upstream project.

## The App spec page

**Work → Settings → App spec** shows the App spec Ever Works is using and whether the file in your repository
is valid.

- The spec is checked **on every push** to the branch your App Work deploys, usually within a minute, and
  whenever you press **Re-check now**.
- Each problem names the exact place — for example `components › web › port` — with its line and column, a
  suggested fix, and **Open in repository**.
- **An invalid file never takes your app down.** Ever Works keeps running the last valid spec and says so.
  Nothing new is built or deployed until the errors are fixed.
- Settings and secrets are listed by **name only**. Secret values are never shown, and the App spec cannot
  contain them: generated secrets are created once when you first deploy and stored encrypted.

You can edit `.works/works.yml` by hand at any time. Add this line at the top for completion in your editor:

```yaml
# yaml-language-server: $schema=https://api.ever.works/api/schema/works.yml.schema.json
```

The full field reference is in the [works.yml schema](../../../../agent-services/works-yml-schema.md#app).

## Blueprint upgrades

When the catalog publishes a newer version of your Blueprint, the App spec page shows **Blueprint
&lt;version&gt; is available.** Choose **Review upgrade** to get a pull request that updates your App spec.

- Changes **you** made to the spec are kept.
- When you and the Blueprint changed the same setting, your value is kept and the conflict is listed in the
  pull request.
- Upgrades marked **Breaking** need your attention before merging — read the pull request description.
- **Not now** hides the notice for that version only.

## Licenses

Ever Works reads your repository's license files and package manifests and classifies the license using the
catalog's license registry. The classification decides where the app may run.

| Class                   | Examples                                                 | Your cluster                                           | Ever Works Apps                                                       | Apps catalog |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------- | ------------ |
| **Open license**        | MIT, Apache-2.0, BSD, MPL, GPL, AGPL                     | Allowed                                                | Allowed when offered for the app                                      | Listed       |
| **Restricted hosting**  | Source-available licenses that limit hosting             | Allowed after you confirm the terms                    | Only when Ever Works has recorded an agreement with the app's authors | Listed       |
| **License unclear**     | No license found, or one the registry does not recognise | Allowed after you confirm you have the right to run it | Not available                                                         | —            |
| **Hosting not allowed** | Non-commercial or no-hosting licenses                    | Allowed after you confirm the restriction              | Never                                                                 | Never listed |

- **Confirming the terms.** Only the Work's owner can confirm: the owner reads the statement shown for that license
  and confirms it. Ever Works records who confirmed, when, and for which license and commit. If the license changes,
  it asks again.
- **Mixed licenses.** Some repositories keep part of their code under a different license (for example an
  `ee/` directory). Ever Works flags this and uses the more restrictive class.
- **License changes upstream.** The license is checked again after every upstream sync. If it becomes more
  restrictive, you are notified; your running app keeps running, and the next deployment waits for your
  confirmation.
- **Source links.** Licenses such as the AGPL require offering the running version's source to its users.
  Deployments of those apps show a **Source** link to the deployed commit. If your repository is private, add
  `license.sourceOfferUrl` to the App spec before deploying.
- **Trademarks.** Some app names are trademarks. Those apps are shown as, for example, **Cal.diy (community
  build)**, and files that carry the project's branding are protected from agent changes.

The classification is an automated reading of the repository's license files, **not legal advice**.

## Contributing a Blueprint

Blueprints are contributed by pull request:

1. Create a public repository `ever-works/<app>-template` with the topic `ever-works-app-blueprint`, containing
   `.works/works.yml`, any overlay files listed in `overlay.yml`, tests and a README.
2. Tag a release `v<version>`.
3. Add an entry to `manifest.json` in [`ever-works/apps`](https://github.com/ever-works/apps). CI checks the
   spec, the license, the overlay limits and that no upstream source was copied.

New entries start as **Beta**. The format is described in the catalog repository's `CONTRIBUTING.md`.

## Related

- [Work Blueprints](../../../../features/work-blueprints.md) — ready-made definitions for platform-built Works.
- [works.yml schema](../../../../agent-services/works-yml-schema.md) — every App spec field.
- [Apps catalog API](./plan.md) (planned; §4) — read the catalog programmatically.
