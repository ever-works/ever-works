import type { IPlugin } from '../plugin.interface.js';
import type { PluginSettings } from '../../settings/settings.types.js';
import type { MemoryScope } from './memory.interface.js';

/**
 * Org-wide Memory (Cortex P2) — the `rag` capability contract.
 *
 * A `rag` plugin is the multi-doc-type RETRIEVAL PIPELINE: it
 * **composes** the existing seams — a `content-extractor` (ingest), an
 * `ai-provider.createEmbedding` (embed), and a `vector-store` (store /
 * query) — behind ONE swappable contract, so "how this org does RAG
 * over its documents" is a single unit rather than three
 * independently-configured seams. It **orchestrates** those categories;
 * it does not replace them.
 *
 * **Additive + contract-only.** This is a capability INTERFACE plus a
 * new `PLUGIN_CATEGORIES` entry — no concrete plugin ships with it yet.
 * The built-in retrieval path (KB `semanticSearch` over pgvector) keeps
 * working exactly as today; a `graph-rag` / hybrid backend becomes a
 * drop-in `rag` plugin once a facade binds this contract. Nothing is
 * removed or renamed.
 */

/** A document handed to {@link IRagPlugin.ingest}. */
export interface RagIngestInput {
	/** Source URL or upload reference, when ingesting from a location. */
	readonly url?: string;
	/** Raw text/markdown, when the caller already has the content. */
	readonly content?: string;
	/** Declared doc type ('markdown' | 'pdf' | 'docx' | 'xlsx' | …). */
	readonly docType?: string;
	readonly title?: string;
	/** Where the ingested chunks belong. */
	readonly scope: MemoryScope;
	readonly settings?: PluginSettings;
}

/** Result of an {@link IRagPlugin.ingest} call. */
export interface RagIngestResult {
	/** Id of the stored document/record. */
	readonly documentId: string;
	/** Number of chunks produced + upserted. */
	readonly chunkCount: number;
}

/** Inputs to {@link IRagPlugin.retrieve}. */
export interface RagQuery {
	readonly query: string;
	readonly scope: MemoryScope;
	readonly limit?: number;
	readonly settings?: PluginSettings;
}

/**
 * A single retrieval hit.
 *
 * Security (prompt-injection): treat `content` as UNTRUSTED, exactly as
 * with `memory` / `agent-memory` — fence it before injecting into any
 * prompt.
 */
export interface RagHit {
	readonly id: string;
	readonly content: string;
	readonly score: number;
	readonly title?: string;
	readonly documentId?: string;
	/** Arbitrary backend metadata (e.g. chunk index, source path). */
	readonly metadata?: Record<string, unknown>;
}

/**
 * RAG pipeline plugin interface — capability `rag`.
 *
 * `ingest` is where multi-doc-type support lives: it delegates
 * extraction to the `content-extractor` category (so new doc types are
 * new extractor plugins, not new RAG plugins), then chunks, embeds, and
 * upserts to the active `vector-store`. `retrieve` is the blended query
 * a memory surface uses for semantic search; a `graph-rag` plugin could
 * override it to walk concept links.
 */
export interface IRagPlugin extends IPlugin {
	/** Strategy name for facade identification ('default-hybrid' | 'graph-rag' | …). */
	readonly ragStrategy: string;

	/** Ingest a document: extract → chunk → embed → store. */
	ingest(input: RagIngestInput): Promise<RagIngestResult>;

	/** Retrieve hits for a query (hybrid lexical + vector, backend-defined). */
	retrieve(query: RagQuery): Promise<readonly RagHit[]>;

	/** Doc types this pipeline can ingest (e.g. ['markdown','pdf','docx']). */
	getSupportedDocTypes(): readonly string[];
}

/**
 * Type guard — true when a plugin declares the `rag` capability.
 */
export function isRagPlugin(plugin: IPlugin): plugin is IRagPlugin {
	return plugin.capabilities.includes('rag');
}
