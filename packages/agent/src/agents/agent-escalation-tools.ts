import type { AgentEscalationDto, AgentEscalationStatus } from '@ever-works/contracts';
import type { AgentToolDescriptor } from './agent-tool.service';
import type { AgentEscalationService } from './agent-escalation.service';
import type { AgentProposalToolSource } from './agent-domain-tool-sources';
// Leaf constant (no runtime graph) — the listener that applies an approved
// proposal keys on it.
import { AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND } from './agent-proposal-kinds';

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
 *
 * ## `resolve_escalation` never resolves on its own (prompt-injection hardening)
 *
 * An escalation is a HUMAN gate: the moment an agent stopped because a person
 * must decide. When the tool resolved it directly, any agent — including one
 * steered by injected text — could close the owner's gate, and its note was
 * handed to the parked run as the owner's answer (a resumed fleet run renders
 * it under `# OWNER ANSWER`). The tool now files a PENDING approval proposal
 * instead; only the owner's approval closes the escalation, and even then the
 * resolution is recorded as agent-authored and never resumes or steers the
 * linked run (`AgentEscalationService.resolve(..., { resolvedBy: 'agent' })`).
 * With no approval queue bound the tool refuses (fail closed).
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

export type EscalationToolService = Pick<AgentEscalationService, 'listForUser' | 'resolve'> &
    Partial<Pick<AgentEscalationService, 'getForUser'>>;

/** Most characters of the proposed note carried on the approval proposal. */
const PROPOSED_NOTE_MAX = 2_000;

/** Narrow an untrusted tool argument to a status, or `undefined`. */
function parseStatusArg(value: unknown): AgentEscalationStatus | undefined {
    return value === 'open' || value === 'resolved' ? value : undefined;
}

export function buildEscalationTools(args: {
    userId: string;
    service: EscalationToolService;
    /** The Agent calling the tools — the proposal is filed in its name. */
    agentId?: string | null;
    /** The run the call happens in (`null` outside a run). */
    agentRunId?: string | null;
    /** The owner-approval seam. Unbound → `resolve_escalation` refuses. */
    proposals?: AgentProposalToolSource | null;
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
            'Propose closing one of the current user’s open escalations, with a note recording what you believe was decided. This does NOT close it: it files an approval request the owner must approve in their Inbox, and even an approved resolution never restarts the run that was waiting on the escalation — only the owner answering it themselves does. Returns pendingApproval=true with the proposal id; resolving an unknown or already-resolved escalation reports proposed=false.',
        parameters: {
            type: 'object',
            properties: {
                escalationId: {
                    type: 'string',
                    description: 'Id of the escalation to propose closing.',
                },
                note: {
                    type: 'string',
                    description:
                        'What you believe was decided (shown to the owner with the request).',
                },
            },
            required: ['escalationId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as ResolveEscalationArgs;
            const escalationId = String(a.escalationId ?? '').trim();
            if (!escalationId) {
                return { resolved: false, proposed: false, error: 'escalationId is required.' };
            }
            if (!args.proposals || !args.agentId) {
                // Fail closed: without an approval path the agent may not
                // close a human gate at all.
                return {
                    resolved: false,
                    proposed: false,
                    error: 'Escalations are decided by the owner. No approval queue is available here, so this escalation was left open — ask the owner to resolve it.',
                };
            }
            try {
                if (typeof args.service.getForUser === 'function') {
                    const existing = await args.service.getForUser(escalationId, args.userId);
                    if (!existing || existing.status !== 'open') {
                        // Unknown, foreign or already resolved: nothing to propose.
                        return { resolved: false, proposed: false };
                    }
                }
                const note = a.note ? String(a.note).slice(0, PROPOSED_NOTE_MAX) : null;
                const proposal = await args.proposals.propose(args.userId, {
                    agentId: args.agentId,
                    runId: args.agentRunId ?? null,
                    title: `Agent asks to close escalation ${escalationId.slice(0, 8)}`,
                    // One request per escalation: a retry returns the pending one.
                    subjectKey: `escalation:${escalationId}`,
                    payload: {
                        kind: AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND,
                        escalationId,
                        note,
                    },
                });
                if (proposal.status === 'rejected') {
                    return {
                        resolved: false,
                        proposed: false,
                        error: "This agent's guardrails do not allow it to close escalations.",
                    };
                }
                return {
                    resolved: false,
                    proposed: true,
                    pendingApproval: true,
                    proposalId: proposal.id,
                    // Said explicitly so the model does not retry.
                    note: 'Waiting for the owner to approve. The escalation stays open until they do; do not retry.',
                };
            } catch (err) {
                return {
                    resolved: false,
                    proposed: false,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        },
    } satisfies AgentToolDescriptor<
        ResolveEscalationArgs,
        {
            resolved: boolean;
            proposed: boolean;
            pendingApproval?: boolean;
            proposalId?: string;
            note?: string;
            error?: string;
        }
    >);

    return out;
}
