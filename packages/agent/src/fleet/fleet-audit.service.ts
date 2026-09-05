import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { FleetAuditAction, FleetAuditView } from '@ever-works/contracts';
import { FLEET_AUDIT_DEFAULT_LIMIT, FLEET_AUDIT_MAX_LIMIT } from '@ever-works/contracts';
import { FleetAudit } from '../entities/fleet-audit.entity';

export interface RecordFleetAuditInput {
    action: FleetAuditAction;
    /** Who did it. NULL = system. */
    actorUserId: string | null;
    /** Owner scope of an owner action; NULL for global actions. */
    ownerUserId?: string | null;
    /** Per-node rows only. */
    nodeId?: string | null;
    details?: Record<string, unknown> | null;
}

/**
 * Panic controls (EW-778) — the ONE writer of `fleet_audit`.
 *
 * Every panic action (stop / clear / drain-all / cancel-in-flight) goes
 * through `record()`, so slice AQ extends one place when it adds
 * per-node rows and retention.
 *
 * Failures are NOT swallowed here: the caller decides. For a panic
 * action the right posture is "act first, then audit; a failed audit is
 * logged and reported, never a reason to undo a drain" — the opposite of
 * `TenantJobRuntimeService.emitAudit`, where the audited write can and
 * should be rolled back. That choice belongs to the caller, not to this
 * service.
 */
@Injectable()
export class FleetAuditService {
    constructor(
        @InjectRepository(FleetAudit)
        private readonly repository: Repository<FleetAudit>,
    ) {}

    async record(input: RecordFleetAuditInput): Promise<FleetAuditView> {
        const row = await this.repository.save(
            this.repository.create({
                action: input.action,
                actorUserId: input.actorUserId ?? null,
                ownerUserId: input.ownerUserId ?? null,
                nodeId: input.nodeId ?? null,
                details: input.details ?? null,
            }),
        );
        return toAuditView(row);
    }

    /** Newest first, every action. Bounded by `FLEET_AUDIT_MAX_LIMIT`. */
    async recent(limit: number = FLEET_AUDIT_DEFAULT_LIMIT): Promise<FleetAuditView[]> {
        const take = Math.min(
            Math.max(Math.trunc(limit) || FLEET_AUDIT_DEFAULT_LIMIT, 1),
            FLEET_AUDIT_MAX_LIMIT,
        );
        const rows = await this.repository.find({ order: { occurredAt: 'DESC' }, take });
        return rows.map(toAuditView);
    }
}

export function toAuditView(row: FleetAudit): FleetAuditView {
    return {
        id: row.id,
        action: row.action,
        actorUserId: row.actorUserId ?? null,
        ownerUserId: row.ownerUserId ?? null,
        nodeId: row.nodeId ?? null,
        details: row.details ?? null,
        occurredAt: row.occurredAt ? new Date(row.occurredAt).toISOString() : null,
    };
}
