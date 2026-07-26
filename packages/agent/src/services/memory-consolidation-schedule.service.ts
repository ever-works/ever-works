import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    KB_MEMORY_CONSOLIDATION_DEFAULT_CADENCE,
    KB_MEMORY_CONSOLIDATION_DEFAULT_MODE,
    KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS,
    type KbMemoryConsolidationCadence,
    type KbMemoryConsolidationMode,
    type KbMemoryConsolidationSettings,
} from '@ever-works/contracts';
import { OrganizationRepository } from '../database/repositories/organization.repository';
import { TenantRepository } from '../database/repositories/tenant.repository';
import { NotificationService } from '../notifications/notification.service';
import type { MemorySynthesisGaps } from './memory-consolidation';
import {
    MemoryConsolidationService,
    type MemoryConsolidationReport,
} from './memory-consolidation.service';
import { MemoryHealthService } from './memory-health.service';

/** Max organizations processed per tick (cron-run bound). */
export const CONSOLIDATION_TICK_ORG_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why one organization was not consolidated on this tick. */
export type ConsolidationSkipReason = 'disabled' | 'not-due' | 'no-owner' | 'failed';

/** Per-tick summary returned to the cron (and logged). */
export interface MemoryConsolidationTickSummary {
    /** Organizations that carried consolidation settings at all. */
    considered: number;
    /** Organizations whose pass actually ran. */
    ran: number;
    /** Passes that ran in `dry-run` mode (nothing persisted). */
    dryRun: number;
    /** Passes that ran in `propose` mode (documents landed for review). */
    proposed: number;
    /** Notifications successfully produced. */
    notified: number;
    skipped: Record<ConsolidationSkipReason, number>;
}

/** Result of one organization's scheduled pass. */
export interface OrgConsolidationResult {
    organizationId: string;
    ran: boolean;
    mode: KbMemoryConsolidationMode;
    reason?: ConsolidationSkipReason;
    report?: MemoryConsolidationReport;
    notified: boolean;
}

/**
 * Consolidation cadence (memory upgrades M9).
 *
 * Runs the EXISTING `MemoryConsolidationService` on a schedule instead
 * of only on a button press. Everything about it is a deliberate
 * non-surprise:
 *
 *  - **Opt-in per organization.** An org with no
 *    `memory_consolidation` settings (which is every org today) is
 *    skipped. Nothing changes for anybody who does not ask for it.
 *  - **Dry-run by default.** `mode` defaults to `dry-run`: the pass
 *    computes the full report and persists NOTHING. The org must
 *    explicitly choose `propose` for the pass to write.
 *  - **Never auto-applied.** Even in `propose` mode the service's own
 *    invariants hold: synthesized documents land as
 *    `reviewState: 'proposed'` (excluded from every prompt until a
 *    human accepts them in the review queue) and duplicates are MARKED
 *    superseded, never deleted. No agent-written memory teaches another
 *    agent without a human in the loop.
 *  - **Configurable cadence.** `daily` / `weekly` (default) / `monthly`,
 *    enforced against `lastRunAt` in the settings blob — so a cron that
 *    fires daily still respects a weekly org.
 *  - **Gap-fed.** The org's measured retrieval gaps (M10) ride into the
 *    synthesis prompt, best-effort — health failures never fail a pass.
 *
 * Scheduling is a JOB, not a cloud feature: the `memory-consolidation-tick`
 * task in `packages/tasks` calls `dispatchDue()` over the internal RPC
 * channel exactly like `digest-dispatcher` / `mission-tick`, so a local
 * install on any job-runtime plugin gets the same cadence.
 */
@Injectable()
export class MemoryConsolidationScheduleService {
    private readonly logger = new Logger(MemoryConsolidationScheduleService.name);

    constructor(
        private readonly organizationRepository: OrganizationRepository,
        private readonly tenantRepository: TenantRepository,
        private readonly consolidation: MemoryConsolidationService,
        // Optional so an install without the health wiring still gets the
        // cadence — the pass simply runs without a gap section.
        @Optional() private readonly health?: MemoryHealthService,
        @Optional() private readonly notifications?: NotificationService,
    ) {}

    /**
     * Run every organization whose cadence is due. Never throws: a
     * failing org is counted and the sweep continues, so one bad tenant
     * cannot stall the whole tick.
     */
    async dispatchDue(
        options: { now?: Date; limit?: number } = {},
    ): Promise<MemoryConsolidationTickSummary> {
        const now = options.now ?? new Date();
        const orgs = await this.organizationRepository.findWithMemoryConsolidationSettings(
            options.limit ?? CONSOLIDATION_TICK_ORG_LIMIT,
        );

        const summary: MemoryConsolidationTickSummary = {
            considered: orgs.length,
            ran: 0,
            dryRun: 0,
            proposed: 0,
            notified: 0,
            skipped: { disabled: 0, 'not-due': 0, 'no-owner': 0, failed: 0 },
        };

        for (const org of orgs) {
            try {
                const result = await this.runForOrganization(org.id, org.memoryConsolidation, {
                    now,
                    tenantId: org.tenantId,
                });
                if (!result.ran) {
                    summary.skipped[result.reason ?? 'failed'] += 1;
                    continue;
                }
                summary.ran += 1;
                if (result.mode === 'propose') summary.proposed += 1;
                else summary.dryRun += 1;
                if (result.notified) summary.notified += 1;
            } catch (error) {
                summary.skipped.failed += 1;
                this.logger.warn(
                    `Scheduled memory consolidation failed for org=${org.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        return summary;
    }

    /**
     * Run (or skip) one organization's scheduled pass. Exposed so the
     * settings UI / an operator can trigger the *scheduled* shape of the
     * pass for a single org without waiting for the cron.
     */
    async runForOrganization(
        organizationId: string,
        settings: KbMemoryConsolidationSettings | null | undefined,
        context: { now?: Date; tenantId?: string; force?: boolean } = {},
    ): Promise<OrgConsolidationResult> {
        const now = context.now ?? new Date();
        const mode = resolveMode(settings);

        if (!settings || settings.enabled !== true) {
            return { organizationId, ran: false, mode, reason: 'disabled', notified: false };
        }
        if (!context.force && !isDue(settings, now)) {
            return { organizationId, ran: false, mode, reason: 'not-due', notified: false };
        }

        // The pass needs a user identity — the AI facade meters against
        // it and `createOrgDocument` stamps it as the author. The tenant
        // owner is the only user guaranteed to exist for an org and to
        // be authorized over it, which is why it is resolved here rather
        // than passed in from the (user-less) cron.
        const ownerUserId = await this.resolveOwnerUserId(organizationId, context.tenantId);
        if (!ownerUserId) {
            this.logger.warn(
                `Scheduled memory consolidation skipped for org=${organizationId}: no owner user resolvable`,
            );
            return { organizationId, ran: false, mode, reason: 'no-owner', notified: false };
        }

        const gaps = await this.resolveGaps(organizationId, now);

        const report = await this.consolidation.runConsolidation(
            { organizationId, userId: ownerUserId },
            { apply: mode === 'propose', gaps },
        );

        // Stamp the run BEFORE notifying: a notification failure must not
        // cause the same window to be reprocessed on the next tick.
        await this.stampLastRun(organizationId, settings, now);

        const notified = await this.notify(
            organizationId,
            ownerUserId,
            mode,
            report,
            now,
            settings,
        );

        return { organizationId, ran: true, mode, report, notified };
    }

    /**
     * Measured retrieval gaps for the synthesis prompt (M11).
     * Best-effort — a health failure downgrades to `null` and the pass
     * runs with the pre-M11 prompt.
     */
    private async resolveGaps(
        organizationId: string,
        now: Date,
    ): Promise<MemorySynthesisGaps | null> {
        if (!this.health) return null;
        const health = await this.health.tryGetOrgHealth(organizationId, { now });
        if (!health) return null;
        const unansweredQueries = health.gapTopics.map((topic) => ({
            query: topic.query,
            occurrences: topic.occurrences,
        }));
        const uncitedTitles = health.uncitedDocs.map((doc) => doc.title);
        if (unansweredQueries.length === 0 && uncitedTitles.length === 0) return null;
        return { unansweredQueries, uncitedTitles };
    }

    /** Tenant-owner lookup; `null` when the chain cannot be resolved. */
    private async resolveOwnerUserId(
        organizationId: string,
        tenantId?: string,
    ): Promise<string | null> {
        let resolvedTenantId = tenantId;
        if (!resolvedTenantId) {
            const org = await this.organizationRepository.findById(organizationId);
            resolvedTenantId = org?.tenantId;
        }
        if (!resolvedTenantId) return null;
        const tenant = await this.tenantRepository.findById(resolvedTenantId);
        return tenant?.ownerUserId ?? null;
    }

    /** Persist `lastRunAt` without clobbering the operator's settings. */
    private async stampLastRun(
        organizationId: string,
        settings: KbMemoryConsolidationSettings,
        now: Date,
    ): Promise<void> {
        try {
            await this.organizationRepository.update(organizationId, {
                memoryConsolidation: { ...settings, lastRunAt: now.toISOString() },
            });
        } catch (error) {
            // A failed stamp means the org is re-processed next tick.
            // Consolidation is idempotent (synthesis is keyed on a stable
            // path, markers are recomputed), so that is safe — log and
            // move on rather than failing the pass that already ran.
            this.logger.warn(
                `Failed to stamp memory-consolidation lastRunAt for org=${organizationId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Announce the report. Silent when the org opted out of
     * notifications, when nothing was found, or when the notification
     * service is not wired — never a hard failure.
     */
    private async notify(
        organizationId: string,
        userId: string,
        mode: KbMemoryConsolidationMode,
        report: MemoryConsolidationReport,
        now: Date,
        settings: KbMemoryConsolidationSettings,
    ): Promise<boolean> {
        if (!this.notifications) return false;
        if (settings.notify === false) return false;
        // Nothing to look at ⇒ no notification. A weekly "0 / 0 / 0"
        // ping is noise that trains people to ignore the channel.
        const findings = report.promoted + report.synthesized + report.superseded;
        if (findings === 0) return false;

        const title =
            mode === 'propose'
                ? 'Memory consolidation — new proposals to review'
                : 'Memory consolidation — preview ready';
        const message =
            `${report.promoted} promoted / ${report.synthesized} synthesized / ` +
            `${report.superseded} superseded across ${report.scanned} documents.` +
            (mode === 'propose'
                ? ' Synthesized documents are waiting in the review queue.'
                : ' Nothing was changed — open Memory to apply.');

        try {
            await this.notifications.notifyMemoryConsolidation({
                userId,
                organizationId,
                title,
                message,
                mode,
                metadata: {
                    scanned: report.scanned,
                    promoted: report.promoted,
                    synthesized: report.synthesized,
                    superseded: report.superseded,
                    dryRun: report.dryRun,
                },
                deduplicationKey: `memory_consolidation_${organizationId}_${now
                    .toISOString()
                    .slice(0, 10)}`,
            });
            return true;
        } catch (error) {
            this.logger.warn(
                `Memory consolidation notification failed for org=${organizationId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }
}

/** Effective mode — `dry-run` unless the org explicitly asked otherwise. */
export function resolveMode(
    settings: KbMemoryConsolidationSettings | null | undefined,
): KbMemoryConsolidationMode {
    return settings?.mode === 'propose' ? 'propose' : KB_MEMORY_CONSOLIDATION_DEFAULT_MODE;
}

/** Effective cadence — `weekly` unless the org explicitly asked otherwise. */
export function resolveCadence(
    settings: KbMemoryConsolidationSettings | null | undefined,
): KbMemoryConsolidationCadence {
    const cadence = settings?.cadence;
    if (cadence === 'daily' || cadence === 'weekly' || cadence === 'monthly') return cadence;
    return KB_MEMORY_CONSOLIDATION_DEFAULT_CADENCE;
}

/**
 * Has the cadence interval elapsed since `lastRunAt`?
 *
 * A missing / unparseable `lastRunAt` means "never ran" ⇒ due. A
 * FUTURE `lastRunAt` (clock skew, hand-edited settings) means not due —
 * the conservative direction, since the cost of a late pass is nil and
 * the cost of an unbounded loop of passes is real.
 */
export function isDue(
    settings: KbMemoryConsolidationSettings | null | undefined,
    now: Date,
): boolean {
    const last = settings?.lastRunAt;
    if (!last) return true;
    const lastMs = Date.parse(last);
    if (Number.isNaN(lastMs)) return true;
    const intervalMs = KB_MEMORY_CONSOLIDATION_INTERVAL_DAYS[resolveCadence(settings)] * DAY_MS;
    return now.getTime() - lastMs >= intervalMs;
}
