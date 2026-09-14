import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * What's new (AW-14) — one row per (person, product changelog entry),
 * meaning "this person has seen this entry".
 *
 * Absent row = unread; present row = read. There is no un-read transition
 * (spec FR-21), no partial state and no per-workspace variant.
 *
 * ## Read state follows the person (spec FR-12)
 *
 * Durable and server-side, so a count cleared on one device is cleared on
 * every device the same person signs in from.
 *
 * ## Deliberately NOT workspace-scoped (spec FR-13)
 *
 * There are no `tenantId` / `organizationId` columns, and that absence is
 * the requirement: switching the active Organization must never change the
 * unread count. A later scope sweep must not "fix" this table.
 *
 * ## `entrySlug` is a soft reference
 *
 * Entries are not stored in the database — they come from the changelog
 * content source that ships with the build (`apps/api/src/changelog/`). So
 * there is no FK on `entrySlug`. Rows whose slug the running build no longer
 * ships are ignored when counting and become eligible for removal after 30
 * days (spec FR-22) via `ProductChangelogReadRepository.deleteBySlugsNotIn`.
 *
 * `userId` is a raw uuid (no `@ManyToOne`) per the EW-654 cycle-avoidance
 * rule; its FK to `users(id)` ON DELETE CASCADE lives in migration
 * `1791140000000-CreateProductChangelogReads`.
 *
 * Rows hold only the person, the entry and a timestamp (spec FR-49).
 */
@Entity({ name: 'product_changelog_reads' })
@Index('uq_product_changelog_read_user_entry', ['userId', 'entrySlug'], { unique: true })
@Index('idx_product_changelog_read_user', ['userId'])
export class ProductChangelogRead {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    /** Entry slug — `[a-z0-9-]{3,64}` (spec FR-6). */
    @Column({ type: 'varchar', length: 64 })
    entrySlug: string;

    @CreateDateColumn()
    readAt: Date;
}
