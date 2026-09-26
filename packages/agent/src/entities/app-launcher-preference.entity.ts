import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    Unique,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';

/**
 * App Launcher (APW-11) — one person's arrangement of one launcher item.
 *
 * Spec: `docs/specs/features/app-works/APW-11-app-launcher/spec.md`; plan
 * `…/plan.md` §3.2 is the normative column list and §3.4 the migration that
 * creates it (`apps/api/src/migrations/1792110000000-CreateAppLauncherPreferences.ts`).
 * `docs/specs/features/app-works/data-model.md` §2.11 is the same table in the
 * programme's data-model inventory.
 *
 * ## What a row means
 *
 * A person has a **visible**, **pinned** and **order** value per launcher item
 * (spec FR-24). `itemKey` names the item, `scopeKey` names the scope the value
 * belongs to, and the pair is what the read and the save both key on.
 *
 * ## Why `scopeKey` instead of a nullable `organizationId` (plan §3.2:224-226)
 *
 * Uniqueness over a nullable column is not portable: Postgres treats NULLs as
 * distinct inside a unique index and so does the SQLite the test and e2e lanes
 * run on, so a workspace with no Organization could hold two rows for the same
 * item. `scopeKey` is therefore a plain NOT NULL string holding exactly one of
 * three things:
 *
 *   - `'global'`   — Ever app rows. Spec FR-24: values for Ever apps are
 *                    personal across Organizations, so every Organization
 *                    reads and writes the same row.
 *   - `'personal'` — Work rows in the person's personal scope (no active
 *                    Organization).
 *   - `<uuid>`     — Work rows in that Organization. Spec FR-24: values for
 *                    Works are per Organization, so Organization B can never
 *                    renumber Organization A's pins (spec FR-62).
 *
 * ## Why there are no `tenantId` / `organizationId` stamp columns (plan §3.2:227-229)
 *
 * `apps/api/src/scope/scope-stamping.subscriber.ts` stamps the ACTIVE
 * Organization onto rows of stamped entities. On an Ever app row — which lives
 * under `'global'` on purpose and is shared by every Organization — that stamp
 * would be actively wrong: activating Organization B would rewrite a row
 * Organization A is reading. Access is by `userId` alone (spec FR-53), which
 * this table's two indexes both lead with.
 *
 * ## Why there is no foreign key to `works` (plan §3.2:230-231)
 *
 * `itemKey` is polymorphic — `'platform:<catalogId>'` and `'work:<uuid>'` — so
 * there is no single table to point at. Rows for a Work that was deleted or is
 * no longer accessible are ignored on read (spec FR-28) and are the first rows
 * pruned once a person holds more than 500 of them.
 *
 * ## What is deliberately NOT stored (plan §3.2:232)
 *
 * No name and no address. Spec §5.2 and FR-43 forbid the launcher leaking a
 * Work title or a host into anything that outlives the request, and a
 * preference table is exactly the kind of place one would otherwise accumulate.
 *
 * ## R-25 (workspace backup)
 *
 * Every table an App Works epic adds is classified for the AW-22 workspace
 * backup. This one is classified as the **account** domain — per-user rows, no
 * Work scope — exporting as `data/account/app-launcher-preferences.jsonl`
 * (`CONTRACTS.md` R-25; `docs/specs/features/app-works/data-model.md` §2.11
 * "Retention (R-25)"; plan §3 "Workspace backup"). The classification itself
 * lives in `packages/agent/src/account-transfer/backup/collectors/`, which this
 * epic's tasks do not own.
 */
@Entity({ name: 'app_launcher_preferences' })
@Unique('uq_app_launcher_prefs_user_scope_item', ['userId', 'scopeKey', 'itemKey'])
@Index('idx_app_launcher_prefs_user_scope', ['userId', 'scopeKey'])
export class AppLauncherPreference {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The person who made these choices. Spec FR-53 — every read is user-scoped. */
    @Column({ type: 'uuid' })
    userId: string;

    /**
     * Explicit `type: 'uuid'` is required, not decorative: the unique index and
     * the migration both key on the column, and a `@ManyToOne` alone would
     * leave its database type to TypeORM's driver-inferred default.
     */
    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    /**
     * `'global'` · `'personal'` · `<organizationId>` — see the class docstring.
     * 40 characters is the longest of the three (a uuid is 36).
     */
    @Column({ type: 'varchar', length: 40 })
    scopeKey: string;

    /**
     * `'platform:<catalogId>'` · `'work:<uuid>'` (plan §3.2:212). 64 characters
     * is the longest legal key the save DTO's regex admits
     * (`^(platform:[a-z0-9-]{2,40}|work:[0-9a-f-]{36})$`, plan §4.2:405).
     */
    @Column({ type: 'varchar', length: 64 })
    itemKey: string;

    /**
     * Spec FR-27 — the **Show** control. Defaults to shown: a person who never
     * opened **Manage apps** has hidden nothing, and an item that is not
     * eligible is excluded by eligibility, not by a stored `false`.
     */
    @Column({ type: 'boolean', default: true })
    visible: boolean;

    /**
     * Spec FR-24/FR-25 — the **Pin** control. Defaults to not pinned, so the
     * six-pin budget (FR-25) is spent only by an explicit choice.
     */
    @Column({ type: 'boolean', default: false })
    pinned: boolean;

    /**
     * Position in the merged pinned view (spec FR-62), `0..5` while pinned.
     * `NULL` for a row that is not pinned, and for a pinned row whose position
     * has not been recomputed yet — the read then falls back to `updatedAt`,
     * which is the "first six by pin time" rule FR-62 states.
     *
     * `smallint` rather than `int` because the value is bounded by the six-pin
     * limit and the column is read on every panel open.
     */
    @Column({ type: 'smallint', nullable: true })
    pinOrder?: number | null;

    /**
     * The person's order inside the item's own section (spec FR-26, FR-27),
     * `0..9999` as the save DTO validates (plan §4.2:405). `NULL` means "no
     * explicit order" — the item then falls back to catalog order (Ever apps)
     * or most-recent-successful-deployment-first (Works), which is what makes a
     * person who never reordered anything see the documented default order.
     */
    @Column({ type: 'integer', nullable: true })
    sortOrder?: number | null;

    @CreateDateColumn()
    createdAt: Date;

    /**
     * Also the pin tie-break: FR-62's "shows the first six by pin time" is read
     * off this column, so a pin always has a time even when `pinOrder` is null.
     */
    @UpdateDateColumn()
    updatedAt: Date;
}
