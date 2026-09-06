import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { FleetAuditAction, FleetAuditView } from '@ever-works/contracts';
import { FLEET_AUDIT_DEFAULT_LIMIT, FLEET_AUDIT_MAX_LIMIT } from '@ever-works/contracts';
import { FleetAudit } from '../entities/fleet-audit.entity';
import { redactSecrets } from '../utils/secret-scan';

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
 * A lifecycle row: the same thing plus the before/after delta every
 * per-node action records, so twenty call sites cannot each invent their
 * own key names.
 */
export interface RecordFleetNodeAuditInput {
    action: FleetAuditAction;
    actorUserId: string | null;
    ownerUserId?: string | null;
    nodeId?: string | null;
    /** State before the change (`tenant_job_runtime_audit` key naming). */
    before?: Record<string, unknown> | null;
    /** State after it. */
    after?: Record<string, unknown> | null;
    /** Anything else worth recording (counts, ids, the route that acted). */
    extra?: Record<string, unknown> | null;
}

/**
 * Keys whose VALUE is dropped outright, whatever it looks like.
 *
 * Matching on the key, not only on the value, is the important half: a
 * sha256 is not "secret-shaped" to any scanner, but a column named
 * `enrollmentTokenHash` in an audit row is still a credential artefact an
 * attacker with log access should never be handed. Substring match, so
 * `previousCredentialHash` and `nodeSecret` are covered too.
 *
 * The cost of that bluntness, and it is deliberate: an INNOCENT key that
 * merely contains one of these words also loses its value. Naming an
 * audit field after a credential column (`previousCredentialExpiresAt`)
 * therefore stores `[redacted]` and quietly throws the fact away. Name
 * the field for what it MEANS (`overlapExpiresAt`) rather than for the
 * column it came from; `redact-belt-does-not-eat-the-facts` in the spec
 * pins the ones the log actually needs.
 */
const REDACTED_KEY_RE = /secret|token|credential|password|passphrase|hash|apikey|api_key/i;

/** What a dropped value is replaced with, so the shape of the row survives. */
const REDACTED_PLACEHOLDER = '[redacted]';

/** Depth cap for the recursive scrub — details blobs are shallow by design. */
const MAX_DETAILS_DEPTH = 6;

/**
 * Panic controls (EW-778) + credential lifecycle (EW-799) — the ONE
 * writer of `fleet_audit`.
 *
 * Every recorded fleet action goes through `record()`: the four panic
 * actions (stop / clear / drain-all / cancel-in-flight) and, since
 * EW-799, every node lifecycle write — enroll, rotate, revoke, per-node
 * drain, pause, disable, delete, capability and ceiling edits, execution
 * preferences and agent-node affinity. One writer, so retention,
 * redaction and the row shape are decided once.
 *
 * ## Two entry points, two postures
 *
 * `record()` THROWS on failure and `tryRecord()` does not. That is not
 * redundancy: the choice of posture belongs to the caller, and both
 * choices exist in this codebase. For a fleet action the right posture is
 * "act first, then audit; a failed audit is logged and reported, never a
 * reason to undo a drain" — the opposite of
 * `TenantJobRuntimeService.emitAudit`, where the audited write can and
 * should be rolled back. `tryRecord` is that first posture, lifted out of
 * the two hand-rolled `tryAudit` privates it used to be duplicated in so
 * that new call sites cannot drift from it.
 *
 * ## The redaction belt
 *
 * `details` is scrubbed HERE, in the writer, rather than at each call
 * site. "An audit row can never contain a credential" is then a property
 * of one function instead of a promise made by twenty, and a future
 * call site that passes a whole entity by accident is still safe. Two
 * passes: keys that name a credential lose their value entirely, and
 * every surviving string is run through `redactSecrets` — the same
 * scanner `modelIdentity` already goes through.
 */
@Injectable()
export class FleetAuditService {
    private readonly logger = new Logger(FleetAuditService.name);

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
                details: redactAuditDetails(input.details),
            }),
        );
        return toAuditView(row);
    }

    /**
     * Record and NEVER throw: returns false when the row could not be
     * written, having logged it at error level with the action and actor.
     *
     * The caller surfaces that as `auditFailed` on its result. Bookkeeping
     * must never be the reason a stop, a drain or a rotation is undone.
     */
    async tryRecord(input: RecordFleetAuditInput): Promise<boolean> {
        try {
            await this.record(input);
            return true;
        } catch (error) {
            this.logger.error(
                `fleet audit row for ${input.action} by ${input.actorUserId ?? 'system'}${
                    input.nodeId ? ` on node ${input.nodeId}` : ''
                } could not be written: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
        }
    }

    /**
     * The lifecycle-row convenience: normalises `before` / `after` into
     * `details` under the SAME key names the kill-switch rows already use
     * (and `tenant_job_runtime_audit` before them), so the whole log reads
     * alike. Never throws — same posture as {@link tryRecord}.
     */
    async recordNodeAction(input: RecordFleetNodeAuditInput): Promise<boolean> {
        const details: Record<string, unknown> = { ...(input.extra ?? {}) };
        if (input.before !== undefined) details.before = input.before;
        if (input.after !== undefined) details.after = input.after;
        return this.tryRecord({
            action: input.action,
            actorUserId: input.actorUserId,
            ownerUserId: input.ownerUserId ?? null,
            nodeId: input.nodeId ?? null,
            details: Object.keys(details).length > 0 ? details : null,
        });
    }

    /** Newest first, every action. Bounded by `FLEET_AUDIT_MAX_LIMIT`. */
    async recent(limit: number = FLEET_AUDIT_DEFAULT_LIMIT): Promise<FleetAuditView[]> {
        const take = clampLimit(limit);
        const rows = await this.repository.find({ order: { occurredAt: 'DESC' }, take });
        return rows.map(toAuditView);
    }

    /**
     * One node's trail, newest first, scoped to its OWNER.
     *
     * Separate from {@link recent} rather than a parameter on it: `recent`
     * reads the whole table and is therefore platform-admin only, and a
     * single method whose scoping depends on which arguments happen to be
     * passed is exactly how an owner-scoped route ends up returning
     * somebody else's rows. The caller must still resolve the node through
     * an owner-scoped lookup first — this filter is the second lock, not
     * the first.
     */
    async recentForOwnerNode(
        ownerUserId: string,
        nodeId: string,
        limit: number = FLEET_AUDIT_DEFAULT_LIMIT,
    ): Promise<FleetAuditView[]> {
        const rows = await this.repository.find({
            where: { ownerUserId, nodeId },
            order: { occurredAt: 'DESC' },
            take: clampLimit(limit),
        });
        return rows.map(toAuditView);
    }
}

function clampLimit(limit: number): number {
    return Math.min(
        Math.max(Math.trunc(limit) || FLEET_AUDIT_DEFAULT_LIMIT, 1),
        FLEET_AUDIT_MAX_LIMIT,
    );
}

/**
 * Scrub a details blob before it is stored. Exported for the spec that
 * pins the belt — the belt is the reason "no audit row contains a
 * credential" is checkable rather than merely intended.
 */
export function redactAuditDetails(
    details: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
    if (!details) return null;
    return scrub(details, 0) as Record<string, unknown>;
}

function scrub(value: unknown, depth: number): unknown {
    if (depth > MAX_DETAILS_DEPTH) return REDACTED_PLACEHOLDER;
    if (typeof value === 'string') {
        // The same scanner `sanitizeModelIdentity` uses, so a token that
        // reached a details blob by any route is replaced, not stored.
        return redactSecrets(value).cleaned;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => scrub(entry, depth + 1));
    }
    if (value && typeof value === 'object') {
        // Dates and other non-plain objects are serialised by the
        // `simple-json` column anyway; normalising them here keeps the
        // scrub total instead of letting an exotic object slip past.
        if (value instanceof Date) return value.toISOString();
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            // Key-based drop FIRST: a hash is not secret-shaped to any
            // scanner, but `enrollmentTokenHash` in a log is still a
            // credential artefact.
            out[key] = REDACTED_KEY_RE.test(key)
                ? entry === null || entry === undefined
                    ? entry
                    : REDACTED_PLACEHOLDER
                : scrub(entry, depth + 1);
        }
        return out;
    }
    return value;
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
