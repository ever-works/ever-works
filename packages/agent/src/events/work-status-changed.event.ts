import { BaseEvent } from './base';
import type { WorkKind, WorkStatus } from '@src/entities/work.entity';

/**
 * EW-665 (Tenants & Organizations Phase 13) — emitted by
 * `WorkLifecycleService.transitionStatus` whenever a Work's lifecycle
 * `status` actually changes (a no-op transition to the same status does
 * NOT emit).
 *
 * The primary consumer is the API-layer `WorkRegisteredListener`, which
 * spawns a backing `Organization` when a `kind === 'company'` Work
 * transitions into `'registered'` (see
 * [spec.md §5.4](../../../../docs/specs/features/tenants-and-organizations/spec.md#54-user-registers-a-company-via-a-work-of-type-company)).
 *
 * The payload carries enough to make the listener's decision WITHOUT a
 * DB read (`kind`, `previousStatus`, `newStatus`) but the listener still
 * re-loads the full Work by `workId` when it needs the company
 * name/website for Org creation — the event is intentionally lean so it
 * stays cheap to emit and serialise.
 */
export class WorkStatusChangedEvent extends BaseEvent {
    static EVENT_NAME = 'work.status.changed';

    constructor(
        public readonly workId: string,
        public readonly userId: string,
        public readonly kind: WorkKind,
        public readonly previousStatus: WorkStatus,
        public readonly newStatus: WorkStatus,
    ) {
        super();
    }
}
