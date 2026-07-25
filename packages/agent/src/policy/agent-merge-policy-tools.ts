import type { ResolvedMergePolicy } from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import type { MergePolicyResolveInput, MergePolicyService } from './merge-policy.service';

/**
 * Merge-policy matrix (Wave 3, D4) — chat tool for the policy surface,
 * per the program DoD rule that every new entity ships with chat tools +
 * keyword slots.
 *
 * Mirrors `fleet/agent-fleet-tools.ts`: a descriptor-factory the tool
 * assembly concatenates at run time (type-only import of
 * `TaskToolDescriptor`, so the Tasks runtime graph is NOT pulled into the
 * policy subpath).
 *
 * READ-ONLY by design — the tool explains the effective policy and where
 * each field came from; changing a policy goes through the Work / Agent /
 * organization update endpoints with their own permission checks.
 *
 * Keyword slots: "merge policy", "can the agent merge", "who merges",
 * "why was the merge refused", "is human approval required", "which
 * branches are protected".
 */

export interface ResolveMergePolicyArgs {
    /** Resolve as it would apply to this Work. */
    workId?: string;
    /** Resolve as it would apply to this Agent (most specific scope). */
    agentId?: string;
}

export function buildMergePolicyTools(args: {
    /**
     * Owner scope. The caller (API/chat runtime) has already established
     * this user; the tool only ever resolves scopes it is handed.
     */
    userId: string;
    service: Pick<MergePolicyService, 'resolve'>;
    /**
     * Owner check for the ids the model supplies — the tool must not
     * become a cross-tenant policy oracle. Returns the scope tuple the
     * user may resolve, or null when they may not.
     */
    authorize: (input: ResolveMergePolicyArgs) => Promise<MergePolicyResolveInput | null>;
}): TaskToolDescriptor[] {
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: 'resolve_merge_policy',
        description:
            'Resolve the effective merge policy for a Work or Agent — whether agents may merge their own pull requests, whether a green quality gate and/or a human approval is required, which merge methods are allowed and which branches are protected. Also reports which scope (tenant, organization, Work, Agent or the platform default) each setting came from. Use when the user asks who may merge, why a merge was refused, or what the current policy is.',
        parameters: {
            type: 'object',
            properties: {
                workId: {
                    type: 'string',
                    description: 'Resolve the policy as it applies to this Work.',
                },
                agentId: {
                    type: 'string',
                    description:
                        'Resolve the policy as it applies to this Agent (the most specific scope; its Work, organization and tenant are discovered automatically).',
                },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as ResolveMergePolicyArgs;
            if (!a.workId && !a.agentId) {
                return { error: 'Provide workId or agentId to resolve a merge policy.' };
            }
            try {
                const scope = await args.authorize(a);
                if (!scope) {
                    return { error: 'Not found or not accessible to the current user.' };
                }
                return await args.service.resolve(scope);
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies TaskToolDescriptor<
        ResolveMergePolicyArgs,
        ResolvedMergePolicy | { error: string }
    >);

    return out;
}
