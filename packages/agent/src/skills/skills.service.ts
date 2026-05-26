import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { createHash } from 'crypto';
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
import { slugifyText } from '../utils/text.utils';

export interface CreateSkillInput {
    ownerType: SkillOwnerType;
    ownerId: string;
    title: string;
    description: string;
    instructionsMd: string;
    frontmatter?: SkillFrontmatter;
    slug?: string;
    version?: string;
}

export interface UpdateSkillInput {
    title?: string;
    description?: string;
    instructionsMd?: string;
    frontmatter?: SkillFrontmatter;
    version?: string;
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

        const conflict = await this.skills.findByOwnerSlug(input.ownerType, input.ownerId, slug);
        if (conflict) {
            throw new ConflictException(
                `A Skill with slug "${slug}" already exists at ${input.ownerType}:${input.ownerId}.`,
            );
        }

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
        });
        return created;
    }

    async update(userId: string, id: string, input: UpdateSkillInput): Promise<Skill> {
        const skill = await this.getOne(userId, id);
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
        await this.skills.updateById(id, patch);
        const refreshed = await this.skills.findById(id);
        if (!refreshed) throw new NotFoundException(`Skill ${id} vanished after update.`);
        return refreshed;
    }

    async remove(userId: string, id: string): Promise<{ deleted: true }> {
        await this.getOne(userId, id);
        // FK CASCADE on skill_bindings.skillId handles the binding rows.
        await this.skills.deleteById(id);
        return { deleted: true };
    }

    async installFromCatalog(userId: string, input: InstallFromCatalogInput): Promise<Skill> {
        assertBody(input.entry.body, 'catalog body');
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
        return this.bindings.findBySkillId(skillId);
    }

    async createBinding(userId: string, input: CreateBindingInput): Promise<SkillBinding> {
        await this.getOne(userId, input.skillId);
        if (input.targetType !== 'tenant' && !input.targetId) {
            throw new BadRequestException(
                `targetId is required when targetType=${input.targetType}.`,
            );
        }
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
        await this.bindings.deleteById(bindingId);
        return { deleted: true };
    }

    async resolveActiveForAgent(
        userId: string,
        agentId: string,
        workId?: string,
        missionId?: string,
        ideaId?: string,
    ): Promise<ResolvedSkill[]> {
        return this.bindings.resolveActive({
            userId,
            agentId,
            workId,
            missionId,
            ideaId,
            forAgentRun: true,
        });
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
}

function assertBody(body: string, fieldHint: string): void {
    if (body.length > MAX_BODY_BYTES) {
        throw new BadRequestException(`${fieldHint} exceeds max 64 KB.`);
    }
    assertNoSecrets(body, fieldHint);
}

function hashBody(body: string): string {
    return createHash('sha256').update(body, 'utf8').digest('hex');
}
