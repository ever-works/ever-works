---
id: memory-decisions
title: Decisions & the Memory Review Queue
sidebar_label: Decisions & Review
---

# Decisions & the Memory Review Queue

Your [Knowledge Base](./knowledge-base.md) is what every Agent run reads before it acts. Two features keep it trustworthy as Agents start writing to it themselves: a first-class **decision** document class, and a **review state** that keeps agent-authored material out of Agent context until a human has looked at it.

:::note Where this lives

There are **two** review surfaces, and which one you use depends on where the proposal was written:

- **`/works/:id/kb/review`** — the queue for a single Work. It opens inside the KB workbench (same tree pane on the left, queue in the center) and is reached from the **Review** link in the workbench header, which carries an amber count badge whenever something is waiting.
- **`/memory`** — the **Awaiting review (N)** panel at the top of the org-wide [Memory](./memory.md) page, holding organization-level proposals, including everything [consolidation](./memory.md#consolidation) synthesizes. The panel hides itself when the queue is empty, so an empty queue costs you no screen space.

:::

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

## The two review surfaces

| Surface                       | Route                               | What it holds                                                                                             | Actions on a row                                                           |
| ----------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Work review queue**         | `/works/:id/kb/review`              | `proposed` documents in that one Work's Knowledge Base — agent-written notes and captured learning.       | **Accept**, **Edit & accept**, **Supersede** (decisions only), **Archive** |
| **Organization review queue** | `/memory` → **Awaiting review (N)** | `proposed` documents published at the organization level, including consolidation's LLM-merged documents. | **Accept**, **Reject**                                                     |

Both are the same circuit breaker seen from two scopes: nothing in either list is feeding Agent context while it sits there.

### How to clear a Work's review queue

1. Open the Work's Knowledge Base at **`/works/:id/kb`** and click **Review** in the tree header — the badge next to it is how many documents are waiting. (**`/works/:id/kb/review`** takes you straight there.)
2. Read the **Memory health** panel above the queue first: it reports the backlog and its age ("23 documents waiting, the oldest for 41 days") and the gap topics retrieval could not answer, so you can tell which proposals actually close a measured hole. See [Memory health](./memory.md#memory-health).
3. Expand a row (**Toggle content preview**) to read the start of the body without leaving the queue — the list itself is metadata-only, so the body is fetched for that one document on demand.
4. Press **Accept** to admit it, or **Edit & accept** to open it in the workbench editor first. On that page a banner says _"This document is awaiting review — it is not feeding agent context yet. Edit it if needed, then accept."_ and carries its own **Accept** and **Archive** buttons, so you fix the wording and accept in place.
5. On a `decision`-class document a **Supersede** action appears as well: choose the surviving decision in the **Replaced by** picker and confirm.
6. Use **Archive** for anything that should not be admitted. Accepted, archived and superseded rows leave the queue immediately.

### How to clear the organization queue

1. Open **`/memory`**. If there is no **Awaiting review** panel, the queue is empty and there is nothing to do.
2. Each row names the document and shows its description (or its path when it has none).
3. **Accept** (`POST /api/memory/review/:docId/accept`) makes the document eligible for context injection; if its class is inheritable it is also overlaid into every Work.
4. **Reject** (`POST /api/memory/review/:docId/reject`) **archives** it — it leaves the queue and is never injected again, but stays readable. It is not a delete, it is idempotent, and if the document had already been accepted under an inheritable class the overlay is retracted.
5. A failed action leaves the row where it is and says so ("Couldn't accept — try again"), so a refusal never reads as a no-op. Retry the same button.

Both organization actions are scoped writes: the document must belong to the active Organization, and anything else answers `404` — deliberately indistinguishable from "does not exist", so document ids in other organizations cannot be probed.

## Recall injection

Agent runs and all four self-managed pipelines pull recall from the same helper, so what an Agent "remembers" is consistent no matter which path invoked it. You can turn recall off for a Work:

```
PATCH /api/works/:id   { "memoryRecallEnabled": false }
```

With it off, self-managed pipeline runs for that Work skip the fenced memory block in their session preamble. It is on by default.

## Related

- [Knowledge Base & Memory](./knowledge-base.md) · [Agents](./agents.md) · [Autonomous Operation](./autonomous-operation.md)
- [Memory (Org-Wide)](./memory.md) — the `/memory` page: the organization-level review queue, consolidation, memory health and Files.
