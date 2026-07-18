# Codex guide — ever-works

Codex follows the same rules as every other agent in this repository.

1. Read the authoritative instructions first: **`AGENTS.md`** and **`CLAUDE.md`** at the repository root.
2. Load the repo skill at **`.agents/skills/ever-works/SKILL.md`** — a concise, verified summary of the monorepo layout, the test frameworks (Jest vs Vitest vs Playwright), naming/alias conventions, commands, and gotchas.
3. Use **pnpm** only (Node >= 22). Verify work with `pnpm type-check`, `pnpm lint`, and `pnpm test` (root `pnpm test` fans out to each workspace's own runner).
4. Read-only exploration is safe; get review before writes. Do **not** run ad-hoc deploy / `kubectl` commands from this repo (deployment is GitOps-driven).

Read-only role presets for multi-agent work live in `.codex/agents/`
(`explorer`, `reviewer`, `docs-researcher`).
