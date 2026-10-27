import {
    FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH,
    isFleetAgentSessionProvider,
    type FleetSessionListResponse,
    type FleetSessionView,
} from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../tasks-domain/agent-task-tools';
import type { FleetSessionService } from './sessions/fleet-session.service';
import { fleetSessionError, readFleetSessionError } from './sessions/fleet-session.errors';

/**
 * Sessions on computers (FL-04 P2, spec FR-51, FR-52, plan §9) — the
 * `sessions` tool family an Agent works with:
 *
 *  - `fleet_sessions_list` / `fleet_sessions_read` — read-only;
 *  - `fleet_sessions_start` — state-changing (`plain`): ALWAYS an Agent
 *    session of THIS Agent (the actor carries its id, so the service can
 *    never be talked into an owner session, FR-51);
 *  - `fleet_sessions_send` — state-changing (`plain`): text typed into one of
 *    this Agent's live sessions;
 *  - `fleet_sessions_rename` — state-changing (`plain`);
 *  - `fleet_sessions_end` — destructive (`confirm`): needs `confirm: true`,
 *    else the CONTRACTS §2.2 `confirmation_required` envelope with the
 *    sentence to show;
 *  - (FL-05 P2) `fleet_sessions_question` — read-only: what a session asks
 *    right now (prompt, options, reason, where it was read) — ANY session the
 *    owner may see, so one Agent can see what another waits on (spec S13);
 *  - (FL-05 P2) `fleet_sessions_answer` — `confirm` class (FL-19 catalogue
 *    §9.1): answers a session's QUESTION with an option or a text; a
 *    permission prompt is refused `permission_denied` unconditionally
 *    (people only), and another session's question only when the Agent's
 *    owner switched on "may answer other sessions" (CONTRACTS R-32).
 *
 * Every refusal answers the CONTRACTS §8 envelope (`{ error: { code, hint } }`)
 * so the model reads a reason it can act on. Every act runs through
 * `FleetSessionService` as the Agent's owner, so the Node's `sessions`
 * audience, the kill switch and the audit row are the same as a person's.
 * The tools act on the Agent's OWN sessions only (read included): another
 * session of the owner's — an owner shell — is not the Agent's to read.
 */

type ToolError = { error: { code: string; hint: string } } | { error: string };

function refusal(error: unknown): ToolError {
    const typed = readFleetSessionError(error);
    if (typed) return { error: { code: typed.code, hint: typed.hint } };
    return { error: error instanceof Error ? error.message : String(error) };
}

function compact(view: FleetSessionView) {
    return {
        id: view.id,
        nodeId: view.nodeId,
        title: view.title,
        state: view.state,
        provider: view.provider,
        cwd: view.cwd,
        outcome: view.outcome,
        endedReason: view.endedReason,
        exitCode: view.exitCode,
        agentRunId: view.agentRunId,
        lastActivityAt: view.lastActivityAt,
    };
}

export interface FleetSessionsToolService {
    service: Pick<
        FleetSessionService,
        | 'listPage'
        | 'get'
        | 'start'
        | 'restart'
        | 'rename'
        | 'end'
        | 'sendInput'
        | 'question'
        | 'answer'
    >;
}

export function buildFleetSessionTools(args: {
    /** The Agent's owner: every act runs as them. */
    userId: string;
    /** The Agent the tools belong to. */
    agentId: string;
    service: FleetSessionsToolService['service'];
}): TaskToolDescriptor[] {
    const actor = { userId: args.userId, agentId: args.agentId };
    const own = async (sessionId: string): Promise<FleetSessionView> => {
        const view = await args.service.get(String(sessionId ?? ''), actor);
        // Not this Agent's: as unknown as a missing one.
        if (view.agentId !== args.agentId) throw fleetSessionError('not_found', 'no such session');
        return view;
    };
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: 'fleet_sessions_list',
        description:
            'Read-only. List your own sessions on the computers you may use — interactive terminals you started (Claude Code or Codex), live first. Each carries its id, computer, title, state and folder.',
        parameters: {
            type: 'object',
            properties: {
                state: { type: 'string', description: 'Optional: live or ended.' },
                nodeId: { type: 'string', description: 'Optional: one computer’s id.' },
                limit: {
                    type: 'integer',
                    description: 'Max sessions (default 20, capped at 100).',
                },
            },
            required: [],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { state?: string; nodeId?: string; limit?: number };
            try {
                const page: FleetSessionListResponse = await args.service.listPage(actor, {
                    agentId: args.agentId,
                    limit: Math.min(Math.max(Number(a.limit) || 20, 1), 100),
                    ...(a.state === 'live' || a.state === 'ended' ? { state: a.state } : {}),
                    ...(typeof a.nodeId === 'string' && a.nodeId ? { nodeId: a.nodeId } : {}),
                });
                return { sessions: page.sessions.map(compact) };
            } catch (error) {
                return refusal(error);
            }
        },
    } satisfies TaskToolDescriptor<{ state?: string; nodeId?: string; limit?: number }, unknown>);

    out.push({
        name: 'fleet_sessions_read',
        description:
            'Read-only. One of your sessions: its state and, once it ended, the last screen the computer kept (plain text).',
        parameters: {
            type: 'object',
            properties: { sessionId: { type: 'string', description: 'The session id.' } },
            required: ['sessionId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { sessionId?: string };
            try {
                const view = await own(String(a.sessionId ?? ''));
                return { session: compact(view), lastScreen: view.lastScreen ?? null };
            } catch (error) {
                return refusal(error);
            }
        },
    } satisfies TaskToolDescriptor<{ sessionId?: string }, unknown>);

    out.push({
        name: 'fleet_sessions_start',
        description:
            'Start an interactive session on one of your computers where YOU (this Agent) work in Claude Code or Codex, isolated from the machine owner’s own configuration, with your own Run. Needs the computer started with --work. The session waits for a free slot when the computer is busy.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer’s id.' },
                provider: { type: 'string', description: 'claude-code or codex.' },
                cwd: {
                    type: 'string',
                    description: 'The folder on the computer (~ is the home folder).',
                },
                firstMessage: {
                    type: 'string',
                    description:
                        'What to do first (3–4 000 characters); typed into the CLI as it starts.',
                },
                title: { type: 'string', description: 'Optional title (1–200 characters).' },
                restartOf: {
                    type: 'string',
                    description: 'Optional: an ended session of yours to start again.',
                },
                taskId: {
                    type: 'string',
                    description:
                        'FL-15: the Task this session works on. Your Run carries it (its history, the board and its chat follow). Refused busy while you already work it, and on a computer other than the one you are pinned to. See fleet_tasks_handoff_options.',
                },
                checkoutId: {
                    type: 'string',
                    description:
                        'FL-15: start in this ready checkout on the computer (its folder replaces cwd). Make a new worktree or clone with fleet_checkouts_create first.',
                },
            },
            required: ['nodeId', 'provider', 'cwd', 'firstMessage'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as {
                nodeId?: string;
                provider?: string;
                cwd?: string;
                firstMessage?: string;
                title?: string;
                restartOf?: string;
                taskId?: string;
                checkoutId?: string;
            };
            if (!isFleetAgentSessionProvider(a.provider)) {
                return {
                    error: { code: 'invalid', hint: 'provider is claude-code or codex' },
                } as unknown;
            }
            try {
                if (a.restartOf) {
                    const ended = await own(a.restartOf);
                    const view = await args.service.restart(
                        ended.id,
                        actor,
                        {},
                        { expectNodeId: String(a.nodeId ?? '') },
                    );
                    return { session: compact(view) };
                }
                const view = await args.service.start(String(a.nodeId ?? ''), actor, {
                    kind: 'agent',
                    provider: a.provider,
                    cwd: String(a.cwd ?? ''),
                    firstMessage: String(a.firstMessage ?? '').slice(
                        0,
                        FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH,
                    ),
                    agentId: args.agentId,
                    ...(a.title ? { title: String(a.title) } : {}),
                    // FL-15 P1/P3: the one start tool takes the Task and the checkout (spec FR-21).
                    ...(a.taskId ? { taskId: String(a.taskId) } : {}),
                    ...(a.checkoutId ? { checkoutId: String(a.checkoutId) } : {}),
                });
                return { session: compact(view), ...(view.task ? { task: view.task } : {}) };
            } catch (error) {
                return refusal(error);
            }
        },
    } satisfies TaskToolDescriptor<Record<string, unknown>, unknown>);

    out.push({
        name: 'fleet_sessions_send',
        description:
            'Type text into one of your live sessions, followed by Enter (as if you typed it at its keyboard). Max 4 000 characters.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string', description: 'The session id.' },
                text: { type: 'string', description: 'What to type.' },
            },
            required: ['sessionId', 'text'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { sessionId?: string; text?: string };
            const text = String(a.text ?? '');
            if (text.length === 0 || text.length > FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH) {
                return {
                    error: { code: 'invalid', hint: 'text is 1–4 000 characters' },
                } as unknown;
            }
            try {
                const view = await own(String(a.sessionId ?? ''));
                await args.service.sendInput(view.id, actor, `${text}\r`);
                return { sent: true };
            } catch (error) {
                return refusal(error);
            }
        },
    } satisfies TaskToolDescriptor<{ sessionId?: string; text?: string }, unknown>);

    out.push({
        name: 'fleet_sessions_rename',
        description: 'Rename one of your sessions (1–200 characters).',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string', description: 'The session id.' },
                title: { type: 'string', description: 'The new title.' },
            },
            required: ['sessionId', 'title'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { sessionId?: string; title?: string };
            try {
                const view = await own(String(a.sessionId ?? ''));
                return {
                    session: compact(
                        await args.service.rename(view.id, actor, String(a.title ?? '')),
                    ),
                };
            } catch (error) {
                return refusal(error);
            }
        },
    } satisfies TaskToolDescriptor<{ sessionId?: string; title?: string }, unknown>);

    out.push({
        name: 'fleet_sessions_end',
        description:
            'DESTRUCTIVE. End one of your sessions: the process is stopped and your Run ends with it. Call with confirm: true only once the person agreed; without it you get the sentence to ask them.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string', description: 'The session id.' },
                confirm: { type: 'boolean', description: 'true once the end was confirmed.' },
            },
            required: ['sessionId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { sessionId?: string; confirm?: boolean };
            try {
                const view = await own(String(a.sessionId ?? ''));
                return {
                    session: compact(
                        await args.service.end(view.id, actor, { confirm: a.confirm === true }),
                    ),
                };
            } catch (error) {
                return refusal(error);
            }
        },
    } satisfies TaskToolDescriptor<{ sessionId?: string; confirm?: boolean }, unknown>);

    // ─── FL-05 P2 — what a session asks, and answering it ──────────────────

    out.push({
        name: 'fleet_sessions_question',
        description:
            'Read-only. What a session on a computer is waiting for right now: the prompt, its options, whether it takes free text, and why it waits (question, permission, blocked). Works for any session you may see, not only yours. Null when nothing waits.',
        parameters: {
            type: 'object',
            properties: { sessionId: { type: 'string', description: 'The session id.' } },
            required: ['sessionId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { sessionId?: string };
            try {
                return await args.service.question(String(a.sessionId ?? ''), actor);
            } catch (error) {
                return refusal(error);
            }
        },
    } satisfies TaskToolDescriptor<{ sessionId?: string }, unknown>);

    out.push({
        name: 'fleet_sessions_answer',
        description:
            'Answer a QUESTION a session is waiting on: one of its options (optionId) or, when it takes one, a free text. Permission prompts are answered by people only and are refused. Answering another Agent\u2019s session needs your owner to have switched on "may answer other sessions" for you. Call with confirm: true once you are sure; without it you get the sentence to confirm.',
        parameters: {
            type: 'object',
            properties: {
                sessionId: { type: 'string', description: 'The session id.' },
                key: {
                    type: 'string',
                    description: 'The attention key fleet_sessions_question gave.',
                },
                optionId: { type: 'string', description: 'One of the options (or give text).' },
                text: {
                    type: 'string',
                    description: 'A free-text answer, when the question takes one.',
                },
                confirm: { type: 'boolean', description: 'true once the answer is decided.' },
            },
            required: ['sessionId', 'key'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as {
                sessionId?: string;
                key?: string;
                optionId?: string;
                text?: string;
                confirm?: boolean;
            };
            try {
                const asked = await args.service.question(String(a.sessionId ?? ''), actor);
                if (a.confirm !== true) {
                    const choice =
                        typeof a.optionId === 'string'
                            ? (asked.attention?.options.find((option) => option.id === a.optionId)
                                  ?.label ?? a.optionId)
                            : 'your text';
                    return {
                        error: {
                            code: 'confirmation_required',
                            hint: `Answer "${asked.attention?.prompt ?? 'this prompt'}" with ${choice}?`,
                            details: { class: 'confirm' },
                        },
                    } as unknown;
                }
                return await args.service.answer(
                    String(a.sessionId ?? ''),
                    actor,
                    {
                        key: String(a.key ?? ''),
                        ...(typeof a.optionId === 'string' ? { optionId: a.optionId } : {}),
                        ...(typeof a.text === 'string' ? { text: a.text } : {}),
                    },
                    'tool',
                );
            } catch (error) {
                return refusal(error);
            }
        },
    } satisfies TaskToolDescriptor<Record<string, unknown>, unknown>);

    return out;
}
