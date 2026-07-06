import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import {
    AGENT_PERMISSIONS_DEFAULT,
    Agent,
    AgentAvatarMode,
    AgentIdleBehavior,
    type AgentPermissions,
    AgentScope,
    AgentStatus,
    type AgentTarget,
} from '../entities/agent.entity';
import { AgentAttachment } from '../entities/agent-attachment.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Work } from '../entities/work.entity';
import { Mission } from '../entities/mission.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { UserUpload } from '../entities/user-upload.entity';
import { AgentRepository, type ListAgentsFilter } from '../database/repositories/agent.repository';
import { AgentMembershipRepository } from '../database/repositories/agent-membership.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import { AgentAttachmentRepository } from '../database/repositories/attachment.repositories';
import { slugifyText } from '../utils/text.utils';
import { isUniqueConstraintError } from '../utils/db-error.utils';
import { toAgentDto, type AgentDto } from './types';
import { computeNextHeartbeat } from './heartbeat-cron';

// Upload IDs are SHA-256 hex strings (the `id` field returned by
// POST /api/uploads/file). 64 lowercase hex chars — NOT UUID-shaped
// (Codex + Greptile P1 on PR #1044).
const SHA256_RE = /^[0-9a-f]{64}$/i;

/**
 * Create-Agent input — writable subset of the entity. Validation
 * lives at the controller DTO layer (`CreateAgentDto` in apps/api).
 * Service enforces cross-field rules + uniqueness + permission
 * normalisation.
 */
export interface CreateAgentInput {
    scope: AgentScope;
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
    name: string;
    title?: string | null;
    capabilities?: string | null;
    aiProviderId?: string | null;
    modelId?: string | null;
    maxSkillContextTokens?: number;
    heartbeatCadence?: string | null;
    idleBehavior?: AgentIdleBehavior;
    pauseAfterFailures?: number;
    permissions?: Partial<AgentPermissions>;
    targets?: AgentTarget[] | null;
    avatarMode?: AgentAvatarMode;
    avatarIcon?: string | null;
    avatarImageUploadId?: string | null;
    // FU-13 — per-Agent git committer identity. Both nullable; when
    // unset, the AGENT_GIT_FACADE binding falls back to the Agent's
    // name + a synthesized email (`<slug>@agents.ever.works`).
    committerName?: string | null;
    committerEmail?: string | null;
}

/**
 * `AgentAttachment` edge enriched with the owning user's `user_uploads`
 * metadata (when the uploads repo is wired and the row still exists).
 * Returned by {@link AgentsService.listAttachments} so the web tiles
 * can render type-aware icons/labels after a page refresh.
 */
export interface AgentAttachmentListRow extends AgentAttachment {
    filename?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    /**
     * API-routed serve URL (`/api/uploads/<userId>/<hash>.<ext>`), same
     * shape `UploadsService.saveFile` returns at upload time — lets the
     * web tiles stay openable after a refresh. Null when the stored
     * object key can't provide the served filename.
     */
    url?: string | null;
}

export interface UpdateAgentInput {
    name?: string;
    title?: string | null;
    capabilities?: string | null;
    aiProviderId?: string | null;
    modelId?: string | null;
    maxSkillContextTokens?: number;
    heartbeatCadence?: string | null;
    idleBehavior?: AgentIdleBehavior;
    pauseAfterFailures?: number;
    permissions?: Partial<AgentPermissions>;
    targets?: AgentTarget[] | null;
    avatarMode?: AgentAvatarMode;
    avatarIcon?: string | null;
    avatarImageUploadId?: string | null;
    committerName?: string | null;
    committerEmail?: string | null;
}

/**
 * Allowed status transitions (agents/spec.md §3.1 FR-5).
 * draft   → active
 * active ⇄ paused
 * active ⇄ running              (running set by dispatcher CAS-claim)
 * active  → error               (set by dispatcher after threshold)
 * error   → paused
 * paused  → active
 * *       → archived            (soft-delete)
 *
 * Note: `active → running` and `running → active` happen via the
 * repository CAS primitive, not through this service. Service
 * transitions are user-initiated.
 */
const USER_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
    [AgentStatus.DRAFT]: [AgentStatus.ACTIVE, AgentStatus.ARCHIVED],
    [AgentStatus.ACTIVE]: [AgentStatus.PAUSED, AgentStatus.ARCHIVED],
    [AgentStatus.RUNNING]: [AgentStatus.ARCHIVED],
    [AgentStatus.PAUSED]: [AgentStatus.ACTIVE, AgentStatus.ARCHIVED],
    [AgentStatus.ERROR]: [AgentStatus.PAUSED, AgentStatus.ACTIVE, AgentStatus.ARCHIVED],
    [AgentStatus.ARCHIVED]: [],
};

/**
 * Core service for the Agents feature (agents/plan.md §2 services
 * row). Owns CRUD, scope-cascade validation, status transitions,
 * and the `tryClaimForRun → release/incrementError` lifecycle the
 * dispatcher calls.
 *
 * Cross-user reads return 404 (architecture/security §9): never
 * leak existence of another user's Agent via 403.
 */
@Injectable()
export class AgentsService {
    private readonly logger = new Logger(AgentsService.name);

    constructor(
        private readonly agents: AgentRepository,
        private readonly memberships: AgentMembershipRepository,
        // Budget repo is here so `delete()` can clean up the per-Agent
        // budget row alongside (FK CASCADE handles it on DB but having
        // the call here keeps the service-level intent visible).
        private readonly budgets: AgentBudgetRepository,
        // `@Optional()` because hand-rolled tests construct AgentsService
        // without the attachments dep. Production DI provides it via
        // AgentsModule.
        @Optional()
        private readonly agentAttachments?: AgentAttachmentRepository,
        // Parent-existence validation for scoped Agents (work/mission/idea).
        // Raw TypeORM repositories (not the custom repos) so we only need the
        // three entities in `forFeature` — no cross-module/custom-repo deps.
        // `@Optional()` keeps the hand-rolled unit-test surface (which never
        // wires these) working; production + e2e DI provide them so the check
        // runs for every real create.
        @Optional()
        @InjectRepository(Work)
        private readonly workRepo?: Repository<Work>,
        @Optional()
        @InjectRepository(Mission)
        private readonly missionRepo?: Repository<Mission>,
        @Optional()
        @InjectRepository(WorkProposal)
        private readonly ideaRepo?: Repository<WorkProposal>,
        // Upload-ownership validation for addAttachment — `user_uploads` indexes
        // every upload by (userId, sha256). `@Optional()` + raw repo, same as above.
        @Optional()
        @InjectRepository(UserUpload)
        private readonly uploadsRepo?: Repository<UserUpload>,
    ) {}

    async list(
        userId: string,
        filter: ListAgentsFilter = {},
    ): Promise<{
        rows: AgentDto[];
        total: number;
    }> {
        const { rows, total } = await this.agents.findByUserIdScoped(userId, filter);
        return { rows: rows.map(toAgentDto), total };
    }

    async getOne(userId: string, id: string): Promise<AgentDto> {
        const agent = await this.requireOwned(userId, id);
        return toAgentDto(agent);
    }

    async create(userId: string, input: CreateAgentInput): Promise<AgentDto> {
        this.validateScopeOwnership(input);
        await this.assertScopeParentExists(userId, input);

        const slug = slugifyText(input.name);
        // `slugifyText('---')` returns `-` (dash), not the empty string,
        // because slug preservation keeps dashes. We need at least one
        // alphanumeric character in the resulting slug — a slug that's
        // pure punctuation is useless for routing / DB lookup.
        if (!slug || !/[a-z0-9]/i.test(slug)) {
            throw new BadRequestException(
                'Agent name must contain at least one alphanumeric character.',
            );
        }

        const conflict = await this.agents.findByUserIdAndSlug(userId, input.scope, slug, {
            missionId: input.scope === AgentScope.MISSION ? (input.missionId ?? null) : null,
            ideaId: input.scope === AgentScope.IDEA ? (input.ideaId ?? null) : null,
            workId: input.scope === AgentScope.WORK ? (input.workId ?? null) : null,
        });
        if (conflict) {
            throw new ConflictException(
                `An Agent named "${input.name}" already exists in this scope.`,
            );
        }

        const permissions: AgentPermissions = {
            ...AGENT_PERMISSIONS_DEFAULT,
            ...(input.permissions ?? {}),
        };
        // Refine: openPullRequests requires canCommitToRepo.
        if (permissions.canOpenPullRequests && !permissions.canCommitToRepo) {
            permissions.canCommitToRepo = true;
        }

        const avatarMode = input.avatarMode ?? AgentAvatarMode.INITIALS;
        this.validateAvatarFields(
            avatarMode,
            input.avatarIcon ?? null,
            input.avatarImageUploadId ?? null,
        );
        this.validateHeartbeatCadence(input.heartbeatCadence ?? null);

        const created = await this.agents
            .create({
                userId,
                scope: input.scope,
                missionId: input.scope === AgentScope.MISSION ? (input.missionId ?? null) : null,
                ideaId: input.scope === AgentScope.IDEA ? (input.ideaId ?? null) : null,
                workId: input.scope === AgentScope.WORK ? (input.workId ?? null) : null,
                name: input.name,
                slug,
                title: input.title ?? null,
                capabilities: input.capabilities ?? null,
                aiProviderId: input.aiProviderId ?? null,
                modelId: input.modelId ?? null,
                maxSkillContextTokens: input.maxSkillContextTokens ?? 4000,
                status: AgentStatus.DRAFT,
                permissions,
                targets: input.targets ?? null,
                heartbeatCadence: input.heartbeatCadence ?? null,
                idleBehavior: input.idleBehavior ?? AgentIdleBehavior.PROPOSE,
                pauseAfterFailures: input.pauseAfterFailures ?? 3,
                errorCount: 0,
                avatarMode,
                avatarIcon: avatarMode === AgentAvatarMode.ICON ? (input.avatarIcon ?? null) : null,
                avatarImageUploadId:
                    avatarMode === AgentAvatarMode.IMAGE
                        ? (input.avatarImageUploadId ?? null)
                        : null,
                // FU-13 — committer identity. Empty strings normalise to
                // null so a blank picker field doesn't accidentally persist
                // a no-op commit identity.
                committerName: input.committerName?.trim() ? input.committerName.trim() : null,
                committerEmail: input.committerEmail?.trim() ? input.committerEmail.trim() : null,
            })
            .catch((err: unknown) => {
                // A concurrent same-name create burst can pass the existence
                // pre-check above for every racer; the unique index then lets
                // exactly one INSERT win and rejects the rest. Translate that lost
                // race into the SAME named 409 a sequential duplicate would get,
                // instead of leaking a raw 500 DB error.
                if (isUniqueConstraintError(err)) {
                    throw new ConflictException(
                        `An Agent named "${input.name}" already exists in this scope.`,
                    );
                }
                throw err;
            });

        // Materialize tenant-Agent memberships into the join table for
        // indexed lookup from the per-target tabs.
        if (input.scope === AgentScope.TENANT && input.targets && input.targets.length > 0) {
            await this.memberships.replaceForAgent(
                created.id,
                input.targets
                    .filter((t) => t.type !== 'wildcard')
                    .map((t) => ({
                        targetType: t.type,
                        targetId: t.id ?? null,
                    })),
            );
        }

        return toAgentDto(created);
    }

    async update(userId: string, id: string, input: UpdateAgentInput): Promise<AgentDto> {
        const agent = await this.requireOwned(userId, id);

        const patch: Partial<Agent> = {};

        if (input.name !== undefined) {
            const slug = slugifyText(input.name);
            if (!slug || !/[a-z0-9]/i.test(slug)) {
                throw new BadRequestException(
                    'Agent name must contain at least one alphanumeric character.',
                );
            }
            if (slug !== agent.slug) {
                const conflict = await this.agents.findByUserIdAndSlug(userId, agent.scope, slug, {
                    missionId: agent.missionId ?? null,
                    ideaId: agent.ideaId ?? null,
                    workId: agent.workId ?? null,
                });
                if (conflict && conflict.id !== agent.id) {
                    throw new ConflictException(
                        `An Agent named "${input.name}" already exists in this scope.`,
                    );
                }
                patch.slug = slug;
            }
            patch.name = input.name;
        }

        if (input.title !== undefined) patch.title = input.title;
        if (input.capabilities !== undefined) patch.capabilities = input.capabilities;
        if (input.aiProviderId !== undefined) patch.aiProviderId = input.aiProviderId;
        if (input.modelId !== undefined) patch.modelId = input.modelId;
        if (input.maxSkillContextTokens !== undefined)
            patch.maxSkillContextTokens = input.maxSkillContextTokens;
        if (input.heartbeatCadence !== undefined) {
            this.validateHeartbeatCadence(input.heartbeatCadence);
            patch.heartbeatCadence = input.heartbeatCadence;
            if (agent.status === AgentStatus.ACTIVE) {
                patch.nextHeartbeatAt =
                    input.heartbeatCadence && input.heartbeatCadence !== 'manual'
                        ? computeNextHeartbeat(input.heartbeatCadence, new Date())
                        : null;
            }
        }
        if (input.idleBehavior !== undefined) patch.idleBehavior = input.idleBehavior;
        if (input.pauseAfterFailures !== undefined)
            patch.pauseAfterFailures = input.pauseAfterFailures;

        if (input.permissions !== undefined) {
            const merged: AgentPermissions = { ...agent.permissions, ...input.permissions };
            if (merged.canOpenPullRequests && !merged.canCommitToRepo) {
                merged.canCommitToRepo = true;
            }
            patch.permissions = merged;
        }

        if (input.targets !== undefined) {
            patch.targets = input.targets;
        }

        if (
            input.avatarMode !== undefined ||
            input.avatarIcon !== undefined ||
            input.avatarImageUploadId !== undefined
        ) {
            const mode = input.avatarMode ?? agent.avatarMode;
            const icon =
                input.avatarIcon !== undefined ? input.avatarIcon : (agent.avatarIcon ?? null);
            const upload =
                input.avatarImageUploadId !== undefined
                    ? input.avatarImageUploadId
                    : (agent.avatarImageUploadId ?? null);
            this.validateAvatarFields(mode, icon, upload);
            patch.avatarMode = mode;
            patch.avatarIcon = mode === AgentAvatarMode.ICON ? icon : null;
            patch.avatarImageUploadId = mode === AgentAvatarMode.IMAGE ? upload : null;
        }

        // FU-13 — committer identity (each field independent so an
        // operator can override just the email without re-typing the
        // name). Empty-string normalises to null.
        if (input.committerName !== undefined) {
            const trimmed = input.committerName?.trim() ?? '';
            patch.committerName = trimmed.length > 0 ? trimmed : null;
        }
        if (input.committerEmail !== undefined) {
            const trimmed = input.committerEmail?.trim() ?? '';
            patch.committerEmail = trimmed.length > 0 ? trimmed : null;
        }

        await this.agents.updateById(id, patch);

        // Reconcile memberships if targets changed.
        if (input.targets !== undefined && agent.scope === AgentScope.TENANT) {
            await this.memberships.replaceForAgent(
                id,
                (input.targets ?? [])
                    .filter((t) => t.type !== 'wildcard')
                    .map((t) => ({ targetType: t.type, targetId: t.id ?? null })),
            );
        }

        const refreshed = await this.agents.findById(id);
        if (!refreshed) throw new NotFoundException('Agent vanished after update');
        return toAgentDto(refreshed);
    }

    async transition(userId: string, id: string, to: AgentStatus): Promise<AgentDto> {
        const agent = await this.requireOwned(userId, id);
        const allowed = USER_TRANSITIONS[agent.status] ?? [];
        if (!allowed.includes(to)) {
            throw new BadRequestException(`Cannot transition Agent from ${agent.status} to ${to}.`);
        }
        const ok = await this.agents.transitionStatus(id, agent.status, to);
        if (!ok) {
            throw new ConflictException('Agent status changed between read and write — retry.');
        }
        // Activating from draft schedules first heartbeat.
        // Review-fix I17: compute the FIRST cadence slot via
        // `computeNextHeartbeat` instead of setting it to `now`. The
        // previous behavior fired the first heartbeat ~immediately on
        // activation regardless of cadence (e.g. an Agent on
        // `0 9 * * *` activated at 14:30 would fire a stray run at
        // 14:30, then again the next morning at 09:00). Now the first
        // scheduled fire genuinely respects the configured cadence.
        // Fallback to `now` if the cadence is unparseable so a
        // misconfigured Agent doesn't get stuck without scheduling.
        if (
            to === AgentStatus.ACTIVE &&
            agent.heartbeatCadence &&
            agent.heartbeatCadence !== 'manual'
        ) {
            const next = computeNextHeartbeat(agent.heartbeatCadence, new Date()) ?? new Date();
            await this.agents.updateById(id, { nextHeartbeatAt: next });
        }
        const refreshed = await this.agents.findById(id);
        if (!refreshed) throw new NotFoundException('Agent vanished after transition');
        return toAgentDto(refreshed);
    }

    async pause(userId: string, id: string): Promise<AgentDto> {
        return this.transition(userId, id, AgentStatus.PAUSED);
    }

    async resume(userId: string, id: string): Promise<AgentDto> {
        return this.transition(userId, id, AgentStatus.ACTIVE);
    }

    async archive(userId: string, id: string): Promise<{ archived: true }> {
        await this.requireOwned(userId, id);
        await this.agents.archiveById(id);
        return { archived: true };
    }

    async deleteHard(userId: string, id: string): Promise<{ deleted: true }> {
        await this.requireOwned(userId, id);
        await this.budgets.deleteByAgentId(id).catch(() => undefined); // FK CASCADE handles it; tolerate
        await this.memberships.deleteByAgentId(id).catch(() => undefined);
        await this.agents.deleteById(id);
        return { deleted: true };
    }

    /**
     * List the Upload edges attached to an Agent. Same shape as the
     * Mission / Idea attachment surfaces, plus joined `user_uploads`
     * metadata (filename / mimeType / size) when available — without
     * it the web attachment tiles can only render a generic file icon
     * after a page refresh (the client-side filename/MIME cache only
     * covers in-session uploads).
     */
    async listAttachments(userId: string, id: string): Promise<AgentAttachmentListRow[]> {
        await this.requireOwned(userId, id);
        if (!this.agentAttachments) return [];
        const rows = await this.agentAttachments.findByAgentId(id);
        if (rows.length === 0 || !this.uploadsRepo) return rows;
        // `user_uploads` is deduped per (userId, sha256); addAttachment
        // already enforces the upload is owned by the caller, so the
        // owner-scoped lookup resolves every attachable upload.
        const uploads = await this.uploadsRepo.find({
            where: { userId, sha256: In(rows.map((r) => r.uploadId)) },
        });
        const bySha = new Map(uploads.map((u) => [u.sha256, u]));
        return rows.map((r) => {
            const u = bySha.get(r.uploadId);
            if (!u) return r;
            // The storage key ends with the served filename
            // (`<sha256>.<ext>` — see UploadsService.saveFile), which is
            // what the owner-gated serve route keys on. Slice it off at
            // the hash (rather than splitting on `/`) so per-Work keys
            // like `dr:<workId>:<name>` resolve too, then rebuild the
            // same API-routed URL saveFile returned at upload time,
            // including the `?workId=` round-trip for those backends.
            const nameAt = u.storagePath.lastIndexOf(u.sha256);
            const servedName = nameAt >= 0 ? u.storagePath.slice(nameAt) : '';
            let url: string | null = null;
            if (servedName) {
                url = u.workId
                    ? `/api/uploads/${encodeURIComponent(userId)}/${servedName}?workId=${encodeURIComponent(u.workId)}`
                    : `/api/uploads/${encodeURIComponent(userId)}/${servedName}`;
            }
            return {
                ...r,
                filename: u.originalFilename ?? null,
                mimeType: u.mimeType ?? null,
                // bigint columns come back as strings from the pg driver.
                sizeBytes: u.fileSize == null ? null : Number(u.fileSize),
                url,
            };
        });
    }

    /** Attach an uploaded file to an Agent. Idempotent. */
    async addAttachment(userId: string, id: string, uploadId: string): Promise<AgentAttachment> {
        await this.requireOwned(userId, id);
        if (!uploadId || !SHA256_RE.test(uploadId)) {
            throw new BadRequestException(`Invalid uploadId`);
        }
        // Security: the uploadId must reference a real upload owned by the
        // caller — without this a ghost/foreign id persisted a dangling
        // attachment edge. `user_uploads` records every upload by (userId,
        // sha256). 404 (not 403) — don't leak whether the upload exists.
        if (this.uploadsRepo) {
            // sha256 is a case-insensitive content hash stored lowercase; the DTO
            // accepts /i, so normalize before the ownership lookup.
            const owned = await this.uploadsRepo.findOne({
                where: { sha256: uploadId.toLowerCase(), userId },
            });
            if (!owned) throw new NotFoundException(`Upload ${uploadId} not found.`);
        }
        if (!this.agentAttachments) {
            throw new BadRequestException(
                `AgentAttachmentRepository is not wired — attach the AgentAttachment provider before calling addAttachment`,
            );
        }
        try {
            return await this.agentAttachments.add(id, uploadId);
        } catch (err) {
            if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
                const existing = (await this.agentAttachments.findByAgentId(id)).find(
                    (a) => a.uploadId === uploadId,
                );
                if (existing) return existing;
            }
            throw err;
        }
    }

    /** Detach an Upload from an Agent. */
    async removeAttachment(
        userId: string,
        id: string,
        attachmentId: string,
    ): Promise<{ deleted: true }> {
        await this.requireOwned(userId, id);
        if (!this.agentAttachments) {
            throw new NotFoundException(`Attachment not found`);
        }
        const row = await this.agentAttachments.findOne(attachmentId);
        if (!row || row.agentId !== id) {
            throw new NotFoundException(`Attachment not found`);
        }
        await this.agentAttachments.remove(attachmentId);
        return { deleted: true };
    }

    // ── internals ─────────────────────────────────────────────────

    private async requireOwned(userId: string, id: string): Promise<Agent> {
        const agent = await this.agents.findByIdAndUser(id, userId);
        if (!agent) {
            // 404 (not 403) — don't leak existence.
            throw new NotFoundException(`Agent ${id} not found.`);
        }
        return agent;
    }

    private validateScopeOwnership(
        input: Pick<CreateAgentInput, 'scope' | 'missionId' | 'ideaId' | 'workId'>,
    ): void {
        const popCount = [input.missionId, input.ideaId, input.workId].filter(Boolean).length;
        switch (input.scope) {
            case AgentScope.TENANT:
                if (popCount > 0) {
                    throw new BadRequestException(
                        'Tenant-scoped Agents must not have missionId/ideaId/workId.',
                    );
                }
                break;
            case AgentScope.MISSION:
                if (!input.missionId || popCount !== 1) {
                    throw new BadRequestException(
                        'Mission-scoped Agents require missionId (and only missionId).',
                    );
                }
                break;
            case AgentScope.IDEA:
                if (!input.ideaId || popCount !== 1) {
                    throw new BadRequestException(
                        'Idea-scoped Agents require ideaId (and only ideaId).',
                    );
                }
                break;
            case AgentScope.WORK:
                if (!input.workId || popCount !== 1) {
                    throw new BadRequestException(
                        'Work-scoped Agents require workId (and only workId).',
                    );
                }
                break;
            default:
                throw new BadRequestException(`Unknown scope: ${input.scope}`);
        }
    }

    /**
     * Security (IDOR / dangling-FK): `validateScopeOwnership` only checks scope
     * CARDINALITY — it never confirmed the referenced parent actually exists or
     * belongs to the caller, so a work/mission/idea-scoped Agent could be created
     * against a ghost or another user's id (201). Look the parent up scoped to the
     * caller and 404 (not 403 — don't leak existence) when it's missing. Resolved
     * via raw `findOne({ where: { id, userId } })` so a cross-user parent reads as
     * not-found, matching the rest of the Agents surface.
     */
    private async assertScopeParentExists(
        userId: string,
        input: Pick<CreateAgentInput, 'scope' | 'missionId' | 'ideaId' | 'workId'>,
    ): Promise<void> {
        switch (input.scope) {
            case AgentScope.WORK: {
                if (!input.workId || !this.workRepo) return;
                const work = await this.workRepo.findOne({
                    where: { id: input.workId, userId },
                });
                if (!work) throw new NotFoundException(`Work ${input.workId} not found.`);
                break;
            }
            case AgentScope.MISSION: {
                if (!input.missionId || !this.missionRepo) return;
                const mission = await this.missionRepo.findOne({
                    where: { id: input.missionId, userId },
                });
                if (!mission) throw new NotFoundException(`Mission ${input.missionId} not found.`);
                break;
            }
            case AgentScope.IDEA: {
                if (!input.ideaId || !this.ideaRepo) return;
                const idea = await this.ideaRepo.findOne({
                    where: { id: input.ideaId, userId },
                });
                if (!idea) throw new NotFoundException(`Idea ${input.ideaId} not found.`);
                break;
            }
            default:
                // Tenant-scoped Agents have no parent row to validate.
                break;
        }
    }

    private validateAvatarFields(
        mode: AgentAvatarMode,
        icon: string | null,
        uploadId: string | null,
    ): void {
        if (mode === AgentAvatarMode.ICON && !icon) {
            throw new BadRequestException('avatarIcon required when avatarMode=icon');
        }
        if (mode === AgentAvatarMode.IMAGE && !uploadId) {
            throw new BadRequestException('avatarImageUploadId required when avatarMode=image');
        }
    }

    private validateHeartbeatCadence(cadence: string | null | undefined): void {
        if (!cadence || cadence === 'manual') return;
        if (!computeNextHeartbeat(cadence, new Date())) {
            throw new BadRequestException(
                `Invalid heartbeatCadence "${cadence}". Use "manual", null, or a supported cron expression.`,
            );
        }
    }

    /**
     * Authorization helper for "Agent X assigns work to Agent Y" —
     * enforces the cross-scope rules in architecture §3. Used by the
     * tools-catalog `createTask` tool gate. Returns silently when OK,
     * throws ForbiddenException otherwise.
     *
     * Exported so other services (TaskTransitionService, mention
     * dispatch) can reuse it.
     */
    async assertCanAssignAcrossScope(actor: Agent, target: Agent): Promise<void> {
        if (actor.userId !== target.userId) {
            throw new ForbiddenException('Cross-user task assignment is not allowed.');
        }
        switch (actor.scope) {
            case AgentScope.TENANT:
                return; // Tenant can assign to any Agent the user owns.
            case AgentScope.MISSION:
                if (target.scope === AgentScope.MISSION && target.missionId === actor.missionId)
                    return;
                if (target.scope === AgentScope.IDEA && target.missionId === actor.missionId)
                    return;
                if (target.scope === AgentScope.WORK && target.missionId === actor.missionId)
                    return;
                throw new ForbiddenException(
                    'Mission-scoped Agents can only assign within their Mission.',
                );
            case AgentScope.IDEA:
                if (target.scope === AgentScope.IDEA && target.ideaId === actor.ideaId) return;
                if (target.scope === AgentScope.MISSION && target.missionId === actor.missionId)
                    return;
                if (target.scope === AgentScope.WORK && target.ideaId === actor.ideaId) return;
                throw new ForbiddenException(
                    'Idea-scoped Agents can only assign within their Idea.',
                );
            case AgentScope.WORK:
                if (target.scope === AgentScope.WORK && target.workId === actor.workId) return;
                throw new ForbiddenException(
                    'Work-scoped Agents can only assign within their Work.',
                );
        }
    }
}
