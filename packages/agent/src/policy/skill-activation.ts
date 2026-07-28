import type { ResolvedToolGrants, ToolGrantDecision } from '@ever-works/contracts';
import { decideToolGrant } from './tool-grant';

/**
 * Grant-aware skill activation (audit item G12) — the PURE half.
 *
 * ## The gap this closes
 *
 * A Skill's frontmatter can declare `allowedTools` — "this skill is about
 * committing code" / "this skill drives the deploy tools". Activation
 * ignored it completely: every bound Skill was injected into the system
 * message regardless of whether the Agent could call the tools the Skill
 * exists to drive.
 *
 * That is not merely untidy. A Skill is instructions, and instructions the
 * Agent cannot carry out are the worst kind of context: the model spends
 * its budget on them, then either hallucinates the missing tool or
 * apologises to the user for a capability the operator deliberately took
 * away. Worse, a Skill body describing a denied surface is a standing
 * invitation to work around the denial.
 *
 * So: a Skill whose declared tools are ALL denied by the effective grant
 * matrix is SUPPRESSED. A Skill that declares nothing is always active
 * (the overwhelming majority — and the reason today's behaviour is
 * preserved exactly under the permissive default matrix).
 *
 * A Skill that declares several tools and keeps at least one stays active:
 * partial capability is still capability, and suppressing it would be a
 * surprising cliff.
 */

/** The subset of a resolved skill this filter needs. */
export interface ActivatableSkill {
    slug: string;
    /** `frontmatter.allowedTools`, if the Skill declared any. */
    allowedTools?: readonly string[] | null;
}

export interface SuppressedSkill<T> {
    skill: T;
    slug: string;
    /** Every declared tool, each with the refusal that killed it. */
    refusals: ToolGrantDecision[];
}

export interface SkillActivationResult<T> {
    active: T[];
    suppressed: SuppressedSkill<T>[];
}

/**
 * Partition skills into the ones the effective grant matrix leaves usable
 * and the ones it does not.
 *
 * `resolved` may be `null`/`undefined` — that is the "no grant matrix
 * wired" case (unit tests, runtimes without the policy module) and every
 * skill stays active, exactly as before this feature landed.
 */
export function filterSkillsByToolGrants<T extends ActivatableSkill>(
    skills: readonly T[],
    resolved: Pick<ResolvedToolGrants, 'matrix' | 'chain'> | null | undefined,
): SkillActivationResult<T> {
    if (!resolved) return { active: [...skills], suppressed: [] };

    const active: T[] = [];
    const suppressed: SuppressedSkill<T>[] = [];

    for (const skill of skills) {
        const declared = (skill.allowedTools ?? []).filter(
            (tool): tool is string => typeof tool === 'string' && tool.trim().length > 0,
        );
        if (declared.length === 0) {
            // Declares nothing → not about tools → always active.
            active.push(skill);
            continue;
        }

        const refusals: ToolGrantDecision[] = [];
        let anyAllowed = false;
        for (const tool of declared) {
            const decision = decideToolGrant(
                { matrix: resolved.matrix, chain: resolved.chain },
                tool,
            );
            if (decision.allowed) {
                anyAllowed = true;
                break;
            }
            refusals.push(decision);
        }

        if (anyAllowed) active.push(skill);
        else suppressed.push({ skill, slug: skill.slug, refusals });
    }

    return { active, suppressed };
}
