import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { config } from '../../config/constants';
import { TenantJobRuntimeService } from './tenant-job-runtime.service';

/**
 * EW-752 P5.1 (T35b) — captures the effective operator allow-list +
 * per-tenant gating flag at process start as a single audit row.
 *
 * Spec: [`docs/specs/features/tenant-job-runtime-overlay/spec.md`](../../../../docs/specs/features/tenant-job-runtime-overlay/spec.md)
 * Plan: [`plan.md` §10 P5.1](../../../../docs/specs/features/tenant-job-runtime-overlay/plan.md)
 *
 * **Why a separate row type:**
 *
 * Per-tenant audit rows (`create` / `update` / `rotate` / etc.) already
 * snapshot the global allow-list inside the per-mutation `after` blob
 * (EW-742 P5 T35). That trail is enough to reconstruct "what was the
 * allow-list when tenant X mutated their overlay", but it does NOT let
 * an operator answer "when did the platform's allow-list itself
 * change" without joining across tenants. The boot row is a single,
 * cheap, monotonic place to read that history.
 *
 * **Dedupe by hash:**
 *
 * Five pods restarting on the same config would otherwise write five
 * identical rows in quick succession — pure noise. The writer reads
 * the most recent existing `operator_allowlist_boot` row, compares
 * its `after.hash`, and skips the insert when nothing changed. The
 * first pod after a config change still writes. Hashing is over a
 * canonical (sorted-keys) JSON of the effective allow-list + gating
 * flag, so cosmetic ordering changes don't trigger a spurious row.
 *
 * **NULL tenantId:**
 *
 * Boot-time state is not tied to any one tenant, so `tenantId = NULL`.
 * Migration `1781200000000-RelaxTenantJobRuntimeAuditTenantNullable`
 * relaxes the audit table's NOT NULL constraint to permit it. Per-
 * tenant audit rows are unaffected and still carry a real tenant id.
 *
 * **Failure mode:**
 *
 * The bootstrap deliberately catches and logs (instead of throwing) so
 * a transient DB hiccup at boot doesn't take the API down. The next
 * pod restart will retry; missing a single boot row is annoying but
 * not load-bearing.
 */
@Injectable()
export class TenantJobRuntimeBootAuditService implements OnApplicationBootstrap {
    private readonly logger = new Logger(TenantJobRuntimeBootAuditService.name);

    constructor(private readonly service: TenantJobRuntimeService) {}

    async onApplicationBootstrap(): Promise<void> {
        try {
            await this.captureBootSnapshot();
        } catch (err) {
            // Never fail the boot on an audit-row write failure — the
            // dedupe loop will retry on the next pod restart. Log loudly
            // so an operator can spot a repeatedly-failing write.
            this.logger.error(
                `Failed to capture operator_allowlist_boot audit row: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    /**
     * Compute the current snapshot, hash it, compare against the most
     * recent persisted boot row, and write a new row iff the hash
     * differs. Exposed (not private) so the spec can drive the dedupe
     * loop without spinning the whole NestJS bootstrap.
     */
    async captureBootSnapshot(): Promise<{ wrote: boolean; hash: string }> {
        const allowedProviders = config.tenantJobRuntime.getAllowedProviders();
        const perTenantGatingEnabled = config.tenantJobRuntime.isPerTenantGatingEnabled();
        const hash = this.hashSnapshot(allowedProviders, perTenantGatingEnabled);

        const latest = await this.service.findLatestBootAudit();
        const latestHash = this.readHash(latest?.after ?? null);
        if (latestHash === hash) {
            this.logger.debug(
                `operator_allowlist_boot hash unchanged (${hash.slice(0, 8)}…) — skipping insert`,
            );
            return { wrote: false, hash };
        }

        await this.service.appendAuditRow({
            tenantId: null,
            actorUserId: null,
            action: 'operator_allowlist_boot',
            before: null,
            after: { allowedProviders, perTenantGatingEnabled, hash },
            credentialVersion: null,
        });
        this.logger.log(
            `Captured operator_allowlist_boot snapshot ` +
                `(providers=[${allowedProviders.join(',')}], ` +
                `perTenantGating=${perTenantGatingEnabled}, hash=${hash.slice(0, 8)}…)`,
        );
        return { wrote: true, hash };
    }

    /**
     * Canonicalise the snapshot (sort the allow-list defensively before
     * hashing) so two operators declaring the providers in different
     * orders don't churn the boot log. The allow-list returned by the
     * config layer already preserves operator-declared order so this is
     * a no-op for well-formed configs, but worth being defensive about
     * — the goal of the hash is dedupe, not byte-for-byte fidelity.
     */
    private hashSnapshot(allowedProviders: string[], perTenantGatingEnabled: boolean): string {
        const canonical = JSON.stringify({
            allowedProviders: [...allowedProviders].sort(),
            perTenantGatingEnabled,
        });
        return createHash('sha256').update(canonical).digest('hex');
    }

    /**
     * Pull the hash out of a previously-stored `after` blob. Returns
     * `null` for malformed / legacy rows so the next boot row writes
     * regardless (we'd rather have a duplicate row than a missing one
     * on a schema bump).
     */
    private readHash(after: Record<string, unknown> | null): string | null {
        if (!after) return null;
        const raw = after['hash'];
        return typeof raw === 'string' ? raw : null;
    }
}
