/**
 * EW-642 — `VectorStoreFacadeService` + `EmbeddingModeResolver`.
 *
 * Mirrors `AiFacadeService.transcribe`'s selection chain so the KB
 * ingest/retrieval paths get a single entry point that picks the right
 * `IVectorStorePlugin` for the (work, user) tuple and routes upsert /
 * query / delete calls through it.
 *
 * RFC anchors:
 *   - §6 selection chain — `providerOverride` → operator env pin
 *     (`KB_VECTOR_STORE_PROVIDER_ID`) → per-Work scope-active plugin →
 *     registry default (`defaultForCapabilities`) → first by id →
 *     otherwise throw `VectorStoreNotConfiguredError`.
 *   - D4 — embedding mode cascade (work → org → env → auto). The
 *     `'auto'` fallback picks `'plugin'` when the resolved vector store
 *     declares `vectorCapabilities.embedsOnWrite === true` (e.g.
 *     Weaviate text2vec, Pinecone with vendor-managed embedding); else
 *     `'platform'` (caller-side embedding via the AI facade).
 *
 * Slice-2 wires the optional `ActivityLogService` for auto-mode flips
 * (today the @Optional() injection just keeps the constructor stable so
 * Phase 3 doesn't have to re-touch the FacadesModule).
 *
 * Design rationale lives in the RFC:
 * `docs/specs/features/knowledge-base/phase-2-vector-plugin-design.md`.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    isVectorStorePlugin,
    type IVectorStorePlugin,
    type UpsertChunksInput,
    type UpsertChunksResult,
    type QueryChunksInput,
    type QueryChunksResult,
    type DeleteByDocumentInput,
    type DeleteByWorkInput,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { config } from '../config';
import { FacadeError } from './base.facade';

const VECTOR_STORE_CAPABILITY = 'vector-store';
const VECTOR_STORE_CATEGORY = 'vector-store' as const;

/**
 * Options accepted by every selection-aware method on
 * `VectorStoreFacadeService`. Mirrors the per-call surface of
 * `FacadeOptions` but keeps the field set tight so callers don't have
 * to thread agent/task ids through paths that don't need them — KB
 * ingest carries them via the work record, retrieval doesn't have them
 * at all.
 */
export interface SelectVectorStoreOpts {
    readonly workId: string;
    readonly userId: string;
    /**
     * Caller-pinned provider id. Highest-priority leg of the RFC §6
     * chain — when set, the facade ONLY tries this provider; no silent
     * fallback to operator pin / scope-active / registry default.
     */
    readonly providerOverride?: string;
}

/**
 * Resolved embedding-mode literal returned by
 * `EmbeddingModeResolver.resolve()`. `'platform'` keeps the legacy
 * caller-side embedding lane (AI facade → embedding bytes → vector
 * store); `'plugin'` defers embedding to the vector-store plugin
 * (vendor-managed, requires `embedsOnWrite === true`).
 */
export type EmbeddingMode = 'platform' | 'plugin';

/**
 * Operator-knob shape — the env var accepts the literal `'auto'`
 * alongside the resolved-mode literals so admins can express "let the
 * facade pick based on what's wired in".
 */
export type EmbeddingModeSetting = EmbeddingMode | 'auto';

/**
 * Thrown by `VectorStoreFacadeService.select()` when no vector-store
 * plugin is selectable for the (work, user, override) tuple. KB
 * ingest catches this and surfaces "no vector store configured" on
 * the workbench so the operator can either install
 * `@ever-works/pgvector-plugin` (the default) or pin one via
 * `KB_VECTOR_STORE_PROVIDER_ID`. Same shape as
 * `TranscriptionNotConfiguredError` from EW-643.
 */
export class VectorStoreNotConfiguredError extends FacadeError {
    constructor(message: string, provider?: string) {
        super(message, 'selectVectorStore', provider);
        this.name = 'VectorStoreNotConfiguredError';
    }
}

/**
 * Thrown by `EmbeddingModeResolver.resolve()` when the resolved mode
 * is `'plugin'` but the chosen vector store declares
 * `capabilities.embedsOnWrite === false`. Callers may catch this and
 * either degrade to `'platform'` (caller-side embedding) or surface
 * the misconfiguration to the user — the facade does NOT auto-degrade
 * because RFC D4 is explicit that the platform/plugin choice is a
 * deliberate operator decision (cost, data-residency, vendor
 * lock-in).
 */
export class EmbeddingModeUnsupportedError extends FacadeError {
    constructor(message: string, provider?: string) {
        super(message, 'resolveEmbeddingMode', provider);
        this.name = 'EmbeddingModeUnsupportedError';
    }
}

/**
 * Helper class that owns the D4 embedding-mode cascade. Pulled out of
 * `VectorStoreFacadeService` so it can be exercised in isolation
 * without any plugin-registry boilerplate (the resolution only depends
 * on the already-resolved plugin's static capabilities + three
 * scalar settings).
 *
 * Cascade (RFC D4):
 *   1. Work-level setting, if explicit (`'platform'` | `'plugin'`).
 *   2. Org-level setting, if explicit.
 *   3. `KB_EMBEDDING_MODE` env value, if explicit.
 *   4. `'auto'` — pick `'plugin'` iff the resolved vector-store plugin
 *      declares `vectorCapabilities.embedsOnWrite === true`; else
 *      `'platform'`.
 *
 * After resolving the mode, the resolver validates the plugin can
 * actually honor it: a resolved `'plugin'` mode against a plugin that
 * does NOT embed-on-write throws `EmbeddingModeUnsupportedError`.
 */
export class EmbeddingModeResolver {
    resolve(opts: {
        workId: string;
        resolvedVectorStorePlugin: IVectorStorePlugin;
        workEmbeddingMode?: EmbeddingModeSetting;
        orgEmbeddingMode?: EmbeddingModeSetting;
    }): EmbeddingMode {
        const cascaded = this.cascade(opts.workEmbeddingMode, opts.orgEmbeddingMode);

        // `'auto'` is resolved here (not in `cascade()`) because the
        // embedsOnWrite-aware fallback depends on the resolved plugin —
        // which `cascade()` deliberately does not know about. RFC D4:
        // pick `'plugin'` iff the plugin declares `embedsOnWrite === true`;
        // else `'platform'`.
        const mode: EmbeddingMode =
            cascaded === 'auto'
                ? opts.resolvedVectorStorePlugin.vectorCapabilities.embedsOnWrite
                    ? 'plugin'
                    : 'platform'
                : cascaded;

        if (mode === 'plugin' && !opts.resolvedVectorStorePlugin.vectorCapabilities.embedsOnWrite) {
            throw new EmbeddingModeUnsupportedError(
                `Vector-store plugin '${opts.resolvedVectorStorePlugin.id}' does not support ` +
                    `embedsOnWrite; resolved embedding mode 'plugin' cannot be honored for ` +
                    `work '${opts.workId}'. Either switch the work/org/env setting to 'platform' ` +
                    `or pick a plugin (e.g. Weaviate text2vec) that embeds on write.`,
                opts.resolvedVectorStorePlugin.id,
            );
        }

        return mode;
    }

    private cascade(
        workSetting?: EmbeddingModeSetting,
        orgSetting?: EmbeddingModeSetting,
    ): EmbeddingModeSetting {
        // 1. Work-level explicit pin wins.
        if (workSetting === 'platform' || workSetting === 'plugin') {
            return workSetting;
        }
        // 2. Org-level explicit pin.
        if (orgSetting === 'platform' || orgSetting === 'plugin') {
            return orgSetting;
        }
        // 3. Env-level explicit pin (KB_EMBEDDING_MODE).
        const envSetting = config.kb.getEmbeddingMode();
        if (envSetting === 'platform' || envSetting === 'plugin') {
            return envSetting;
        }
        // 4. Otherwise propagate `'auto'` so `resolve()` can apply the
        // embedsOnWrite-aware fallback against the actual plugin.
        return 'auto';
    }
}

/**
 * `VectorStoreFacadeService` — single entry point for upsert / query /
 * delete against the resolved `IVectorStorePlugin`. Slice-2 wires this
 * into the KB ingest + retrieval paths; until then the facade is just
 * Phase-3 plumbing.
 *
 * Resolution chain mirrors `AiFacadeService.transcribe`:
 *   1. `providerOverride` (highest priority — caller pinned).
 *   2. Operator env pin via `KB_VECTOR_STORE_PROVIDER_ID`.
 *   3. Per-Work scope-active plugin (via `WorkPluginRepository`).
 *   4. Registry default — first plugin in the `vector-store` category
 *      with `defaultForCapabilities.includes('vector-store')`; else
 *      first by id.
 *   5. Otherwise throw `VectorStoreNotConfiguredError`.
 */
@Injectable()
export class VectorStoreFacadeService {
    private readonly logger = new Logger(VectorStoreFacadeService.name);

    constructor(
        private readonly registry: PluginRegistryService,
        @Optional() private readonly workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly activityLogService?: ActivityLogService,
    ) {}

    /**
     * Resolve the vector-store plugin for the (workId, userId,
     * providerOverride) tuple. Throws
     * `VectorStoreNotConfiguredError` when nothing qualifies — KB
     * ingest catches this and surfaces a workbench banner so the
     * operator can install/pin a backend.
     */
    async select(opts: SelectVectorStoreOpts): Promise<IVectorStorePlugin> {
        // 1. Caller pin — when set, ONLY this provider is tried.
        if (opts.providerOverride) {
            const pinned = this.lookupPlugin(opts.providerOverride);
            if (!pinned) {
                throw new VectorStoreNotConfiguredError(
                    `Pinned vector-store provider '${opts.providerOverride}' not found or not ` +
                        `a vector-store plugin.`,
                    opts.providerOverride,
                );
            }
            return pinned;
        }

        // 2. Operator pin via KB_VECTOR_STORE_PROVIDER_ID — same
        // hard-fail semantics as the caller-level override; the env
        // var is an explicit operator decision and a missing plugin is
        // a misconfiguration, not a fallback trigger.
        const envPin = config.kb.getVectorStoreProviderId();
        if (envPin) {
            const pinned = this.lookupPlugin(envPin);
            if (!pinned) {
                throw new VectorStoreNotConfiguredError(
                    `Operator-pinned vector-store provider '${envPin}' ` +
                        `(KB_VECTOR_STORE_PROVIDER_ID) not found or not a vector-store plugin.`,
                    envPin,
                );
            }
            return pinned;
        }

        // 3. Per-Work scope-active plugin — same `WorkPluginRepository`
        // path AiFacadeService uses. Quietly fall through when no
        // active row exists (this leg is best-effort).
        if (this.workPluginRepository) {
            try {
                const active = await this.workPluginRepository.findActiveByCapability(
                    opts.workId,
                    VECTOR_STORE_CAPABILITY,
                );
                if (active) {
                    const registered = this.registry.get(active.pluginId);
                    const inst = registered?.plugin as unknown as IVectorStorePlugin | undefined;
                    if (
                        registered &&
                        registered.state === 'loaded' &&
                        inst &&
                        isVectorStorePlugin(inst)
                    ) {
                        return inst;
                    }
                }
            } catch (err) {
                this.logger.debug(
                    `Scope-active vector-store lookup failed for work ${opts.workId}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }

        // 4. Registry iteration — pick category === 'vector-store' AND
        // capability advertised. Prefer `defaultForCapabilities`; fall
        // back to first by id (stable sort for deterministic dev/test
        // runs).
        const candidates = this.registry
            .getByCapability(VECTOR_STORE_CAPABILITY)
            .filter(
                (p) =>
                    p.state === 'loaded' &&
                    p.manifest.category === VECTOR_STORE_CATEGORY &&
                    p.manifest.capabilities.includes(VECTOR_STORE_CAPABILITY),
            );

        if (candidates.length > 0) {
            const preferred = candidates.find((p) =>
                p.manifest.defaultForCapabilities?.includes(VECTOR_STORE_CAPABILITY),
            );
            const chosen =
                preferred ??
                [...candidates].sort((a, b) => a.plugin.id.localeCompare(b.plugin.id))[0];
            const inst = chosen.plugin as unknown as IVectorStorePlugin;
            if (isVectorStorePlugin(inst)) {
                return inst;
            }
        }

        // 5. Nothing qualifies.
        throw new VectorStoreNotConfiguredError(
            `No vector-store plugin registered for work '${opts.workId}'. ` +
                `Install '@ever-works/pgvector-plugin' (default) or pin one via ` +
                `KB_VECTOR_STORE_PROVIDER_ID.`,
        );
    }

    /**
     * Pass-through wrapper for `upsertChunks` — resolves the plugin
     * once and delegates. Keeps KB ingest from re-implementing the
     * `select()` dance on every call.
     */
    async upsertChunks(
        input: UpsertChunksInput,
        opts: SelectVectorStoreOpts,
    ): Promise<UpsertChunksResult> {
        const plugin = await this.select(opts);
        return plugin.upsertChunks(input);
    }

    /** Pass-through wrapper for `queryChunks`. */
    async queryChunks(
        input: QueryChunksInput,
        opts: SelectVectorStoreOpts,
    ): Promise<QueryChunksResult> {
        const plugin = await this.select(opts);
        return plugin.queryChunks(input);
    }

    /** Pass-through wrapper for `deleteByDocument`. */
    async deleteByDocument(
        input: DeleteByDocumentInput,
        opts: SelectVectorStoreOpts,
    ): Promise<void> {
        const plugin = await this.select(opts);
        return plugin.deleteByDocument(input);
    }

    /** Pass-through wrapper for `deleteByWork`. */
    async deleteByWork(input: DeleteByWorkInput, opts: SelectVectorStoreOpts): Promise<void> {
        const plugin = await this.select(opts);
        return plugin.deleteByWork(input);
    }

    /**
     * Registry lookup that respects the vector-store contract: must be
     * `'loaded'`, must declare the `'vector-store'` capability token,
     * must structurally satisfy `IVectorStorePlugin`. Used by the
     * operator-pin + caller-pin legs of `select()`.
     */
    private lookupPlugin(pluginId: string): IVectorStorePlugin | null {
        const registered = this.registry.get(pluginId);
        if (!registered || registered.state !== 'loaded') {
            return null;
        }
        if (!registered.manifest.capabilities.includes(VECTOR_STORE_CAPABILITY)) {
            return null;
        }
        const inst = registered.plugin as unknown as IVectorStorePlugin;
        if (!isVectorStorePlugin(inst)) {
            return null;
        }
        return inst;
    }
}
