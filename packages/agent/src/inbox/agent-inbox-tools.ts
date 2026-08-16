import type { AgentToolDescriptor } from '../agents/agent-tool.service';
import type { AskHumanInput, InboxService } from './inbox.service';

/**
 * Inbox (operator message center) — the `askHuman` agent tool.
 *
 * Mirrors `agents/agent-escalation-tools.ts`: a descriptor factory the
 * tool assembly concatenates at run time, reached through the existing
 * `AGENT_DOMAIN_TOOL_SOURCES` bundle. Every import here is TYPE-ONLY —
 * `InboxService` transitively pulls the steering / approvals /
 * notification graphs, and `AgentToolService` must not gain that
 * runtime graph just to describe one tool.
 *
 * Available to EVERY agent — no permission gate on purpose: asking the
 * human is always safe (it grants nothing and touches nothing), and a
 * gated question tool would push agents back to guessing.
 *
 * Owner scope: the tool writes only for `userId` — the agent's owner —
 * and the run/task links come from the run context bound at build
 * time, never from the model.
 */

export interface AskHumanArgs {
    question: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    context?: string;
}

export type InboxToolService = Pick<InboxService, 'askHuman'>;

export function buildInboxTools(args: {
    userId: string;
    agentId: string;
    /** Executing run — `null` outside a real run (chat preview, tests). */
    agentRunId: string | null;
    service: InboxToolService;
}): AgentToolDescriptor[] {
    const out: AgentToolDescriptor[] = [];

    out.push({
        name: 'ask_human',
        description:
            'Ask your human operator a blocking question and PAUSE until they answer. Use this when you cannot proceed without a decision only a person can make — ambiguous requirements, a risky/irreversible step, missing credentials, or a choice between materially different directions. Optionally offer structured options (id + label) so the human can answer with one click. After calling this tool, finish your current turn promptly: the run is parked as awaiting input, and the human’s answer will arrive as the next user message when the run is resumed. Do not call this for questions you can resolve yourself or defer politely to the end of the work.',
        parameters: {
            type: 'object',
            properties: {
                question: {
                    type: 'string',
                    description: 'The question for the human, first line = subject.',
                },
                options: {
                    type: 'array',
                    description:
                        'Optional structured answers: [{id, label, description?}]. The chosen option label comes back in the answer.',
                    items: { type: 'object' },
                },
                context: {
                    type: 'string',
                    description:
                        'Optional background: what you tried, what is at stake, what each option implies.',
                },
            },
            required: ['question'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as AskHumanArgs;
            const question = String(a.question ?? '').trim();
            if (!question) {
                return { error: 'ask_human: question is required.' };
            }
            const input: AskHumanInput = {
                question,
                options: a.options,
                context: a.context ? String(a.context) : null,
            };
            try {
                const { item, parked } = await args.service.askHuman(args.userId, input, {
                    agentId: args.agentId,
                    agentRunId: args.agentRunId,
                });
                return {
                    asked: true,
                    inboxItemId: item.id,
                    parked,
                    message: parked
                        ? 'Your question was delivered to the human’s inbox and this run is now parked awaiting their reply. Finish your turn now with a short status summary; the answer will arrive as the next user message when the run resumes.'
                        : 'Your question was delivered to the human’s inbox. This run could not be parked automatically, so finish your turn with a short status summary; the answer will arrive in a future run.',
                };
            } catch (err) {
                return { error: err instanceof Error ? err.message : String(err) };
            }
        },
    } satisfies AgentToolDescriptor<
        AskHumanArgs,
        { asked: true; inboxItemId: string; parked: boolean; message: string }
    >);

    return out;
}
