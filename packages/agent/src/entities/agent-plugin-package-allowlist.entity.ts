import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Which remotely-fetched Agent Plugins packages an operator permits.
 *
 * Deliberately a **separate table** from `plugin_allowlist`, and the reason is
 * worth stating plainly: a row in `plugin_allowlist` authorises installing
 * **executable code** into the platform process. A row here authorises
 * fetching an **inert data package**. Those are different powers with
 * different blast radii, and letting one table grant both would mean the
 * safer decision silently carries the more dangerous one.
 *
 * Only `git` and `npm` are gated. A `local` package is already inside a
 * directory the operator configured and controls, so an allowlist would be
 * asking permission for bytes they put there themselves.
 *
 * Global (Tier D), like its sibling: this is a deployment-operator decision,
 * not a tenant one.
 */

/** Remote sources that require an allowlist entry. */
export type AgentPluginPackageAllowlistSource = 'git' | 'npm';

@Entity({ name: 'agent_plugin_package_allowlist' })
@Index('uq_agent_plugin_allowlist_name_source', ['packageName', 'source'], { unique: true })
export class AgentPluginPackageAllowlist {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /**
     * The npm package name, or the git URL, that is permitted.
     *
     * Matched BEFORE any network call is made — an entry is permission to
     * fetch, so checking it after downloading would defeat the purpose.
     */
    @Column({ type: 'varchar', length: 2048 })
    packageName: string;

    @Column({ type: 'varchar', length: 16 })
    source: AgentPluginPackageAllowlistSource;

    /**
     * Permitted versions, as a semver range for npm or a ref pattern for git.
     * Null means any version of an otherwise-permitted package.
     */
    @Column({ type: 'varchar', length: 256, nullable: true })
    versionRange?: string | null;

    /** Expected sha512 (npm) or commit (git), when the operator pins one exactly. */
    @Column({ type: 'varchar', length: 256, nullable: true })
    integrity?: string | null;

    /**
     * Lets an operator revoke permission without losing the row, so the
     * reason it existed is still visible.
     */
    @Column({ type: 'boolean', default: true })
    enabled: boolean;

    /** Why this entry exists — an audit note for the next operator. */
    @Column({ type: 'text', nullable: true })
    notes?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
