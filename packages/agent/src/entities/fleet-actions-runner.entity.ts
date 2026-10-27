import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type {
    FleetActionsRunnerCurrentJob,
    FleetActionsRunnerMode,
    FleetActionsRunnerPhase,
    FleetActionsRunnerScope,
    FleetActionsRunnerState,
    FleetActionsRunnerStateSource,
} from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Actions runners on computers (FL-18, CONTRACTS §4.11) — one GitHub Actions
 * self-hosted runner registered on one Node of the Fleet.
 *
 * Contract columns (CONTRACTS §4.11): `nodeId`, `name`, `scope`, `target`,
 * `labels`, `mode`, `state`, `githubRunnerId`, `lastSeenAt`, `installedAt`,
 * `ownerUserId`. The rest are epic-local (plan §4.1): which GitHub App
 * installation registered it, its version, service unit and folder, where its
 * state came from, whether a person stopped it, the install's phase, the job
 * it is on, the last failure line, and the soft-remove instant.
 *
 * `labels` holds the EXTRA labels only (GitHub adds `self-hosted`, the OS and
 * the architecture itself) as `simple-json` text — the storage type CONTRACTS
 * §4 fixes for structured values, so the same entity runs on Postgres and on
 * the better-sqlite3 test stack. Enums are `varchar` validated in code.
 *
 * Never a token: the registration and remove tokens exist in memory for one
 * response and one child environment (spec FR-7).
 *
 * Written ONLY by `FleetActionsRunnersService`. Raw uuid columns (no
 * `@ManyToOne`, the house rule); the foreign keys live in the migration
 * (`1796180000000-CreateFleetActionsRunners`). Registered in
 * `database/_entities-inventory.ts` and `_entity-names.ts`.
 */
@Entity({ name: 'fleet_actions_runners' })
@Index('idx_fleet_actions_runners_node', ['nodeId'])
@Index('idx_fleet_actions_runners_owner_state', ['ownerUserId', 'state'])
@Index('idx_fleet_actions_runners_installation', ['installationEntityId'])
// Unique among the rows still on the computer: a removed runner's name may be used again.
@Index('uq_fleet_actions_runners_node_name', ['nodeId', 'name'], {
    unique: true,
    where: '"removedAt" IS NULL',
})
export class FleetActionsRunner {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The computer the runner lives on. */
    @Column({ type: 'uuid' })
    nodeId: string;

    /** The computer's owner (CONTRACTS §4.11 `ownerUserId`). */
    @Column({ type: 'uuid' })
    ownerUserId: string;

    /** The computer's Organization, when it is shared through one. */
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** The `github_app_installations` row that registered it (the token minter's installation). */
    @Column({ type: 'uuid', nullable: true })
    installationEntityId?: string | null;

    /** `org` · `repo`. */
    @Column({ type: 'varchar', length: 8 })
    scope: FleetActionsRunnerScope;

    /** `owner/repo` or `org`. */
    @Column({ type: 'varchar', length: 200 })
    target: string;

    /** The runner's name at GitHub; unique per computer among the rows not removed. */
    @Column({ type: 'varchar', length: 64 })
    name: string;

    /** The extra labels the owner chose. */
    @Column({ type: 'simple-json' })
    labels: string[];

    /** `service` · `docker`. */
    @Column({ type: 'varchar', length: 16, default: 'service' })
    mode: FleetActionsRunnerMode;

    /** CONTRACTS §4.11: `installing · idle · working · offline · stopped · failed · removed · unknown`. */
    @Column({ type: 'varchar', length: 16, default: 'installing' })
    state: FleetActionsRunnerState;

    /** `github` · `node` — who said `state` last (GitHub wins when fresh, FR-13). */
    @Column({ type: 'varchar', length: 8, nullable: true })
    stateSource?: FleetActionsRunnerStateSource | null;

    /** True while a person (or an approved Agent act) stopped it: suppresses `runner-stopped` (FR-19). */
    @Column({ type: 'boolean', default: false })
    stoppedByOwner: boolean;

    /** The install's phase while `installing` (FR-11). */
    @Column({ type: 'varchar', length: 24, nullable: true })
    phase?: FleetActionsRunnerPhase | null;

    /** GitHub's runner id, once registered. */
    @Column({ type: 'bigint', nullable: true })
    githubRunnerId?: string | number | null;

    /** The runner build, e.g. `2.321.0`. */
    @Column({ type: 'varchar', length: 32, nullable: true })
    runnerVersion?: string | null;

    /** The unit / label / service name on the computer. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    serviceUnit?: string | null;

    /** The folder, relative to the node's runners folder (its name). */
    @Column({ type: 'varchar', length: 400 })
    installDir: string;

    /** The job it is on while `working`. */
    @Column({ type: 'simple-json', nullable: true })
    currentJob?: FleetActionsRunnerCurrentJob | null;

    /** A hint line only — the first line of a failure, or the discrepancy of `unknown` (FR-17). */
    @Column({ type: 'varchar', length: 512, nullable: true })
    lastError?: string | null;

    /** The durable job that installs it (or last controlled it). */
    @Column({ type: 'uuid', nullable: true })
    lastJobId?: string | null;

    /** Last time GitHub listed it online, or the node said its service ran. */
    @PortableDateColumn({ nullable: true })
    lastSeenAt?: Date | null;

    /** Last time anything was read about it (GitHub or the node). */
    @PortableDateColumn({ nullable: true })
    lastCheckAt?: Date | null;

    /** When its registration completed; null while installing. */
    @PortableDateColumn({ nullable: true })
    installedAt?: Date | null;

    /** Soft remove (`state: removed`): the row stays 30 days for the audit trail and is never listed. */
    @PortableDateColumn({ nullable: true })
    removedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
