import {
    BadRequestException,
    ConflictException,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { WorkRepository } from '@ever-works/agent/database';
import { EverWorksDnsService } from '@ever-works/agent/ever-works-providers';
import type { Work } from '@ever-works/agent/entities';

/**
 * EW-739 — service backing the managed-subdomain API.
 *
 * Single source of truth for "read or change the managed subdomain attached
 * to a Work" so the new `GET/PUT /api/deploy/works/:id/subdomain` endpoints,
 * the future Deploy-tab UI server actions, and any background reconciler
 * (EW-741) all flow through the same validation + DNS + persistence chain.
 *
 * Stays out of `DeployService` deliberately — that service drives the deploy
 * pipeline (workflow dispatch, secret pushes). Renaming a subdomain is
 * orthogonal to a deploy: it touches DNS + the Work row, then either patches
 * the live Ingress directly (k8s, future EW-740 follow-up) or surfaces a
 * "redeploy required" hint to the caller. Keeping it separate also lets the
 * tests stub a much smaller dependency surface than `DeployService`'s.
 */
export interface SubdomainState {
    /** Leftmost label persisted on `work.managedSubdomain`. */
    readonly subdomain: string | null;
    /** `${subdomain}.${rootDomain}`. */
    readonly fqdn: string | null;
    /** `https://${fqdn}`. */
    readonly url: string | null;
    /** `true` iff the DNS provider has a record for `fqdn`. */
    readonly recordOk: boolean;
    /**
     * `true` iff the caller can re-allocate via `PUT`. Gated on
     * `work.deployProvider ∈ {'ever-works','k8s'}` AND, for k8s, the
     * `EW734_K8S_MANAGED_SUBDOMAIN` env flag being active so operator
     * opt-in is respected.
     */
    readonly editable: boolean;
}

/**
 * Reserved platform labels — never let a tenant claim these. Mirrors the
 * spec §7 blocklist + the `SubdomainAllocator` BLOCKLIST so DB-level state
 * stays consistent whether the label was assigned via the allocator or via
 * an explicit `PUT`. Kept module-local (not exported from `@ever-works/agent`)
 * because the allocator's set is `private static readonly` and exporting
 * it would couple the API to a private detail.
 */
const RESERVED_LABELS: ReadonlySet<string> = new Set([
    'www',
    'api',
    'app',
    'admin',
    'mail',
    'auth',
    'docs',
    'status',
    'platform',
    'dashboard',
    'cdn',
    'static',
    'root',
    'mx',
    'ns',
    'ns1',
    'ns2',
]);

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

@Injectable()
export class ManagedSubdomainService {
    private readonly logger = new Logger(ManagedSubdomainService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly dnsService: EverWorksDnsService,
    ) {}

    /**
     * Resolve current state for the UI. Never mutates. Always returns a
     * snapshot — when no managed subdomain is allocated yet, all url-shaped
     * fields are `null` and `recordOk` is `false`, but `editable` may still
     * be `true` so the UI can offer a first-time allocation flow.
     */
    async getState(workId: string): Promise<SubdomainState> {
        const work = await this.requireWork(workId);
        const provider = this.dnsService.getProvider();
        const rootDomain = provider?.rootDomain() ?? this.fallbackRootDomain();
        const subdomain = (work.managedSubdomain ?? '').trim().toLowerCase() || null;
        const fqdn = subdomain ? `${subdomain}.${rootDomain}` : null;
        const url = fqdn ? `https://${fqdn}` : null;

        let recordOk = false;
        if (subdomain && fqdn && provider) {
            try {
                recordOk = await provider.recordExists(fqdn);
            } catch (cause) {
                // A probe failure is a transient health signal, not a hard
                // error — log + fall through so the UI still renders.
                this.logger.warn(
                    `recordExists probe failed for ${fqdn}: ${(cause as Error).message}`,
                );
            }
        }

        return {
            subdomain,
            fqdn,
            url,
            recordOk,
            editable: this.isEditable(work),
        };
    }

    /**
     * Re-allocate the managed subdomain to `requested` for `workId`. Steps:
     *   1. Format guard (defence-in-depth — controller DTO already validated).
     *   2. Blocklist guard (spec §7).
     *   3. No-op when `requested` already matches `work.managedSubdomain`.
     *   4. Global uniqueness via `WorkRepository.findByManagedSubdomain`.
     *   5. Remove the old DNS record (best-effort) — keeps the zone tidy and
     *      releases the old label so a sibling Work can re-claim it.
     *   6. Persist `work.managedSubdomain = requested`. The partial unique
     *      index is the DB-level backstop against concurrent renames.
     *   7. Ensure the new DNS record. Failure is hard-error: a successful
     *      persist without a working CNAME would leave the UI showing a
     *      claim that doesn't resolve. We try to roll back the persisted
     *      claim so the caller can retry.
     *
     * Returns the post-update `SubdomainState` for the caller.
     */
    async update(workId: string, requested: string): Promise<SubdomainState> {
        const normalized = (requested ?? '').trim().toLowerCase();
        if (!LABEL_RE.test(normalized) || normalized.length > 63) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'Invalid subdomain format. Must be lowercase letters, digits, and dashes (no leading/trailing dash), 1-63 characters.',
            });
        }
        if (RESERVED_LABELS.has(normalized)) {
            throw new BadRequestException({
                status: 'error',
                message: `Subdomain "${normalized}" is reserved by the platform and cannot be claimed.`,
            });
        }

        const work = await this.requireWork(workId);
        if (!this.isEditable(work)) {
            throw new BadRequestException({
                status: 'error',
                message:
                    'Managed subdomain is not editable for this work (requires ever-works or k8s provider with managed mode active).',
            });
        }

        const currentSubdomain = (work.managedSubdomain ?? '').trim().toLowerCase();
        if (currentSubdomain === normalized) {
            // Idempotent — short-circuit so we don't re-touch DNS unnecessarily.
            return this.getState(workId);
        }

        const claimedBy = await this.workRepository.findByManagedSubdomain(normalized);
        if (claimedBy && claimedBy.id !== work.id) {
            throw new ConflictException({
                status: 'error',
                message: `Subdomain "${normalized}" is already claimed by another work.`,
            });
        }

        const provider = this.dnsService.getProvider();
        const lbTarget = process.env.EVER_WORKS_DEPLOY_LB_HOSTNAME?.trim() ?? '';
        if (!provider) {
            throw new InternalServerErrorException({
                status: 'error',
                message:
                    'Managed DNS is not configured on this environment (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID / EVER_WORKS_DEPLOY_LB_HOSTNAME missing).',
            });
        }
        if (!lbTarget) {
            throw new InternalServerErrorException({
                status: 'error',
                message:
                    'Managed DNS target (EVER_WORKS_DEPLOY_LB_HOSTNAME) is not configured on this environment.',
            });
        }

        const rootDomain = provider.rootDomain();
        const newFqdn = `${normalized}.${rootDomain}`;
        const oldFqdn = currentSubdomain ? `${currentSubdomain}.${rootDomain}` : null;

        // Step 5: best-effort old-record cleanup. A failure here doesn't
        // block the rename — the new claim is what the user wants live —
        // but we log so an operator can clean up a dangling CNAME.
        if (oldFqdn) {
            try {
                await provider.removeRecord({ host: oldFqdn });
            } catch (cause) {
                this.logger.warn(
                    `Failed to remove stale DNS record for ${oldFqdn} during rename of work ${work.id}: ${(cause as Error).message}`,
                );
            }
        }

        // Step 6: persist. A concurrent rename racing to the same label will
        // surface as a unique-index violation here; we map it to 409 so the
        // UI shows a friendly retry message instead of a generic 500.
        try {
            await this.workRepository.update(work.id, { managedSubdomain: normalized });
        } catch (cause) {
            if (this.isUniqueViolation(cause)) {
                throw new ConflictException({
                    status: 'error',
                    message: `Subdomain "${normalized}" was just claimed by another work. Please pick a different one.`,
                });
            }
            throw cause;
        }

        // Step 7: ensure the new record. On failure, try to roll back the
        // persisted claim so the user isn't stuck with a half-applied rename.
        try {
            await provider.ensureRecord({
                host: newFqdn,
                type: 'CNAME',
                target: lbTarget,
                proxied: false,
                ttl: 1,
            });
        } catch (cause) {
            this.logger.error(
                `ensureRecord failed for ${newFqdn} on work ${work.id}: ${(cause as Error).message}; rolling back persisted claim`,
            );
            try {
                await this.workRepository.update(work.id, {
                    managedSubdomain: currentSubdomain || null,
                });
            } catch (rollbackErr) {
                this.logger.error(
                    `Failed to roll back managedSubdomain for work ${work.id}: ${(rollbackErr as Error).message}`,
                );
            }
            throw new InternalServerErrorException({
                status: 'error',
                message: `Failed to create DNS record for ${newFqdn}. The rename was not applied.`,
            });
        }

        this.logger.log(
            `Managed subdomain for work ${work.id} updated: ${currentSubdomain || '(unset)'} -> ${normalized}`,
        );

        // Re-read so the response reflects the persisted state (including
        // `recordOk` after the freshly ensured record).
        return this.getState(work.id);
    }

    /**
     * For callers that don't have the Work in hand yet — keeps the
     * controller thin and centralises the 404 message.
     */
    private async requireWork(workId: string): Promise<Work> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException({
                status: 'error',
                message: `Work ${workId} not found`,
            });
        }
        return work;
    }

    /**
     * Editable iff the deploy provider is one that runs through
     * `applyManagedSubdomain`. For `'k8s'` we additionally require the
     * `EW734_K8S_MANAGED_SUBDOMAIN` flag so operators opt-in per env —
     * matches the gate in `DeployService.isManagedSubdomainForK8sEnabled`.
     * `'ever-works'` is always managed.
     */
    private isEditable(work: Work): boolean {
        const provider = (work.deployProvider ?? '').trim().toLowerCase();
        if (provider === 'ever-works') {
            return true;
        }
        if (provider === 'k8s') {
            return process.env.EW734_K8S_MANAGED_SUBDOMAIN === 'true';
        }
        return false;
    }

    private fallbackRootDomain(): string {
        return process.env.EVER_WORKS_DOMAIN?.trim() || 'ever.works';
    }

    /**
     * Mirrors `SubdomainAllocator.isUniqueViolation`. Kept duplicated rather
     * than re-exported because the allocator's helper is `private` and
     * widening visibility for one cross-module caller would be worse than a
     * 10-line copy.
     */
    private isUniqueViolation(cause: unknown): boolean {
        if (!cause || typeof cause !== 'object') return false;
        const err = cause as { code?: string; driverError?: { code?: string }; message?: string };
        if (err.code === '23505') return true;
        if (err.driverError?.code === '23505') return true;
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
        const msg = (err.message ?? '').toLowerCase();
        return msg.includes('unique constraint') || msg.includes('uq_works_managedsubdomain');
    }
}
