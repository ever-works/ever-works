# Task Breakdown: MCP Server

**Feature ID**: `mcp-server`
**Status**: `Done` (Retrospective; ongoing as new tools are whitelisted)
**Last updated**: 2026-05-01

---

## Phase 1 — Bootstrap

- [x] T1. `apps/mcp/` workspace package with NestJS scaffold.
- [x] T2. MCP SDK integration with stdio transport.
- [x] T3. streamable-http transport.

## Phase 2 — OpenAPI ingestion

- [x] T4. Fetch OpenAPI spec at boot from configured `EVER_WORKS_API_URL`.
- [x] T5. Whitelist file at `apps/mcp/src/openapi-tools/whitelist.ts`.
- [x] T6. Spec → MCP tool def converter.

## Phase 3 — Auth + sanitisation

- [x] T7. API key forwarding via `x-api-key` / `Authorization`.
- [x] T8. HTTP-mode `Authorization: Bearer` requirement.
- [x] T9. Response sanitiser stripping sensitive fields.
- [x] T10. 2-minute call timeout.

## Phase 4 — Tools (across releases)

- [x] T11. Works (12), Generation (4), Items (4), Deployment (4),
      Plugins (5), Scheduling (4), Comparisons (5) — total 36.

## Phase 5 — Deployment

- [x] T12. Dockerfile under `.deploy/docker/mcp/`.
- [x] T13. Compose service entry.

## Phase 6 — Docs

- [x] T14. User-facing doc `docs/features/mcp-server.md`.
- [x] T15. Setup snippets for Claude Desktop / Claude Code.
- [x] T16. Retrospective spec/plan/tasks.

## Future work (open)

- [ ] SSE bridge for HTTP-mode streaming.
- [ ] Per-call AI key rotation.

## Definition of Done

- [x] All shipped tasks complete, tests pass, docs present, constitution
      gates verified.
