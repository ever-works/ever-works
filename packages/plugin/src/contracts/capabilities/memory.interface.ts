import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';

/**
 * Org-wide Memory (Cortex P2) — the `memory` capability contract.
 *
 * Where `agent-memory` (see `agent-memory.interface.ts`) models
 * per-run, per-session recall for a single coding/generation agent, the
 * `memory` capability models the ORGANIZATION'S durable memory
 * framework: how knowledge is indexed, retrieved, and (optionally)
 * compiled into distilled "concept" pages across every Work / Mission /
 * Agent in an org. It is the swappable seam behind the Memory surface,
 * exactly the way `vector-store` and `content-extractor` are swappable
 * seams behind retrieval and ingest.
 *
 * **Additive + contract-only.** This is a capability INTERFACE plus a
 * new `PLUGIN_CATEGORIES` entry — no concrete plugin ships with it yet.
 * The built-in behavior remains the existing per-Work Knowledge Base;
 * community frameworks (mem0 / zep / langmem-style org memory) become
 * drop-in `memory` plugins once a facade binds this contract. It removes
 * and renames nothing: the `agent-memory` capability and the
 * `WorkKnowledgeDocument` family are untouched.
 *
 * **Scope shape.** Every operation carries a {@link MemoryScope} so a
 * backend can segment by tenant / organization / work / mission. A
 * memory framework is org-aware by construction.
 */

/**
 * The scope an org-memory operation is bound to. Widens from a single
 * Work up to the whole Organization / Tenant. All fields optional — a
 * backend uses whichever it segments by.
 */
export interface MemoryScope {
	readonly tenantId?: string | null;
	readonly organizationId?: string | null;
	readonly workId?: string | null;
	readonly missionId?: string | null;
	/** Free-form partition hint (e.g. 'episodic' | 'semantic'); backend-defined. */
	readonly partition?: string;
}

/**
 * A document handed to {@link IMemoryPlugin.index}. `content` is the raw
 * text to remember; identity + provenance fields let the backend
 * de-duplicate and link back to the source.
 */
export interface MemoryIndexInput {
	/** Stable id of the source document/record, when the caller has one. */
	readonly sourceId?: string;
	/** Provenance kind ('kb-document' | 'agent-run' | 'manual' | …). */
	readonly sourceType?: string;
	/** Human-readable title. */
	readonly title?: string;
	/** The text to index. */
	readonly content: string;
	/** Free-form tags for clustering / filtering. */
	readonly tags?: readonly string[];
	/** Where this memory belongs. */
	readonly scope: MemoryScope;
	/** Resolved plugin settings injected by the facade. */
	readonly settings?: PluginSettings;
}

/** Result of an {@link IMemoryPlugin.index} call. */
export interface MemoryIndexResult {
	/** Backend-assigned id for the stored record. */
	readonly id: string;
	/** Whether an existing record was updated rather than created. */
	readonly updated?: boolean;
}

/** Inputs to {@link IMemoryPlugin.search}. */
export interface MemoryQuery {
	/** Free-form query text; the backend chooses lexical / semantic / hybrid. */
	readonly query: string;
	/** Restrict the search to this scope. */
	readonly scope: MemoryScope;
	/** Cap on returned records (backend default when omitted). */
	readonly limit?: number;
	readonly tags?: readonly string[];
	readonly settings?: PluginSettings;
}

/**
 * A record returned by {@link IMemoryPlugin.search}.
 *
 * Security (prompt-injection): treat `content` as UNTRUSTED. Memory is
 * populated from prior runs / documents that may have processed hostile
 * external content, so a consumer that injects it into a prompt MUST
 * fence it (e.g. a `<memory>…</memory>` section) and never let it
 * override system instructions — the same rule the `agent-memory`
 * contract carries. This contract only carries the text.
 */
export interface MemoryRecord {
	readonly id: string;
	readonly title?: string;
	readonly content: string;
	readonly tags?: readonly string[];
	/** Similarity score (0..1) when the search is ranked. */
	readonly score?: number;
	readonly sourceId?: string;
	readonly sourceType?: string;
	/** ISO-8601 timestamp the record was written, when the backend reports it. */
	readonly createdAt?: string;
}

/** Inputs to the optional {@link IMemoryPlugin.synthesize} pass. */
export interface MemorySynthesisInput {
	readonly scope: MemoryScope;
	/** Optional cap on how many concepts to (re)synthesize this pass. */
	readonly limit?: number;
	readonly settings?: PluginSettings;
}

/** A compiled, deduplicated "concept" page produced by synthesis. */
export interface MemoryConcept {
	readonly id: string;
	readonly title: string;
	/** Compiled markdown body. */
	readonly body: string;
	/** How many raw records were compiled into this concept. */
	readonly entryCount?: number;
}

/** Result of the optional {@link IMemoryPlugin.synthesize} pass. */
export interface MemorySynthesisResult {
	readonly concepts: readonly MemoryConcept[];
}

/**
 * Memory-framework plugin interface — capability `memory`.
 *
 * Required surface: `index` (write a document into memory) + `search`
 * (retrieve records for a scope). The synthesis + stats surface is
 * OPTIONAL — the built-in default and simple backends implement a flat
 * store with no concept compilation, and the facade probes for presence
 * before exposing those operations.
 */
export interface IMemoryPlugin extends IPlugin {
	/** Framework name for facade identification ('agentmemory' | 'mem0' | 'zep' | …). */
	readonly memoryFramework: string;

	/** Index a document into the org's memory. Returns the stored record id. */
	index(input: MemoryIndexInput): Promise<MemoryIndexResult>;

	/** Retrieve records relevant to `query` within the given scope. */
	search(query: MemoryQuery): Promise<readonly MemoryRecord[]>;

	// ── Optional cognitive surface (Cortex P3) ─────────────────────────

	/** Compile clusters of related records into distilled concept pages. */
	synthesize?(input: MemorySynthesisInput): Promise<MemorySynthesisResult>;

	/** Report entry / concept counts for the scope (drives the header counters). */
	stats?(
		scope: MemoryScope,
		settings?: PluginSettings
	): Promise<{
		entries: number;
		concepts: number;
	}>;
}

/**
 * Type guard — true when a plugin declares the `memory` capability.
 */
export function isMemoryPlugin(plugin: IPlugin): plugin is IMemoryPlugin {
	return plugin.capabilities.includes('memory');
}
