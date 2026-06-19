import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { JobRuntimeId } from '@ever-works/plugin';
import { TenantJobRuntimeConfig } from '../entities/tenant-job-runtime-config.entity';

/**
 * EW-742 P3.1 / T22 — enqueue-site `credentialVersion` capture helper.
 *
 * The graceful-drain semantics locked in [ADR-017 §3](../../../../docs/specs/decisions/017-tenant-scoped-job-runtime-overlay.md#3-credential-rotation--graceful-drain-locked-q4-do-not-reopen)
 * (Q4) and [`spec.md` FR-5](../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * require every enqueue to stamp the active `(providerId, credentialVersion)`
 * onto the run record so the worker host can later resolve THAT snapshot
 * via {@link CredentialVersionService.resolveSnapshot} — even if the tenant
 * rotates mid-run.
 *
 * # Why a dedicated helper instead of inlining the lookup
 *
 * Twelve dispatcher call sites in {@link ./_tasks-symbols} all need the
 * same `(tenantId) -> { providerId, credentialVersion }` projection. A
 * dedicated `@Injectable()` gives them ONE place to:
 *   - share the row read (one query per enqueue, no provider-specific
 *     fan-out);
 *   - share the fail-open behaviour on database hiccup (return
 *     `{ providerId: null, credentialVersion: null }` and log — never
 *     block an enqueue because the overlay lookup failed);
 *   - migrate to the T21 cache + future history table without touching
 *     dispatcher code.
 *
 * # Why this is NOT {@link TenantAwareRuntimeResolver}
 *
 * The resolver wraps the EW-685 binding-factory registry and returns the
 * `IJobRuntimeProvider` a tenant should dispatch through. The stamper
 * only answers "what should I write into this run's metadata?" — no
 * provider, no registry, no honest-stopgap behaviour. Dispatchers need
 * BOTH (resolve via the resolver, stamp via this helper) and the two
 * concerns evolve independently:
 *   - resolver gets a per-provider credential-binding hook once EW-686
 *     P2 lands;
 *   - stamper gets the cache + history table once T21 + the P1 follow-up
 *     land.
 *
 * # Scope of THIS PR
 *
 * Only the helper itself + tests. Per-dispatcher wiring (the actual
 * `await stamper.stamp(tenantId)` call inside each of the twelve
 * dispatchers and the run-record schema column it writes into) lands
 * separately — each dispatcher's enqueue payload type needs a
 * `credentialVersion?: number` field added, and that's a per-dispatcher
 * change that's safer to ship one-at-a-time after this helper is on
 * `main`. The deliberate seam: dispatchers can adopt this helper
 * incrementally without coordinating a single bus-stop PR.
 *
 * # Failure mode
 *
 * If the repository throws (DB hiccup, missing migration, etc.), the
 * stamper logs at `warn` and returns `{ providerId: null,
 * credentialVersion: null }` so the enqueue still succeeds. Stamping is a
 * BEST-EFFORT metadata write; the worker host treats a missing
 * `credentialVersion` as "no tenant overlay was active when this was
 * enqueued" and runs against the instance default — same as the
 * pre-overlay (EW-683) code path.
 */
@Injectable()
export class RuntimeBindingStamperService {
    private readonly logger = new Logger(RuntimeBindingStamperService.name);

    constructor(
        @InjectRepository(TenantJobRuntimeConfig)
        private readonly configRepository: Repository<TenantJobRuntimeConfig>,
    ) {}

    /**
     * Returns the `(providerId, credentialVersion)` tuple that should be
     * stamped onto a run record enqueued for `tenantId`, or
     * `{ providerId: null, credentialVersion: null }` when no tenant
     * overlay applies (matching the pre-overlay byte-identical code path).
     *
     * `{ providerId: null, credentialVersion: null }` cases:
     *   - `tenantId` is `null` / `undefined` (no tenant context).
     *   - No overlay row exists for the tenant.
     *   - Overlay row is disabled (`enabled = false`).
     *   - Overlay mode is `inherit`.
     *   - Repository lookup throws (logged + fail-open).
     *
     * `(providerId, credentialVersion)` cases:
     *   - Overlay row exists, `enabled = true`, mode is `byo` or
     *     `override`. The row's own `providerId` + `credentialVersion`
     *     are returned (single source of truth — no second query to
     *     {@link CredentialVersionService.getCurrentVersion} since the
     *     row we just read has the current version on it).
     */
    async stamp(tenantId: string | null | undefined): Promise<{
        providerId: JobRuntimeId | null;
        credentialVersion: number | null;
    }> {
        if (!tenantId) {
            return { providerId: null, credentialVersion: null };
        }

        let row: TenantJobRuntimeConfig | null;
        try {
            row = await this.configRepository.findOne({
                where: { tenantId },
                select: ['tenantId', 'providerId', 'credentialVersion', 'mode', 'enabled'],
            });
        } catch (err) {
            this.logger.warn(
                `RuntimeBindingStamperService.stamp(${tenantId}) — overlay lookup failed ` +
                    `(${err instanceof Error ? err.message : String(err)}); returning null/null ` +
                    `(fail-open — enqueue proceeds against instance default)`,
            );
            return { providerId: null, credentialVersion: null };
        }

        if (!row || !row.enabled || row.mode === 'inherit') {
            return { providerId: null, credentialVersion: null };
        }

        // mode === 'byo' | 'override' AND enabled — return the row's own
        // providerId + credentialVersion. The row read above selects
        // credentialVersion explicitly, so we don't need a second query
        // to CredentialVersionService.getCurrentVersion (which would
        // read the same row).
        return {
            providerId: row.providerId as JobRuntimeId,
            credentialVersion: row.credentialVersion,
        };
    }
}
