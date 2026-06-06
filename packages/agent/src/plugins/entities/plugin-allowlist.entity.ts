import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Where the allowlisted package is served from (EW-693).
 *
 * Self-hosters may mirror the catalog to GitHub Packages on a private
 * org or to a different npm mirror; the installer resolves the package
 * against the matching registry URL from `PLUGIN_REGISTRY_*` config.
 */
export type PluginAllowlistSource = 'npm' | 'github-packages';

/**
 * Admin-managed list of non-first-party packages permitted for
 * runtime install (EW-693, FR-11).
 *
 * First-party `@ever-works/*` is implicitly allowed and does not
 * require a row here. Everything else MUST match an enabled row by
 * `packageName` (unique) before any download — the installer refuses
 * non-allowlisted packages BEFORE network fetch. Optional `integrity`
 * pinning provides a second gate at verify-before-load time (FR-10).
 *
 * Schema is intentionally narrow: one row per package name. Versions
 * are constrained by `versionRange` (semver) so an allowlist entry
 * can pin a single version (`'2.1.3'`) or a tolerated range (`'^2.0.0'`).
 */
@Entity({ name: 'plugin_allowlist' })
@Index('uq_plugin_allowlist_package', ['packageName'], { unique: true })
export class PluginAllowlistEntity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * Full npm package name, e.g. `@some-vendor/cool-plugin` or
     * `cool-plugin`. Unique — there is at most one allowlist entry
     * per package, and updates re-pin existing rows rather than
     * creating duplicates.
     */
    @Column({ type: 'varchar' })
    packageName: string;

    /**
     * Semver range pinning what versions are allowed.
     * Examples: `'2.1.3'` (exact), `'^2.0.0'` (caret), `'>=1.5 <2'`
     * (range). The installer rejects any resolved version that does
     * not satisfy this range.
     */
    @Column({ type: 'varchar' })
    versionRange: string;

    /**
     * Optional sha512 integrity. When set, the installer MUST refuse
     * an install whose downloaded integrity does not match (FR-10).
     * When null, only the registry-provided integrity (npm's own
     * tarball sha) is verified.
     */
    @Column({ type: 'varchar', nullable: true })
    integrity: string | null;

    /**
     * Which registry serves this package. Defaults to public npm.
     */
    @Column({ type: 'varchar', default: 'npm' })
    source: PluginAllowlistSource;

    /**
     * Toggle to disable an allowlist entry without deleting it
     * (admin UX). Disabled rows are treated as if absent by the
     * installer.
     */
    @Column({ type: 'boolean', default: true })
    enabled: boolean;

    @CreateDateColumn()
    createdAt: Date;
}
