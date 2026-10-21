import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import { FleetSessionService } from '@ever-works/agent/fleet';
import {
    parseFleetSessionEvent,
    parseFleetSessionList,
    type FleetLinkExtensionMessage,
} from '@ever-works/contracts';
import { FleetLinkRegistry } from '../../fleet-link/fleet-link.registry';

/** Channel-0 types the session family reports on (CONTRACTS §3.3). */
export const FLEET_SESSION_NODE_CONTROL_TYPES = ['session.event', 'session.list'] as const;

/**
 * Sessions on computers (FL-04) — what a machine reports about its sessions,
 * into `FleetSessionService` (CONTRACTS §3.3, §5.1, spec FR-11):
 *
 *  - `session.event` — `started`, `activity`, `title`, `exited`, `lost` →
 *    `applyNodeEvent` (an event that beat its row is held there briefly);
 *  - `session.list` — after every (re)connect, every session the daemon
 *    holds and its health → `reconcileList`.
 *
 * Registered on the link registry of THIS replica: channel-0 family messages
 * are delivered only on the replica that holds the node's link (FL-02
 * `FleetLinkRemote`), so nothing a node reports is processed twice.
 *
 * Everything a node sends is untrusted: it is parsed by the shared contract
 * (bounded strings, known events, bounded screens), and anything that does
 * not parse is dropped with a debug line. With `FLEET_SESSIONS_ENABLED` off
 * the reports are dropped too — the switch is checked per message, so turning
 * it on needs no restart. Never throws into the link.
 */
@Injectable()
export class FleetSessionLinkListener implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(FleetSessionLinkListener.name);
    private readonly unsubscribes: Array<() => void> = [];
    /** The tail of each node's report queue. */
    private readonly queues = new Map<string, Promise<void>>();

    constructor(
        private readonly registry: FleetLinkRegistry,
        private readonly sessions: FleetSessionService,
    ) {}

    onModuleInit(): void {
        this.unsubscribes.push(
            this.registry.onNodeControl('session.event', (nodeId, message) =>
                this.onEvent(nodeId, message),
            ),
            this.registry.onNodeControl('session.list', (nodeId, message) =>
                this.onList(nodeId, message),
            ),
        );
    }

    onModuleDestroy(): void {
        for (const unsubscribe of this.unsubscribes.splice(0)) {
            try {
                unsubscribe();
            } catch {
                // Shutting down: nothing to do.
            }
        }
    }

    /** One `session.event` (exported for the spec through the instance). */
    onEvent(nodeId: string, message: FleetLinkExtensionMessage): void {
        if (!config.fleet.isSessionsEnabled()) return;
        const event = parseFleetSessionEvent(message);
        if (!event) {
            this.logger.debug(`dropped a malformed session.event from node ${nodeId}`);
            return;
        }
        this.enqueue(nodeId, 'session.event', () => this.sessions.applyNodeEvent(nodeId, event));
    }

    /** One `session.list` after a (re)connect. */
    onList(nodeId: string, message: FleetLinkExtensionMessage): void {
        if (!config.fleet.isSessionsEnabled()) return;
        const list = parseFleetSessionList(message);
        if (!list) {
            this.logger.debug(`dropped a malformed session.list from node ${nodeId}`);
            return;
        }
        this.enqueue(nodeId, 'session.list', () => this.sessions.reconcileList(nodeId, list));
    }

    /**
     * One node's reports are applied in the order they arrived — `started`
     * before `exited`, a list before the events that follow it — while
     * different nodes proceed in parallel. A failure is logged and never
     * blocks the next report.
     */
    private enqueue(nodeId: string, type: string, work: () => Promise<void>): void {
        const previous = this.queues.get(nodeId) ?? Promise.resolve();
        const run = previous
            .then(work)
            .catch((error: unknown) => {
                this.logger.warn(
                    `${type} from node ${nodeId} failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            });
        this.queues.set(nodeId, run);
        void run.then(() => {
            if (this.queues.get(nodeId) === run) this.queues.delete(nodeId);
        });
    }

    /** Resolves once every report received so far has been applied (shutdown, specs). */
    async idle(): Promise<void> {
        await Promise.all([...this.queues.values()]);
    }
}
