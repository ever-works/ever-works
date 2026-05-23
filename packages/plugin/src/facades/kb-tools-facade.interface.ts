/**
 * EW-641 Phase 2/d row 36c — facade contract for LLM-callable KB
 * tools. The agent-pipeline plugin (row 36b) builds `tool({...})`
 * definitions whose `execute` callbacks delegate to this interface;
 * the agent package implements it via `KbToolsFacadeAdapter` which
 * delegates to `KbAgentToolsService` (row 36, PR #988).
 *
 * Living in `@ever-works/plugin` rather than co-located in the
 * agent-pipeline plugin so:
 *  - `StepExecutionContext.kbTools?` can carry it (mirrors how
 *    `kbContext` carries `KbContextBundleData` from `@ever-works/contracts`),
 *  - other pipeline plugins (claude-managed-agent, codex, etc.)
 *    can opt-in without re-defining the contract,
 *  - the agent-pipeline plugin's row-36b local definition can
 *    eventually re-export this one to keep a single source of truth.
 *
 * **Result envelope contract**: every method returns a discriminated
 * `{ ok: true, data } | { ok: false, error }`. The agent-side
 * adapter swallows HttpException subclasses (NotFound/Forbidden/etc.)
 * and surfaces them as `ok:false` strings so the pipeline runner can
 * pass-through to the LLM without try/catch dancing.
 *
 * Permission gates live one layer down in `KnowledgeBaseService`:
 * `ensureCanView` for search/read, `ensureCanEdit` for write/lock/
 * unlock. The adapter doesn't re-implement them.
 */

/** Shared result envelope — uniform across all KB tool calls. */
export type KbToolFacadeResult<T> =
	| { readonly ok: true; readonly data: T }
	| { readonly ok: false; readonly error: string };

/** Input to `kbSearch` — same shape as `KbSearchToolInput` on the
 *  agent side. */
export interface IKbToolsFacadeSearchInput {
	readonly q?: string;
	/** Optional KB class filter (`brand` / `legal` / etc.). String-
	 *  union by design — the adapter casts to the agent's enum. */
	readonly class?: string;
	/** Optional lifecycle status filter. */
	readonly status?: string;
	/** Page size; the adapter clamps to [1, 50] (default 20). */
	readonly limit?: number;
}

/** Input to `kbWrite` — same shape as `KbWriteToolInput` on the
 *  agent side. The wrapper passes `source: 'agent'` automatically
 *  and forwards an optional `generatedByAgentRunId` to credit the
 *  audit trail. */
export interface IKbToolsFacadeWriteInput {
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
 * LLM-facing facade for KB tools — implemented by the agent-side
 * `KbToolsFacadeAdapter`, threaded through
 * `StepExecutionContext.kbTools`, consumed by the agent-pipeline
 * plugin's `createKbTools()` factory.
 *
 * Return types use `unknown` for the success payload so this
 * contract doesn't import contracts/agent types — the plugin layer
 * only ever passes the result envelope through to the LLM.
 */
export interface IKbToolsFacade {
	kbSearch(
		workId: string,
		userId: string,
		input: IKbToolsFacadeSearchInput
	): Promise<KbToolFacadeResult<{ items: ReadonlyArray<unknown>; total: number }>>;

	kbRead(workId: string, userId: string, idOrPath: string): Promise<KbToolFacadeResult<unknown>>;

	kbWrite(
		workId: string,
		userId: string,
		input: IKbToolsFacadeWriteInput
	): Promise<KbToolFacadeResult<{ document: unknown; action: 'created' | 'updated' }>>;

	kbLock(
		workId: string,
		userId: string,
		docId: string,
		mode: 'full' | 'additions-only'
	): Promise<KbToolFacadeResult<unknown>>;

	kbUnlock(workId: string, userId: string, docId: string): Promise<KbToolFacadeResult<unknown>>;
}
