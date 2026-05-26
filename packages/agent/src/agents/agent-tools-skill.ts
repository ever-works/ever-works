import type { SkillRepository } from '../database/repositories/skill.repository';
import type {
    SkillBindingRepository,
    ResolvedSkill,
} from '../database/repositories/skill-binding.repository';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 10.3.
 *
 * Tool descriptor for `getSkillBody`. When ANY bound skill is
 * resolved for an Agent run, this tool is auto-registered into the
 * tool-loop so the model can fetch the full body of a skill it sees
 * referenced in the priority-sorted summary. Spec
 * `agent-prompt-assembly.md §6.3` — progressive disclosure for the
 * Skills bundle.
 *
 * The full tool surface (createTask / commitToRepo / etc.) ships in
 * Phase 16; this file just provides the schema + invocation handler
 * that AgentRunService can hand to the AI facade when it lands.
 *
 * Returns a fresh `getSkillBody` factory bound to an Agent's
 * user/agent/work/mission/idea context — keeps cross-user isolation
 * baked into the tool itself rather than relying on the caller.
 */

export interface GetSkillBodyToolArgs {
    slug: string;
}

export interface GetSkillBodyToolResult {
    slug: string;
    title: string;
    body: string;
    priority: number;
    version: string;
}

export interface GetSkillBodyToolDescriptor {
    name: 'getSkillBody';
    description: string;
    parameters: {
        type: 'object';
        properties: {
            slug: { type: 'string'; description: string };
        };
        required: ['slug'];
    };
    invoke: (args: GetSkillBodyToolArgs) => Promise<GetSkillBodyToolResult | { error: string }>;
}

export interface CreateGetSkillBodyToolContext {
    userId: string;
    agentId: string;
    workId?: string;
    missionId?: string;
    ideaId?: string;
}

export function createGetSkillBodyTool(
    skills: SkillRepository,
    bindings: SkillBindingRepository,
    context: CreateGetSkillBodyToolContext,
): GetSkillBodyToolDescriptor {
    return {
        name: 'getSkillBody',
        description:
            'Fetch the full body of one bound Skill by slug. Use this when the priority-sorted Skill summary lists a slug whose details you need to act on. Returns an error if the slug is not bound to this Agent.',
        parameters: {
            type: 'object',
            properties: {
                slug: {
                    type: 'string',
                    description:
                        'The skill slug (lowercase-with-hyphens) as listed in ACTIVE SKILLS.',
                },
            },
            required: ['slug'],
        },
        invoke: async (args) => {
            if (!args?.slug || typeof args.slug !== 'string') {
                return { error: 'slug is required' };
            }
            const active: ResolvedSkill[] = await bindings.resolveActive({
                userId: context.userId,
                agentId: context.agentId,
                workId: context.workId,
                missionId: context.missionId,
                ideaId: context.ideaId,
                forAgentRun: true,
            });
            const match = active.find((row) => row.skill.slug === args.slug);
            if (!match) {
                return {
                    error: `Skill "${args.slug}" is not bound to this Agent. Available: ${active
                        .map((r) => r.skill.slug)
                        .join(', ')}`,
                };
            }
            const full = await skills.findByIdAndUser(match.skill.id, context.userId);
            if (!full) {
                return { error: `Skill "${args.slug}" not readable.` };
            }
            return {
                slug: full.slug,
                title: full.title,
                body: full.instructionsMd,
                priority: match.binding.priority,
                version: full.version,
            };
        },
    };
}

/**
 * Decide whether to auto-register `getSkillBody` in the tool-loop
 * for an Agent run. Mirrors the spec wording: register when ANY
 * bound skill is resolved.
 */
export function shouldRegisterSkillTool(resolvedSkills: { slug: string }[]): boolean {
    return resolvedSkills.length > 0;
}
