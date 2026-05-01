# Feature Specification: Community PR Processing

**Feature ID**: `community-pr-processing`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

When community members open Pull Requests against a directory's main repo
(typically adding a new item to an Awesome-List-style README), the platform
discovers the open PRs, extracts each item via AI, validates it against the
directory's data schema, merges or comments on the PR, and (optionally)
auto-closes processed PRs. Each directory gets a per-directory mutex so two
processing runs don't fight over the same PRs.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** my directory has community PRs open with new items, **when**
  the periodic processor runs, **then** each PR is read, parsed, validated,
  and merged (or commented if invalid).
- **Given** a PR adds an item that already exists in the directory,
  **when** processing runs, **then** the PR is closed with a "duplicate"
  comment instead of merging.
- **Given** a PR has been processed before (its number is in
  `processedPrNumbers`), **when** processing runs again, **then** the PR
  is skipped — no double-processing.

### 2.2 Edge cases & failures

- **Given** another worker is already processing the same directory's PRs,
  **when** my worker tries, **then** my run is a no-op (`acquired: false`)
  and exits cleanly.
- **Given** the AI extraction returns malformed YAML/JSON, **when**
  validation fails, **then** the PR is left open with a comment listing
  the validation errors.
- **Given** the GitHub rate limit is hit mid-batch, **when** the next
  request fails, **then** the run aborts cleanly, persists state, and
  resumes on the next cycle from where it left off.

## 3. Functional Requirements

- **FR-1** The processor MUST list open PRs in the directory's main repo,
  paginated up to 100 at a time.
- **FR-2** Per-directory exclusivity MUST be enforced via
  `DistributedTaskLockService.runExclusive` keyed by `community-pr:<directoryId>`.
- **FR-3** The processor MUST track processed PRs in
  `directory.communityPrState.processedPrNumbers` and skip any PR already
  listed there.
- **FR-4** For each unprocessed open PR, the processor MUST extract the
  proposed item(s) using the directory's configured AI provider plugin.
- **FR-5** Extracted items MUST be validated against the directory's data
  schema (categories, tags, required fields).
- **FR-6** Valid items MUST be merged (PR auto-merged or branch
  fast-forwarded as configured); the PR MUST then be marked processed.
- **FR-7** Invalid items MUST trigger a PR comment listing the validation
  errors, leaving the PR open for the contributor to fix.
- **FR-8** Duplicate items MUST result in PR closure with a duplicate
  comment, not merging.
- **FR-9** If `autoClose` is true, processed PRs MUST be closed after merge.
- **FR-10** The processor MUST persist `directory.communityPrState`
  (totalItemsAdded, processedPrNumbers) on each successful PR processing
  so progress survives crashes.

## 4. Non-Functional Requirements

- **Performance**: a processing run handles up to 100 PRs per directory per
  invocation; longer queues drain over multiple runs.
- **Reliability**: per-directory mutex prevents duplicate processing; state
  persistence enables resume.
- **Security**: PR processing uses the directory owner's GitHub token via
  the configured git provider plugin.
- **Observability**: each run emits an activity-log entry with counts
  (processed / skipped / failed); per-PR outcomes go to logs.
- **Cost**: AI cost tracked per extraction; `min_items_for_comparison`-style
  sanity checks not applicable here.

## 5. Key Entities & Domain Concepts

| Entity / concept              | Description                                                       |
| ----------------------------- | ----------------------------------------------------------------- |
| `CommunityPrState`            | Directory-level progress: `processedPrNumbers`, `totalItemsAdded` |
| `CommunityPrProcessorService` | Service that drives processing; uses the lock service             |
| `CommunityPrTriggerSource`    | Where the run was triggered from (`api` / `cron` / `webhook`)     |
| Per-directory lock key        | `community-pr:<directoryId>` (Principle IV)                       |

## 6. Out of Scope

- Generating new items from external sources (that's the directory's main
  generation pipeline).
- Reviewing PRs that don't follow the data-add convention (only structured
  "add an item" PRs are processed).
- Multi-repo processing (one main repo per directory).

## 7. Acceptance Criteria

- [x] Two concurrent runs against the same directory produce one effective
      execution; the loser exits cleanly with `acquired: false`.
- [x] Already-processed PR numbers are skipped on re-runs.
- [x] Invalid PRs receive a comment, not a merge.
- [x] Duplicates are closed with a duplicate comment.
- [x] State is persisted incrementally so crashes don't lose progress.
- [x] Tests cover lock contention, state persistence, validation paths.

## 8. Open Questions

_None on develop._

## 9. Constitution Gates

- [x] **I**: AI extraction goes through the AI provider plugin facade.
- [x] **II**: capability-driven AI access.
- [x] **III**: items are merged into the user's repo, not the database.
- [x] **IV**: long-running batches run as Trigger.dev tasks; in-process
      coordination via `DistributedTaskLockService`.
- [x] **V**: `directory.communityPrState` jsonb column added via additive
      migration.
- [x] **VI**: covered in
      `packages/agent/src/community-pr/__tests__/`.
- [x] **VII**: GitHub tokens are loaded from the encrypted plugin-settings
      store; never logged.
- [x] **VIII**: N/A.
- [x] **IX**: this spec describes user-observable behaviour.
- [x] **X**: state schema is additive; old directories without the column
      default to empty state.

## 10. References

- User-facing doc:
  [`../../../features/community-pr-processing.md`](../../../features/community-pr-processing.md)
- Internal architecture:
  [`../../../agent-services/community-pr-service.md`](../../../agent-services/community-pr-service.md)
- Implementation: `packages/agent/src/community-pr/`
- Lock primitive:
  [`../../../agent-services/distributed-task-lock.md`](../../../agent-services/distributed-task-lock.md)
