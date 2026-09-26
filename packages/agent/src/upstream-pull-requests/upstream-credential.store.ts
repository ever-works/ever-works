import { Injectable } from '@nestjs/common';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import type { UpstreamCredentialRecordStore } from './upstream-credential.service';

/**
 * APW-09 T43 — the **durable** credential-of-record record, on APW-02's upstream
 * state row (FR-43, XC-18).
 *
 * ## Why this file exists at all
 *
 * `UpstreamCredentialService` reads and writes the record through
 * {@link UpstreamCredentialRecordStore} and refuses by name when nothing is
 * bound (`upstream-credential.service.ts:134-146,481-488`). This is the
 * implementation that binding carries, and the row it writes is the one
 * `work_upstream_states.credentialMemberUserId` lives on: a handover therefore
 * survives the process that performed it, which is the whole difference between
 * a record and a rumour. Two members can never each believe they are the
 * credential of record, because there is exactly one column and exactly one row
 * per App Work (`uq_work_upstream_states_work`).
 *
 * ## `write` refuses rather than reporting a handover it did not record
 *
 * {@link UpstreamCredentialRecordStore.write} answers `void`, so the only way it
 * can refuse is to throw — and it does, with
 * {@link UpstreamCredentialRecordUnwrittenError}, when the App Work has no state
 * row to record the member on. That case is genuinely anomalous (APW-01 writes
 * the state row with the Work, in one transaction) and returning quietly would
 * be the failure the service's own docstring calls worse than the pause it was
 * meant to clear: a success the next background job contradicts. The throw
 * propagates through `UpstreamCredentialService.handover`, which does not catch
 * it — so a store that refuses can never be reported as a successful handover.
 *
 * `read` is the opposite posture, on purpose: `null` means "no handover has been
 * recorded", and a Work with no state row reads the same way as a Work whose
 * column is NULL. The credential of record then falls back to the Work's creator
 * — a usable answer, not an error.
 *
 * ## No cache, no memo, no second source
 *
 * Every `read` hits the row. The record is what a paused App Work is waiting to
 * change, so a cached copy would keep answering the old member after a handover
 * and after a `down()` of the migration above, which is precisely the confusion
 * the durable record exists to end. Nothing here holds a token either: the
 * column stores a member id, and the member's connection is resolved per job by
 * `UpstreamCredentialService` through the FR-24 member-token door.
 */
@Injectable()
export class UpstreamCredentialStateStore implements UpstreamCredentialRecordStore {
    constructor(private readonly states: WorkUpstreamStateRepository) {}

    /** The recorded member, or `null` when no handover has been recorded. */
    async read(workId: string): Promise<string | null> {
        return this.states.findCredentialMemberUserId(workId);
    }

    /**
     * Record `memberUserId` as the App Work's credential of record.
     *
     * @throws UpstreamCredentialRecordUnwrittenError when there is no state row
     * to record it on — never a silent success.
     */
    async write(workId: string, memberUserId: string): Promise<void> {
        const recorded = await this.states.setCredentialMemberUserId(workId, memberUserId);

        if (!recorded) {
            throw new UpstreamCredentialRecordUnwrittenError(workId, memberUserId);
        }
    }
}

/**
 * The handover could not be recorded on the row that is supposed to carry it:
 * the App Work has no `work_upstream_states` row.
 *
 * `code` is the service's own refusal name for "the record cannot be kept"
 * (`UpstreamCredentialHandoverRefusal`, `upstream-credential.service.ts:226-230`)
 * so the route can answer §4.1's body rather than a `500` shape of its own —
 * a handover that cannot be recorded is `handover_unavailable` however it
 * arrived at that.
 */
export class UpstreamCredentialRecordUnwrittenError extends Error {
    readonly code = 'handover_unavailable';

    constructor(
        readonly workId: string,
        readonly memberUserId: string,
    ) {
        super(
            `App Work ${workId} has no upstream state row: member ${memberUserId} was not recorded as its credential of record`,
        );
        this.name = 'UpstreamCredentialRecordUnwrittenError';
    }
}
