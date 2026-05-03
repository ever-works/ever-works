# Feature Specification: Generation Cancellation

**Feature ID**: `generation-cancellation`
**Branch**: `feat/generation-cancel-controls` (merged via PR #383)
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

Long-running work generations can be cancelled mid-flight from the web
dashboard or via the API. The cancel signal is routed to wherever the run is
actually executing — Trigger.dev, an in-process worker, or a stuck/stale
run that never started — and the result is surfaced back to the caller as
one of four explicit modes.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** a work is currently generating and I have edit rights,
  **when** I click "Cancel" on the work page, **then** the generation
  stops shortly afterwards and the work's status becomes `cancelled`.
- **Given** I cancel a generation, **when** I open the activity log,
  **then** I see an entry "Generation cancelled for `<work>`" marked
  as completed (not failed).
- **Given** a generation has just been cancelled, **when** I trigger a new
  generation, **then** it kicks off cleanly with no leftover state from
  the cancelled run.

### 2.2 Edge cases & failures

- **Given** the work is not currently generating, **when** I call the
  cancel endpoint, **then** I get `409 Conflict` and the work state
  is unchanged.
- **Given** the work's generation completed between my cancel click
  and the API call, **when** the cancel runs, **then** the response
  reports `mode: already_finished` and no state changes.
- **Given** the work was flagged as generating but no actual run is
  found (worker crashed without finalising), **when** I cancel, **then**
  the response reports `mode: stale` and the status is forced to ERROR.
- **Given** I do not have edit rights on the work, **when** I attempt
  to cancel, **then** I get `403 Forbidden`.
- **Given** the deployment lacks a generation dispatcher (no Trigger.dev),
  **when** I cancel a Trigger.dev-backed run, **then** I get `400` with
  a clear "cancellation not available in this environment" message.

## 3. Functional Requirements

- **FR-1** The system MUST expose `POST /api/works/:id/cancel-generation`
  that returns `202 Accepted` on a successful cancel request.
- **FR-2** The system MUST verify the caller has edit rights on the
  work before processing the cancel request.
- **FR-3** The system MUST reject the cancel with `409 Conflict` if the
  work is not in `generating` status.
- **FR-4** The system MUST report one of four cancellation modes in the
  response: `trigger` | `in_process` | `stale` | `already_finished`.
- **FR-5** Successful cancellation MUST transition `work.generateStatus.status`
  to `cancelled`.
- **FR-6** Successful cancellation MUST close the in-progress
  `GenerationHistory` row.
- **FR-7** The system MUST write an activity-log entry "Generation cancelled
  for `<work>`" with status `COMPLETED`, not `FAILED`.
- **FR-8** When a cancel is routed via Trigger.dev, the system MUST request
  the cancel through the Trigger.dev SDK using the run's `triggerRunId`.
- **FR-9** When a cancel is routed in-process, the system MUST signal an
  in-memory cancellation token that the pipeline executor checks between
  steps.
- **FR-10** A cancelled work MUST be in a clean, retriable state — the
  user can immediately start a new generation.

## 4. Non-Functional Requirements

- **Performance**: cancel endpoint returns within 1 s (P95) regardless of
  pipeline size; the worker may take longer to actually tear down.
- **Reliability**: cancel is idempotent — calling it twice in a row produces
  `409` on the second call (already cancelled).
- **Security & privacy**: cancel requires edit rights; ownership-checked
  against `WorkOwnershipService`.
- **Observability**: every cancel — including the `already_finished` and
  `stale` modes — produces an activity-log entry so the audit trail is
  complete.
- **Compatibility**: extends existing `GenerateStatusType` enum with a new
  `cancelled` value; existing consumers that handle the enum exhaustively
  needed updates.

## 5. Key Entities & Domain Concepts

| Entity / concept        | Description                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `GenerateStatusType`    | Enum: `generating` / `generated` / `error` / `cancelled` (new)          |
| Cancellation mode       | `trigger` / `in_process` / `stale` / `already_finished`                 |
| In-process cancel token | Per-run AbortController that the executor checks between pipeline steps |

## 6. Out of Scope

- Pausing/resuming a generation (cancel is terminal).
- Cancelling individual pipeline steps (cancel only acts at run granularity).
- Refunding billing for cancelled runs (handled by the billing layer
  separately).

## 7. Acceptance Criteria

- [x] `POST /api/works/:id/cancel-generation` returns `202` for an
      in-progress run.
- [x] All four cancellation modes are tested.
- [x] Cancelled run produces an activity-log entry with `COMPLETED` status.
- [x] Web dashboard exposes a Cancel control on works that are
      actively generating.
- [x] `409` is returned for non-generating works.
- [x] `403` is returned for users without edit rights.
- [x] Tests cover ownership check, status check, mode routing,
      idempotent re-cancel.

## 8. Open Questions

_None._

## 9. Constitution Gates

- [x] **I — Plugin-first**: N/A.
- [x] **II — Capability-driven**: N/A.
- [x] **III — Source-of-truth repos**: cancel does not touch the data repo;
      a partially-generated run leaves whatever it had committed in place.
- [x] **IV — Trigger.dev**: cancel routes through the Trigger.dev SDK when
      a run was dispatched there.
- [x] **V — Forward-only migrations**: new `cancelled` enum value added via
      forward migration; existing rows unaffected.
- [x] **VI — Tests**: covered in `work-generation.service.spec.ts` and
      pipeline executor tests.
- [x] **VII — Secret hygiene**: N/A.
- [x] **VIII — Plugin counts**: N/A.
- [x] **IX — Behaviour-first**: this spec describes user-observable
      behaviour.
- [x] **X — Backwards-compat**: enum extension is additive; existing
      consumers continue to work.

## 10. References

- User-facing doc: [`../../../features/generation-cancellation.md`](../../../features/generation-cancellation.md)
- Implementation:
    - `apps/api/src/works/works.controller.ts:516` (endpoint)
    - `packages/agent/src/services/work-generation.service.ts:330`
      (mode routing)
    - `packages/contracts/src/api/work/generate-status.enum.ts`
      (`cancelled` value)
- PR: #383
