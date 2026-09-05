import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { EncryptedJsonColumn } from './_secret-json-column';

/** Git hosting provider behind a registry entry. */
export type RepoConnectionProvider = 'github' | 'git';

/**
 * How credentials for this repository are resolved at use time:
 *   - `'inherit'`    — no per-repo credential; the git facade's normal
 *                      5-step chain (OAuth account → plugin PAT → …) applies.
 *   - `'github-app'` — `credentialRef` holds a `GitHubAppInstallation`
 *                      entity id; an installation access token is minted
 *                      on demand.
 *   - `'secret-ref'` — `credentialRef` holds a secret POINTER in the
 *                      `in-process-secret-store-resolver` scheme
 *                      (`env:NAME`) or a plugin pointer (`plugin:github`).
 *
 * `credentialRef` is ALWAYS a pointer, never a raw token — the registry
 * stores where a credential lives, not the credential itself.
 */
export type RepoConnectionCredentialMode = 'inherit' | 'github-app' | 'secret-ref';

/**
 * Provenance of a registry row:
 *   - `'manual'`     — user-entered via Settings → Repositories.
 *   - `'work'`       — reserved for materialized Work-derived rows.
 *                      Work-derived entries are currently computed on
 *                      read (never persisted), so no row carries this
 *                      value yet; the discriminator exists so a future
 *                      "pin this Work repo" flow needs no schema change.
 *   - `'github-app'` — imported (one click) from a GitHub App
 *                      installation repository snapshot.
 */
export type RepoConnectionSourceType = 'manual' | 'work' | 'github-app';

/** Caps enforced on the `envFiles` payload (validated in the service AND DTO). */
export const REPO_CONNECTION_ENV_FILE_MAX_COUNT = 8;
export const REPO_CONNECTION_ENV_FILE_MAX_CONTENT_BYTES = 32 * 1024;

/**
 * Cap on the `envGrants` list (self-build slice Y). Mirrors the runner's
 * own `MAX_ENV_PASSTHROUGH`, so a list the registry accepts can never be
 * silently truncated on the machine that applies it.
 */
export const REPO_CONNECTION_ENV_GRANT_MAX_COUNT = 32;

/** A single, traversal-free directory segment. */
export const REPO_CONNECTION_MOUNT_DIR_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** True when `value` is safe to use verbatim as `/workspace/<value>`. */
export function isSafeMountDir(value: string): boolean {
    if (typeof value !== 'string') return false;
    if (!REPO_CONNECTION_MOUNT_DIR_PATTERN.test(value)) return false;
    return value !== '.' && value !== '..';
}

/**
 * Coerce an arbitrary string into ONE safe directory segment: every
 * character outside the mount-dir alphabet (path separators, spaces,
 * unicode) collapses to `-`, and leading dots/dashes are dropped so the
 * result can never be `.`, `..`, a hidden directory, or an option-looking
 * argument. Empty input degrades to `repo`, never to an empty segment.
 */
export function sanitizeMountDirSegment(value: string | null | undefined): string {
    const sanitized = (typeof value === 'string' ? value : '')
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[.\-]+/, '')
        .slice(0, 200)
        .replace(/[.\-]+$/, '');
    return sanitized || 'repo';
}

/**
 * THE effective workspace mount directory for a registry row.
 *
 * `mountPath` is validated as a single traversal-free segment at the API
 * boundary — but it is OPTIONAL, and the fallback is the display `name`,
 * which is only length-checked (it may contain `/`, `..`, or spaces).
 * Every path-building consumer (provision specs, managed-session mount
 * paths) resolves through this one function so the fallback can never
 * escape `/workspace/<dir>`.
 */
export function resolveMountDir(
    mountPath: string | null | undefined,
    name: string | null | undefined,
): string {
    const explicit = typeof mountPath === 'string' ? mountPath.trim() : '';
    if (explicit) {
        return isSafeMountDir(explicit) ? explicit : sanitizeMountDirSegment(explicit);
    }
    return sanitizeMountDirSegment(name);
}

/**
 * Repository registry (Feature G) — a global, account-level repository
 * record independent of Works. Rows are standalone: they describe a
 * repo (URL, display name, mount dir, credential pointer, seed .env
 * files) that agents can be granted access to via
 * {@link AgentRepoAttachment} rows, and that future workspace
 * provisioning can mount alongside a Work's primary repo.
 *
 * Additive by design: the Work three-repo model
 * (`sourceRepository.relatedRepositories`) is untouched; Work repos are
 * SURFACED in the registry listing as computed, read-only entries — they
 * are never copied into this table.
 */
@Entity({ name: 'repo_connections' })
@Index('uq_repo_connection_user_name', ['userId', 'name'], { unique: true })
@Index('idx_repo_connection_user', ['userId'])
export class RepoConnection {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    // EW-651/657 Tier C scope denormalization. No @ManyToOne — the
    // no-cycle rule for scope entities (see user.entity.ts EW-654).
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    /** Display name; also the default mount directory when `mountPath` is null. */
    @Column({ type: 'varchar', length: 120 })
    name: string;

    /** https or ssh clone URL. Validated at the API boundary. */
    @Column({ type: 'varchar', length: 512 })
    url: string;

    @Column({ type: 'varchar', length: 16, default: 'github' })
    provider: RepoConnectionProvider;

    @Column({ type: 'varchar', length: 120, nullable: true })
    defaultBranch?: string | null;

    /**
     * Directory name (single path segment, `^[A-Za-z0-9._-]{1,200}$`)
     * the repo is mounted under inside a provisioned workspace
     * (`/workspace/<mountPath>`). NULL → fall back to `name`.
     */
    @Column({ type: 'varchar', length: 200, nullable: true })
    mountPath?: string | null;

    @Column({ type: 'text', nullable: true })
    description?: string | null;

    @Column({ type: 'varchar', length: 24, default: 'inherit' })
    credentialMode: RepoConnectionCredentialMode;

    /**
     * Credential POINTER (see {@link RepoConnectionCredentialMode}) —
     * `env:NAME`, `plugin:github`, or a GitHubAppInstallation entity id.
     * NEVER a raw token; nothing here is secret by itself.
     */
    @Column({ type: 'varchar', length: 200, nullable: true })
    credentialRef?: string | null;

    /**
     * Seed `.env` files keyed by relative path (`{ [path]: content }`),
     * envelope-encrypted at rest via {@link EncryptedJsonColumn}. Caps:
     * ≤ {@link REPO_CONNECTION_ENV_FILE_MAX_COUNT} files, each content ≤
     * {@link REPO_CONNECTION_ENV_FILE_MAX_CONTENT_BYTES} bytes. API
     * responses MASK contents (paths + sizes only); full content is
     * returned only by the explicit owner-gated env-files endpoint.
     */
    @EncryptedJsonColumn({ nullable: true })
    envFiles?: Record<string, string> | null;

    /**
     * Env var NAMES this repository's runs may read from the RUNNER's own
     * environment, through the runner's platform-owned refusal (self-build
     * slice Y). Names only — deliberately NOT encrypted, because a grant is
     * not a secret and an operator (and an auditor) must be able to read,
     * grep and diff exactly which variables a repository was allowed.
     *
     * `null` / `[]` is the default and reproduces today's behaviour: the
     * runner refuses every platform-owned name. Each entry is one EXACT
     * name; there is no wildcard and no prefix form, so granting
     * `DATABASE_URL` admits `DATABASE_URL` and not `DATABASE_URL_REPLICA`.
     * Names in the un-grantable core (`FLEET_`, `EVER_WORKS_`, `PLUGIN_`,
     * `AUTH_`, `BETTER_AUTH_`, `PLATFORM_`) are refused at write time AND
     * ignored at use time — see `FLEET_RUN_ENV_UNGRANTABLE_PATTERN`.
     *
     * Capped at {@link REPO_CONNECTION_ENV_GRANT_MAX_COUNT}.
     */
    @Column({ type: 'simple-json', nullable: true })
    envGrants?: string[] | null;

    /** When true, the repo is offered everywhere without an explicit attach. */
    @Column({ type: 'boolean', default: true })
    availableInAllProjects: boolean;

    @Column({ type: 'varchar', length: 16, default: 'manual' })
    sourceType: RepoConnectionSourceType;

    /** Set when a future flow materializes a Work-derived row. */
    @Column({ type: 'uuid', nullable: true })
    sourceWorkId?: string | null;

    /** GitHubAppInstallationRepository id this row was imported from. */
    @Column({ type: 'uuid', nullable: true })
    sourceInstallationRepoId?: string | null;

    @Column({ type: 'boolean', default: true })
    enabled: boolean;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    /**
     * Effective workspace mount directory (mountPath override or name),
     * always a single traversal-free segment — see {@link resolveMountDir}.
     */
    getMountDir(): string {
        return resolveMountDir(this.mountPath, this.name);
    }
}
