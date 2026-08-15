import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    InternalServerErrorException,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import type { Skill, SkillFrontmatter, SkillOwnerType } from '../entities/skill.entity';
import { SkillRepository, type ListSkillsFilter } from '../database/repositories/skill.repository';
import {
    SkillBindingRepository,
    type ResolvedSkill,
} from '../database/repositories/skill-binding.repository';
import type { SkillBinding, SkillBindingTargetType } from '../entities/skill-binding.entity';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { assertNoSecrets } from '../utils/secret-scan';
import { assertNoInjectionTokens } from '../utils/content-policy';
import { slugifyText } from '../utils/text.utils';
import { normalizeInvocationSlug } from './skill-invocation';
import { AgentRepository } from '../database/repositories/agent.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkProposalRepository } from '../user-research/work-proposal.repository';
import { Mission } from '../entities/mission.entity';
// Grant-aware skill activation (audit item G12). Both are leaf modules
// (token + pure function) so the skills subpath gains no runtime graph.
import { TOOL_GRANT_ENFORCER, type ToolGrantEnforcer } from '../policy/tool-grant.enforcer';
import { filterSkillsByToolGrants } from '../policy/skill-activation';

export interface CreateSkillInput {
    ownerType: SkillOwnerType;
    ownerId: string;
    title: string;
    description: string;
    instructionsMd: string;
    frontmatter?: SkillFrontmatter;
    slug?: string;
    version?: string;
    /** Optional slash command (`plan` or `/plan`); unique per user. */
    invocationSlug?: string | null;
}

export interface UpdateSkillInput {
    title?: string;
    description?: string;
    instructionsMd?: string;
    frontmatter?: SkillFrontmatter;
    version?: string;
    /** `null` clears the slash command; a string (re)assigns it. */
    invocationSlug?: string | null;
}

export interface InstallFromCatalogInput {
    catalogProviderId: string;
    catalogSlug: string;
    ownerType: SkillOwnerType;
    ownerId: string;
    /** Pre-fetched catalog entry from `SkillsFacadeService.getEntry`. */
    entry: {
        slug: string;
        title: string;
        description: string;
        frontmatter: SkillFrontmatter;
        body: string;
        version: string;
    };
}

export interface CreateBindingInput {
    skillId: string;
    targetType: SkillBindingTargetType;
    targetId?: string | null;
    priority?: number;
    injectIntoAgent?: boolean;
    injectIntoGenerator?: boolean;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Skills feature — Phase 9.
 *
 * Owns CRUD + catalog install + bindings management. Mirrors
 * AgentsService/AgentFileService posture: cross-user reads → 404,
 * secret-scan on every body write, 64 KB cap per body, slug
 * uniqueness within (ownerType, ownerId).
 */
@Injectable()
export class SkillsService {
    private readonly logger = new Logger(SkillsService.name);

    constructor(
        private readonly skills: SkillRepository,
        private readonly bindings: SkillBindingRepository,
        @Optional() private readonly activityLog?: ActivityLogService,
        @InjectRepository(Mission)
        private readonly missions?: Repository<Mission>,
        private readonly agents?: AgentRepository,
        private readonly works?: WorkRepository,
        private readonly ideas?: WorkProposalRepository,
        // Grant-aware skill activation (audit item G12). APPENDED LAST +
        // `@Optional()` so every existing positional constructor call
        // keeps working; unbound → activation behaves exactly as before.
        @Optional()
        @Inject(TOOL_GRANT_ENFORCER)
        private readonly toolGrants?: ToolGrantEnforcer,
    ) {}

    // ── Skill CRUD ────────────────────────────────────────────────

    async list(
        userId: string,
        filter: ListSkillsFilter = {},
    ): Promise<{ rows: Skill[]; total: number }> {
        return this.skills.findByUserIdFiltered(userId, filter);
    }

    async getOne(userId: string, id: string): Promise<Skill> {
        const skill = await this.skills.findByIdAndUser(id, userId);
        if (!skill) throw new NotFoundException(`Skill ${id} not found.`);
        return skill;
    }

    async create(userId: string, input: CreateSkillInput): Promise<Skill> {
        const slug = input.slug ?? slugifyText(input.title);
        if (!slug) {
            throw new BadRequestException(
                'Skill title must contain at least one alphanumeric character.',
            );
        }
        assertBody(input.instructionsMd, 'instructionsMd');
        await this.assertOwnedScope(userId, input.ownerType, input.ownerId);

        const conflict = await this.skills.findByOwnerSlug(input.ownerType, input.ownerId, slug);
        if (conflict) {
            throw new ConflictException(
                `A Skill with slug "${slug}" already exists at ${input.ownerType}:${input.ownerId}.`,
            );
        }

        const invocationSlug = await this.resolveInvocationSlugForWrite(
            userId,
            input.invocationSlug,
            null,
        );

        const frontmatter: SkillFrontmatter = input.frontmatter ?? {
            name: slug,
            description: input.description,
        };
        const created = await this.skills.create({
            userId,
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            slug,
            title: input.title,
            description: input.description,
            instructionsMd: input.instructionsMd,
            frontmatter,
            contentHash: hashBody(input.instructionsMd),
            version: input.version ?? '1.0.0',
            invocationSlug,
        });
        return created;
    }

    async update(userId: string, id: string, input: UpdateSkillInput): Promise<Skill> {
        await this.getOne(userId, id);
        const patch: Partial<Skill> = {};
        if (input.title !== undefined) patch.title = input.title;
        if (input.description !== undefined) patch.description = input.description;
        if (input.frontmatter !== undefined) patch.frontmatter = input.frontmatter;
        if (input.version !== undefined) patch.version = input.version;
        if (input.instructionsMd !== undefined) {
            assertBody(input.instructionsMd, 'instructionsMd');
            patch.instructionsMd = input.instructionsMd;
            patch.contentHash = hashBody(input.instructionsMd);
        }
        if (input.invocationSlug !== undefined) {
            patch.invocationSlug = await this.resolveInvocationSlugForWrite(
                userId,
                input.invocationSlug,
                id,
            );
        }
        await this.skills.updateByIdAndUser(id, userId, patch);
        const refreshed = await this.skills.findByIdAndUser(id, userId);
        if (!refreshed) throw new NotFoundException(`Skill ${id} vanished after update.`);
        return refreshed;
    }

    async remove(userId: string, id: string): Promise<{ deleted: true }> {
        await this.getOne(userId, id);
        // FK CASCADE on skill_bindings.skillId handles the binding rows.
        await this.skills.deleteByIdAndUser(id, userId);
        return { deleted: true };
    }

    async installFromCatalog(userId: string, input: InstallFromCatalogInput): Promise<Skill> {
        assertBody(input.entry.body, 'catalog body');
        await this.assertOwnedScope(userId, input.ownerType, input.ownerId);
        const conflict = await this.skills.findByOwnerSlug(
            input.ownerType,
            input.ownerId,
            input.entry.slug,
        );
        if (conflict) {
            throw new ConflictException(
                `Catalog skill "${input.entry.slug}" is already installed at ${input.ownerType}:${input.ownerId}.`,
            );
        }
        const created = await this.skills.create({
            userId,
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            slug: input.entry.slug,
            title: input.entry.title,
            description: input.entry.description,
            frontmatter: input.entry.frontmatter,
            instructionsMd: input.entry.body,
            contentHash: hashBody(input.entry.body),
            sourceCatalogSlug: input.entry.slug,
            sourceCatalogVersion: input.entry.version,
            sourcePath: input.catalogProviderId,
            version: input.entry.version,
        });

        await this.logActivity({
            userId,
            skillId: created.id,
            actionType: ActivityActionType.SKILL_INSTALLED,
        });
        return created;
    }

    // ── Bindings CRUD ─────────────────────────────────────────────

    async listBindings(userId: string, skillId: string): Promise<SkillBinding[]> {
        await this.getOne(userId, skillId);
        // Security: forward userId so the repository scopes the lookup to the
        // owner in the WHERE clause (defense-in-depth vs. cross-user IDOR).
        return this.bindings.findBySkillId(skillId, userId);
    }

    async createBinding(userId: string, input: CreateBindingInput): Promise<SkillBinding> {
        await this.getOne(userId, input.skillId);
        if (input.targetType !== 'tenant' && !input.targetId) {
            throw new BadRequestException(
                `targetId is required when targetType=${input.targetType}.`,
            );
        }
        await this.assertOwnedScope(userId, input.targetType, input.targetId ?? userId);
        const binding = await this.bindings.create({
            skillId: input.skillId,
            targetType: input.targetType,
            targetId: input.targetType === 'tenant' ? null : input.targetId,
            userId,
            priority: input.priority ?? 100,
            injectIntoAgent: input.injectIntoAgent ?? true,
            injectIntoGenerator: input.injectIntoGenerator ?? false,
        });

        await this.logActivity({
            userId,
            skillId: input.skillId,
            actionType: ActivityActionType.SKILL_ATTACHED_TO_AGENT,
        });
        return binding;
    }

    async removeBinding(userId: string, bindingId: string): Promise<{ deleted: true }> {
        const binding = await this.bindings.findByIdAndUser(bindingId, userId);
        if (!binding) throw new NotFoundException(`Skill binding ${bindingId} not found.`);
        // Security: ownership-scoped delete — userId is enforced in the WHERE
        // clause so a TOCTOU gap after the guard above cannot delete another
        // user's binding (cross-user IDOR).
        await this.bindings.deleteByIdAndUser(bindingId, userId);
        return { deleted: true };
    }

    /**
     * Which Skills apply to this Agent right now?
     *
     * Grant-aware since audit item G12: a Skill whose frontmatter declares
     * `allowedTools` and whose EVERY declared tool is refused by the
     * effective tool-grant matrix is dropped here, not injected and then
     * ignored. Skills that declare no tools are untouched, and an install
     * with no grant rows (or no enforcer wired) resolves exactly as it did
     * before the matrix existed.
     */
    async resolveActiveForAgent(
        userId: string,
        agentId: string,
        workId?: string,
        missionId?: string,
        ideaId?: string,
    ): Promise<ResolvedSkill[]> {
        const resolved = await this.bindings.resolveActive({
            userId,
            agentId,
            workId,
            missionId,
            ideaId,
            forAgentRun: true,
        });
        if (!this.toolGrants || resolved.length === 0) return resolved;

        let grants;
        try {
            grants = await this.toolGrants.resolve({
                userId,
                agentId,
                workId: workId ?? null,
            });
        } catch (err) {
            // A failed policy read must never silently strip an Agent of
            // its Skills — degrade to "everything active" and say so.
            this.logger.warn(
                `Tool-grant resolution failed during skill activation for agent ${agentId}; all bound skills stay active: ${err}`,
            );
            return resolved;
        }

        const { active } = filterSkillsByToolGrants(
            resolved.map((row) => ({
                slug: row.skill.slug,
                allowedTools: row.skill.frontmatter?.allowedTools ?? null,
                row,
            })),
            grants,
        );
        return active.map((entry) => entry.row);
    }

    // ── Invocation slugs (slash commands) ─────────────────────────

    /** The user's skills that carry an invocation slug (composer autocomplete). */
    async listInvocable(userId: string): Promise<Skill[]> {
        return this.skills.findInvocableByUser(userId);
    }

    // NOTE: resolving a message's leading `/slug` at RUN time lives in
    // `AgentRunService` (parseSlashInvocation + the user-scoped
    // `SkillRepository.findByUserAndInvocationSlug`), not here — one
    // resolution path, so the popup, the parser and the injection
    // cannot drift apart.

    /**
     * Normalize + validate an invocation slug and enforce per-user
     * uniqueness (409 naming the conflicting skill). `excludeSkillId`
     * lets an update keep its own slug.
     */
    private async resolveInvocationSlugForWrite(
        userId: string,
        raw: string | null | undefined,
        excludeSkillId: string | null,
    ): Promise<string | null> {
        if (raw === undefined || raw === null || raw.trim() === '') return null;
        const normalized = normalizeInvocationSlug(raw);
        if (!normalized) {
            throw new BadRequestException(
                'invocationSlug must be lowercase letters, digits and hyphens, starting with a letter or digit (max 64 chars).',
            );
        }
        const conflict = await this.skills.findByUserAndInvocationSlug(userId, normalized);
        if (conflict && conflict.id !== excludeSkillId) {
            throw new ConflictException(
                `Invocation slug "/${normalized}" is already used by skill "${conflict.title}".`,
            );
        }
        return normalized;
    }

    // ── internals ─────────────────────────────────────────────────

    private async logActivity(args: {
        userId: string;
        skillId: string;
        actionType: ActivityActionType;
    }): Promise<void> {
        if (!this.activityLog) return;
        try {
            // Post-rebase fix: develop's CreateActivityLogDto dropped
            // `resourceType`/`resourceId` + renamed SUCCESS → COMPLETED.
            await this.activityLog.log({
                userId: args.userId,
                action: args.actionType,
                actionType: args.actionType,
                status: ActivityStatus.COMPLETED,
                summary: `Skill ${args.skillId} — ${args.actionType}`,
                details: { resourceType: 'skill', resourceId: args.skillId },
            });
        } catch (err) {
            this.logger.warn(`Failed to log activity ${args.actionType}: ${err}`);
        }
    }

    private async assertOwnedScope(
        userId: string,
        ownerType: SkillOwnerType | SkillBindingTargetType,
        ownerId: string,
    ): Promise<void> {
        if (ownerType === 'tenant') {
            if (ownerId !== userId) {
                throw new NotFoundException('Skill target not found.');
            }
            return;
        }

        if (ownerType === 'agent') {
            if (!this.agents) this.throwMissingOwnershipRepository(ownerType);
            const agent = await this.agents.findByIdAndUser(ownerId, userId);
            if (!agent) throw new NotFoundException('Skill target not found.');
            return;
        }

        if (ownerType === 'work') {
            if (!this.works) this.throwMissingOwnershipRepository(ownerType);
            const work = await this.works.findById(ownerId);
            if (!work || work.userId !== userId)
                throw new NotFoundException('Skill target not found.');
            return;
        }

        if (ownerType === 'idea') {
            if (!this.ideas) this.throwMissingOwnershipRepository(ownerType);
            const idea = await this.ideas.findByIdForUser(ownerId, userId);
            if (!idea) throw new NotFoundException('Skill target not found.');
            return;
        }

        if (ownerType === 'mission') {
            if (!this.missions) this.throwMissingOwnershipRepository(ownerType);
            const mission = await this.missions.findOne({ where: { id: ownerId, userId } });
            if (!mission) throw new NotFoundException('Skill target not found.');
        }
    }

    private throwMissingOwnershipRepository(ownerType: Exclude<SkillOwnerType, 'tenant'>): never {
        throw new InternalServerErrorException(
            `Skill ${ownerType} ownership check is unavailable.`,
        );
    }
}

function assertBody(body: string, fieldHint: string): void {
    if (body.length > MAX_BODY_BYTES) {
        throw new BadRequestException(`${fieldHint} exceeds max 64 KB.`);
    }
    assertNoSecrets(body, fieldHint);
    // D11: reject chat-template control tokens (<|im_start|>, [INST], …) in
    // any Skill body — they can hijack the agent's system prompt when the
    // Skill is injected, and are never legitimate in a markdown body. Matters
    // most for `installFromCatalog` (cross-user import) but is safe on every
    // write since no human-authored body contains model control sequences.
    assertNoInjectionTokens(body, fieldHint);
}

function hashBody(body: string): string {
    return createHash('sha256').update(body, 'utf8').digest('hex');
}
