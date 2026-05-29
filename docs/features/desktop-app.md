---
id: desktop-app
title: Desktop App
sidebar_label: Desktop App
---

# Desktop App

> **Status: coming soon.** The Desktop App is on the roadmap. Today you can run Ever Works in the cloud or self-host the full stack with Docker. This page describes where the local experience is headed.

The **Desktop App** will let you run all of Ever Works **locally as a single application** — the API, the web dashboard, the [Workers](./workers.md), and the database, all bundled together. Install it, open it, and you have the entire platform on your own machine: build [Works](./creating-a-work.md), run [Agents](./agents.md), and operate [Missions](./missions.md) without depending on anyone else's servers.

## What "all local" means

- **Full stack in one app** — the API, frontend, background-jobs runtime, and database ship together. No separate services to wire up.
- **Your data on your machine** — repositories, Knowledge Base, and configuration stay local by default.
- **Works offline-first** — the platform keeps working without a constant connection to a cloud backend.

## Local, but not isolated

The Desktop App is designed to **connect outward** when you want it to:

- Point it at an **external database** (managed Postgres, or your own server).
- Use an **external background-jobs backend** (a hosted or self-hosted jobs service) instead of the bundled one.
- Connect any **AI, search, deployment, storage, or email provider** through the same [plugin system](../plugin-system/index.md) the cloud uses.
- Push your Works' code and content to **your Git provider** and deploy to **your targets**, exactly as in the cloud.

So you can start fully local and selectively move pieces to the cloud as you grow — without changing how you work.

## Why it matters

The Desktop App is the strongest expression of the platform's ownership promise: **open source (AGPLv3), your machine, your data, your repositories.** It's Ever Works as a workshop that lives on your desk, not just in a browser tab.

## See also

- [Workers](./workers.md) · [Plugin System](../plugin-system/index.md)
- [Installation](../installation.md) · [DevOps & Deployment](../devops/docker.md)
- [Roadmap](../roadmap.md)
