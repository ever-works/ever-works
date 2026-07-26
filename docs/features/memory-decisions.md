---
id: memory-decisions
title: Decisions & the Memory Review Queue
sidebar_label: Decisions & Review
---

# Decisions & the Memory Review Queue

Your [Knowledge Base](./knowledge-base.md) is what every Agent run reads before it acts. Two features keep it trustworthy as Agents start writing to it themselves: a first-class **decision** document class, and a **review state** that keeps agent-authored material out of Agent context until a human has looked at it.

## Decisions

A KB document with `class: decision` records a choice — what was decided, why, and whether it still holds. Decisions carry their own lifecycle, separate from the document's publish status:

```
proposed  →  accepted  →  superseded  →  archived
```

`archived` is reachable from any non-terminal state. Illegal moves are rejected with `409`.

```
POST /api/works/:id/kb/documents/:docId/decision-status
     { "status": "superseded", "supersededByDocId": "…", "rationale": "…" }
```

Transitioning to `superseded` with a `supersededByDocId` records the replacement chain on **both** documents, so a reader always lands on the decision that is currently in force rather than a stale one. When a superseded decision is later archived, its survivor is promoted so the chain never dead-ends.

Retrieval is decision-aware: accepted decisions rank ahead of general notes for the same query, and they render with their status so an Agent (and you) can see at a glance whether a rule is current.

## Review state

Anything an Agent writes or synthesizes lands as `reviewState: proposed`. Proposed documents are **excluded from context injection** at all three retrieval paths — an Agent cannot bootstrap its own claims into its own future context.

Absent or `null` review state is treated as `accepted`, so everything written before this feature (and everything a human writes) keeps feeding context exactly as before.

### Acting on a proposal

| Action           | Endpoint                                          | Effect                                                                                                                                                        |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accept           | `POST /api/works/:id/kb/documents/:docId/accept`  | Flips `reviewState` to `accepted` so the document starts feeding context. A decision still in `proposed` is accepted as current in the same call. Idempotent. |
| Edit then accept | `PATCH` the document, then Accept                 | Fix the wording first, then admit it.                                                                                                                         |
| Supersede        | `POST …/decision-status` with `superseded`        | Keeps the history and points readers at the replacement.                                                                                                      |
| Archive          | `POST /api/works/:id/kb/documents/:docId/archive` | Kept readable, dropped from default listings and from context injection. Never a physical delete. Idempotent.                                                 |

Archive is deliberately not a delete: a decision you reversed is itself part of the record.

## Recall injection

Agent runs and all four self-managed pipelines pull recall from the same helper, so what an Agent "remembers" is consistent no matter which path invoked it. You can turn recall off for a Work:

```
PATCH /api/works/:id   { "memoryRecallEnabled": false }
```

With it off, self-managed pipeline runs for that Work skip the fenced memory block in their session preamble. It is on by default.

## Related

- [Knowledge Base & Memory](./knowledge-base.md) · [Agents](./agents.md) · [Autonomous Operation](./autonomous-operation.md)
