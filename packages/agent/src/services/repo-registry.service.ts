import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import {
    REPO_CONNECTION_ENV_FILE_MAX_CONTENT_BYTES,
    REPO_CONNECTION_ENV_FILE_MAX_COUNT,
    RepoConnection,
    isSafeMountDir,
    resolveMountDir,
    sanitizeMountDirSegment,
    type RepoConnectionCredentialMode,
    type RepoConnectionProvider,
    type RepoConnectionSourceType,
} from '../entities/repo-connection.entity';
import { RepoConnectionRepository } from '../database/repositories/repo-connection.repository';
import { AgentRepoAttachmentRepository } from '../database/repositories/agent-repo-attachment.repository';
import { AgentRepository } from '../database/repositories/agent.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { GitHubAppInstallationRepository } from '../database/repositories/github-app-installation.repository';
import { GitHubAppInstallationRepoRepository } from '../database/repositories/github-app-installation-repository.repository';
import type { AgentRepoAttachment } from '../entities/agent-repo-attachment.entity';
import { WORK_REPO_ROLES, getWorkRepoFullName, type WorkRepoRole } from '../works/work-repo-match';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';

/** One seed env file as carried on the wire (API DTO shape). */
export interface RepoConnectionEnvFile {
    path: string;
    content: string;
}

/** Masked env-file descriptor — what list/get responses expose. */
export interface RepoConnectionEnvFileMeta {
    path: string;
    /** UTF-8 byte length of the content (not returned itself). */
    size: number;
}

/**
 * Registry listing entry. Manual + imported rows AND computed
 * Work-derived entries share this shape; `readonly` distinguishes the
 * derived entries (no row behind them — they cannot be edited/deleted).
 */
export interface RepoConnectionView {
    id: string;
    name: string;
    url: string;
    provider: RepoConnectionProvider;
    defaultBranch: string | null;
    mountPath: string | null;
    /** Effective mount dir — `mountPath` override or `name`. */
    mountDir: string;
    description: string | null;
    credentialMode: RepoConnectionCredentialMode;
    credentialRef: string | null;
    envFiles: RepoConnectionEnvFileMeta[];
    availableInAllProjects: boolean;
    sourceType: RepoConnectionSourceType;
    sourceWorkId: string | null;
    sourceInstallationRepoId: string | null;
    enabled: boolean;
    readonly: boolean;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface AgentRepoView extends RepoConnectionView {
    /** True when an attachment row exists for the agent. */
    attached: boolean;
    /** Attachment `enabled` flag; false when not attached. */
    attachmentEnabled: boolean;
}

/** Resolved attachment for provisioning consumers (CMA sessions, workspaces). */
export interface ResolvedAgentRepo {
    repoConnectionId: string;
    url: string;
    branch: string | null;
    mountDir: string;
    envFiles: RepoConnectionEnvFile[];
}

export interface CreateRepoConnectionInput {
    name: string;
    url: string;
    provider?: RepoConnectionProvider;
    defaultBranch?: string | null;
    mountPath?: string | null;
    description?: string | null;
    credentialMode?: RepoConnectionCredentialMode;
    credentialRef?: string | null;
    envFiles?: RepoConnectionEnvFile[];
    availableInAllProjects?: boolean;
    enabled?: boolean;
}

export type UpdateRepoConnectionInput = Partial<CreateRepoConnectionInput>;

// Env-file paths may nest (e.g. `apps/api/.env`): slash-joined segments,
// each mount-path-shaped, no `.`/`..` segments, capped at 200 chars total.
const ENV_FILE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

/** `https://host/...` or ssh (`git@host:path` / `ssh://...`). */
export function isValidRepoUrl(url: string): boolean {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed || trimmed.length > 512 || /\s/.test(trimmed)) return false;
    if (trimmed.startsWith('https://')) {
        try {
            const parsed = new URL(trimmed);
            return parsed.protocol === 'https:' && !!parsed.hostname;
        } catch {
            return false;
        }
    }
    if (trimmed.startsWith('ssh://')) {
        return /^ssh:\/\/[^/]+\/.+$/.test(trimmed);
    }
    // scp-like: git@github.com:owner/repo.git
    return /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/.test(trimmed);
}

/**
 * Single directory segment; no separators, so traversal is impossible.
 * Shares its definition with the mount-dir resolver on the entity — the
 * API boundary REJECTS what the resolver would otherwise have to
 * sanitize.
 */
export function isValidMountPath(mountPath: string): boolean {
    return isSafeMountDir(mountPath);
}

export function isValidEnvFilePath(path: string): boolean {
    if (typeof path !== 'string' || !path || path.length > 200) return false;
    if (path.startsWith('/') || path.includes('\\')) return false;
    const segments = path.split('/');
    return segments.every(
        (segment) => ENV_FILE_SEGMENT_PATTERN.test(segment) && segment !== '.' && segment !== '..',
    );
}

/**
 * Validate the full env-files payload against the caps. Throws
 * BadRequestException with a precise message on the first violation.
 */
export function assertValidEnvFiles(files: RepoConnectionEnvFile[]): void {
    if (files.length > REPO_CONNECTION_ENV_FILE_MAX_COUNT) {
        throw new BadRequestException(
            `At most ${REPO_CONNECTION_ENV_FILE_MAX_COUNT} env files are allowed per repository.`,
        );
    }
    const seen = new Set<string>();
    for (const file of files) {
        if (!isValidEnvFilePath(file.path)) {
            throw new BadRequestException(`Invalid env file path: "${file.path}".`);
        }
        if (seen.has(file.path)) {
            throw new BadRequestException(`Duplicate env file path: "${file.path}".`);
        }
        seen.add(file.path);
        if (typeof file.content !== 'string') {
            throw new BadRequestException(`Env file "${file.path}" content must be a string.`);
        }
        if (Buffer.byteLength(file.content, 'utf8') > REPO_CONNECTION_ENV_FILE_MAX_CONTENT_BYTES) {
            throw new BadRequestException(
                `Env file "${file.path}" exceeds the ${REPO_CONNECTION_ENV_FILE_MAX_CONTENT_BYTES / 1024}KB limit.`,
            );
        }
    }
}

function envFilesToRecord(files: RepoConnectionEnvFile[]): Record<string, string> {
    const record: Record<string, string> = {};
    for (const file of files) {
        record[file.path] = file.content;
    }
    return record;
}

function envFilesFromRecord(record: Record<string, string> | null | undefined): {
    files: RepoConnectionEnvFile[];
    meta: RepoConnectionEnvFileMeta[];
} {
    const entries = Object.entries(record ?? {});
    return {
        files: entries.map(([path, content]) => ({ path, content })),
        meta: entries.map(([path, content]) => ({
            path,
            size: Buffer.byteLength(content ?? '', 'utf8'),
        })),
    };
}

/**
 * Advisory mount spec carried on `WorkspaceProvisionSpec.attachedRepos`.
 * Token-free (mirrors `repoUrl`) and env-file-free: the provision spec
 * crosses the plugin boundary, so secrets never ride on it.
 */
export interface AdvisoryAttachedRepoSpec {
    url: string;
    branch?: string;
    mountDir: string;
}

/**
 * Minimal read surface the provisioning resolver needs.
 * `AgentRepoAttachmentRepository` satisfies it structurally — declared
 * here so consumers (e.g. `TaskWorkspaceService`) depend on the
 * function, not on this module's Nest provider graph.
 */
export interface AgentRepoAttachmentReader {
    listEnabledForAgentWithRepos(agentId: string, userId: string): Promise<AgentRepoAttachment[]>;
}

/**
 * Pure edge → mount-spec mapping. Drops edges whose repo row is missing
 * (relation not loaded / row deleted) or itself disabled: the attachment
 * flag and the row flag must BOTH be on for a repo to mount.
 */
export function mapAttachmentEdgesToRepos(
    edges: readonly AgentRepoAttachment[],
): ResolvedAgentRepo[] {
    const resolved: ResolvedAgentRepo[] = [];
    for (const edge of edges) {
        const repo = edge.repoConnection;
        if (!repo || !repo.enabled) continue;
        resolved.push({
            repoConnectionId: repo.id,
            url: repo.url,
            branch: repo.defaultBranch ?? null,
            // NEVER the raw `name`: it is only length-checked, so an
            // unsanitized fallback would let `../../etc` escape
            // `/workspace/<dir>` in every path-building consumer.
            mountDir: resolveMountDir(repo.mountPath, repo.name),
            envFiles: envFilesFromRecord(repo.envFiles).files,
        });
    }
    return resolved;
}

/**
 * Provisioning read: an agent's ENABLED attachments whose repo rows are
 * themselves enabled, resolved to mountable specs WITH full env-file
 * contents. Server-side only — never serialize the result to an API
 * response (see `RepoRegistryService.toView` for the masked shape).
 */
export async function resolveAttachedReposForAgent(
    attachments: AgentRepoAttachmentReader,
    agentId: string,
    userId: string,
): Promise<ResolvedAgentRepo[]> {
    return mapAttachmentEdgesToRepos(
        await attachments.listEnabledForAgentWithRepos(agentId, userId),
    );
}

/** Strip env files (and the row id) for the advisory provision-spec field. */
export function toAdvisoryRepoSpecs(
    repos: readonly ResolvedAgentRepo[],
): AdvisoryAttachedRepoSpec[] {
    return repos.map((repo) => ({
        url: repo.url,
        ...(repo.branch ? { branch: repo.branch } : {}),
        mountDir: repo.mountDir,
    }));
}

/**
 * Repository registry (Feature G). One service owns the whole surface:
 * registry CRUD (with env-file masking), the derived Work-repo listing
 * union, one-click GitHub-App import, and the Agent → repo attachment
 * edge — plus the provisioning-side resolver that turns an agent's
 * enabled attachments into mountable repo specs.
 *
 * Authz posture: every method takes the calling `userId` first and
 * treats a row owned by anyone else as nonexistent (404, never 403).
 */
@Injectable()
export class RepoRegistryService {
    private readonly logger = new Logger(RepoRegistryService.name);

    constructor(
        private readonly repoConnections: RepoConnectionRepository,
        private readonly attachments: AgentRepoAttachmentRepository,
        private readonly agents: AgentRepository,
        private readonly works: WorkRepository,
        private readonly ghInstallations: GitHubAppInstallationRepository,
        private readonly ghInstallationRepos: GitHubAppInstallationRepoRepository,
        // Appended LAST + @Optional() per the positional-spec arity rule:
        // every existing construction keeps working. Activity rows are
        // best-effort by contract (skills.service precedent).
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    // ── Registry CRUD ────────────────────────────────────────────────

    async list(
        userId: string,
        options: { includeDerived?: boolean } = {},
    ): Promise<RepoConnectionView[]> {
        const rows = await this.repoConnections.listByUser(userId);
        const views = rows.map((row) => this.toView(row));
        if (!options.includeDerived) {
            return views;
        }
        return [...views, ...(await this.listWorkDerived(userId))];
    }

    async get(userId: string, id: string): Promise<RepoConnectionView> {
        const row = await this.requireOwned(userId, id);
        return this.toView(row);
    }

    async create(userId: string, input: CreateRepoConnectionInput): Promise<RepoConnectionView> {
        this.assertValidCore(input);
        const envFiles = input.envFiles ?? [];
        assertValidEnvFiles(envFiles);

        const name = input.name.trim();
        const existing = await this.repoConnections.findByUserAndName(userId, name);
        if (existing) {
            throw new ConflictException(
                `A repository named "${name}" already exists in your registry.`,
            );
        }

        const row = await this.repoConnections.create({
            userId,
            name,
            url: input.url.trim(),
            provider: input.provider ?? 'github',
            defaultBranch: input.defaultBranch?.trim() || null,
            mountPath: input.mountPath?.trim() || null,
            description: input.description ?? null,
            credentialMode: input.credentialMode ?? 'inherit',
            credentialRef: input.credentialRef?.trim() || null,
            envFiles: envFiles.length > 0 ? envFilesToRecord(envFiles) : null,
            availableInAllProjects: input.availableInAllProjects ?? true,
            sourceType: 'manual',
            enabled: input.enabled ?? true,
        });
        await this.logActivity(
            userId,
            ActivityActionType.REPO_CONNECTION_CREATED,
            row.id,
            row.name,
        );
        return this.toView(row);
    }

    async update(
        userId: string,
        id: string,
        input: UpdateRepoConnectionInput,
    ): Promise<RepoConnectionView> {
        const row = await this.requireOwned(userId, id);
        // Fallbacks LAST: an in-process caller that passes an explicit
        // `name: undefined` on a partial update must validate against the
        // stored row, not against undefined (spreading `input` after the
        // fallbacks would overwrite them with the undefined key).
        this.assertValidCore({
            ...input,
            name: input.name ?? row.name,
            url: input.url ?? row.url,
        });

        if (input.name !== undefined) {
            const name = input.name.trim();
            if (name !== row.name) {
                const clash = await this.repoConnections.findByUserAndName(userId, name);
                if (clash && clash.id !== row.id) {
                    throw new ConflictException(
                        `A repository named "${name}" already exists in your registry.`,
                    );
                }
                row.name = name;
            }
        }
        if (input.url !== undefined) row.url = input.url.trim();
        if (input.provider !== undefined) row.provider = input.provider;
        if (input.defaultBranch !== undefined) {
            row.defaultBranch = input.defaultBranch?.trim() || null;
        }
        if (input.mountPath !== undefined) row.mountPath = input.mountPath?.trim() || null;
        if (input.description !== undefined) row.description = input.description ?? null;
        if (input.credentialMode !== undefined) row.credentialMode = input.credentialMode;
        if (input.credentialRef !== undefined) {
            row.credentialRef = input.credentialRef?.trim() || null;
        }
        if (input.availableInAllProjects !== undefined) {
            row.availableInAllProjects = input.availableInAllProjects;
        }
        if (input.enabled !== undefined) row.enabled = input.enabled;
        if (input.envFiles !== undefined) {
            assertValidEnvFiles(input.envFiles);
            row.envFiles = input.envFiles.length > 0 ? envFilesToRecord(input.envFiles) : null;
        }

        const saved = await this.repoConnections.save(row);
        await this.logActivity(
            userId,
            ActivityActionType.REPO_CONNECTION_UPDATED,
            saved.id,
            saved.name,
        );
        return this.toView(saved);
    }

    async remove(userId: string, id: string): Promise<{ deleted: true }> {
        const row = await this.requireOwned(userId, id);
        const deleted = await this.repoConnections.deleteByIdAndUser(id, userId);
        if (!deleted) {
            throw new NotFoundException('Repository not found.');
        }
        await this.logActivity(userId, ActivityActionType.REPO_CONNECTION_DELETED, id, row.name);
        return { deleted: true };
    }

    /** Owner-gated FULL env-file read — the only unmasked path. */
    async getEnvFiles(userId: string, id: string): Promise<{ files: RepoConnectionEnvFile[] }> {
        const row = await this.requireOwned(userId, id);
        return { files: envFilesFromRecord(row.envFiles).files };
    }

    /** Replace the env-file set wholesale ("Save All" semantics). */
    async setEnvFiles(
        userId: string,
        id: string,
        files: RepoConnectionEnvFile[],
    ): Promise<{ files: RepoConnectionEnvFileMeta[] }> {
        assertValidEnvFiles(files);
        const row = await this.requireOwned(userId, id);
        row.envFiles = files.length > 0 ? envFilesToRecord(files) : null;
        const saved = await this.repoConnections.save(row);
        return { files: envFilesFromRecord(saved.envFiles).meta };
    }

    // ── GitHub-App import ────────────────────────────────────────────

    /**
     * One-click import of a GitHub-App installation repository into the
     * registry: creates a REAL row (`sourceType: 'github-app'`) whose
     * `credentialRef` points at the installation entity id, so token
     * minting can resolve through the App at use time.
     *
     * Conflicts are loud 409s (already-imported and duplicate-name),
     * never silent suffixing — the user renames and retries.
     */
    async importFromGithubApp(
        userId: string,
        installationRepoId: string,
    ): Promise<RepoConnectionView> {
        const repo = await this.ghInstallationRepos.findById(installationRepoId);
        if (!repo) {
            throw new NotFoundException('GitHub App repository not found.');
        }
        const installation = await this.ghInstallations.findById(repo.installationEntityId);
        if (
            !installation ||
            installation.createdByUserId !== userId ||
            installation.deletedAt ||
            installation.suspendedAt
        ) {
            // Cross-user (or dead installation) reads 404 — never 403.
            throw new NotFoundException('GitHub App repository not found.');
        }

        const alreadyImported = await this.repoConnections.findByUserAndSourceInstallationRepoId(
            userId,
            repo.id,
        );
        if (alreadyImported) {
            throw new ConflictException(
                `"${repo.fullName}" is already in your registry as "${alreadyImported.name}".`,
            );
        }

        const name = repo.repo;
        const nameClash = await this.repoConnections.findByUserAndName(userId, name);
        if (nameClash) {
            throw new ConflictException(
                `A repository named "${name}" already exists in your registry. Rename it, then import again.`,
            );
        }

        const row = await this.repoConnections.create({
            userId,
            name,
            url: `https://github.com/${repo.fullName}`,
            provider: 'github',
            defaultBranch: repo.defaultBranch ?? null,
            credentialMode: 'github-app',
            credentialRef: installation.id,
            sourceType: 'github-app',
            sourceInstallationRepoId: repo.id,
            availableInAllProjects: true,
            enabled: true,
        });
        await this.logActivity(
            userId,
            ActivityActionType.REPO_CONNECTION_IMPORTED,
            row.id,
            row.name,
        );
        return this.toView(row);
    }

    // ── Agent attachments ────────────────────────────────────────────

    /** Registry rows + this agent's attachment state, for the settings card. */
    async listForAgent(userId: string, agentId: string): Promise<AgentRepoView[]> {
        await this.requireAgent(userId, agentId);
        const [rows, edges] = await Promise.all([
            this.repoConnections.listByUser(userId),
            this.attachments.listForAgent(agentId, userId),
        ]);
        const edgeByRepoId = new Map(edges.map((edge) => [edge.repoConnectionId, edge]));
        return rows.map((row) => {
            const edge = edgeByRepoId.get(row.id);
            return {
                ...this.toView(row),
                attached: !!edge,
                attachmentEnabled: edge?.enabled ?? false,
            };
        });
    }

    async setAttachment(
        userId: string,
        agentId: string,
        repoConnectionId: string,
        enabled: boolean,
    ): Promise<{ agentId: string; repoConnectionId: string; enabled: boolean }> {
        await this.requireAgent(userId, agentId);
        await this.requireOwned(userId, repoConnectionId);
        const edge = await this.attachments.upsert({
            userId,
            agentId,
            repoConnectionId,
            enabled,
        });
        await this.logActivity(
            userId,
            ActivityActionType.REPO_ATTACHED_TO_AGENT,
            repoConnectionId,
            agentId,
        );
        return { agentId, repoConnectionId, enabled: edge.enabled };
    }

    async removeAttachment(
        userId: string,
        agentId: string,
        repoConnectionId: string,
    ): Promise<{ deleted: true }> {
        await this.requireAgent(userId, agentId);
        const deleted = await this.attachments.deleteByAgentAndRepo(
            agentId,
            repoConnectionId,
            userId,
        );
        if (!deleted) {
            throw new NotFoundException('Repository attachment not found.');
        }
        await this.logActivity(
            userId,
            ActivityActionType.REPO_DETACHED_FROM_AGENT,
            repoConnectionId,
            agentId,
        );
        return { deleted: true };
    }

    // ── Derived Work entries ─────────────────────────────────────────

    /**
     * Work repos surfaced as computed, read-only registry entries — one
     * per declared repo role. Never materialized; ids are synthetic
     * (`work:<workId>:<role>`), so they cannot collide with row uuids.
     */
    private async listWorkDerived(userId: string): Promise<RepoConnectionView[]> {
        const works = await this.works.findByUser(userId);
        const derived: RepoConnectionView[] = [];
        for (const work of works) {
            for (const role of WORK_REPO_ROLES) {
                const fullName = getWorkRepoFullName(work, role);
                if (!fullName) continue;
                derived.push(this.workRepoView(work.id, work.name, role, fullName));
            }
        }
        return derived;
    }

    private workRepoView(
        workId: string,
        workName: string,
        role: WorkRepoRole,
        fullName: string,
    ): RepoConnectionView {
        return {
            id: `work:${workId}:${role}`,
            name: `${workName} (${role})`,
            url: `https://github.com/${fullName}`,
            provider: 'github',
            defaultBranch: null,
            mountPath: null,
            mountDir: sanitizeMountDirSegment(fullName.split('/')[1] ?? fullName),
            description: null,
            credentialMode: 'inherit',
            credentialRef: null,
            envFiles: [],
            availableInAllProjects: false,
            sourceType: 'work',
            sourceWorkId: workId,
            sourceInstallationRepoId: null,
            enabled: true,
            readonly: true,
            createdAt: null,
            updatedAt: null,
        };
    }

    // ── Internals ────────────────────────────────────────────────────

    /**
     * Best-effort activity row (conventions rule 9 — user-visible state
     * changes leave a trace). Never throws; a feed write must not fail
     * a registry mutation that already happened. `label` is a display
     * name (repo name, or the agent id for attachment events) — never
     * secret material.
     */
    private async logActivity(
        userId: string,
        actionType: ActivityActionType,
        repoConnectionId: string,
        label: string,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                action: actionType,
                actionType,
                status: ActivityStatus.COMPLETED,
                summary: `Repository ${label} — ${actionType}`,
                details: { resourceType: 'repo_connection', resourceId: repoConnectionId },
            });
        } catch (err) {
            this.logger.warn(`Failed to log activity ${actionType}: ${err}`);
        }
    }

    private async requireOwned(userId: string, id: string): Promise<RepoConnection> {
        const row = await this.repoConnections.findByIdAndUser(id, userId);
        if (!row) {
            throw new NotFoundException('Repository not found.');
        }
        return row;
    }

    private async requireAgent(userId: string, agentId: string): Promise<void> {
        const agent = await this.agents.findByIdAndUser(agentId, userId);
        if (!agent) {
            throw new NotFoundException('Agent not found.');
        }
    }

    private assertValidCore(
        input: Pick<CreateRepoConnectionInput, 'name' | 'url' | 'mountPath' | 'credentialRef'>,
    ): void {
        const name = input.name?.trim();
        if (!name || name.length > 120) {
            throw new BadRequestException('Repository name is required (max 120 characters).');
        }
        if (!isValidRepoUrl(input.url ?? '')) {
            throw new BadRequestException(
                'Repository URL must be an https:// URL or an ssh remote (git@host:owner/repo).',
            );
        }
        const mountPath = input.mountPath?.trim();
        if (mountPath && !isValidMountPath(mountPath)) {
            throw new BadRequestException(
                'Mount path must be a single directory name (letters, digits, ".", "_", "-").',
            );
        }
        if (input.credentialRef && input.credentialRef.length > 200) {
            throw new BadRequestException('Credential reference is too long (max 200 characters).');
        }
    }

    /** Masked view — env-file contents never leave through list/get. */
    private toView(row: RepoConnection): RepoConnectionView {
        return {
            id: row.id,
            name: row.name,
            url: row.url,
            provider: row.provider,
            defaultBranch: row.defaultBranch ?? null,
            mountPath: row.mountPath ?? null,
            mountDir: resolveMountDir(row.mountPath, row.name),
            description: row.description ?? null,
            credentialMode: row.credentialMode,
            credentialRef: row.credentialRef ?? null,
            envFiles: envFilesFromRecord(row.envFiles).meta,
            availableInAllProjects: row.availableInAllProjects,
            sourceType: row.sourceType,
            sourceWorkId: row.sourceWorkId ?? null,
            sourceInstallationRepoId: row.sourceInstallationRepoId ?? null,
            enabled: row.enabled,
            readonly: false,
            createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
            updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
        };
    }
}
