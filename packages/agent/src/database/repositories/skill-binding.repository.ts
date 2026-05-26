import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SkillBinding, type SkillBindingTargetType } from '../../entities/skill-binding.entity';
import { Skill } from '../../entities/skill.entity';

export interface ResolvedSkill {
    binding: SkillBinding;
    skill: Skill;
}

export interface ResolveActiveOptions {
    /** Resolve "for an Agent" — joins agent-direct + work + mission + idea + tenant bindings. */
    agentId?: string;
    workId?: string;
    missionId?: string;
    ideaId?: string;
    /** Required for all queries — bindings are user-scoped per security spec §8. */
    userId: string;
    /** When true, only bindings flagged for AI runs (default behavior). */
    forAgentRun?: boolean;
    /** When true, only bindings flagged for Generator runs. */
    forGeneratorRun?: boolean;
}

/**
 * Skills feature — Phase 8.4 / `features/skills/plan.md §2`.
 *
 * `resolveActive` is the single source of truth for "which skills
 * apply to this AI call?" — joining `skill_bindings` to `skills`
 * with priority sorting + duplicate skill dedup (when the same
 * skill is bound at multiple scopes, the highest-priority binding
 * wins).
 *
 * The resolver is intentionally pure SQL — `AiFacadeService` calls
 * it inside `assembleSystemMessage()` (Phase 10) for the agent-run
 * path; `getSkillBody` tool returns one body on demand via
 * `findById`.
 */
@Injectable()
export class SkillBindingRepository {
    constructor(
        @InjectRepository(SkillBinding)
        private readonly repository: Repository<SkillBinding>,
    ) {}

    async findById(id: string): Promise<SkillBinding | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdAndUser(id: string, userId: string): Promise<SkillBinding | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findBySkillId(skillId: string): Promise<SkillBinding[]> {
        return this.repository.find({ where: { skillId } });
    }

    async findByTarget(
        targetType: SkillBindingTargetType,
        targetId: string,
    ): Promise<SkillBinding[]> {
        return this.repository.find({ where: { targetType, targetId } });
    }

    async create(data: Partial<SkillBinding>): Promise<SkillBinding> {
        const entity = this.repository.create(data);
        return this.repository.save(entity);
    }

    async deleteById(id: string): Promise<void> {
        await this.repository.delete(id);
    }

    async deleteByTarget(
        targetType: SkillBindingTargetType,
        targetId: string,
        skillId: string,
    ): Promise<void> {
        await this.repository.delete({ targetType, targetId, skillId });
    }

    /**
     * Resolve the active set of `{ binding, skill }` rows for a
     * concrete AI call. Joins per target type + dedupes by skillId
     * (highest-priority binding wins — priority = lower-is-higher
     * per spec). Returns sorted by priority ASC.
     *
     * The "for agent" caller passes `agentId` and (optionally)
     * `workId/missionId/ideaId/userId`. Bindings matching ANY of
     * those targets are surfaced. Tenant bindings (targetType =
     * 'tenant', targetId = null) are included by userId alone.
     */
    async resolveActive(options: ResolveActiveOptions): Promise<ResolvedSkill[]> {
        const { agentId, workId, missionId, ideaId, userId } = options;
        const forAgentRun = options.forAgentRun ?? true;
        const forGeneratorRun = options.forGeneratorRun ?? false;

        const qb = this.repository
            .createQueryBuilder('binding')
            .innerJoin(Skill, 'skill', 'skill.id = binding.skillId')
            .addSelect('skill.id', 'skill_id')
            .addSelect('skill.userId', 'skill_userId')
            .addSelect('skill.ownerType', 'skill_ownerType')
            .addSelect('skill.ownerId', 'skill_ownerId')
            .addSelect('skill.slug', 'skill_slug')
            .addSelect('skill.title', 'skill_title')
            .addSelect('skill.description', 'skill_description')
            .addSelect('skill.frontmatter', 'skill_frontmatter')
            .addSelect('skill.instructionsMd', 'skill_instructionsMd')
            .addSelect('skill.contentHash', 'skill_contentHash')
            .addSelect('skill.version', 'skill_version')
            .where('binding.userId = :userId', { userId });

        // Build target filter — at least one branch must match. When
        // nothing matches, only tenant-level bindings apply.
        const ors: string[] = ["(binding.targetType = 'tenant' AND binding.targetId IS NULL)"];
        const params: Record<string, unknown> = {};
        if (agentId) {
            ors.push("(binding.targetType = 'agent' AND binding.targetId = :agentId)");
            params.agentId = agentId;
        }
        if (workId) {
            ors.push("(binding.targetType = 'work' AND binding.targetId = :workId)");
            params.workId = workId;
        }
        if (missionId) {
            ors.push("(binding.targetType = 'mission' AND binding.targetId = :missionId)");
            params.missionId = missionId;
        }
        if (ideaId) {
            ors.push("(binding.targetType = 'idea' AND binding.targetId = :ideaId)");
            params.ideaId = ideaId;
        }
        qb.andWhere(`(${ors.join(' OR ')})`, params);

        if (forAgentRun) qb.andWhere('binding.injectIntoAgent = :inject', { inject: true });
        if (forGeneratorRun) qb.andWhere('binding.injectIntoGenerator = :gen', { gen: true });

        qb.orderBy('binding.priority', 'ASC').addOrderBy('binding.createdAt', 'ASC');

        const raws = await qb.getRawMany<Record<string, unknown>>();
        // Dedup by skillId — highest-priority binding wins. Since
        // the query is sorted by priority ASC, the first occurrence
        // for any skillId is the winner.
        const seen = new Set<string>();
        const out: ResolvedSkill[] = [];
        for (const row of raws) {
            const skillId = String(row['skill_id']);
            if (seen.has(skillId)) continue;
            seen.add(skillId);
            out.push({
                binding: {
                    id: String(row['binding_id']),
                    skillId,
                    targetType: row['binding_targetType'] as SkillBindingTargetType,
                    targetId: (row['binding_targetId'] as string | null) ?? null,
                    userId: String(row['binding_userId']),
                    injectIntoAgent: !!row['binding_injectIntoAgent'],
                    injectIntoGenerator: !!row['binding_injectIntoGenerator'],
                    priority: Number(row['binding_priority']),
                    createdAt: new Date(String(row['binding_createdAt'])),
                } as SkillBinding,
                skill: {
                    id: skillId,
                    userId: String(row['skill_userId']),
                    ownerType: row['skill_ownerType'] as any,
                    ownerId: String(row['skill_ownerId']),
                    slug: String(row['skill_slug']),
                    title: String(row['skill_title']),
                    description: String(row['skill_description']),
                    frontmatter:
                        typeof row['skill_frontmatter'] === 'string'
                            ? safeParseJson(row['skill_frontmatter'] as string)
                            : (row['skill_frontmatter'] as any),
                    instructionsMd: String(row['skill_instructionsMd']),
                    contentHash: String(row['skill_contentHash']),
                    version: String(row['skill_version'] ?? '1.0.0'),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                } as Skill,
            });
        }
        return out;
    }
}

function safeParseJson<T = unknown>(s: string): T {
    try {
        return JSON.parse(s) as T;
    } catch {
        return {} as T;
    }
}
