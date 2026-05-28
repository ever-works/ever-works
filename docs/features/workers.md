---
id: workers
title: Workers (Background Execution)
sidebar_label: Workers
---

# Workers (Background Execution)

**Workers** are the engine room behind everything that happens when you're not looking. They're the background-execution layer that runs your [Agents](./agents.md), generation pipelines, [scheduled updates](./scheduled-updates.md), and [Mission](./missions.md) ticks reliably, in parallel, with retries — so the platform's [autonomous operation](./autonomous-operation.md) keeps humming whether you have one Work or a hundred.

You rarely manage Workers directly. They're the "who's actually doing the job" answer underneath the Agents and schedules you *do* manage.

## What Workers run

| Job kind | What it does |
|---|---|
| **Agent heartbeats** | Wake each active Agent on its cadence, run its decision loop, record the run. |
| **Agent tasks & chat replies** | Execute work assigned to an Agent; reply when an Agent is mentioned. |
| **Generation pipelines** | Build and refresh a Work's content and code. |
| **Scheduled updates** | Re-run a Work's pipeline on its cadence. |
| **Mission ticks** | Generate fresh Ideas for scheduled Missions. |
| **Inbound email** | Turn incoming mail into Tasks or conversations. |
| **Ingest & extraction** | Normalize and extract uploaded Knowledge Base sources. |
| **Community PR processing** | Triage and merge community contributions. |

## How Workers behave

- **Parallel** — many jobs run at once; a dispatcher claims due work in batches so thousands of Agents and schedules scale without stepping on each other.
- **Safe under contention** — a single Agent's heartbeat can only be claimed by one Worker at a time (compare-and-set), so nothing runs twice.
- **Retried** — transient failures (network blips, provider rate limits, upstream 5xx) are retried with backoff before a job is marked failed.
- **Bounded** — runs have timeouts; an Agent that keeps failing auto-pauses rather than burning budget.
- **Observable** — every run emits activity-log entries and surfaces on the relevant Dashboard, with cost attributed to the right Agent, Task, or Work.

## Where they run

Workers are powered by the platform's background-jobs infrastructure (Trigger.dev plus internal queues). In the cloud, this is fully managed for you. When you self-host — or run the upcoming [Desktop App](./desktop-app.md) — Workers run alongside the rest of the stack, and you can also point them at an external or self-hosted jobs backend.

## See also

- [Agents](./agents.md) · [Autonomous Operation](./autonomous-operation.md)
- [Scheduled Updates](./scheduled-updates.md) · [Missions](./missions.md)
- [Desktop App](./desktop-app.md)
