import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type {
    FleetKillSwitchAdminState,
    FleetKillSwitchChangeResult,
    FleetKillSwitchState,
} from '@ever-works/contracts';
import { FLEET_KILL_SWITCH_REASON_MAX_LENGTH } from '@ever-works/contracts';
import type { RunKillSwitch } from '../agents/run-kill-switch';
import type { FleetKillSwitch } from '../entities/fleet-kill-switch.entity';
import { FleetAuditService } from './fleet-audit.service';
import { FleetKillSwitchRepository } from './fleet-kill-switch.repository';

/** The verdict every reader gets when the flag cannot be read. */
const UNVERIFIED_STOPPED: FleetKillSwitchAdminState = {
    stopped: true,
    reason: null,
    since: null,
    unverified: true,
    setByUserId: null,
};

/**
 * Panic controls (EW-778) — the GLOBAL STOP FLAG.
 *
 * ## The one rule: reads fail CLOSED
 *
 * `state()` never throws and never answers `stopped: false` unless it
 * has actually read a row that says so. A missing row (migration not
 * applied), a query error, a driver hiccup — every one of them yields
 * `{ stopped: true, unverified: true }`. This is stated in exactly one
 * place so the three consumers cannot drift:
 *
 *   - `RunDispatchGateService` — through the `RUN_KILL_SWITCH` port
 *     (`shouldHaltDispatch`), parks every new agent run;
 *   - `FleetRunRouterService` + the fleet-aware dispatcher — refuse to
 *     route or enqueue (never fall back to the cloud);
 *   - `FleetJobService.lease` — answers `[]` to every node.
 *
 * No cache, on purpose: the read is one primary-key lookup, and a cache
 * would be a window in which an operator's stop is ignored.
 *
 * ## What set / clear do — and do not do
 *
 * `stop()` / `clear()` flip the row and then write ONE `fleet_audit` row
 * carrying the actor. The switch flips even when the audit write fails
 * (the failure is logged and reported as `auditFailed`): bookkeeping
 * must never be the reason a stop did not land. Neither cancels running
 * work — that is `cancel-in-flight`, an explicit separate step — and
 * neither promotes parked runs itself; the API-side clear route asks the
 * gate to do that once the flip has been acknowledged.
 */
@Injectable()
export class FleetKillSwitchService implements RunKillSwitch, OnApplicationBootstrap {
    private readonly logger = new Logger(FleetKillSwitchService.name);

    constructor(
        private readonly repository: FleetKillSwitchRepository,
        private readonly audit: FleetAuditService,
    ) {}

    /**
     * Seed the global row as NOT stopped if it is missing. The migration
     * does this too; the boot-time belt covers schema-synchronised stacks
     * (the e2e harness), where no migration ever runs and a missing row
     * would fail every dispatch closed forever. Never overwrites an
     * existing row — a thrown switch survives a restart — and never
     * throws: a missing TABLE simply leaves reads fail-closed until the
     * migration lands.
     */
    async onApplicationBootstrap(): Promise<void> {
        try {
            if (await this.repository.ensureSeeded()) {
                this.logger.log('fleet_kill_switch global row seeded (not stopped)');
            }
        } catch (error) {
            this.logger.warn(
                `fleet_kill_switch could not be seeded at boot — dispatch stays refused until the migration runs: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /** Full state, actor included. Never throws — see the class docblock. */
    async state(): Promise<FleetKillSwitchAdminState> {
        let row: FleetKillSwitch | null;
        try {
            row = await this.repository.read();
        } catch (error) {
            this.logger.error(
                `fleet kill switch could not be read — refusing dispatch (fail-closed): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return { ...UNVERIFIED_STOPPED };
        }
        if (!row) {
            this.logger.error(
                'fleet_kill_switch has no global row (migration not applied?) — refusing dispatch (fail-closed)',
            );
            return { ...UNVERIFIED_STOPPED };
        }
        return {
            stopped: row.stopped === true,
            reason: row.reason ?? null,
            since: row.setAt ? new Date(row.setAt).toISOString() : null,
            unverified: false,
            setByUserId: row.setByUserId ?? null,
        };
    }

    /** The state as any signed-in user may see it — the actor is not leaked. */
    async publicState(): Promise<FleetKillSwitchState> {
        const { stopped, reason, since, unverified } = await this.state();
        return { stopped, reason, since, unverified };
    }

    /** True when no new work may start: the flag is set OR could not be read. */
    async isStopped(): Promise<boolean> {
        return (await this.state()).stopped;
    }

    /** `RunKillSwitch` port — the dispatch gate's question. */
    async shouldHaltDispatch(): Promise<boolean> {
        return this.isStopped();
    }

    /**
     * Throw the switch. Idempotent: stopping an already-stopped fleet
     * refreshes the reason and the actor (a second operator adding
     * context) and records `changed: false`.
     */
    async stop(actorUserId: string, reason?: string | null): Promise<FleetKillSwitchChangeResult> {
        const before = await this.state();
        const now = new Date();
        const cleanReason = normalizeReason(reason);
        await this.repository.write({
            stopped: true,
            reason: cleanReason,
            setByUserId: actorUserId,
            setAt: now,
        });
        const after: FleetKillSwitchAdminState = {
            stopped: true,
            reason: cleanReason,
            since: now.toISOString(),
            unverified: false,
            setByUserId: actorUserId,
        };
        const changed = before.unverified || !before.stopped;
        this.logger.warn(
            `fleet kill switch SET by ${actorUserId}${cleanReason ? ` — ${cleanReason}` : ''} (changed=${changed})`,
        );
        const auditFailed = !(await this.tryAudit('kill-switch.stop', actorUserId, {
            reason: cleanReason,
            changed,
            before: snapshot(before),
            after: snapshot(after),
        }));
        return { state: after, changed, auditFailed };
    }

    /** Clear the switch. Idempotent; records `changed: false` when it was already clear. */
    async clear(actorUserId: string): Promise<FleetKillSwitchChangeResult> {
        const before = await this.state();
        const now = new Date();
        await this.repository.write({
            stopped: false,
            reason: null,
            setByUserId: actorUserId,
            setAt: now,
        });
        const after: FleetKillSwitchAdminState = {
            stopped: false,
            reason: null,
            since: now.toISOString(),
            unverified: false,
            setByUserId: actorUserId,
        };
        const changed = before.unverified || before.stopped;
        this.logger.warn(`fleet kill switch CLEARED by ${actorUserId} (changed=${changed})`);
        const auditFailed = !(await this.tryAudit('kill-switch.clear', actorUserId, {
            changed,
            before: snapshot(before),
            after: snapshot(after),
        }));
        return { state: after, changed, auditFailed };
    }

    /** Audit after the flip; a failure is logged and reported, never thrown. */
    private async tryAudit(
        action: 'kill-switch.stop' | 'kill-switch.clear',
        actorUserId: string,
        details: Record<string, unknown>,
    ): Promise<boolean> {
        try {
            await this.audit.record({ action, actorUserId, ownerUserId: null, details });
            return true;
        } catch (error) {
            this.logger.error(
                `fleet audit row for ${action} by ${actorUserId} could not be written: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }
}

function normalizeReason(reason: string | null | undefined): string | null {
    if (typeof reason !== 'string') return null;
    const trimmed = reason.trim();
    if (!trimmed) return null;
    return trimmed.length > FLEET_KILL_SWITCH_REASON_MAX_LENGTH
        ? trimmed.slice(0, FLEET_KILL_SWITCH_REASON_MAX_LENGTH)
        : trimmed;
}

function snapshot(state: FleetKillSwitchAdminState): Record<string, unknown> {
    return {
        stopped: state.stopped,
        reason: state.reason,
        since: state.since,
        unverified: state.unverified,
        setByUserId: state.setByUserId,
    };
}
