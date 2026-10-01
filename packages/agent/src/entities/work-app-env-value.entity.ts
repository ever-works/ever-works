import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { AppEnvStoredOrigin } from '@ever-works/contracts';
import { Work } from './work.entity';
import { ClassToObject } from './types';
import { TimestampColumn } from './_types';

/**
 * APW-07 (App env & dependencies) — one stored Environment value of one App
 * Work.
 *
 * Spec: `docs/specs/features/app-works/APW-07-app-env-and-dependencies/spec.md`
 * (FR-1…FR-34). Plan: `…/plan.md` §3.1 (`plan.md:176-193`) is the normative
 * column list — this file implements it column for column, with the two index
 * names the plan fixes at `plan.md:191-192`. Migration:
 * `apps/api/src/migrations/1792070000000-CreateAppEnvAndDependencies.ts` (T7).
 * Repository: `…/database/repositories/work-app-env-value.repository.ts` (T8).
 *
 * ## The value is never stored in the clear (FR-5)
 *
 * `valueEncrypted` holds the `enc::v1::` envelope `AppEnvCrypto` writes, and
 * the column is NOT NULL: a row without one is a row whose value nobody can
 * read, and the plan does not allow one. Nothing else on the row carries the
 * value — `valueBytes` is a length, `generatorFingerprint` is the canonical
 * generate block, and no API response, log, Activity entry or telemetry event
 * ever gets either the envelope or its plaintext (plan §3.3:234-235).
 *
 * ## One row per name per App Work
 *
 * `uq_work_app_env_values_work_name (workId, name)` is what makes that true at
 * the database, so the race-safe generation of `plan.md:195-200` has
 * something real to lose: `INSERT … ON CONFLICT DO NOTHING` then read back,
 * and the loser of the race reads the WINNER's envelope (ACC-07-02). Deleting
 * the Work takes every row with it (`workId → works(id) ON DELETE CASCADE`) —
 * a value has no meaning without the App Work whose app reads it.
 *
 * ## Every timestamp is a `TimestampColumn` (bigint epoch ms)
 *
 * Exactly as `WorkUpstreamState` and `WorkDeployment` do, and as APW-06's
 * APW06-G16 records for the same reason: a raw `timestamp` column is
 * `timestamptz` on Postgres and has no equivalent at all on better-sqlite3 —
 * the default `DATABASE_TYPE`, the CI driver and the whole e2e stack — so a
 * portable comparison (`version`/`updatedAt`/`generatedAt` reads and the
 * "changed since the last build" maths of plan §2.2) has to be numeric. The
 * transformer turns the stored epoch back into a `Date` on read.
 *
 * ## Closed sets come from `@ever-works/contracts`
 *
 * `origin` is typed by `AppEnvStoredOrigin` (APW-07 T1,
 * `packages/contracts/src/apps/app-env.ts`), which is exactly the four members
 * `plan.md:182` allows a stored row to carry — `default` is deliberately NOT
 * one of them: an entry that follows the App spec unchanged has no row at all.
 *
 * ## Scope columns, and why they carry no relation
 *
 * `tenantId` / `organizationId` are plain nullable uuids with no `@ManyToOne`,
 * for the reason `WorkDeployment` records at `:89-94` (EW-654/EW-655): a
 * relation here drags the Tenant/Organization entity graph into the decorator
 * evaluation of the whole inventory. `setByUserId` is a bare uuid for the same
 * class of reason — deleting a person must not cascade a generated secret
 * away.
 *
 * ## R-25 (workspace backup)
 *
 * Exported as `data/works/app-env-values.jsonl` through the parent Work ids,
 * with `valueEncrypted` redacted to `{ wasSet }` and `valueBytes` dropped
 * (`plan.md:174`, T45).
 */
@Entity({ name: 'work_app_env_values' })
@Index('uq_work_app_env_values_work_name', ['workId', 'name'], { unique: true })
@Index('idx_work_app_env_values_work', ['workId'])
export class WorkAppEnvValue {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The App Work whose app reads this value. */
    @Column({ type: 'uuid' })
    workId: string;

    /** One row per (Work, name) — the unique index above enforces it. */
    @ManyToOne(() => Work, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'workId' })
    work?: ClassToObject<Work>;

    /**
     * The env name, `^[A-Z_][A-Z0-9_]{0,127}$` (`APP_ENV_NAME_PATTERN`, FR-18).
     * 128 characters is the plan's width and the pattern's maximum.
     */
    @Column({ type: 'varchar', length: 128 })
    name: string;

    /**
     * `generated` · `prompted` · `user` · `derived` — where the stored value
     * came from (`APP_ENV_STORED_ORIGINS`, `plan.md:182`). A keypair's public
     * half is the only `derived` row.
     */
    @Column({ type: 'varchar', length: 16 })
    origin: AppEnvStoredOrigin;

    /**
     * The `enc::v1::` envelope — the value, encrypted at rest, and the only
     * place it exists. NOT NULL by the plan; the repository's per-Work read
     * deliberately does not select it.
     */
    @Column({ type: 'text' })
    valueEncrypted: string;

    /**
     * The plaintext's byte length, measured when it was stored. FR-31's 1 MiB
     * per-App-Work ceiling is a SUM over this column, and it is never shown.
     */
    @Column({ type: 'int' })
    valueBytes: number;

    /**
     * `+1` on every change (FR-24): it drives the table's change flags and the
     * `v<version>` build/deploy fingerprints of plan §2.2:138.
     */
    @Column({ type: 'int', default: 1 })
    version: number;

    /**
     * The canonical `generate` block the value was produced with — `base64:24`,
     * `chars:40:alnum`, `keypair:ed25519:pem` (`plan.md:186`, §4.3:397). A
     * difference from the App spec's current block is what sets
     * `generatorChanged` (FR-12); it never regenerates a value implicitly.
     */
    @Column({ type: 'varchar', length: 160, nullable: true })
    generatorFingerprint?: string | null;

    /** For a `<NAME>_PUBLIC` row: the keypair entry it is the public half of. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    derivedFromName?: string | null;

    /** When the generator produced the value (FR-9). NULL for a set/imported one. */
    @TimestampColumn({ nullable: true })
    generatedAt?: Date | null;

    /** Who set it, for the table's "set by" line. No relation — see above. */
    @Column({ type: 'uuid', nullable: true })
    setByUserId?: string | null;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A scope FKs, plain
    // columns with no relation (see the class docstring).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
