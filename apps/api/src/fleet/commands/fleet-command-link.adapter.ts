import { Injectable, Logger } from '@nestjs/common';
import {
    FleetCommandException,
    type FleetCommandCancelInput,
    type FleetCommandNodePort,
    type FleetCommandPortCaller,
    type FleetCommandRunHandle,
    type FleetCommandStartInput,
} from '@ever-works/agent/fleet';
import {
    decodeFleetLinkExit,
    FLEET_LINK_FRAME_KINDS,
    makeFleetLinkError,
    parseFleetCommandNodeMessage,
    type FleetCommandRunStarted,
    type FleetConsents,
} from '@ever-works/contracts';
import type { FleetLinkChannel, FleetLinkChannelEvents } from '../../fleet-link/fleet-link-channel';
import { FleetLinkService } from '../../fleet-link/fleet-link.service';
import type { FleetLinkCaller } from '../../fleet-link/fleet-link.types';

/** How long `command.run` waits for the machine to say the process started. */
export const FLEET_COMMAND_START_TIMEOUT_MS = 20_000;

/** How long `command.cancel` waits for the machine's answer. */
export const FLEET_COMMAND_CANCEL_TIMEOUT_MS = 10_000;

/**
 * Commands on computers (FL-12) — `FLEET_COMMAND_NODE_PORT` over the node
 * link (FL-02). The agent package's `FleetCommandService` decides; this only
 * carries a run to the machine and its reports back.
 *
 * One `command` channel per run, opened with `{ commandId, nodeId, runId }`
 * (CONTRACTS §3.3, lane-log decision 4) through `FleetLinkService.openChannel`
 * — so the link's own gate runs first, in its order: the link flag,
 * existence, the kill switch (the family changes the machine), `manage`
 * against the consents the live link presented, the `commands` family
 * audience (the Agent's owner for an Agent), then "is it connected" on any
 * API replica. The open is audited by the link (`node.link.channel-open`).
 *
 * After the node accepted the channel this listens to it (the node says
 * nothing before `command.run`), so a failed start can stop listening BEFORE
 * it closes the channel — the service then reads one end, the refusal, never
 * a second "the channel closed" end racing it.
 */
@Injectable()
export class FleetCommandLinkAdapter implements FleetCommandNodePort {
    private readonly logger = new Logger(FleetCommandLinkAdapter.name);

    constructor(private readonly link: FleetLinkService) {}

    isConnected(nodeId: string): boolean {
        return this.link.isConnected(nodeId);
    }

    liveConsents(nodeId: string): FleetConsents | null {
        return this.link.liveConsents(nodeId);
    }

    async start(
        input: FleetCommandStartInput,
    ): Promise<{ handle: FleetCommandRunHandle; started: FleetCommandRunStarted }> {
        let channel: FleetLinkChannel | null = null;
        let unlisten: (() => void) | null = null;
        try {
            channel = await this.link.openChannel({
                nodeId: input.nodeId,
                family: 'command',
                params: { commandId: input.commandId, nodeId: input.nodeId, runId: input.runId },
                caller: toLinkCaller(input.caller),
                requirement: {
                    consent: 'manage',
                    actionFamily: 'commands',
                    stateChanging: true,
                    target: input.commandId,
                },
            });
            unlisten = channel.listen(this.eventsFor(input));
            const reply = await channel.request(
                'command.run',
                {
                    runId: input.runId,
                    command: input.command,
                    timeoutSec: input.timeoutSec,
                    ...(input.cwd ? { cwd: input.cwd } : {}),
                },
                { timeoutMs: FLEET_COMMAND_START_TIMEOUT_MS },
            );
            if ('error' in reply) throw new FleetCommandException(reply.error);
            if (!('result' in reply)) {
                // A run never answers with an operation id; a node that does is one we do not understand.
                throw new FleetCommandException(
                    makeFleetLinkError(
                        'operation_failed',
                        'the computer answered a command in a way this platform does not understand',
                    ),
                );
            }
            const opened = channel;
            return {
                handle: { close: () => this.closeQuietly(opened, input.nodeId) },
                started: readStarted(reply.result),
            };
        } catch (error) {
            unlisten?.();
            if (channel && !channel.isClosed) this.closeQuietly(channel, input.nodeId);
            throw error;
        }
    }

    async cancel(input: FleetCommandCancelInput): Promise<void> {
        let channel: FleetLinkChannel | null = null;
        try {
            channel = await this.link.openChannel({
                nodeId: input.nodeId,
                family: 'command',
                params: { commandId: input.commandId, nodeId: input.nodeId, runId: input.runId },
                caller: toLinkCaller(input.caller),
                // Stopping a command only stops spending: not refused by the link's
                // kill-switch gate (the kill switch already stops every command itself).
                requirement: {
                    consent: 'manage',
                    actionFamily: 'commands',
                    stateChanging: false,
                    target: input.commandId,
                },
            });
            const reply = await channel.request(
                'command.cancel',
                { runId: input.runId },
                { timeoutMs: FLEET_COMMAND_CANCEL_TIMEOUT_MS },
            );
            if ('error' in reply) throw new FleetCommandException(reply.error);
        } finally {
            if (channel && !channel.isClosed) this.closeQuietly(channel, input.nodeId);
        }
    }

    private eventsFor(input: FleetCommandStartInput): FleetLinkChannelEvents {
        const { sink } = input;
        return {
            json: (message) => {
                const parsed = parseFleetCommandNodeMessage(message);
                if (parsed) sink.message(parsed);
            },
            binary: (kind, payload) => {
                if (kind === FLEET_LINK_FRAME_KINDS.DATA) sink.data(payload);
                else if (kind === FLEET_LINK_FRAME_KINDS.EXIT) sink.exit(decodeFleetLinkExit(payload));
            },
            close: (reason, hint) => sink.closed(reason, hint),
            resume: () => sink.resumed?.(),
        };
    }

    private closeQuietly(channel: FleetLinkChannel, nodeId: string): void {
        if (channel.isClosed) return;
        try {
            channel.close('normal');
        } catch (error) {
            this.logger.debug(
                `closing a command channel on node ${nodeId} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

function toLinkCaller(caller: FleetCommandPortCaller): FleetLinkCaller {
    switch (caller.kind) {
        case 'agent':
            return { kind: 'agent', agentId: caller.agentId, ownerUserId: caller.ownerUserId };
        case 'system':
            return { kind: 'system', job: caller.job };
        case 'user':
        default:
            return { kind: 'user', userId: (caller as { userId: string }).userId };
    }
}

/** The node's `command.run` result, bounded (it is untrusted). */
function readStarted(value: unknown): FleetCommandRunStarted {
    const record =
        typeof value === 'object' && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    return {
        pid: typeof record.pid === 'number' && Number.isInteger(record.pid) ? record.pid : null,
        startedAt:
            typeof record.startedAt === 'string' && record.startedAt.length <= 40
                ? record.startedAt
                : new Date().toISOString(),
        shell: typeof record.shell === 'string' ? record.shell.slice(0, 120) : '',
    };
}
