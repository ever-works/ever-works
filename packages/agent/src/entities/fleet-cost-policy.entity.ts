import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Fleet cost accounting (EW-777) — the owner's FLEET-WIDE daily model-spend
 * ceiling: every enrolled node of the account, summed per UTC day.
 *
 * One row per owner. `dailyCeilingCents` NULL means "inherit the deployment
 * default" (`FLEET_DAILY_COST_CEILING_USD`, itself unset by default = no
 * ceiling), so a row can exist purely to carry `trippedOn`.
 *
 * `trippedOn` is the ONE-NOTICE key for the fleet-wide trip, exactly as
 * `fleet_nodes.dailyCostTrippedOn` is for the per-node one: the trip is a
 * CAS on it (`FleetCostPolicyRepository.casTrip`), so however many
 * completions cross the ceiling on one day, exactly one files the Inbox
 * notice. Draining is repeated on every crossing — a ceiling is a stop, not
 * a rate limit — and every node stays `disabled` until the owner re-enables
 * it. Cleared whenever the owner changes the ceiling
 * (`FleetCostPolicyRepository.upsertCeiling`): the next crossing of a NEW
 * ceiling is news again.
 *
 * The ceiling sums `fleet_jobs.costCents` ONLY — spend the owner's own
 * machines reported — never the account's cloud spend or BYOK usage rows.
 * Those have their own budgets (`agent_budgets`, `work_budgets`); folding
 * them in here would make one ceiling drain a fleet for money spent
 * elsewhere.
 *
 * `userId` is a raw uuid reference (no @ManyToOne) per the EW-654
 * cycle-avoidance rule; the FK to `users` lives in the migration
 * (`1788300000000-AddFleetCostAccounting`).
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this repo
 * has no `autoLoadEntities`, so a forFeature'd-but-unregistered entity
 * throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'fleet_cost_policies' })
@Index('uq_fleet_cost_policies_user', ['userId'], { unique: true })
export class FleetCostPolicy {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Owner the policy belongs to (scopes every read and write). */
    @Column({ type: 'uuid' })
    userId: string;

    /** Owner-set ceiling in cents; NULL = inherit the deployment default. */
    @Column({ type: 'int', nullable: true })
    dailyCeilingCents?: number | null;

    /** UTC day (`YYYY-MM-DD`) the fleet was last drained by this ceiling. */
    @Column({ type: 'varchar', length: 10, nullable: true })
    trippedOn?: string | null;

    /** When that drain happened — for the operator, `trippedOn` is the key. */
    @PortableDateColumn({ nullable: true })
    trippedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
