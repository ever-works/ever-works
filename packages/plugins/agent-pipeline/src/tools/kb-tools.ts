import { tool } from 'ai';
import { z } from 'zod';
import type { PluginLogger } from '@ever-works/plugin';

/**
 * EW-641 Phase 2/d row 36b — agent-pipeline plugin-side wrappers for
 * the LLM-callable KB tools (`kb_search` / `kb_read` / `kb_write` /
 * `kb_lock` / `kb_unlock`). Each wrapper is a `tool({...})` definition
 * (Vercel AI SDK) with a zod input schema and an `execute` callback
 * that delegates to the row 36 `KbAgentToolsService`.
 *
 * The agent-pipeline plugin lives in `packages/plugins/` and runs
 * outside the NestJS container. It can't directly inject
 * `KbAgentToolsService` — instead, the wiring layer (row 36c, future
 * PR) supplies an `IKbToolsFacade` adapter through the existing
 * `ParentToolContext.facades` mechanism. The interface lives here
 * (local-first) so this PR doesn't have to bump `@ever-works/plugin`'s
 * public surface; row 36c can promote it if cross-package reuse
 * shows up.
 *
 * **Scope note**: this row only ADDS the tool builders and a
 * `createKbTools()` aggregator. It does NOT wire them into
 * `createParentTools()` — that lives in row 36c so the agent-pipeline
 * tool-set roster change is reviewed separately from the tool
 * definitions themselves. Importing this module is therefore a no-op
 * for the existing pipeline until 36c flips the switch.
 *
 * Tool inputs accept string-union shapes for class / status / lockMode
 * to keep the LLM-facing schema simple. The facade implementation
 * (NestJS side, KbAgentToolsService) casts contracts string-unions →
 * agent enums at the boundary per cumulative gotcha #5.
 */

// ─── Facade contract (LLM-callable surface) ────────────────────────────

/** Shapes returned by every KB tool. Mirrors `KbToolResult<T>` from
 *  `@ever-works/agent/services` so the LLM sees a uniform `{ok, ...}`
 *  envelope regardless of which tool it called. */
export type KbToolResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Tool input contracts — match `KbSearchToolInput` / `KbWriteToolInput`
 *  on the agent side. Kept here as TS interfaces (not zod schemas) so
 *  this file can be consumed from non-zod contexts too. */
export interface IKbSearchInput {
	readonly q?: string;
	readonly class?: string;
	readonly status?: string;
	readonly limit?: number;
}

export interface IKbWriteInput {
	readonly path: string;
	readonly title: string;
	readonly class: string;
	readonly body: string;
	readonly description?: string | null;
	readonly tags?: string[];
	readonly categories?: string[];
	readonly language?: string;
	readonly generatedByAgentRunId?: string | null;
}

/**
 * Facade interface the wiring layer (row 36c) will implement against
 * NestJS-side `KbAgentToolsService`. Keeping the contract here so the
 * agent-pipeline plugin doesn't take a runtime dep on the agent
 * package (it consumes only the interface shape).
 *
 * Each method returns a `KbToolResult<T>` so the tool's `execute`
 * can pass-through to the LLM as-is.
 */
export interface IKbToolsFacade {
	kbSearch(
		workId: string,
		userId: string,
		input: IKbSearchInput
	): Promise<KbToolResult<{ items: ReadonlyArray<unknown>; total: number }>>;

	kbRead(workId: string, userId: string, idOrPath: string): Promise<KbToolResult<unknown>>;

	kbWrite(
		workId: string,
		userId: string,
		input: IKbWriteInput
	): Promise<KbToolResult<{ document: unknown; action: 'created' | 'updated' }>>;

	kbLock(
		workId: string,
		userId: string,
		docId: string,
		mode: 'full' | 'additions-only'
	): Promise<KbToolResult<unknown>>;

	kbUnlock(workId: string, userId: string, docId: string): Promise<KbToolResult<unknown>>;
}

// ─── Tool-builder context ───────────────────────────────────────────────

export interface KbToolBuilderContext {
	/** Owning Work scope — every tool call is bound to this. */
	readonly workId: string;
	/** User performing the call — used for the per-tool permission gate
	 *  inside the facade implementation (ensureCanView / ensureCanEdit). */
	readonly userId: string;
	/** Facade that bridges to NestJS-side `KbAgentToolsService`. */
	readonly facade: IKbToolsFacade;
	/** Plugin logger — used to debug-log failures + permission gate
	 *  rejections without spamming user-visible errors. */
	readonly logger: PluginLogger;
}

// ─── zod input schemas ──────────────────────────────────────────────────

/** Canonical KB document classes — keep in lockstep with
 *  `@ever-works/contracts`' `KB_DOCUMENT_CLASSES` constant.
 *  Hardcoded here so the agent-pipeline plugin doesn't take a runtime
 *  dep on `@ever-works/contracts`. Row 36c may promote this to a
 *  shared constant if drift surfaces in CI. */
const KB_CLASS_VALUES = [
	'brand',
	'legal',
	'seo',
	'style',
	'glossary',
	'competitors',
	'personas',
	'research',
	'output',
	'freeform'
] as const;

const KB_STATUS_VALUES = ['active', 'archived', 'draft'] as const;

const KB_LOCK_MODE_VALUES = ['full', 'additions-only'] as const;

const kbSearchInputSchema = z.object({
	q: z.string().optional().describe('Free-text search query — RRF-blended lexical + semantic.'),
	class: z.enum(KB_CLASS_VALUES).optional().describe('Filter results to a single KB class (brand, legal, …).'),
	status: z
		.enum(KB_STATUS_VALUES)
		.optional()
		.describe('Filter by lifecycle status (default behavior covers active).'),
	limit: z.number().int().optional().describe('Maximum results to return (default 20, clamped to 50).')
});

const kbReadInputSchema = z.object({
	idOrPath: z
		.string()
		.describe(
			'Document id (UUID) or path of the form `<class>/<slug>[.md]` — same shape as `@kb:` mentions in chat.'
		)
});

const kbWriteInputSchema = z.object({
	path: z
		.string()
		.describe(
			'Target path as `<class>/<slug>.md`. If a doc with this path exists, it is updated; otherwise created.'
		),
	title: z.string().describe('Human-readable title.'),
	class: z.enum(KB_CLASS_VALUES).describe('KB class — required even on update for clarity.'),
	body: z.string().describe('Markdown body.'),
	description: z.string().nullable().optional().describe('Optional one-line summary.'),
	tags: z.array(z.string()).optional().describe('Optional tag slugs.'),
	categories: z.array(z.string()).optional().describe('Optional category slugs.'),
	language: z.string().optional().describe('BCP-47 language tag (default en).')
});

const kbLockInputSchema = z.object({
	docId: z.string().describe('Document id (UUID).'),
	mode: z
		.enum(KB_LOCK_MODE_VALUES)
		.describe('`full` blocks all body mutations; `additions-only` allows additions but rejects deletions/edits.')
});

const kbUnlockInputSchema = z.object({
	docId: z.string().describe('Document id (UUID).')
});

// ─── Tool factories ────────────────────────────────────────────────────

export function createKbSearchTool(ctx: KbToolBuilderContext) {
	return tool({
		description:
			'Search the Knowledge Base. Returns metadata-only matches (no body) so the model decides which to read next.',
		inputSchema: kbSearchInputSchema,
		execute: async (input) => {
			try {
				return await ctx.facade.kbSearch(ctx.workId, ctx.userId, input);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				ctx.logger.warn(`kb_search tool error: ${error}`);
				return { ok: false, error };
			}
		}
	});
}

export function createKbReadTool(ctx: KbToolBuilderContext) {
	return tool({
		description:
			'Fetch a single Knowledge Base document by id or `<class>/<slug>` path. Returns the full body for citing.',
		inputSchema: kbReadInputSchema,
		execute: async ({ idOrPath }) => {
			try {
				return await ctx.facade.kbRead(ctx.workId, ctx.userId, idOrPath);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				ctx.logger.warn(`kb_read tool error: ${error}`);
				return { ok: false, error };
			}
		}
	});
}

export function createKbWriteTool(ctx: KbToolBuilderContext, generatedByAgentRunId?: string) {
	return tool({
		description:
			'Create or update a Knowledge Base document by path. Upserts: if a doc with the same path exists, it is updated; otherwise a new one is created with source="agent".',
		inputSchema: kbWriteInputSchema,
		execute: async (input) => {
			try {
				return await ctx.facade.kbWrite(ctx.workId, ctx.userId, {
					...input,
					generatedByAgentRunId
				});
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				ctx.logger.warn(`kb_write tool error: ${error}`);
				return { ok: false, error };
			}
		}
	});
}

export function createKbLockTool(ctx: KbToolBuilderContext) {
	return tool({
		description:
			'Lock a Knowledge Base document so further edits are blocked (full) or restricted to additions only.',
		inputSchema: kbLockInputSchema,
		execute: async ({ docId, mode }) => {
			try {
				return await ctx.facade.kbLock(ctx.workId, ctx.userId, docId, mode);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				ctx.logger.warn(`kb_lock tool error: ${error}`);
				return { ok: false, error };
			}
		}
	});
}

export function createKbUnlockTool(ctx: KbToolBuilderContext) {
	return tool({
		description: 'Clear the lock on a Knowledge Base document. No-op when the doc is already unlocked.',
		inputSchema: kbUnlockInputSchema,
		execute: async ({ docId }) => {
			try {
				return await ctx.facade.kbUnlock(ctx.workId, ctx.userId, docId);
			} catch (err) {
				const error = err instanceof Error ? err.message : String(err);
				ctx.logger.warn(`kb_unlock tool error: ${error}`);
				return { ok: false, error };
			}
		}
	});
}

/**
 * Build the full set of KB tools at once, keyed by their canonical
 * names (`kb_search` / `kb_read` / `kb_write` / `kb_lock` /
 * `kb_unlock`). Row 36c spreads this into `createParentTools()`'s
 * returned tools map.
 */
export function createKbTools(ctx: KbToolBuilderContext, generatedByAgentRunId?: string) {
	return {
		kb_search: createKbSearchTool(ctx),
		kb_read: createKbReadTool(ctx),
		kb_write: createKbWriteTool(ctx, generatedByAgentRunId),
		kb_lock: createKbLockTool(ctx),
		kb_unlock: createKbUnlockTool(ctx)
	};
}
