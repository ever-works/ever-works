import type { FleetDisplayView } from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';

/**
 * Desktop view & control (FL-07, plan §9, T-28, FR-31) — the Agent's read of a
 * computer's desktop, under the name CONTRACTS §11.3 fixes:
 *
 *  - `fleet_desktop_displays` — the displays the machine last reported (id,
 *    name, size, scale, primary), the same list a person sees. Read-only.
 *
 * `fleet_desktop_screenshot` (FR-30) is served by the API route
 * `GET /api/fleet/nodes/:id/desktop/screenshot` for MCP and the CLI; the Agent
 * tool waits for the tool runtime to carry a picture as an image rather than
 * as thousands of tokens of text (lane log, owner question).
 *
 * The node link lives in the API, which this package must not import, so the
 * read goes through {@link FleetDesktopReaderPort} (bound by the API's desktop
 * module under {@link FLEET_DESKTOP_READER}). Gates: the Agent's own grants are
 * FL-19's (it assembles these tools behind them); the port checks the
 * computer's `desktop` audience for the Agent's OWNER (R-25) and `--attend`.
 * Errors are the CONTRACTS §8 envelope `{ error: { code, hint } }`, the same
 * sentences the Desktop tab shows.
 */

export const FLEET_DESKTOP_DISPLAYS_TOOL_NAME = 'fleet_desktop_displays';

export const FLEET_DESKTOP_TOOL_ANNOTATIONS = {
    [FLEET_DESKTOP_DISPLAYS_TOOL_NAME]: {
        readOnly: true,
        destructive: false,
        confirmationClass: 'plain',
    },
} as const;

/** Who is asking: the Agent and the person it works for. */
export interface FleetDesktopAgentCaller {
    agentId: string;
    ownerUserId: string;
}

/** The API's half of the Agent's desktop reads. */
export interface FleetDesktopReaderPort {
    readDisplays(caller: FleetDesktopAgentCaller, nodeId: string): Promise<FleetDisplayView[]>;
}

/** DI token the API binds to its desktop service. */
export const FLEET_DESKTOP_READER = 'FLEET_DESKTOP_READER' as const;

type ToolError = { error: { code: string; hint: string } };

/** A refusal from the port: the CONTRACTS §8 envelope it threw, else a 404/403 by status, else `internal`. */
function refusal(err: unknown): ToolError {
    const response = (err as { getResponse?: () => unknown } | null)?.getResponse?.();
    const envelope = (response as { error?: { code?: unknown; hint?: unknown } } | null)?.error;
    if (envelope && typeof envelope.code === 'string') {
        return {
            error: {
                code: envelope.code,
                hint: typeof envelope.hint === 'string' ? envelope.hint : '',
            },
        };
    }
    const status = (err as { getStatus?: () => number } | null)?.getStatus?.();
    if (status === 404) return { error: { code: 'not_found', hint: 'no such computer' } };
    if (status === 403)
        return {
            error: {
                code: 'permission_denied',
                hint: err instanceof Error ? err.message : 'not allowed',
            },
        };
    return { error: { code: 'internal', hint: err instanceof Error ? err.message : String(err) } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildFleetDesktopTools(args: {
    agentId: string;
    /** The Agent's owner: the audience check is about them. */
    userId: string;
    reader: FleetDesktopReaderPort;
}): TaskToolDescriptor[] {
    const caller: FleetDesktopAgentCaller = { agentId: args.agentId, ownerUserId: args.userId };
    return [
        {
            name: FLEET_DESKTOP_DISPLAYS_TOOL_NAME,
            description:
                "List the displays of one of the user's computers as its screen helper last reported them: each display's id, name, pixel size, scale and whether it is the primary. The same list a person sees in the Desktop tab. Read-only; needs the computer to run with --attend and an approved screen helper.",
            parameters: {
                type: 'object',
                properties: {
                    nodeId: {
                        type: 'string',
                        description: 'The computer (its id, from list_fleet_nodes).',
                    },
                },
                required: ['nodeId'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { nodeId?: unknown };
                if (typeof a.nodeId !== 'string' || !UUID.test(a.nodeId)) {
                    return { error: { code: 'invalid', hint: 'nodeId' } };
                }
                try {
                    return { displays: await args.reader.readDisplays(caller, a.nodeId) };
                } catch (err) {
                    return refusal(err);
                }
            },
        } satisfies TaskToolDescriptor,
    ];
}
