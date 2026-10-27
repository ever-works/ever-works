import {
    groupFleetPorts,
    isFleetPortNumber,
    isFleetPortOpenTarget,
    type FleetPortOpenResult,
} from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';
import { readFleetPortsError } from './fleet-ports.errors';
import type { FleetPortTunnelService } from './fleet-port-tunnel.service';
import type { FleetPortsService } from './fleet-ports.service';

/**
 * Servers and ports (FL-10, spec S11, FR-20) — the Agent's tools:
 *
 *  - `fleet_ports_list` — read-only: the same list a person sees (web
 *    servers first, the rest folded), nothing audited;
 *  - `fleet_ports_open` — not destructive, class `plain`, audited as
 *    `agent:<id>`: opens a server ON THE MACHINE (its desktop, or its preview
 *    browser). The address is never an argument: the tool takes a port
 *    number, and the node builds `http(s)://127.0.0.1:<port>/` itself, so no
 *    call can aim it at another host.
 *
 * Both run as the Agent for its owner, through the node's audiences (CONTRACTS
 * §2.1) — an Agent sees exactly what its owner may see, and the link's gate
 * (kill switch, `--manage`) applies unchanged. A refusal comes back as
 * `{ error, code }`.
 */

export interface FleetPortsToolArgs {
    nodeId: string;
    /** Ports to watch for (reported as waiting until something listens). */
    watch?: number[];
}

export interface FleetPortsOpenToolArgs {
    nodeId: string;
    port: number;
    target?: string;
}

function failure(error: unknown): { error: string; code?: string } {
    const typed = readFleetPortsError(error);
    if (typed) return { error: typed.hint, code: typed.code };
    return { error: error instanceof Error ? error.message : String(error) };
}

export function buildFleetPortsTools(args: {
    agent: { id: string; userId: string; name?: string | null };
    service: Pick<FleetPortsService, 'list' | 'open'>;
    /** Phase 2 — `fleet_ports_preview_open|close`; absent (or the flag off), they are not offered. */
    tunnels?: Pick<FleetPortTunnelService, 'open' | 'closeForUser' | 'isEnabled'> | null;
}): TaskToolDescriptor[] {
    const actor = {
        kind: 'agent' as const,
        agentId: args.agent.id,
        ownerUserId: args.agent.userId,
        agentName: args.agent.name ?? null,
    };
    const out: TaskToolDescriptor[] = [];

    out.push({
        name: 'fleet_ports_list',
        description:
            'List the TCP ports a computer in the fleet is listening on, as read on the machine itself: web servers first (port, page title, HTTP status, program or container behind it, whether it is only reachable on the machine), then other ports (databases, ssh) and hidden system ports. Read-only. Use it to find the address of a dev server an agent started, or to say what is on a port.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer (fleet node id).' },
                watch: {
                    type: 'array',
                    items: { type: 'integer' },
                    description:
                        'Optional ports to watch for: listed as waiting until a server starts on them.',
                },
            },
            required: ['nodeId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as FleetPortsToolArgs;
            if (typeof a.nodeId !== 'string' || a.nodeId.length === 0)
                return { error: 'nodeId is required' };
            try {
                const list = await args.service.list(a.nodeId, actor, { watch: a.watch });
                const groups = groupFleetPorts(list.ports);
                return {
                    computer: list.nodeName,
                    sampledAt: list.sampledAt,
                    webServers: groups.web,
                    otherPorts: groups.other,
                    systemPorts: groups.noise.length,
                    waiting: groups.waiting.map((port) => port.port),
                    canOpen: list.canOpen,
                    defaultTarget: list.defaultTarget,
                };
            } catch (error) {
                return failure(error);
            }
        },
    } satisfies TaskToolDescriptor<FleetPortsToolArgs, Record<string, unknown>>);

    out.push({
        name: 'fleet_ports_open',
        description:
            "Open a web server ON the computer it runs on: in the machine's default browser on its desktop when it has one the node can reach, otherwise in the computer's preview browser (a browser profile no agent uses). Not destructive; audited. Takes a port number — the address is always that port on the machine itself. Returns where it opened. It does not show you the page.",
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The computer (fleet node id).' },
                port: { type: 'integer', description: 'The listening port, 1–65535.' },
                target: {
                    type: 'string',
                    description:
                        'Optional: desktop or preview-profile. Default: the desktop when available.',
                },
            },
            required: ['nodeId', 'port'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as FleetPortsOpenToolArgs;
            if (typeof a.nodeId !== 'string' || a.nodeId.length === 0)
                return { error: 'nodeId is required' };
            const port = Number(a.port);
            if (!isFleetPortNumber(port)) return { error: 'port must be a number from 1 to 65535' };
            const target = isFleetPortOpenTarget(a.target) ? a.target : undefined;
            if (a.target !== undefined && target === undefined) {
                return { error: 'target must be desktop or preview-profile' };
            }
            try {
                const result: FleetPortOpenResult = await args.service.open(
                    a.nodeId,
                    port,
                    actor,
                    target ? { target } : {},
                );
                // Never hand the Agent a viewer token: the picture is for a person.
                return {
                    opened: true,
                    target: result.target,
                    url: result.url,
                    endsAt: result.endsAt ?? null,
                };
            } catch (error) {
                return failure(error);
            }
        },
    } satisfies TaskToolDescriptor<FleetPortsOpenToolArgs, Record<string, unknown>>);

    const tunnels = args.tunnels;
    if (tunnels && tunnels.isEnabled()) {
        out.push({
            name: 'fleet_ports_preview_open',
            description:
                "Open a preview of a fleet computer's web server for your OWNER to see in their own browser: an owner-only, time-boxed link (closes after 10 idle minutes or 60 minutes; at most 4 per person). Not destructive; audited. You cannot open the link yourself — tell your owner to choose Preview in my browser on the computer's Ports tab, where it is already open.",
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'The computer (fleet node id).' },
                    port: { type: 'integer', description: 'The listening port, 1–65535.' },
                },
                required: ['nodeId', 'port'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { nodeId?: string; port?: number };
                if (typeof a.nodeId !== 'string' || a.nodeId.length === 0)
                    return { error: 'nodeId is required' };
                const port = Number(a.port);
                if (!isFleetPortNumber(port))
                    return { error: 'port must be a number from 1 to 65535' };
                try {
                    const { tunnel } = await tunnels.open(a.nodeId, port, actor);
                    // Never a hand-off: an Agent is never given a way into the tunnel (spec U15).
                    return {
                        opened: true,
                        url: tunnel.url,
                        endsAt: tunnel.endsAt,
                        forOwner:
                            'Your owner opens it from the Ports tab (Preview in my browser) — the link works only in their browser.',
                    };
                } catch (error) {
                    return failure(error);
                }
            },
        } satisfies TaskToolDescriptor<
            { nodeId?: string; port?: number },
            Record<string, unknown>
        >);

        out.push({
            name: 'fleet_ports_preview_close',
            description:
                "Close the preview of a fleet computer's port that was opened for your owner.",
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'The computer (fleet node id).' },
                    port: { type: 'integer', description: 'The port whose preview to close.' },
                },
                required: ['nodeId', 'port'],
            },
            invoke: async (raw) => {
                const a = (raw ?? {}) as { nodeId?: string; port?: number };
                if (typeof a.nodeId !== 'string' || a.nodeId.length === 0)
                    return { error: 'nodeId is required' };
                const port = Number(a.port);
                if (!isFleetPortNumber(port))
                    return { error: 'port must be a number from 1 to 65535' };
                try {
                    await tunnels.closeForUser(a.nodeId, port, actor);
                    return { closed: true };
                } catch (error) {
                    return failure(error);
                }
            },
        } satisfies TaskToolDescriptor<
            { nodeId?: string; port?: number },
            Record<string, unknown>
        >);
    }

    return out;
}
