import {
    decodeFleetLinkControl,
    decodeFleetLinkFrame,
    decodeFleetLinkJson,
    encodeFleetLinkControl,
    encodeFleetLinkJson,
    type FleetLinkControlMessage,
    type FleetLinkExtensionMessage,
    type FleetLinkFrame,
    type FleetLinkHello,
} from '@ever-works/contracts';
import type { FleetLinkRegistryOptions, FleetLinkSocketPort } from '../fleet-link.registry';

/** Test support for the link specs: a manual clock and a recording socket port. */

export const NODE_ID = '7d1f0c2a-3b4e-4f5a-8c6d-9e0f1a2b3c4d';
export const OWNER = 'owner-1';

export function manualTimers(start = 1_760_000_000_000) {
    let time = start;
    let nextId = 1;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const options: Required<Pick<FleetLinkRegistryOptions, 'now' | 'setTimer' | 'clearTimer'>> = {
        now: () => time,
        setTimer: (callback, ms) => {
            const id = nextId++;
            timers.set(id, { at: time + ms, callback });
            return id;
        },
        clearTimer: (handle) => {
            timers.delete(handle as number);
        },
    };
    return {
        options,
        now: () => time,
        advance(ms: number) {
            const target = time + ms;
            for (;;) {
                let due: number | null = null;
                let dueAt = Infinity;
                for (const [id, timer] of timers) {
                    if (timer.at <= target && timer.at < dueAt) {
                        due = id;
                        dueAt = timer.at;
                    }
                }
                if (due === null) break;
                const timer = timers.get(due)!;
                timers.delete(due);
                time = Math.max(time, timer.at);
                timer.callback();
            }
            time = target;
        },
        pendingCount: () => timers.size,
    };
}

export class RecordingPort implements FleetLinkSocketPort {
    readonly frames: FleetLinkFrame[] = [];
    closed: { code: number; reason: string } | null = null;
    accepting = true;

    send(frame: Uint8Array): boolean {
        if (!this.accepting || this.closed) return false;
        const decoded = decodeFleetLinkFrame(frame);
        if (!decoded) throw new Error('the registry sent an undecodable frame');
        this.frames.push({ ...decoded, payload: decoded.payload.slice() });
        return true;
    }

    close(code: number, reason: string): void {
        this.closed = { code, reason };
    }

    controls(): Array<FleetLinkControlMessage | FleetLinkExtensionMessage> {
        return this.frames
            .filter((frame) => frame.channel === 0)
            .map((frame) => decodeFleetLinkControl(frame.payload))
            .filter(
                (message): message is FleetLinkControlMessage | FleetLinkExtensionMessage =>
                    message !== null,
            );
    }

    last(type: string): (FleetLinkControlMessage | FleetLinkExtensionMessage) | undefined {
        return [...this.controls()].reverse().find((message) => message.type === type);
    }

    jsonOn(channel: number): Array<Record<string, unknown>> {
        return this.frames
            .filter((frame) => frame.channel === channel && frame.kind === 10)
            .map((frame) => decodeFleetLinkJson(frame.payload, Number.MAX_SAFE_INTEGER))
            .filter((message): message is Record<string, unknown> => message !== null);
    }
}

export function hello(overrides: Partial<FleetLinkHello> = {}): FleetLinkHello {
    return {
        type: 'link.hello',
        nodeId: NODE_ID,
        linkVersion: 1,
        capabilities: ['os:linux', 'managed'],
        consents: { work: true, attend: false, manage: true, usageScan: false },
        token: 'token',
        nodeVersion: '0.3.0',
        ...overrides,
    };
}

export function controlFrame(
    message: FleetLinkControlMessage | FleetLinkExtensionMessage,
): FleetLinkFrame {
    return decodeFleetLinkFrame(encodeFleetLinkControl(message)!)!;
}

export function jsonFrame(channel: number, message: Record<string, unknown>): FleetLinkFrame {
    return decodeFleetLinkFrame(encodeFleetLinkJson(channel, message)!)!;
}

/** Let promise continuations run. */
export async function settle(times = 10): Promise<void> {
    for (let i = 0; i < times; i += 1) await Promise.resolve();
}
