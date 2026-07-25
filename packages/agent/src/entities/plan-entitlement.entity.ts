import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Plan entitlements (pricing Wave 9 M1) — per-plan feature/limit values
 * as key/value rows, additive to the columns already on
 * `subscription_plans` (maxWorks, allowedCadences, …). New Wave 9
 * levers (daily free credits, concurrency, retention, …) land here
 * WITHOUT a schema change per lever.
 *
 * `planId` is the plan CODE (`subscription_plans.code`: 'free' /
 * 'standard' / 'premium' / …), NOT the plan row uuid — plans are
 * seeded at boot by `SubscriptionService.seedPlans()` AFTER migrations
 * run, so the seed migration can only reference the stable code.
 *
 * Read through `EntitlementsService.get(planId, key, fallback)` (in-
 * memory TTL cache). A key stores EITHER `valueInt` OR `valueText`;
 * `UNIQUE(planId, key)` keeps one value per plan per lever.
 *
 * Seeded keys (free plan, `1783400000000` migration, INSERT-if-missing):
 *   - `daily-free-credits`  (default 50, env CREDITS_DAILY_FREE)
 *   - `max-concurrent-runs` (default 3 — the D5 safety-valve posture)
 *   - `works-limit`         (default 1 — mirrors FREE `maxWorks`)
 *
 * NOTE: also registered in `database/_entities-inventory.ts` — this
 * repo has no `autoLoadEntities`; a forFeature'd-but-unregistered
 * entity throws EntityMetadataNotFoundError on first query.
 */
@Entity({ name: 'plan_entitlements' })
@Index('idx_plan_entitlements_plan_key', ['planId', 'key'], { unique: true })
export class PlanEntitlement {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** Plan code (`subscription_plans.code`), e.g. 'free'. */
    @Column({ type: 'varchar', length: 64 })
    planId: string;

    /** Entitlement lever, e.g. 'daily-free-credits'. */
    @Column({ type: 'varchar', length: 64 })
    key: string;

    @Column({ type: 'int', nullable: true })
    valueInt?: number | null;

    @Column({ type: 'varchar', length: 128, nullable: true })
    valueText?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
