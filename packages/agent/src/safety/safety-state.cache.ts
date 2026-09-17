import { Injectable } from '@nestjs/common';
import {
    SAFETY_CACHE_TTL_MS,
    type ResolvedLadder,
    type WorkspacePauseState,
} from '@ever-works/contracts';

/** One workspace's safety snapshot. */
export interface SafetySnapshot {
    ladder: ResolvedLadder;
    pause: WorkspacePauseState;
    /** True when either half could not be read — the fail-closed posture. */
    safe: boolean;
    loadedAt: number;
}

export interface SafetySnapshotLoader {
    (key: SafetyCacheKey): Promise<SafetySnapshot>;
}

export interface SafetyCacheKey {
    ownerUserId: string;
    workspaceScopeId: string;
    agentId: string | null;
    tenantId: string | null;
    organizationId: string | null;
}

/**
 * Safety rails (AW-24) — how "takes effect within 10 seconds, with no restart
 * and no redeploy" is achieved (FR-37) without new infrastructure.
 *
 * Per workspace (and per Agent, because an Agent narrows the ladder) this
 * holds the resolved rungs, the pause row and a `loadedAt`. Every read checks
 * the age and refreshes in band. There is no pub/sub and no websocket: a
 * ten-second stale window is INSIDE the budget the product promises, and
 * anything that needed a message bus would be a new failure mode for a
 * component whose entire job is to keep working.
 *
 * A write invalidates the local entry immediately, so the replica that took
 * the write is never the one showing stale state, and the others expire
 * within the same ten seconds.
 *
 * ## Why an in-process map and not the shared cache
 *
 * Because the gate is on the tool loop's hot path and must answer in single-
 * digit milliseconds. A network round trip per tool call would spend the
 * entire p95 budget (FR-20) on a lookup whose answer changes a few times a
 * year. Bounded by a cap on distinct workspaces so a many-tenant worker
 * cannot grow it without limit.
 */
@Injectable()
export class SafetyStateCache {
    private readonly entries = new Map<string, SafetySnapshot>();

    /** Enough for every workspace a worker realistically touches in a window. */
    private static readonly MAX_ENTRIES = 500;

    async get(key: SafetyCacheKey, load: SafetySnapshotLoader): Promise<SafetySnapshot> {
        const id = cacheKey(key);
        const existing = this.entries.get(id);
        if (existing && Date.now() - existing.loadedAt <= SAFETY_CACHE_TTL_MS) {
            return existing;
        }

        const snapshot = await load(key);
        this.set(id, snapshot);
        return snapshot;
    }

    /** Drop one workspace's snapshot — called immediately after a write. */
    invalidate(key: Pick<SafetyCacheKey, 'ownerUserId' | 'workspaceScopeId'>): void {
        const prefix = `${key.ownerUserId}|${key.workspaceScopeId}|`;
        for (const id of [...this.entries.keys()]) {
            if (id.startsWith(prefix)) this.entries.delete(id);
        }
    }

    /** Drop everything. Used by tests and by a wholesale configuration change. */
    clear(): void {
        this.entries.clear();
    }

    /** How many snapshots are held. Exposed for the cache's own spec. */
    size(): number {
        return this.entries.size;
    }

    private set(id: string, snapshot: SafetySnapshot): void {
        if (this.entries.size >= SafetyStateCache.MAX_ENTRIES && !this.entries.has(id)) {
            // Oldest insertion first — a Map iterates in insertion order, and
            // an approximate eviction is the right trade for a cache whose
            // entries all expire within ten seconds anyway.
            const oldest = this.entries.keys().next();
            if (!oldest.done) this.entries.delete(oldest.value);
        }
        this.entries.set(id, snapshot);
    }
}

function cacheKey(key: SafetyCacheKey): string {
    return `${key.ownerUserId}|${key.workspaceScopeId}|${key.agentId ?? '-'}`;
}
