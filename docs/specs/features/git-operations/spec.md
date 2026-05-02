# Feature Specification: Git Operations (Facade & Provider Plugins)

**Feature ID**: `git-operations`
**Status**: `Retrospective`
**Created**: 2026-05-01
**Last updated**: 2026-05-01
**Owner**: Ever Works Team

---

## 1. Overview

The platform's primary storage is Git. Every work has three repos —
data, markdown, website — under user ownership. All read/write access
goes through `GitFacadeService`, which resolves the user's configured
git provider plugin (today: GitHub) and routes operations through a
unified interface combining `isomorphic-git` for local operations and
provider REST APIs for remote operations.

## 2. User Scenarios

### 2.1 Primary scenarios

- **Given** I have a work whose data lives in `me/cool-tools-data`,
  **when** any pipeline step calls `gitFacade.cloneOrPull(...)`, **then**
  the repo is cloned the first time and pulled on subsequent calls,
  cached locally per user/repo.
- **Given** the platform needs to commit generated items, **when** the
  pipeline calls `add → commit → push`, **then** the commit is made as
  the configured user (their name + email) and pushed to origin.
- **Given** the community PR processor needs to list open PRs, **when**
  it calls `gitFacade.listPullRequests(owner, repo, ...)`, **then**
  the result comes back through the provider's REST API.
- **Given** my deployment fails because of a transient network blip,
  **when** the platform retries `push` with `maxRetries`, **then** the
  operation succeeds without needing user intervention.

### 2.2 Edge cases & failures

- **Given** I haven't connected a git provider, **when** any service
  requests an operation, **then** the facade throws `NoGitProviderError`
  with a clear "configure a git provider" message.
- **Given** my OAuth token expired, **when** an operation hits the
  provider API, **then** the facade throws `NoGitCredentialsError` and
  the dashboard prompts me to reconnect.
- **Given** my repo is huge and the first clone times out, **when** the
  next call retries, **then** `cloneOrPull` resumes by attempting a
  pull (the partial clone is cleaned and retried).
- **Given** I provide an explicit token in `GitFacadeOptions.token`,
  **when** the operation runs, **then** the explicit token wins over
  the OAuth token from the user's plugin settings.

## 3. Functional Requirements

- **FR-1** All git access from the platform MUST go through
  `GitFacadeService` — services MUST NOT import Octokit /
  isomorphic-git directly.
- **FR-2** The facade MUST resolve the active git provider plugin via
  the plugin registry (capability `git-provider`) — no plugin id
  hardcoded.
- **FR-3** The facade MUST expose: repository management
  (`getRepository`, `createRepository`, `repositoryExists`,
  `hasRepositoryAccess`, `getWorkContents`, `getFileContent`,
  `getReadme`); local git (`cloneOrPull`, `add`, `commit`, `push`);
  PR operations (`listPullRequests`, `getPullRequestFiles`,
  `createPullRequestComment`, `closePullRequest`); branch and history
  (`listBranches`, `getCommits`); URL utilities (`getWebUrl`,
  `getRawFileUrl`, `isConfigured`).
- **FR-4** Credential resolution MUST follow this priority: explicit
  token in options → OAuth token from `OAuthTokenRepository` for the
  user/provider → throw `NoGitCredentialsError`.
- **FR-5** The facade MUST define a typed error hierarchy:
  `GitFacadeError` (base), `NoGitProviderError`,
  `GitProviderNotFoundError`, `NoGitCredentialsError`.
- **FR-6** `cloneOrPull` MUST cache repos locally per user/repo and
  upgrade subsequent calls to `pull`.
- **FR-7** `push` MUST support `maxRetries` for transient failures.
- **FR-8** Each work MUST operate on three repos using the
  naming convention `<slug>-data`, `<slug>`, `<slug>-website`.
- **FR-9** Provider plugins (today GitHub) MUST implement the full
  `IGitProviderPlugin` interface; new providers (GitLab / Bitbucket)
  plug in via the same interface.

## 4. Non-Functional Requirements

- **Performance**: local cache amortises clone cost to O(diff) on
  subsequent runs.
- **Reliability**: `push` retries handle transient failures; explicit
  error types let callers branch precisely.
- **Security & privacy**: tokens come from the encrypted
  plugin-settings store; never logged; never exposed in the URL.
- **Observability**: every facade call emits a structured log line with
  operation, owner, repo, duration. Errors include the typed class
  name.
- **Compatibility**: `IGitProviderPlugin` is versioned with the plugin
  SDK; breaking changes require a SDK major version bump.

## 5. Key Entities & Domain Concepts

| Entity / concept     | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| `GitFacadeService`   | Capability-agnostic entry point for all git operations                    |
| `IGitProviderPlugin` | Contract every git provider plugin must implement                         |
| `GitFacadeOptions`   | `{userId, providerId, workId?, token?}` per-call context             |
| Repository ecosystem | Per-work triple: `<slug>-data`, `<slug>`, `<slug>-website`           |
| Local cache          | Per-user, per-repo working work reused across calls                  |
| Error hierarchy      | `NoGitProviderError`, `GitProviderNotFoundError`, `NoGitCredentialsError` |

## 6. Out of Scope

- Direct multi-repo refs (subtrees, submodules) — each repo is independent.
- Branch protection management.
- Force-push helpers (deliberately not in the facade).
- Local-only providers (e.g. file-system git) — every provider talks to
  a remote.

## 7. Acceptance Criteria

- [x] No service imports Octokit / isomorphic-git directly outside the
      GitHub plugin and the facade itself.
- [x] All four error types fire from the right code paths.
- [x] Cache hit path measurably faster than first clone.
- [x] `maxRetries` on push works under simulated transient failure.
- [x] Tests cover credential cascade, error hierarchy, retry,
      multi-repo flow.

## 8. Open Questions

- `[NEEDS CLARIFICATION: GitLab and Bitbucket plugin priorities and
timeline]`

## 9. Constitution Gates

- [x] **I**: git providers are plugins.
- [x] **II**: services request git operations through the facade —
      capability-driven.
- [x] **III**: this feature IS the mechanism that makes Principle III
      practical (everything that touches the user's repo goes here).
- [x] **IV**: long-running pulls/pushes happen inside background jobs;
      the facade itself is just the API.
- [x] **V**: no schema changes (unless a new provider needs new
      settings storage — handled by plugin migration).
- [x] **VI**: facade has unit tests; each provider plugin has its own
      suite; integration tests against a real GitHub repo in CI.
- [x] **VII**: tokens flow through the facade options object, never
      logged.
- [x] **VIII**: N/A.
- [x] **IX**: behaviour-first description here; implementation details
      in `plan.md`.
- [x] **X**: SDK versioned; new providers don't break existing ones.

## 10. References

- User-facing doc: [`../../../features/git-operations.md`](../../../features/git-operations.md)
- Implementation:
    - `packages/agent/src/facades/git.facade.ts`
    - `packages/plugins/github/`
    - `@ever-works/plugin/git-provider`
- Related: [`plugin-system/spec.md`](../plugin-system/spec.md)
