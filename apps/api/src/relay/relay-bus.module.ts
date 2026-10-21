import {
    Global,
    Inject,
    Injectable,
    Logger,
    Module,
    OnApplicationBootstrap,
    OnApplicationShutdown,
    Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { config } from '@ever-works/agent/config';
import { COMPUTER_FANOUT_BUS } from '../computer/computer-relay.registry';
import { getRedisUrl } from '../health/service-detection';
import {
    TERMINAL_FANOUT_BUS,
    TerminalRelayRegistry,
    type TerminalFanoutBus,
} from '../terminal/terminal-relay.registry';
import { RELAY_BUS, relayBusKey, relayBusSecretFromEnv, type RelayBus } from './relay-bus';
import { InProcessRelayBus } from './relay-bus.in-process';
import { ValkeyRelayBus, type ValkeyRelayBusOptions } from './relay-bus.valkey';
import { RelayComputerFanoutBus, RelayTerminalFanoutBus } from './relay-fanout';

/** The boot error a multi-replica deployment without a bus gets (spec FR-31). It names the setting, never the URL. */
export const RELAY_BUS_REQUIRED_MESSAGE =
    'FLEET_RELAY_REQUIRE_BUS=true but no relay bus is configured: set REDIS_URL to the Valkey every API replica shares, ' +
    'or unset FLEET_RELAY_REQUIRE_BUS on a single-replica deployment.';

/**
 * The boot error a required bus with no usable signing secret gets: without a key the bus
 * sends nothing, drops everything and refuses every single-use claim, which is the same
 * misconfiguration as a missing URL. It names the settings, never the secret.
 */
export const RELAY_BUS_SECRET_REQUIRED_MESSAGE =
    'FLEET_RELAY_REQUIRE_BUS=true but the relay bus has no signing secret: set TERMINAL_ATTACH_SECRET ' +
    '(or BETTER_AUTH_SECRET), at least 16 characters and the same on every API replica.';

/** What the boot log says when an operator switched the bus off (`FLEET_RELAY_BUS_ENABLED=false`). */
export const RELAY_BUS_DISABLED_MESSAGE =
    'Relay bus: off (FLEET_RELAY_BUS_ENABLED) — the terminal relay, the computer live view and node links ' +
    'serve this process only, although a Redis URL is configured; single-use link and viewer tokens are ' +
    'claimed per process, so with several replicas one token can be accepted once per replica';

/**
 * Pick the relay bus (CONTRACTS R-7): Valkey exactly when a Redis URL is
 * configured, the in-process bus otherwise — and a boot error, not a
 * degraded relay, when `FLEET_RELAY_REQUIRE_BUS=true` names a bus that is
 * not configured.
 *
 * `enabled: false` (`FLEET_RELAY_BUS_ENABLED=false`) is the operator's kill
 * switch: the in-process bus even with a Redis URL — every relay exactly as
 * it was before the bus existed. It is a deliberate choice, so it wins over
 * `FLEET_RELAY_REQUIRE_BUS` (which guards against a URL that is missing by
 * mistake) instead of failing boot in the middle of an incident; the boot
 * log says so.
 */
export function createRelayBus(input: {
    url: string | null;
    required: boolean;
    /** Default true. */
    enabled?: boolean;
    valkey?: Omit<ValkeyRelayBusOptions, 'url'>;
}): RelayBus {
    if (input.url && input.enabled === false) return new InProcessRelayBus();
    if (!input.url) {
        if (input.required) throw new Error(RELAY_BUS_REQUIRED_MESSAGE);
        return new InProcessRelayBus();
    }
    if (input.required) {
        const secret =
            input.valkey?.secret === undefined ? relayBusSecretFromEnv() : input.valkey.secret;
        if (!relayBusKey(secret)) throw new Error(RELAY_BUS_SECRET_REQUIRED_MESSAGE);
    }
    return new ValkeyRelayBus({ ...input.valkey, url: input.url });
}

/** How often remote-created terminal runs are swept. */
export const RELAY_TERMINAL_SWEEP_INTERVAL_MS = 5 * 60_000;

/** The signals a replica says goodbye on before it exits: Kubernetes stops a pod with SIGTERM; Ctrl-C is SIGINT. */
export const RELAY_BUS_SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/** How long the goodbye may hold up a signalled exit. */
export const RELAY_BUS_LEAVE_TIMEOUT_MS = 2_000;

/** The slice of `process` the lifecycle listens on (a spec hands in a double). */
export interface RelayBusSignalProcess {
    readonly pid: number;
    once(signal: NodeJS.Signals, listener: () => void): unknown;
    removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
    listenerCount(signal: NodeJS.Signals): number;
    kill(pid: number, signal: NodeJS.Signals): unknown;
}

export const RELAY_BUS_SIGNAL_PROCESS = 'RELAY_BUS_SIGNAL_PROCESS' as const;

/**
 * Boot log, the remote-terminal sweeper, and the bus's goodbye.
 *
 * **Why a signal listener of its own, not `app.enableShutdownHooks()`.**
 * `apps/api/src/main.ts` never enables Nest's shutdown hooks, so on SIGTERM
 * no `onApplicationShutdown` runs and, without this, the bus never publishes
 * its leave message: peers keep routing to a dead replica until presence
 * expires (15 s). Enabling the hooks app-wide would start running every
 * module's shutdown hook on every deploy (database pools, queue workers, the
 * link gateway's closes …) — a behaviour change far outside this bus, and an
 * open owner question (FL-02 lane log, Q6). So this listener does exactly one
 * thing: on SIGTERM / SIGINT it closes the bus (the leave goes out first),
 * bounded by {@link RELAY_BUS_LEAVE_TIMEOUT_MS}, and then hands the signal
 * back — if nothing else listens for it, it re-raises it so Node's default
 * action ends the process exactly as it did before; if something else
 * listens (Nest's hooks, should they be enabled one day), that listener
 * decides, as it would have without this one. Only the Valkey bus listens:
 * the in-process bus has nobody to tell.
 */
@Injectable()
export class RelayBusLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
    private readonly logger = new Logger('RelayBus');
    private sweeper: NodeJS.Timeout | null = null;
    private readonly signals: RelayBusSignalProcess;
    private readonly signalListeners = new Map<NodeJS.Signals, () => void>();

    constructor(
        @Inject(RELAY_BUS) private readonly bus: RelayBus,
        @Inject(TERMINAL_FANOUT_BUS) private readonly terminalBus: TerminalFanoutBus,
        private readonly moduleRef: ModuleRef,
        @Optional() @Inject(RELAY_BUS_SIGNAL_PROCESS) signals?: RelayBusSignalProcess,
    ) {
        this.signals = signals ?? process;
    }

    onApplicationBootstrap(): void {
        if (this.bus.mode === 'valkey') {
            this.logger.log(`Relay bus: valkey (this replica ${this.bus.replicaId})`);
        } else if (getRedisUrl() && !config.fleet.isRelayBusEnabled()) {
            this.logger.warn(RELAY_BUS_DISABLED_MESSAGE);
        } else {
            this.logger.log(
                'Relay bus: single-replica (no REDIS_URL) — relays serve this process only',
            );
        }
        if (this.bus.mode !== 'valkey') return;
        this.listenForSignals();
        if (!(this.terminalBus instanceof RelayTerminalFanoutBus)) return;
        // The terminal registry is resolved lazily (it consumes this module's bus).
        let registry: TerminalRelayRegistry | null = null;
        try {
            registry = this.moduleRef.get(TerminalRelayRegistry, { strict: false });
        } catch {
            registry = null;
        }
        if (!registry) return;
        const terminalBus = this.terminalBus;
        const target = registry;
        this.sweeper = setInterval(() => {
            try {
                terminalBus.sweep(target);
            } catch (error) {
                this.logger.warn(
                    `relay terminal sweep failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }, RELAY_TERMINAL_SWEEP_INTERVAL_MS);
        this.sweeper.unref?.();
    }

    async onApplicationShutdown(): Promise<void> {
        this.stopListening();
        if (this.sweeper) clearInterval(this.sweeper);
        await this.bus.close();
    }

    private listenForSignals(): void {
        for (const signal of RELAY_BUS_SHUTDOWN_SIGNALS) {
            if (this.signalListeners.has(signal)) continue;
            const listener = () => void this.onSignal(signal);
            this.signalListeners.set(signal, listener);
            this.signals.once(signal, listener);
        }
    }

    private stopListening(): void {
        for (const [signal, listener] of this.signalListeners) {
            this.signals.removeListener(signal, listener);
        }
        this.signalListeners.clear();
    }

    /** @internal — exposed for the spec through the signal double. */
    async onSignal(signal: NodeJS.Signals): Promise<void> {
        this.stopListening();
        if (this.sweeper) clearInterval(this.sweeper);
        let timer: NodeJS.Timeout | null = null;
        try {
            await Promise.race([
                this.bus.close(),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, RELAY_BUS_LEAVE_TIMEOUT_MS);
                    timer.unref?.();
                }),
            ]);
        } catch (error) {
            this.logger.warn(
                `relay bus goodbye failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            if (timer) clearTimeout(timer);
        }
        // This listener stood in for Node's default action; with nobody else
        // listening, re-raise the signal so the process ends as it always did.
        if (this.signals.listenerCount(signal) === 0) this.signals.kill(this.signals.pid, signal);
    }
}

/**
 * The relay bus for the whole API (FL-02). `@Global()` because the tokens it
 * binds are consumed `@Optional()` by modules that must not import it: the
 * terminal relay (`TERMINAL_FANOUT_BUS`), the computer live view
 * (`COMPUTER_FANOUT_BUS`) and the node link (`RELAY_BUS`). Unbound — a test
 * module, a context without it — each falls back to its in-process default.
 *
 * `FLEET_RELAY_BUS_ENABLED=false` turns the cross-replica bus off without a
 * code change (see {@link createRelayBus}).
 */
@Global()
@Module({
    providers: [
        {
            provide: RELAY_BUS,
            useFactory: (): RelayBus =>
                createRelayBus({
                    url: getRedisUrl(),
                    required: config.fleet.isRelayBusRequired(),
                    enabled: config.fleet.isRelayBusEnabled(),
                }),
        },
        {
            provide: TERMINAL_FANOUT_BUS,
            useFactory: (bus: RelayBus) => new RelayTerminalFanoutBus(bus),
            inject: [RELAY_BUS],
        },
        {
            provide: COMPUTER_FANOUT_BUS,
            useFactory: (bus: RelayBus) => new RelayComputerFanoutBus(bus),
            inject: [RELAY_BUS],
        },
        RelayBusLifecycle,
    ],
    exports: [RELAY_BUS, TERMINAL_FANOUT_BUS, COMPUTER_FANOUT_BUS],
})
export class RelayBusModule {}
