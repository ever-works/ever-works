import type { ResolvedToolGrants, ToolGrantDecision } from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import type { ToolGrantEnforcer, ToolGrantResolveInput } from './tool-grant.enforcer';

/**
 * Tool-grant matrix (audit item G4) — chat tools for the grant surface,
 * per the program DoD rule that every new entity ships with chat tools +
 * keyword slots, not just REST.
 *
 * Mirrors `agent-merge-policy-tools.ts`: a descriptor-factory the tool
 * assembly concatenates at run time (type-only import of
 * `TaskToolDescriptor`, so the Tasks runtime graph is NOT pulled into the
 * policy subpath).
 *
 * READ-ONLY by design. The tools explain what is granted and why; WRITING
 * a grant is an access-control change and goes through the REST surface
 * with its own ownership checks and audit trail. A model that can widen
 * its own tool access on request is not an access-control system.
 *
 * Keyword slots (wired in `apps/web/src/lib/ai/tools/tool-selection.ts`):
 * "tool grant", "tool access", "grant matrix", "allowed tools", "which
 * tools can", "why can't the agent", "revoke tool", "tool permission".
 */

export interface ResolveToolGrantsArgs {
    /** Resolve as it would apply to this Work. */
    workId?: string;
    /** Resolve as it would apply to this Agent (most specific scope). */
    agentId?: string;
}

export interface CheckToolGrantArgs extends ResolveToolGrantsArgs {
    /** The tool name to test against the effective matrix. */
    toolName?: string;
}

export function buildToolGrantTools(args: {
    /**
     * Owner scope. The caller (API / chat runtime) has already established
     * this user; the tools only ever resolve scopes they are handed.
     */
    userId: string;
    service: Pick<ToolGrantEnforcer, 'resolve' | 'decide'>;
    /**
     * Owner check for the ids the MODEL supplies — without it the tool is
     * a cross-tenant access-policy oracle. Returns the scope tuple the
     * user may resolve, or null when they may not.
     */
    authorize: (input: ResolveToolGrantsArgs) => Promise<ToolGrantResolveInput | null>;
}): TaskToolDescriptor[] {
    const out: TaskToolDescriptor[] = [];

    const scopeProperties = {
        workId: {
            type: 'string' as const,
            description: 'Resolve the grants as they apply to this Work.',
        },
        agentId: {
            type: 'string' as const,
            description:
                'Resolve the grants as they apply to this Agent (the most specific scope; its Work, organization and tenant are discovered automatically).',
        },
    };

    out.push({
        name: 'resolve_tool_grants',
        description:
            'Resolve the effective tool-grant matrix for a Work or Agent — which tools are allowed, which are denied, and which scope (tenant, organization, Work, Agent or the platform default) each rule came from. Also reports grant patterns a scope asked for that its parent scope never granted (those are rejected, never widened). Use when the user asks what tools an agent may use, why a tool is unavailable, or who controls tool access.',
        parameters: {
            type: 'object',
            properties: scopeProperties,
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as ResolveToolGrantsArgs;
            if (!a.workId && !a.agentId) {
                return { error: 'Provide workId or agentId to resolve a tool-grant matrix.' };
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
    } satisfies TaskToolDescriptor<ResolveToolGrantsArgs, ResolvedToolGrants | { error: string }>);

    out.push({
        name: 'check_tool_grant',
        description:
            'Check whether ONE named tool is currently allowed for a Work or Agent, and report which scope decided. Use when the user asks "can this agent call X?" or wants to know why a specific tool was refused.',
        parameters: {
            type: 'object',
            properties: {
                ...scopeProperties,
                toolName: {
                    type: 'string',
                    description: 'The exact tool name to test, e.g. "commitToRepo".',
                },
            },
            required: ['toolName'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as CheckToolGrantArgs;
            if (!a.toolName || typeof a.toolName !== 'string') {
                return { error: 'toolName is required.' };
            }
            if (!a.workId && !a.agentId) {
                return { error: 'Provide workId or agentId to check a tool grant.' };
            }
            try {
                const scope = await args.authorize(a);
                if (!scope) {
                    return { error: 'Not found or not accessible to the current user.' };
                }
                return await args.service.decide(scope, a.toolName);
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies TaskToolDescriptor<CheckToolGrantArgs, ToolGrantDecision | { error: string }>);

    return out;
}
