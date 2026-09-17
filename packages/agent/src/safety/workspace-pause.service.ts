import { Injectable, Logger } from '@nestjs/common';
import {
    WORKSPACE_PAUSE_REASON_MAX,
    WORKSPACE_PAUSED_UNVERIFIED,
    WORKSPACE_RUNNING,
    type WorkspacePauseState,
} from '@ever-works/contracts';
import { WorkspacePauseRepository, type WorkspaceRef } from './workspace-pause.repository';

/**
 * Safety rails (AW-24) — the owner's stop, read and written.
 *
 * ## The one rule: reads fail CLOSED
 *
 * `state()` never throws and never answers `paused: false` unless it has
 * actually completed a read that says so. A missing table (migration not
 * applied), a query error, a driver hiccup — every one of them yields
 * `{ paused: true, unverified: true }`. This is stated in exactly one place,
 * mirroring `FleetKillSwitchService.state()`, so the consumers cannot drift.
 *
 * ## What pause and resume do — and do not do
 *
 * Pausing refuses STARTS. It does not cancel work already running: an
 * executing run stops cleanly at its next tool boundary with its state
 * preserved, and killing it is a second, separately confirmed action (FR-43,
 * FR-45). Resuming is a human action and only a human action (FR-47) — the
 * human-actor guard is what enforces that, before anything reaches here.
 *
 * P1 ships the row, the read and the write. P3 wires the remaining start
 * points and the resume fan-out.
 */
@Injectable()
export class WorkspacePauseService {
    private readonly logger = new Logger(WorkspacePauseService.name);

    constructor(private readonly repository: WorkspacePauseRepository) {}

    /** Full state. Never throws — see the class docblock. */
    async state(ref: WorkspaceRef | null | undefined): Promise<WorkspacePauseState> {
        if (!ref?.tenantId) {
            // No workspace to be paused. This is the pre-tenant path (an
            // account that has not been upgraded), not a read failure, so it
            // is running rather than fail-closed: refusing here would stop
            // every action for every such account.
            return { ...WORKSPACE_RUNNING };
        }
        try {
            const row = await this.repository.find(ref);
            if (!row) return { ...WORKSPACE_RUNNING };
            return {
                paused: true,
                unverified: false,
                reason: row.reason ?? null,
                pausedByUserId: row.pausedByUserId ?? null,
                pausedAt: row.pausedAt ? new Date(row.pausedAt).toISOString() : null,
                refusedStarts: row.refusedStarts ?? 0,
                cleanlyStopped: row.cleanlyStopped ?? 0,
            };
        } catch (error) {
            this.logger.error(
                `Workspace pause could not be read for tenant ${ref.tenantId} — treating the ` +
                    `workspace as paused (fail-closed): ${
                        error instanceof Error ? error.message : String(error)
                    }`,
            );
            return { ...WORKSPACE_PAUSED_UNVERIFIED };
        }
    }

    /** True when no new work may start: the row exists OR could not be read. */
    async isPaused(ref: WorkspaceRef | null | undefined): Promise<boolean> {
        return (await this.state(ref)).paused;
    }

    /**
     * Stop the workspace. Idempotent: pausing an already-paused workspace
     * refreshes the reason and the actor and reports `changed: false`.
     */
    async pause(
        ref: WorkspaceRef,
        actorUserId: string,
        ownerUserId: string,
        reason?: string | null,
    ): Promise<{ state: WorkspacePauseState; changed: boolean }> {
        const before = await this.state(ref);
        await this.repository.pause({
            tenantId: ref.tenantId,
            organizationId: ref.organizationId ?? null,
            userId: ownerUserId,
            pausedByUserId: actorUserId,
            reason: normalizeReason(reason),
        });
        const after = await this.state(ref);
        const changed = before.unverified || !before.paused;
        this.logger.warn(
            `Workspace ${ref.tenantId}/${ref.organizationId ?? '-'} PAUSED by ${actorUserId}` +
                `${after.reason ? ` — ${after.reason}` : ''} (changed=${changed})`,
        );
        return { state: after, changed };
    }

    /** Resume. Idempotent; reports `changed: false` when it was already running. */
    async resume(
        ref: WorkspaceRef,
        actorUserId: string,
    ): Promise<{ state: WorkspacePauseState; changed: boolean }> {
        const changed = await this.repository.resume(ref);
        this.logger.warn(
            `Workspace ${ref.tenantId}/${ref.organizationId ?? '-'} RESUMED by ${actorUserId} ` +
                `(changed=${changed})`,
        );
        return { state: { ...WORKSPACE_RUNNING }, changed };
    }

    /**
     * Count one refused start against the live pause.
     *
     * Best-effort by contract: the banner's number is bookkeeping, and a
     * failed increment must never be the reason a refusal did not land.
     */
    async countRefusedStart(ref: WorkspaceRef): Promise<void> {
        try {
            await this.repository.countRefusedStart(ref);
        } catch (error) {
            this.logger.warn(
                `Workspace pause counter could not be incremented for tenant ${ref.tenantId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

function normalizeReason(reason: string | null | undefined): string | null {
    if (typeof reason !== 'string') return null;
    const trimmed = reason.trim();
    if (!trimmed) return null;
    return trimmed.length > WORKSPACE_PAUSE_REASON_MAX
        ? trimmed.slice(0, WORKSPACE_PAUSE_REASON_MAX)
        : trimmed;
}
