# Ever Works Platform – Project Instructions for AI Agents

This repository uses **AGENTS.md** as the primary, shared instruction file for all AI coding assistants.

## Canonical Source of Truth

For all AI agents (Cursor, Claude, Augment Code, GitHub Copilot, etc.):

- **Treat `CLAUDE.md` as the canonical, detailed instruction document** for this project.
- Do **not** duplicate or reinvent project rules if they already exist in `CLAUDE.md`.

### Read These First

1. **Primary project rules**: [`CLAUDE.md`](./CLAUDE.md)
2. **Augment-specific wrapper**: [`AUGMENT.md`](./AUGMENT.md)
3. **Copilot-specific hints**: [`.github/copilot-instructions.md`](./.github/copilot-instructions.md)

When in doubt, prefer the guidance in `CLAUDE.md` and only add tool-specific nuances in your own context.

## Instruction Layering

To keep instructions consistent and easy to maintain, follow this layering model:

1. **Root index – `AGENTS.md` (this file)**: Multi-agent entrypoint and meta-rules. Keep this light and focused on routing different tools to the right docs.
2. **Canonical manual – `CLAUDE.md`**: Single, detailed source of truth for project architecture, workflows, conventions, and general AI behavior.
3. **Tool-specific supplements**: Files like `AUGMENT.md`, `.github/copilot-instructions.md`, or nested `AGENTS.md` in subfolders may add small, tool- or folder-specific nuances and examples, but should reference `CLAUDE.md` instead of duplicating it.

## How Cursor Should Use This File

Cursor supports `AGENTS.md` in the project root (and nested `AGENTS.md` in subfolders).

When operating in this repository, Cursor agents should:

1. Load **this `AGENTS.md`**.
2. Then load and follow **`CLAUDE.md`** as the main rule set.
3. Optionally consult **AUGMENT.md** or `.github/copilot-instructions.md` for additional examples or quick references.

## High-Level Project Pointers (Non-Duplicative)

These are minimal, high-signal reminders; full details are in `CLAUDE.md`.

- This is a **TypeScript monorepo** built with **Turborepo** and **pnpm workspaces**.
- Backend: **NestJS 11** (`apps/api`) with TypeORM and SWC.
- Frontend: **Next.js 16 App Router** (`apps/web`) with React 19 and Tailwind CSS.
- Shared logic: `packages/agent`, `packages/monitoring`, `packages/cli-shared`.
- Use **pnpm** only (no npm/yarn). Node.js **≥20**.
- Respect **Prettier** and **TypeScript** rules described in `CLAUDE.md`.

For architecture, testing patterns, deployment, and detailed conventions, **do not restate them here**—instead, **read and follow `CLAUDE.md`**.

## Central Documentation

For human-facing documentation and deeper architecture notes, see:

- **Project docs**: https://github.com/ever-works/ever-works-docs/tree/develop/website/docs
- **Repository**: https://github.com/ever-works/ever-works
- **Website**: https://ever.works

## When Extending Rules

If you need to extend or refine project rules:

1. Prefer updating **`CLAUDE.md`** so all agents can benefit.
2. Keep **this `AGENTS.md`** short and focused on **linking** to canonical sources.
3. Only add content here if it is **Cursor-specific behavior** that cannot live elsewhere.

Avoid copying large sections from `CLAUDE.md` into this file—link instead.
