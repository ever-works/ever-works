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
 * An installed **Agent Plugins** package — the open, cross-vendor package
 * format defined at <https://github.com/agentplugins/agent-plugins-spec>.
 *
 * This is emphatically NOT the native Ever Works plugin table. The two are
 * different species and the tables stay distinct on purpose:
 *
 * | | `plugins` (native) | `agent_plugin_packages` (this) |
 * | - | - | - |
 * | Contents | executable TypeScript, `import()`-ed | inert data: a manifest, markdown skills, MCP configs |
 * | Manifest | `everworks.plugin` in `package.json` | `plugin.json`, a closed schema |
 * | Trust | code runs in-process | data is safe to parse; only stdio MCP servers execute, behind ADR-018's gate |
 * | Scope | deployment-wide | per tenant/organization |
 *
 * Confusing them is the one mistake with real consequences here, which is
 * also why `agent_plugin_package_allowlist` is a separate table from
 * `plugin_allowlist`: a row in the latter authorises installing **code**.
 */

/** Where a package's bytes came from. */
export type AgentPluginPackageSource = 'local' | 'git' | 'npm';

/**
 * Install lifecycle, mirroring the native plugin table's vocabulary so an
 * operator reading both sees the same words.
 *
 * - `available` — discovered and validated, but not registered for use.
 * - `installed` — registered; its skills reach the catalog.
 * - `failed`    — acquisition or validation failed; see `installError`.
 */
export type AgentPluginPackageInstallState = 'available' | 'installed' | 'failed';

/**
 * One finding recorded against a package at validation time, mirroring the
 * conformance library's `Finding` shape.
 *
 * Stored rather than recomputed so the install UI can explain WHY a skill or
 * an MCP server is missing without re-reading the package from disk — and so
 * the explanation survives the package becoming unreadable.
 */
export interface AgentPluginPackageFinding {
    readonly code: string;
    readonly severity: 'fatal' | 'error' | 'warning';
    readonly scope: string;
    readonly message: string;
    readonly subject?: string;
    readonly at?: string;
}

@Entity({ name: 'agent_plugin_packages' })
// A package name is unique per owner: two tenants may each install a package
// called `acme.tools`, and one tenant may not install it twice.
@Index('uq_agent_plugin_package_user_name', ['userId', 'name'], { unique: true })
@Index('idx_agent_plugin_package_user', ['userId'])
@Index('idx_agent_plugin_package_state', ['installState'])
export class AgentPluginPackage {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    // EW-651/657 Tier A scope denormalization. No @ManyToOne — the no-cycle
    // rule for scope entities (see user.entity.ts EW-654), and deliberately
    // no XOR CHECK: ScopeStampingSubscriber populates BOTH columns on insert,
    // so a XOR constraint would abort the migration on ordinary data.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /**
     * The manifest `name`, which is the package's identity across every
     * conformant client. Spec section 5.5 caps it at 64 characters; the column
     * is wider so a future release relaxing that does not need a migration.
     */
    @Column({ type: 'varchar', length: 120 })
    name: string;

    /**
     * The manifest `version`, when the package declares one.
     *
     * Nullable on purpose: the specification forbids a client to reject a
     * package for a missing or non-semver version, so this is metadata for
     * update checks, never an identity or a gate.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    version?: string | null;

    /** The Agent Plugins release the package targets, from its `$schema`. */
    @Column({ type: 'varchar', length: 16 })
    specVersion: string;

    @Column({ type: 'varchar', length: 16, default: 'local' })
    source: AgentPluginPackageSource;

    /**
     * How to find the package again: an absolute directory for `local`, a
     * URL with a ref for `git`, a name with a version for `npm`.
     */
    @Column({ type: 'varchar', length: 2048 })
    sourceRef: string;

    /** Absolute path the package currently occupies on this replica. */
    @Column({ type: 'varchar', length: 2048, nullable: true })
    installPath?: string | null;

    /**
     * sha512 integrity for `npm`, or the resolved commit for `git`. Null for
     * `local`, where the operator owns the bytes and there is nothing to
     * verify against.
     */
    @Column({ type: 'varchar', length: 256, nullable: true })
    integrity?: string | null;

    /** The validated `plugin.json`, stored verbatim. */
    @Column('simple-json', { nullable: true })
    manifest?: Record<string, unknown> | null;

    /**
     * Everything the conformance library reported: skipped skills, disabled
     * MCP configurations, tolerated manifest oddities.
     */
    @Column('simple-json', { default: '[]' })
    findings: AgentPluginPackageFinding[];

    /** Skill names this package contributed, for a catalog listing without a disk read. */
    @Column('simple-json', { default: '[]' })
    skillNames: string[];

    /** MCP server names this package declares. */
    @Column('simple-json', { default: '[]' })
    mcpServerNames: string[];

    @Column({ type: 'varchar', length: 16, default: 'available' })
    installState: AgentPluginPackageInstallState;

    /** Why the last acquisition or validation failed. Never carries a credential. */
    @Column({ type: 'text', nullable: true })
    installError?: string | null;

    /**
     * Content hash of the package as installed.
     *
     * Doubles as the synthesized catalog-entry version for a package with no
     * declared `version` — but note it is TRUNCATED before it reaches
     * `skills.sourceCatalogVersion`, which is varchar(16).
     */
    @Column({ type: 'varchar', length: 128, nullable: true })
    contentHash?: string | null;

    // MUST be @PortableDateColumn rather than `type: 'timestamp'`: CI and e2e
    // run better-sqlite3, which has no `timestamp` type, and TypeORM's
    // metadata validation throws at BOOT rather than at query time. There is a
    // guard spec for exactly this.
    @PortableDateColumn({ nullable: true })
    lastValidatedAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
