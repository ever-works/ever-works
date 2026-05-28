import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WorkStatusChangedEvent } from '@ever-works/agent/events';
import { WorkRepository } from '@ever-works/agent/database';
import { OrganizationService } from './organization.service';

/**
 * EW-665 (Tenants & Organizations Phase 13) — turns a Company Work's
 * `→ registered` lifecycle transition into a backing `Organization`
 * ([spec.md §5.4](../../../docs/specs/features/tenants-and-organizations/spec.md#54-user-registers-a-company-via-a-work-of-type-company)).
 *
 * Listens for `work.status.changed` (emitted by
 * `WorkLifecycleService.transitionStatus`). Acts ONLY when:
 *   - `kind === 'company'` — plain Works never spawn an Org; AND
 *   - `newStatus === 'registered'` — the inflection point; AND
 *   - `previousStatus !== 'registered'` — guards against a double-fire
 *     re-entering on an already-registered Work.
 *
 * On a match it re-loads the full Work (the event payload is lean and
 * doesn't carry the company name/website) and calls
 * `OrganizationService.createOrganizationFromCompanyWork`, which is
 * itself idempotent on `linkedWorkId` — so even if this listener fires
 * twice, at most one Org is created per Work.
 *
 * **Errors are swallowed + logged, never rethrown.** Event handlers run
 * detached from the request that triggered the transition; a throw here
 * would surface as an unhandled rejection (and on `emitAsync` could fail
 * the caller). The status transition itself already succeeded and is the
 * source of truth — Org creation is a best-effort downstream effect that
 * a retry / manual re-transition can recover.
 */
@Injectable()
export class WorkRegisteredListener {
    private readonly logger = new Logger(WorkRegisteredListener.name);

    constructor(
        private readonly organizationService: OrganizationService,
        private readonly workRepository: WorkRepository,
    ) {}

    @OnEvent(WorkStatusChangedEvent.EVENT_NAME)
    async onWorkStatusChanged(event: WorkStatusChangedEvent): Promise<void> {
        // Cheap synchronous gate before any DB work.
        if (
            event.kind !== 'company' ||
            event.newStatus !== 'registered' ||
            event.previousStatus === 'registered'
        ) {
            return;
        }

        try {
            const work = await this.workRepository.findById(event.workId);
            if (!work) {
                this.logger.warn(
                    `work.status.changed for ${event.workId} → registered but Work no longer exists; skipping Org create`,
                );
                return;
            }

            const org = await this.organizationService.createOrganizationFromCompanyWork(
                event.userId,
                {
                    id: work.id,
                    name: work.name,
                    companyName: work.companyName ?? null,
                    companyWebsite: work.companyWebsite ?? null,
                },
            );

            this.logger.log(
                `Company Work ${work.id} registered → Organization ${org.id} (slug=${org.slug})`,
            );
        } catch (error) {
            // Detached handler — must not crash the originating request /
            // bubble as an unhandled rejection. Log + move on.
            this.logger.error(
                `Failed to create Organization from registered Company Work ${event.workId}: ${
                    (error as Error)?.message ?? error
                }`,
                (error as Error)?.stack,
            );
        }
    }
}
