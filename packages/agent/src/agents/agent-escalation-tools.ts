import type { AgentEscalationDto, AgentEscalationStatus } from '@ever-works/contracts';
import type { AgentToolDescriptor } from './agent-tool.service';
import type { AgentEscalationService } from './agent-escalation.service';

/**
 * Judgment layer G3/G10 — chat tools for the escalation queue, per the
 * program DoD rule that every entity ships with chat tools + keyword
 * slots (REST alone is not "shipped").
 *
 * Mirrors `fleet/agent-fleet-tools.ts`: a descriptor factory the tool
 * assembly concatenates at run time, reached through the existing
 * `AGENT_DOMAIN_TOOL_SOURCES` bundle. Every import here is TYPE-ONLY —
 * `AgentEscalationService` transitively pulls the AI facade (the
 * confidence judge), and `AgentToolService` must not gain that runtime
 * graph just to describe two tools.
 *
 * Keyword slots (web side, `tool-selection.ts`): "escalation",
 * "escalated", "needs a decision", "waiting on me", "blocked on me",
 * "gave up", "stuck run".
 *
 * Owner scope: every tool reads/writes ONLY `args.userId` — the agent's
 * owner. The model never supplies a user id, so there is no parameter to
 * tamper with.
 */

export interface ListEscalationsArgs {
    /** `open` (default), `resolved`, or `all`. */
    status?: string;
    /** Max rows (default 20, capped at 50). */
    limit?: number;
}

export interface ResolveEscalationArgs {
    escalationId: string;
    note?: string;
}

export type EscalationToolService = Pick<AgentEscalationService, 'listForUser' | 'resolve'>;

/** Narrow an untrusted tool argument to a status, or `undefined`. */
function parseStatusArg(value: unknown): AgentEscalationStatus | undefined {
    return value === 'open' || value === 'resolved' ? value : undefined;
}

export function buildEscalationTools(args: {
    userId: string;
    service: EscalationToolService;
}): AgentToolDescriptor[] {
    const out: AgentToolDescriptor[] = [];

    out.push({
        name: 'list_escalations',
        description:
            'List the escalations waiting on the current user — the moments an agent stopped without finishing and needs a human decision (quality gate exhausted, a guardrail or merge policy refused, a budget stopped the work, a run parked or queued too long, or the doom-loop detector stopped a run cycling on the same failure). Highest-confidence first. Each entry carries what happened, what must be decided, what was already tried, and how sure the platform is that a person is genuinely required. Use when the user asks what is waiting on them, what is blocked, or why an agent gave up.',
        parameters: {
            type: 'object',
            properties: {
                status: {
                    type: 'string',
                    description: 'open (default), resolved, or all.',
                },
                limit: {
                    type: 'integer',
                    description: 'Max escalations to return (default 20, capped at 50).',
                },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as ListEscalationsArgs;
            const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
            try {
                const escalations = await args.service.listForUser(args.userId, {
                    // `all` is the ONLY way to see resolved rows: an
                    // unrecognized value falls back to `open`, which is
                    // the safe, useful default rather than a silent
                    // everything-dump.
                    ...(a.status === 'all' ? {} : { status: parseStatusArg(a.status) ?? 'open' }),
                    limit,
                });
                return { escalations };
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies AgentToolDescriptor<ListEscalationsArgs, { escalations: AgentEscalationDto[] }>);

    out.push({
        name: 'resolve_escalation',
        description:
            'Close one escalation once the decision has been made, with an optional note recording what was decided. Only the current user’s own open escalations can be resolved; resolving an already-resolved or unknown escalation reports resolved=false rather than failing.',
        parameters: {
            type: 'object',
            properties: {
                escalationId: {
                    type: 'string',
                    description: 'Id of the escalation to close.',
                },
                note: {
                    type: 'string',
                    description: 'What was decided (stored on the escalation).',
                },
            },
            required: ['escalationId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as ResolveEscalationArgs;
            const escalationId = String(a.escalationId ?? '').trim();
            if (!escalationId) return { resolved: false, error: 'escalationId is required.' };
            try {
                const resolved = await args.service.resolve(
                    escalationId,
                    args.userId,
                    a.note ? String(a.note) : null,
                );
                return { resolved };
            } catch (err) {
                return {
                    resolved: false,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        },
    } satisfies AgentToolDescriptor<ResolveEscalationArgs, { resolved: boolean; error?: string }>);

    return out;
}
