---
id: sessions-and-steering
title: Sessions & Run Steering
sidebar_label: Sessions & Steering
---

# Sessions & Run Steering

Every time an Agent runs — on a schedule, from a Task, from chat, from an inbound event — the platform records a **session** (an agent run). The Sessions view is where you watch them, and **steering** is how you talk to one that is already in flight instead of waiting for it to finish and starting another.

## The Sessions list

```
GET /api/agents/runs
```

returns _your_ runs across every Agent and every Work, newest first, with `{ data, meta: { total, limit, offset } }`.

Filters (each one only ever narrows your own set — you cannot widen it to somebody else's runs):

| Filter    | Values                                                      |
| --------- | ----------------------------------------------------------- |
| `status`  | `queued` · `running` · `completed` · `failed` · `cancelled` |
| `kind`    | `heartbeat` · `manual` · `task` · `chat` · `event`          |
| `workId`  | uuid                                                        |
| `agentId` | uuid                                                        |
| `taskId`  | uuid                                                        |
| `limit`   | 1–200 (default 50)                                          |
| `offset`  | ≥ 0                                                         |

Each row carries what the run cost and changed — duration, tokens, changed files, spend — plus its gate status and attempt count, whether it is `awaitingInput`, and why it is queued if it is.

A Work's header polls a cheaper summary of the same data:

```
GET /api/works/:id/runs-summary
→ { running, queued, awaiting, failedLast24h }
```

## Steering a live run

```
POST /api/agents/:id/runs/:runId/steer   { "message": "…" }
```

The message is appended to the run's pending-input queue and drained **between tool round-trips**, so the Agent picks it up at the next clean boundary rather than mid-call.

The response tells you which of two things happened:

| `dispatched` | Meaning                                                                            |
| ------------ | ---------------------------------------------------------------------------------- |
| `injected`   | The run is live; your message is queued into it. `queuedCount` is the queue depth. |
| `new-run`    | The run already finished while you were typing — start a fresh run instead.        |

`new-run` is deliberately **not** an error: "the run ended while a human was typing" is a normal race with a defined next step.

In Task chat, posting a message while a run is live steers that run rather than dispatching a second one.

## Interrupting

```
POST /api/agents/:id/runs/:runId/interrupt
```

asks for a **cooperative stop**. The tool loop honours it at its next per-iteration checkpoint, so the run halts _between_ iterations and completes with a summary instead of being killed mid-call. If the run is already terminal you get a `409` — unlike steering, there is no meaningful fallback.

To kill a run outright, use the existing `POST /api/agents/:id/runs/:runId/cancel`.

## Resuming a parked run

A run that asked you a question sets `awaitingInput` and parks. It is **never reaped** by the idle sweeper while it is waiting — that guarantee is enforced both in the sweeper and in SQL.

```
POST /api/agents/:id/runs/:runId/resume   { "message": "…" }   (message optional)
```

dispatches a **new** run that carries the original's pipeline session id, so the Agent keeps its conversation and its context rather than starting cold. Runs are immutable: the source row stays terminal and the answer is recorded as a new run linked back to it. `409` when the run is not resumable (still live, or ended for a non-parkable reason).

## Ownership

All four surfaces are owner-scoped twice over — the Agent lookup and the run lookup are both user-filtered — so somebody else's run id is indistinguishable from one that does not exist (`404`, never `403`).

## Related

- [Agents](./agents.md) · [Autonomous Operation](./autonomous-operation.md) · [Quality Gates](./quality-gates.md)
