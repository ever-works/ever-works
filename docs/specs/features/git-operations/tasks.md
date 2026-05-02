# Task Breakdown: Git Operations

**Feature ID**: `git-operations`
**Status**: `Done` (Retrospective; ongoing as new providers ship)
**Last updated**: 2026-05-01

---

## Phase 1 — SDK contract

- [x] T1. `IGitProviderPlugin` interface in
      `@ever-works/plugin/git-provider`.
- [x] T2. Capability registration (`git-provider`).

## Phase 2 — Facade

- [x] T3. `GitFacadeService` with all method groups (repo / local / PR
      / branch / URL).
- [x] T4. Error hierarchy: `GitFacadeError`, `NoGitProviderError`,
      `GitProviderNotFoundError`, `NoGitCredentialsError`.
- [x] T5. Credential resolution cascade (explicit token → OAuth →
      error).
- [x] T6. `cloneOrPull` with local cache.
- [x] T7. `push` with `maxRetries`.

## Phase 3 — GitHub plugin

- [x] T8. `packages/plugins/github/` scaffold with metadata.
- [x] T9. `IGitProviderPlugin` implementation using Octokit +
      isomorphic-git.
- [x] T10. OAuth flow integration.
- [x] T11. PR-related methods (list, files, comment, close).

## Phase 4 — Wiring

- [x] T12. `DataGeneratorService` uses the facade.
- [x] T13. `MarkdownGeneratorService` uses the facade.
- [x] T14. `WebsiteGeneratorService` uses the facade.
- [x] T15. `CommunityPrProcessorService` uses the facade.
- [x] T16. `WorksConfigService` uses the facade.

## Phase 5 — Tests

- [x] T17. Unit tests on the facade with a mock provider.
- [x] T18. Integration tests against a real GitHub repo in CI.
- [x] T19. Error-hierarchy fire paths.

## Phase 6 — Docs

- [x] T20. User-facing doc `docs/features/git-operations.md`.
- [x] T21. GitHub plugin doc `docs/plugin-system/github-plugin.md`.
- [x] T22. Retrospective spec/plan/tasks.

## Future work (open)

- [ ] GitLab provider plugin.
- [ ] Bitbucket provider plugin.

## Definition of Done

- [x] All shipped tasks complete, tests pass, docs present, constitution
      gates verified.
