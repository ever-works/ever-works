import {
    resolveComputerState,
    type ComputerState,
    type ComputerStateAction,
    type ComputerStateResolution,
    type FleetNodeView,
} from '@ever-works/contracts';

/**
 * Computer health (FL-03) — pure presentation of a computer's STATE: which
 * word sits beside the dot, which sentence explains it, the values that
 * sentence needs, and the one fix. A `.shared.ts` file (house convention) so it
 * is unit-tested and importable from server and client components alike.
 *
 * The state itself is `resolveComputerState` from `@ever-works/contracts` —
 * the same function the API, the needs-a-look producers and the Agent tools
 * use — so no surface can disagree with another about what state a machine is
 * in. Nothing here derives a value: every interpolated value is one the node
 * or the platform reported (FR-30).
 */

export { resolveComputerState };
export type { ComputerState, ComputerStateAction, ComputerStateResolution };

/** Leaves under `fleet.states` — the word beside the dot. */
export type ComputerStateWordKey =
    | 'online'
    | 'busy'
    | 'offline'
    | 'enrolling'
    | 'paused'
    | 'disabled'
    | 'draining'
    | 'quarantined'
    | 'throttled'
    | 'limited'
    | 'upgradeRequired';

/** Leaves under `fleet.stateSentences`. */
export type ComputerStateSentenceKey =
    | ComputerStateWordKey
    | 'busyNoCount'
    | 'offlineNever'
    | 'quarantinedNoReason'
    | 'throttledCpu'
    | 'throttledMemory'
    | 'throttledDisk'
    | 'throttledNoReason'
    | 'limitedMany';

/** `upgrade-required` → `upgradeRequired`: i18n leaves are camelCase (CONTRACTS §11.4). */
export function stateKey(state: ComputerState): ComputerStateWordKey {
    return state.replace(/-([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
    ) as ComputerStateWordKey;
}

const THROTTLE_SENTENCE: Record<'cpu' | 'memory' | 'disk', ComputerStateSentenceKey> = {
    cpu: 'throttledCpu',
    memory: 'throttledMemory',
    disk: 'throttledDisk',
};

/** Tailwind class for the state's dot. The WORD always sits beside it — never colour alone (FR-9). */
export function stateDotClass(state: ComputerState): string {
    switch (state) {
        case 'online':
            return 'bg-success';
        case 'busy':
            return 'bg-info';
        case 'quarantined':
        case 'disabled':
            return 'bg-danger';
        case 'enrolling':
        case 'draining':
        case 'throttled':
        case 'limited':
        case 'upgrade-required':
            return 'bg-warning';
        default:
            return 'bg-text-muted dark:bg-text-muted-dark';
    }
}

/** What a model CLI is called in a sentence. Product names are not translated. */
export function cliDisplayName(provider: string | undefined | null): string {
    switch (provider) {
        case 'claude-code':
            return 'Claude Code';
        case 'codex':
            return 'Codex';
        default:
            return provider ?? '';
    }
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * Binary bytes — `6 GiB`, `1.5 GiB`, `512 MiB` — the unit the node speaks of
 * its own floor in. Null for an unknown figure so the caller renders "—",
 * never "0 B" (which would read as a full disk).
 */
export function formatBinaryBytes(bytes: number | null | undefined): string | null {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
    if (bytes >= 10 * GIB) return `${Math.round(bytes / GIB)} GiB`;
    if (bytes >= GIB) return `${(bytes / GIB).toFixed(1).replace(/\.0$/, '')} GiB`;
    return `${Math.round(bytes / MIB)} MiB`;
}

/** {@link formatBinaryBytes} for a MiB figure (what the snapshot carries). */
export function formatMiB(mib: number | null | undefined): string | null {
    return typeof mib === 'number' ? formatBinaryBytes(mib * MIB) : null;
}

/** Uptime as a key under `fleet.health.duration` and its values; null for an unknown figure. */
export function uptimeCopy(
    seconds: number | null | undefined,
): { key: 'days' | 'hours' | 'minutes'; values: Record<string, number> } | null {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    if (days > 0) return { key: 'days', values: { days, hours } };
    if (hours > 0) return { key: 'hours', values: { hours, minutes } };
    return { key: 'minutes', values: { minutes } };
}

/**
 * A reset or check-in instant in the VIEWER's zone (FR-11), and the same
 * instant in UTC for the tooltip. Null for an unparseable instant.
 */
export function formatInstant(iso: string, locale: string): { local: string; utc: string } | null {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return null;
    const options: Intl.DateTimeFormatOptions = {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
    };
    return {
        local: new Intl.DateTimeFormat(locale, options).format(date),
        utc: new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(date),
    };
}

export interface ComputerStateCopy {
    state: ComputerState;
    /** Leaf under `fleet.states` — the word beside the dot. */
    wordKey: ComputerStateWordKey;
    /** Leaf under `fleet.stateSentences` — the sentence. */
    sentenceKey: ComputerStateSentenceKey;
    /**
     * Raw values the sentence interpolates. `until` and `lastSeenAt` stay ISO
     * strings: the component formats them in the VIEWER's zone (FR-11).
     */
    values: Record<string, string | number>;
    action: ComputerStateAction | null;
}

/** The copy for one resolved state. */
export function computerStateCopy(resolution: ComputerStateResolution): ComputerStateCopy {
    const { state, params, action } = resolution;
    const values: Record<string, string | number> = {};
    let sentenceKey: ComputerStateSentenceKey = stateKey(state);
    switch (state) {
        case 'busy':
            if (typeof params.jobs === 'number' && params.jobs > 0) values.jobs = params.jobs;
            else sentenceKey = 'busyNoCount';
            break;
        case 'draining':
            break;
        case 'offline':
            if (params.lastSeenAt) values.lastSeenAt = params.lastSeenAt;
            else sentenceKey = 'offlineNever';
            break;
        case 'quarantined':
            if (params.reason) values.reason = params.reason;
            else sentenceKey = 'quarantinedNoReason';
            break;
        case 'throttled':
            if (params.dimension && params.value !== undefined && params.limit !== undefined) {
                sentenceKey = THROTTLE_SENTENCE[params.dimension];
                values.value =
                    params.dimension === 'disk'
                        ? (formatBinaryBytes(params.value) ?? '')
                        : params.value;
                values.limit =
                    params.dimension === 'disk'
                        ? (formatBinaryBytes(params.limit) ?? '')
                        : params.limit;
            } else if (params.reason) {
                values.reason = params.reason;
            } else {
                sentenceKey = 'throttledNoReason';
            }
            break;
        case 'limited':
            values.cli = cliDisplayName(params.provider);
            if (params.until) values.until = params.until;
            if ((params.limitedCount ?? 1) > 1) sentenceKey = 'limitedMany';
            break;
        default:
            break;
    }
    return { state, wordKey: stateKey(state), sentenceKey, values, action };
}

/**
 * The state to show: the SERVER's judgement when one is in hand (it knows the
 * deployment's offline window and the owner's job count, which the browser
 * does not), else the browser's own. One exception: a `limited` answer whose
 * reset time has passed is stale by the clock alone, so the browser's own
 * reading — which drops expired limits — is shown instead.
 */
export function preferredStateResolution(
    server: ComputerStateResolution | null | undefined,
    node: FleetNodeView,
    options: { now?: number; canWake?: boolean } = {},
): ComputerStateResolution {
    const now = options.now ?? Date.now();
    if (server) {
        const until = server.state === 'limited' ? Date.parse(server.params.until ?? '') : NaN;
        if (!(server.state === 'limited' && Number.isFinite(until) && until <= now)) return server;
    }
    return resolveComputerState(node, { ...options, now });
}

/** Resolve and present in one call — what a card or header needs. */
export function computerStateCopyFor(
    node: FleetNodeView,
    options: { now?: number; canWake?: boolean } = {},
): ComputerStateCopy {
    return computerStateCopy(resolveComputerState(node, options));
}
