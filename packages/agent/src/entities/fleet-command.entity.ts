import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { FleetCommandRequester, FleetCommandState } from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Commands on computers (FL-12, CONTRACTS §4.4, R-2, R-11) — one command line
 * sent to one or more computers. Each computer's execution is a
 * `FleetCommandRun` (`fleet_command_runs`).
 *
 * A one-off Command (`cadence` null) is IMMEDIATE: delivered over the node
 * link, never queued (R-11). A Command with a `cadence` is a Schedule, which
 * FL-13 owns; this table already carries `cadence`, `name`, `enabled`,
 * `lastRunAt` and `nextRunAt` so FL-13 adds Schedules without a second table
 * (FL-13's slot `1796130000000` adds `pausedAt`, `pausedReason`,
 * `syncGeneration`, `syncedGeneration` and `deletedAt`).
 *
 * `command` is stored REDACTED when the platform's secret scanner trips on it
 * (spec FR-13); the node received the line as typed. Which Agent asked for an
 * Agent-requested Command is in its audit rows (`requestedBy: agent:<id>`),
 * not here (§4.4 has no Agent column).
 *
 * Written ONLY by `FleetCommandService`. Raw uuid columns (no `@ManyToOne`);
 * the `userId` foreign key lives in the migration
 * (`1796120000000-CreateFleetCommands`). Registered in
 * `database/_entities-inventory.ts` and `_entity-names.ts`.
 */
@Entity({ name: 'fleet_commands' })
@Index('idx_fleet_commands_user_created', ['userId', 'createdAt'])
@Index('idx_fleet_commands_user_state', ['userId', 'state'])
export class FleetCommand {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The person who asked (an Agent's owner when an Agent asked). Set at creation. */
    @Column({ type: 'uuid' })
    userId: string;

    /** The computers asked for, in the order asked (`simple-json` text, CONTRACTS §4 storage types). */
    @Column({ type: 'simple-json' })
    nodeIds: string[];

    /** The command line (redacted when it tripped the secret scanner). Set at creation. */
    @Column({ type: 'text' })
    command: string;

    /** True when `command` was redacted before it was written. */
    @Column({ type: 'boolean', default: false })
    commandRedacted: boolean;

    /** The folder asked for; null = the machine owner's home. */
    @Column({ type: 'text', nullable: true })
    cwd?: string | null;

    /** 1–3600, default 600 (CONTRACTS §10). */
    @Column({ type: 'int', default: 600 })
    timeoutSec: number;

    /** Schedules only (FL-13): `{ kind, expr, at, timezone: 'node' }`. Always null in FL-12. */
    @Column({ type: 'simple-json', nullable: true })
    cadence?: Record<string, unknown> | null;

    /** Schedules only (FL-13). */
    @Column({ type: 'text', nullable: true })
    name?: string | null;

    /** Schedules only (FL-13). */
    @Column({ type: 'boolean', default: true })
    enabled: boolean;

    /** `user` | `agent`. Set at creation. */
    @Column({ type: 'varchar', length: 8, default: 'user' })
    requestedBy: FleetCommandRequester;

    /** `queued · running · done · failed · cancelled` (one-off Commands). */
    @Column({ type: 'varchar', length: 16, default: 'queued' })
    state: FleetCommandState;

    /** When it last ran (a one-off: when it was sent). */
    @PortableDateColumn({ nullable: true })
    lastRunAt?: Date | null;

    /** Schedules only (FL-13). */
    @PortableDateColumn({ nullable: true })
    nextRunAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
