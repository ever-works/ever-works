import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FLEET_KILL_SWITCH_ID } from '@ever-works/contracts';
import { FleetKillSwitch } from '../entities/fleet-kill-switch.entity';

/** The columns a flip writes. Everything else on the row is bookkeeping. */
export interface FleetKillSwitchWrite {
    stopped: boolean;
    reason: string | null;
    setByUserId: string | null;
    setAt: Date;
}

/**
 * Panic controls (EW-778) — feature-owned repository over the one-row
 * `fleet_kill_switch` table (provided by `FleetModule`, not
 * `DatabaseModule` — same split as `FleetJobRepository`).
 *
 * Deliberately NO cache: a cached read is a window in which the switch
 * is ignored, and the read is a single primary-key lookup. `read()` is
 * allowed to throw — `FleetKillSwitchService` is the one place that
 * turns a failure into the fail-closed verdict.
 */
@Injectable()
export class FleetKillSwitchRepository {
    constructor(
        @InjectRepository(FleetKillSwitch)
        private readonly repository: Repository<FleetKillSwitch>,
    ) {}

    /** The global row, or null when the migration that seeds it has not run. */
    async read(): Promise<FleetKillSwitch | null> {
        return this.repository.findOne({ where: { id: FLEET_KILL_SWITCH_ID } });
    }

    /**
     * Insert the global row as NOT stopped when it is missing; leave an
     * existing row alone. The migration seeds it too — this is the boot-
     * time belt for stacks whose schema is synchronised rather than
     * migrated (the e2e harness), where a missing row would otherwise
     * fail every dispatch closed forever. Throws when the table itself
     * is missing; the caller logs and reads stay fail-closed.
     */
    async ensureSeeded(): Promise<boolean> {
        const existing = await this.read();
        if (existing) return false;
        await this.repository.insert({
            id: FLEET_KILL_SWITCH_ID,
            stopped: false,
            reason: null,
            setByUserId: null,
            setAt: null,
        });
        return true;
    }

    /**
     * Flip the switch. Updates the seeded row; inserts it only when it is
     * missing (an unmigrated database being operated by hand), so a
     * stop always lands even in that degraded state.
     */
    async write(patch: FleetKillSwitchWrite): Promise<void> {
        const result = await this.repository.update({ id: FLEET_KILL_SWITCH_ID }, patch);
        if ((result.affected ?? 0) === 0) {
            await this.repository.insert({ id: FLEET_KILL_SWITCH_ID, ...patch });
        }
    }
}
