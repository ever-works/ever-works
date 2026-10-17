# Implementation Plan: Record Visibility

**Feature ID**: `record-visibility`
**Spec**: [`spec.md`](./spec.md)
**Status**: `Draft`
**Last updated**: 2026-10-15

## Phase 1 — Schema and backfill

- **P1.1** `visibility` + `visibilityExplicit` on tasks, goals, missions, work_proposals, agents (3 dialects, `down`).
- **P1.2** Backfill org-scope rows (team / organization) and keep personal rows private.
- **P1.3** `team_resources.resourceType` `goal`.
- **P1.4** Roster backfill into `organization_members`; keep it in sync on invite accept and removal.

## Phase 2 — Policy

- **P2.1** `RecordAccessPolicy` + `visibleTo(principal)` query helper (user principal, integration principal).
- **P2.2** Route every list/get path of tasks, goals, missions, ideas and agents through it; one test per replaced
  `userId = caller` filter.
- **P2.3** Write rules: owner/roles unchanged; participants comment + transition; readers comment.
- **P2.4** Automatic scope on team add/remove while `visibilityExplicit = false`.

## Phase 3 — Events

- **P3.1** `<aggregate>.visibility_changed` recording (private → id-only data).

## Phase 4 — UI

- **P4.1** Visibility control on five forms ("Automatic" until chosen).
- **P4.2** Mine | Shared with me | Organization tabs on five lists.
- **P4.3** Goal form: teams.

## Phase 5 — Tests

- Visibility matrix, automatic scope, migration (3 dialects), `Mine` unchanged.

## Dependencies

- **Uses**: [`domain-events`](../domain-events/plan.md) for `visibility_changed`.
- **Used by**: [`integrations-api-v1`](../integrations-api-v1/plan.md), [`integration-keys`](../integration-keys/plan.md).
