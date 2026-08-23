import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    UnprocessableEntityException,
} from '@nestjs/common';
import {
    AGENT_PERMISSIONS_DEFAULT,
    Agent,
    AgentAvatarMode,
    AgentIdleBehavior,
    type AgentPermissions,
    AgentScope,
    type AgentScorecardMetric,
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
import { Environment } from '../entities/environment.entity';
import { AgentRepository, type ListAgentsFilter } from '../database/repositories/agent.repository';
import { AgentMembershipRepository } from '../database/repositories/agent-membership.repository';
import { AgentBudgetRepository } from '../database/repositories/agent-budget.repository';
import { AgentAttachmentRepository } from '../database/repositories/attachment.repositories';
import { slugifyText } from '../utils/text.utils';
import { isUniqueConstraintError } from '../utils/db-error.utils';
import { toAgentDto, type AgentDto } from './types';
import { computeNextHeartbeat } from './heartbeat-cron';
import { validateScorecard } from './scorecard';
import { validateGuardrails, type AgentGuardrails } from './guardrails';
// Merge-policy matrix (Wave 3, D4). The sanitizer is a pure contracts
// helper (no Nest graph, no DB), so the agents module gains no runtime
// dependency on the policy module.
import {
    AGENT_INIT_SCRIPT_MAX_BYTES,
    sanitizeMergePolicyOverride,
    type MergePolicyOverride,
} from '@ever-works/contracts';
// Capabilities tab — the init script is deliberate authoring (like the
// five canonical Agent files), so a secret-like value is hard-rejected
// rather than redacted.
import { assertNoSecrets } from '../utils/secret-scan';
import {
    ownershipStamp,
    ownershipWhereWith,
    type OwnershipScope,
} from '../database/ownership-scope';

// Upload IDs are SHA-256 hex strings (the `id` field returned by
// POST /api/uploads/file). 64 lowercase hex chars — NOT UUID-shaped
// (Codex + Greptile P1 on PR #1044).
const SHA256_RE = /^[0-9a-f]{64}$/i;
const SUPPORTED_AGENT_TARGET_TYPES = new Set(['mission', 'idea', 'work', 'wildcard']);

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
    /**
     * Environments (Settings → Environments) — assigned runtime
     * Environment id. Must belong to the same user and be `published`
     * (draft assignment is a 422); null/unset = platform default.
     */
    environmentId?: string | null;
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
    /**
     * Memory recall injection toggle (memory upgrades M2). Recall is
     * on by default; `false` disables the prompt splice for this Agent.
     */
    memoryRecallEnabled?: boolean;
    heartbeatCadence?: string | null;
    idleBehavior?: AgentIdleBehavior;
    pauseAfterFailures?: number;
    permissions?: Partial<AgentPermissions>;
    targets?: AgentTarget[] | null;
    /**
     * Direct manager for the Org Chart (teams-and-companies spec §1.2).
     * Null clears it. Same-user + acyclicity validated in update().
     */
    reportsToAgentId?: string | null;
    avatarMode?: AgentAvatarMode;
    avatarIcon?: string | null;
    avatarImageUploadId?: string | null;
    committerName?: string | null;
    committerEmail?: string | null;
    /**
     * Environments (Settings → Environments) — assigned runtime
     * Environment id. Must belong to the same user and be `published`
     * (draft assignment is a 422); `null` clears back to the platform
     * default runtime.
     */
    environmentId?: string | null;
    /**
     * Agent Scorecards increment 1 — replace the whole scorecard
     * (null clears it). Validated via `validateScorecard`.
     */
    scorecard?: AgentScorecardMetric[] | null;
    /**
     * Merge-policy matrix (Wave 3, D4) — this Agent's slice, the MOST
     * specific scope. A PARTIAL object is normal (resolution is
     * field-by-field); `null` clears the Agent override so it inherits
     * the Work / organization / tenant / platform default.
     *
     * Distinct from `permissions.canOpenPullRequests`, which governs
     * OPENING a PR; this governs LANDING one.
     */
    mergePolicy?: MergePolicyOverride | null;
    /**
     * Capabilities tab — per-Agent init script (advisory v1). `null`
     * or a blank string clears it. Capped at 16 KB, secret-scanned
     * (hard-reject) on write.
     */
    initScript?: string | null;
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

    /**
     * How many times `addTarget` / `removeTarget` re-read and retry their
     * CAS write before giving up. Two operators editing the same Agent's
     * reach at once is the realistic contention (the Work header picker
     * and the Agent detail page); past a few rounds it's a hot row we'd
     * rather report as a conflict than spin on.
     */
    private static readonly TARGETS_CAS_ATTEMPTS = 3;

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
        // Environments — assignment validation (same-user + published).
        // `@Optional()` + raw repo, same posture as the scope-parent
        // validators above; production + e2e DI provide it via the
        // `Environment` forFeature entry in AgentsModule.
        @Optional()
        @InjectRepository(Environment)
        private readonly environmentRepo?: Repository<Environment>,
    ) {}

    async list(
        userId: string,
        filter: ListAgentsFilter = {},
        ownershipScope?: OwnershipScope,
    ): Promise<{
        rows: AgentDto[];
        total: number;
    }> {
        const { rows, total } = await this.agents.findByUserIdScoped(
            userId,
            filter,
            ownershipScope,
        );
        return { rows: rows.map(toAgentDto), total };
    }

    async getOne(userId: string, id: string, ownershipScope?: OwnershipScope): Promise<AgentDto> {
        const agent = await this.requireOwned(userId, id, ownershipScope);
        return toAgentDto(agent);
    }

    async create(
        userId: string,
        input: CreateAgentInput,
        ownershipScope?: OwnershipScope,
    ): Promise<AgentDto> {
        this.validateScopeOwnership(input);
        await this.assertScopeParentExists(userId, input, ownershipScope);
        await this.assertTargetsExist(userId, input.targets, ownershipScope);

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

        const conflict = await this.agents.findByUserIdAndSlug(
            userId,
            input.scope,
            slug,
            {
                missionId: input.scope === AgentScope.MISSION ? (input.missionId ?? null) : null,
                ideaId: input.scope === AgentScope.IDEA ? (input.ideaId ?? null) : null,
                workId: input.scope === AgentScope.WORK ? (input.workId ?? null) : null,
            },
            ownershipScope,
        );
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
        if (input.environmentId) {
            await this.assertAssignableEnvironment(userId, input.environmentId, ownershipScope);
        }

        const created = await this.agents
            .create({
                userId,
                ...ownershipStamp(ownershipScope),
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
                // Environments — validated above (same-user + published).
                environmentId: input.environmentId ?? null,
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

        // Materialize memberships into the join table for indexed lookup
        // from the per-target tabs. Every scope, not just tenant: an
        // Agent pinned to one Work can be lent to another (see
        // `addTarget`), and the index is what those surfaces read.
        if (input.targets && input.targets.length > 0) {
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

    async update(
        userId: string,
        id: string,
        input: UpdateAgentInput,
        ownershipScope?: OwnershipScope,
    ): Promise<AgentDto> {
        const agent = await this.requireOwned(userId, id, ownershipScope);

        const patch: Partial<Agent> = {};

        if (input.name !== undefined) {
            const slug = slugifyText(input.name);
            if (!slug || !/[a-z0-9]/i.test(slug)) {
                throw new BadRequestException(
                    'Agent name must contain at least one alphanumeric character.',
                );
            }
            if (slug !== agent.slug) {
                const conflict = await this.agents.findByUserIdAndSlug(
                    userId,
                    agent.scope,
                    slug,
                    {
                        missionId: agent.missionId ?? null,
                        ideaId: agent.ideaId ?? null,
                        workId: agent.workId ?? null,
                    },
                    ownershipScope,
                );
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

        // Environments — null clears back to the platform default; a
        // non-null id must be the caller's own PUBLISHED Environment
        // (draft → 422, cross-user/unknown → 404; rule is server-side so
        // tool/import callers can't bypass the UI filter).
        if (input.environmentId !== undefined) {
            if (input.environmentId !== null) {
                await this.assertAssignableEnvironment(userId, input.environmentId, ownershipScope);
            }
            patch.environmentId = input.environmentId;
        }
        if (input.maxSkillContextTokens !== undefined)
            patch.maxSkillContextTokens = input.maxSkillContextTokens;
        if (input.memoryRecallEnabled !== undefined)
            patch.memoryRecallEnabled = input.memoryRecallEnabled;
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
            await this.assertTargetsExist(userId, input.targets, ownershipScope);
            patch.targets = input.targets;
        }

        if (input.reportsToAgentId !== undefined) {
            if (input.reportsToAgentId !== null) {
                await this.assertValidReportsTo(
                    userId,
                    agent,
                    input.reportsToAgentId,
                    ownershipScope,
                );
            }
            patch.reportsToAgentId = input.reportsToAgentId;
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

        // Agent Scorecards increment 1 — whole-array replace; null (or an
        // empty array) clears the scorecard. `validateScorecard` is the
        // defense-in-depth check behind the DTO layer (tools/import callers
        // reach this service without class-validator).
        if (input.scorecard !== undefined) {
            if (input.scorecard !== null) {
                const problem = validateScorecard(input.scorecard);
                if (problem) throw new BadRequestException(problem);
            }
            patch.scorecard =
                input.scorecard && input.scorecard.length > 0 ? input.scorecard : null;
        }

        // Merge-policy matrix (Wave 3, D4) — whole-object replace at THIS
        // scope; `null` (or an empty object) clears the Agent override so
        // resolution falls through to the Work / org / tenant / platform
        // default. `sanitizeMergePolicyOverride` is the defense-in-depth
        // check behind the DTO layer (tool/import callers reach this
        // service without class-validator) and drops unknown values rather
        // than coercing them to something permissive.
        if (input.mergePolicy !== undefined) {
            if (input.mergePolicy === null) {
                patch.mergePolicy = null;
            } else {
                const sanitized = sanitizeMergePolicyOverride(input.mergePolicy);
                patch.mergePolicy = Object.keys(sanitized).length > 0 ? sanitized : null;
            }
        }

        // Capabilities tab — init script. Same posture as the five
        // canonical Agent files (deliberate authoring surface): 16 KB
        // byte cap + hard-reject secret scan. Blank normalises to null so
        // an emptied editor clears the column instead of storing "".
        if (input.initScript !== undefined) {
            if (input.initScript === null || input.initScript.trim().length === 0) {
                patch.initScript = null;
            } else {
                const bytes = Buffer.byteLength(input.initScript, 'utf8');
                if (bytes > AGENT_INIT_SCRIPT_MAX_BYTES) {
                    throw new BadRequestException(
                        `Init script is ${Math.round(bytes / 1024)} KB; max ${
                            AGENT_INIT_SCRIPT_MAX_BYTES / 1024
                        } KB.`,
                    );
                }
                assertNoSecrets(input.initScript, 'Agent init script');
                patch.initScript = input.initScript;
            }
        }

        await this.agents.updateById(id, patch);

        // Reconcile memberships if targets changed — every scope, for the
        // same reason `create` materializes them for every scope.
        if (input.targets !== undefined) {
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

    /**
     * Add ONE reach target to an Agent (idempotent).
     *
     * The read-modify-write of the whole `targets` array lives here
     * rather than in the caller: the Work header's "Assign existing
     * Agent" picker only knows the Work it is attaching to, and making
     * it PATCH the full array would mean two round-trips racing every
     * other editor of the same Agent.
     *
     * The write goes through `casUpdateTargets` rather than a plain
     * update: a concurrent writer that committed between our read and
     * our write loses its target otherwise, while the membership row it
     * already wrote survives — leaving `agent_memberships` (what the
     * `assignedWorkId` filter reads) disagreeing with `AgentDto.targets`.
     * A lost CAS re-reads and recomputes, and the membership write only
     * happens on the attempt whose array actually landed.
     *
     * Any owned Agent can be lent out, whatever its own scope — an
     * operator whose Agents were all created from a Work would otherwise
     * have nothing to assign. The one thing rejected is lending an Agent
     * to the parent it is ALREADY pinned to, which would record reach it
     * has by scope and then let `removeTarget` appear to revoke it.
     */
    async addTarget(
        userId: string,
        id: string,
        target: AgentTarget,
        ownershipScope?: OwnershipScope,
    ): Promise<AgentDto> {
        let agent = await this.requireOwned(userId, id, ownershipScope);
        await this.assertTargetExists(userId, target, ownershipScope);

        for (let attempt = 0; attempt < AgentsService.TARGETS_CAS_ATTEMPTS; attempt++) {
            this.assertNotOwnScopeParent(agent, target);

            const current = agent.targets ?? [];
            if (
                current.some(
                    (t) => t.type === target.type && (t.id ?? null) === (target.id ?? null),
                )
            ) {
                return toAgentDto(agent);
            }

            // Both writes in ONE transaction: a membership insert that
            // fails after a won CAS would otherwise leave `targets`
            // claiming reach that `agent_memberships` (what the
            // `assignedWorkId` filter reads) has no row for.
            const won = await this.agents.withTransaction(async (manager) => {
                const landed = await this.agents.casUpdateTargets(
                    id,
                    agent.targets ?? null,
                    [...current, target],
                    manager,
                );
                if (!landed) {
                    return false;
                }
                if (target.type !== 'wildcard') {
                    await this.memberships.addMembership(
                        id,
                        target.type,
                        target.id ?? null,
                        manager,
                    );
                }
                return true;
            });
            if (!won) {
                agent = await this.requireOwned(userId, id, ownershipScope);
                continue;
            }

            const refreshed = await this.agents.findById(id);
            if (!refreshed) throw new NotFoundException('Agent vanished after update');
            return toAgentDto(refreshed);
        }

        throw new ConflictException(
            `Agent ${id} is being reassigned by someone else — retry the assignment.`,
        );
    }

    /**
     * Remove ONE reach target from an Agent (idempotent — removing a
     * target the Agent never had is a no-op, not a 404).
     */
    async removeTarget(
        userId: string,
        id: string,
        target: AgentTarget,
        ownershipScope?: OwnershipScope,
    ): Promise<AgentDto> {
        let agent = await this.requireOwned(userId, id, ownershipScope);
        this.assertTargetShape(target);

        for (let attempt = 0; attempt < AgentsService.TARGETS_CAS_ATTEMPTS; attempt++) {
            const current = agent.targets ?? [];
            const next = current.filter(
                (t) => !(t.type === target.type && (t.id ?? null) === (target.id ?? null)),
            );

            // One transaction for the CAS + the membership delete, so a
            // failure on either leaves both untouched rather than
            // stranding a membership row for a target `targets` no
            // longer lists (or vice versa).
            const won = await this.agents.withTransaction(async (manager) => {
                if (next.length !== current.length) {
                    const landed = await this.agents.casUpdateTargets(
                        id,
                        agent.targets ?? null,
                        next.length > 0 ? next : null,
                        manager,
                    );
                    if (!landed) {
                        return false;
                    }
                }

                // Unconditional even when `targets` never listed it —
                // this is also the repair path for a membership row left
                // behind by an older non-atomic write.
                if (target.type !== 'wildcard') {
                    await this.memberships.removeMembership(
                        id,
                        target.type,
                        target.id ?? null,
                        manager,
                    );
                }
                return true;
            });
            if (!won) {
                agent = await this.requireOwned(userId, id, ownershipScope);
                continue;
            }

            const refreshed = await this.agents.findById(id);
            if (!refreshed) throw new NotFoundException('Agent vanished after update');
            return toAgentDto(refreshed);
        }

        throw new ConflictException(
            `Agent ${id} is being reassigned by someone else — retry the unassignment.`,
        );
    }

    /**
     * An Agent already reaches the parent it is scoped to; recording that
     * as a target would double-count the relationship and hand the caller
     * an "unassign" it cannot honor.
     */
    private assertNotOwnScopeParent(agent: Agent, target: AgentTarget): void {
        const ownParent =
            (agent.scope === AgentScope.WORK && target.type === 'work' && agent.workId) ||
            (agent.scope === AgentScope.MISSION && target.type === 'mission' && agent.missionId) ||
            (agent.scope === AgentScope.IDEA && target.type === 'idea' && agent.ideaId);
        if (ownParent && ownParent === target.id) {
            throw new BadRequestException(
                `Agent "${agent.name}" already belongs to this ${target.type} by scope.`,
            );
        }
    }

    /**
     * The target row must exist AND belong to the caller — otherwise an
     * assignment would advertise reach into someone else's Work (and
     * `findOne({ id, userId })` returning null is also how we avoid
     * confirming that another user's Work exists).
     */
    private async assertTargetExists(
        userId: string,
        target: AgentTarget,
        ownershipScope?: OwnershipScope,
    ): Promise<void> {
        this.assertTargetShape(target);
        switch (target.type) {
            case 'work':
                await this.assertScopeParentExists(
                    userId,
                    {
                        scope: AgentScope.WORK,
                        workId: target.id,
                    },
                    ownershipScope,
                );
                break;
            case 'mission':
                await this.assertScopeParentExists(
                    userId,
                    {
                        scope: AgentScope.MISSION,
                        missionId: target.id,
                    },
                    ownershipScope,
                );
                break;
            case 'idea':
                await this.assertScopeParentExists(
                    userId,
                    {
                        scope: AgentScope.IDEA,
                        ideaId: target.id,
                    },
                    ownershipScope,
                );
                break;
            case 'wildcard':
                break;
            default:
                throw new BadRequestException('Agent target type is invalid.');
        }
    }

    private assertTargetShape(target: AgentTarget): void {
        if (
            !target ||
            typeof target !== 'object' ||
            typeof target.type !== 'string' ||
            !SUPPORTED_AGENT_TARGET_TYPES.has(target.type)
        ) {
            throw new BadRequestException('Agent target type is invalid.');
        }
        if (
            target.type !== 'wildcard' &&
            (typeof target.id !== 'string' || target.id.trim().length === 0)
        ) {
            throw new BadRequestException(`Agent ${target.type} target requires an id.`);
        }
    }

    /** Bulk create/PATCH targets must pass the same exact-scope gate as addTarget. */
    private async assertTargetsExist(
        userId: string,
        targets: AgentTarget[] | null | undefined,
        ownershipScope?: OwnershipScope,
    ): Promise<void> {
        if (!targets?.length) return;
        await Promise.all(
            targets.map((target) => this.assertTargetExists(userId, target, ownershipScope)),
        );
    }

    /**
     * Replace the Agent's dispatch guardrails (PUT semantics — the
     * whole policy object is swapped; `null` clears back to the
     * default queue-everything posture).
     *
     * Defense-in-depth: the API DTO already shape-checks the body, but
     * the service re-runs the pure `validateGuardrails` so non-HTTP
     * callers (import surfaces, future tools) get the same contract.
     */
    async setGuardrails(
        userId: string,
        id: string,
        guardrails: AgentGuardrails | null,
        ownershipScope?: OwnershipScope,
    ): Promise<AgentDto> {
        await this.requireOwned(userId, id, ownershipScope);
        if (guardrails !== null) {
            const violation = validateGuardrails(guardrails);
            if (violation) {
                throw new BadRequestException(violation);
            }
        }
        await this.agents.updateById(id, { guardrails });
        const refreshed = await this.agents.findById(id);
        if (!refreshed) throw new NotFoundException('Agent vanished after update');
        return toAgentDto(refreshed);
    }

    async transition(
        userId: string,
        id: string,
        to: AgentStatus,
        ownershipScope?: OwnershipScope,
    ): Promise<AgentDto> {
        const agent = await this.requireOwned(userId, id, ownershipScope);
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

    async pause(userId: string, id: string, ownershipScope?: OwnershipScope): Promise<AgentDto> {
        return this.transition(userId, id, AgentStatus.PAUSED, ownershipScope);
    }

    async resume(userId: string, id: string, ownershipScope?: OwnershipScope): Promise<AgentDto> {
        return this.transition(userId, id, AgentStatus.ACTIVE, ownershipScope);
    }

    /**
     * Inverse of `archive`. Deliberately NOT routed through
     * `transition`/`USER_TRANSITIONS`: opening ARCHIVED in that table
     * would also make `pause`/`resume` silently un-archive an Agent.
     * This is its own explicit move, and it lands on PAUSED rather
     * than ACTIVE so an Agent with a cron cadence never resumes firing
     * heartbeats as a side effect of being pulled out of the archive —
     * the operator activates it deliberately afterwards.
     */
    async unarchive(
        userId: string,
        id: string,
        ownershipScope?: OwnershipScope,
    ): Promise<AgentDto> {
        const agent = await this.requireOwned(userId, id, ownershipScope);
        if (agent.status !== AgentStatus.ARCHIVED) {
            throw new BadRequestException('Only archived Agents can be unarchived.');
        }
        const ok = await this.agents.transitionStatus(id, AgentStatus.ARCHIVED, AgentStatus.PAUSED);
        if (!ok) {
            throw new ConflictException('Agent status changed between read and write — retry.');
        }
        const refreshed = await this.agents.findById(id);
        if (!refreshed) throw new NotFoundException('Agent vanished after unarchive');
        return toAgentDto(refreshed);
    }

    async archive(
        userId: string,
        id: string,
        ownershipScope?: OwnershipScope,
    ): Promise<{ archived: true }> {
        await this.requireOwned(userId, id, ownershipScope);
        await this.agents.archiveById(id);
        return { archived: true };
    }

    async deleteHard(
        userId: string,
        id: string,
        ownershipScope?: OwnershipScope,
    ): Promise<{ deleted: true }> {
        await this.requireOwned(userId, id, ownershipScope);
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
    async listAttachments(
        userId: string,
        id: string,
        ownershipScope?: OwnershipScope,
    ): Promise<AgentAttachmentListRow[]> {
        await this.requireOwned(userId, id, ownershipScope);
        if (!this.agentAttachments) return [];
        const rows = await this.agentAttachments.findByAgentId(id);
        if (rows.length === 0 || !this.uploadsRepo) return rows;
        // `user_uploads` is deduped per (userId, sha256); addAttachment
        // already enforces the upload is owned by the caller, so the
        // owner-scoped lookup resolves every attachable upload.
        const uploads = await this.uploadsRepo.find({
            where: ownershipWhereWith<UserUpload>(userId, ownershipScope, {
                sha256: In(rows.map((r) => r.uploadId)),
            }),
        });
        const bySha = new Map(uploads.map((u) => [u.sha256, u]));
        if (new Set(rows.map((row) => row.uploadId)).size !== bySha.size) {
            throw new NotFoundException(`Attachment not found`);
        }
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
    async addAttachment(
        userId: string,
        id: string,
        uploadId: string,
        ownershipScope?: OwnershipScope,
    ): Promise<AgentAttachment> {
        await this.requireOwned(userId, id, ownershipScope);
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
                where: ownershipWhereWith<UserUpload>(userId, ownershipScope, {
                    sha256: uploadId.toLowerCase(),
                }),
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
        ownershipScope?: OwnershipScope,
    ): Promise<{ deleted: true }> {
        await this.requireOwned(userId, id, ownershipScope);
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

    private async requireOwned(
        userId: string,
        id: string,
        ownershipScope?: OwnershipScope,
    ): Promise<Agent> {
        const agent = await this.agents.findByIdAndUser(id, userId, ownershipScope);
        if (!agent) {
            // 404 (not 403) — don't leak existence.
            throw new NotFoundException(`Agent ${id} not found.`);
        }
        return agent;
    }

    /**
     * `reportsToAgentId` guard (teams-and-companies spec §1.2): the manager
     * must be another agent of the same user (cross-user → 404, no
     * existence leak), not the agent itself, and pointing at it must not
     * close a cycle — walking up the manager chain from the proposed
     * manager may never reach the agent (bounded walk, Paperclip-style
     * max-50 chain-of-command guard).
     */
    private async assertValidReportsTo(
        userId: string,
        agent: Agent,
        reportsToAgentId: string,
        ownershipScope?: OwnershipScope,
    ): Promise<void> {
        if (reportsToAgentId === agent.id) {
            throw new ConflictException('An Agent cannot report to itself.');
        }
        const manager = await this.agents.findByIdAndUser(reportsToAgentId, userId, ownershipScope);
        if (!manager) {
            throw new NotFoundException(`Agent ${reportsToAgentId} not found.`);
        }
        let cursor: Agent | null = manager;
        for (let i = 0; cursor && i < 50; i++) {
            if (cursor.id === agent.id) {
                throw new ConflictException('This reporting line would create a cycle.');
            }
            cursor = cursor.reportsToAgentId
                ? await this.agents.findByIdAndUser(cursor.reportsToAgentId, userId, ownershipScope)
                : null;
        }
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
        ownershipScope?: OwnershipScope,
    ): Promise<void> {
        switch (input.scope) {
            case AgentScope.WORK: {
                if (!input.workId || !this.workRepo) return;
                const work = await this.workRepo.findOne({
                    where: ownershipWhereWith<Work>(userId, ownershipScope, {
                        id: input.workId,
                    }),
                });
                if (!work) throw new NotFoundException(`Work ${input.workId} not found.`);
                break;
            }
            case AgentScope.MISSION: {
                if (!input.missionId || !this.missionRepo) return;
                const mission = await this.missionRepo.findOne({
                    where: ownershipWhereWith<Mission>(userId, ownershipScope, {
                        id: input.missionId,
                    }),
                });
                if (!mission) throw new NotFoundException(`Mission ${input.missionId} not found.`);
                break;
            }
            case AgentScope.IDEA: {
                if (!input.ideaId || !this.ideaRepo) return;
                const idea = await this.ideaRepo.findOne({
                    where: ownershipWhereWith<WorkProposal>(userId, ownershipScope, {
                        id: input.ideaId,
                    }),
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
     * Environments — an Environment may be assigned only when it belongs
     * to the same user (cross-user/unknown → 404, no existence leak) and
     * is `published`. Draft rows are refused with a 422 and a clear
     * message: publishing is the explicit "this recipe is ready" gate,
     * and the UI filters its picker to published rows for the same
     * reason — this server-side check is what makes the rule real for
     * tool/import callers that bypass the UI.
     */
    private async assertAssignableEnvironment(
        userId: string,
        environmentId: string,
        ownershipScope?: OwnershipScope,
    ): Promise<void> {
        if (!this.environmentRepo) {
            // Hand-rolled unit-test surface without the repo wired;
            // production + e2e DI always provide it (AgentsModule
            // forFeatures Environment).
            return;
        }
        const environment = await this.environmentRepo.findOne({
            where: ownershipWhereWith<Environment>(userId, ownershipScope, {
                id: environmentId,
            }),
        });
        if (!environment) {
            throw new NotFoundException('Environment not found');
        }
        if (environment.status !== 'published') {
            throw new UnprocessableEntityException(
                'Only published Environments can be assigned to an Agent. Publish the Environment first.',
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
