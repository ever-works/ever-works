import {
    effectiveConsents,
    fleetFamilyAllows,
    isFleetLinkErrorCode,
    type FleetCommandConfirmationDetails,
    type FleetCommandRunView,
    type FleetCommandSummary,
    type FleetLinkErrorCode,
    type FleetNodeView,
} from '@ever-works/contracts';

/**
 * Commands on computers (FL-12, spec FR-15 … FR-18, §5) — the pure half of the
 * hub's Commands tab: which computers can be picked and why not, what a card's
 * end line says, and the summary line. No React, no fetch — unit-tested on its
 * own (`commands.shared.unit.spec.ts`).
 */

/** Why a computer cannot be picked (spec S2, FR-15), as an i18n key under `fleet.commands.picker.reasons`. */
export type CommandPickReason =
    | 'offline'
    | 'manageOff'
    | 'notAllowed'
    | 'paused'
    | 'disabled'
    | 'enrolling'
    | 'cluster'
    | 'linkDown';

export interface CommandPickRow {
    nodeId: string;
    name: string;
    /** `Linux` · `macOS` · `Windows` · null. */
    os: string | null;
    selectable: boolean;
    reason: CommandPickReason | null;
    lastHeartbeatAt: string | null;
}

/** `Linux` · `macOS` · `Windows` from a node's `platform` (`linux/x64`), or null. */
export function commandOsLabel(platform: string | null | undefined): string | null {
    const os = (platform ?? '').split('/')[0].trim().toLowerCase();
    if (os === 'linux') return 'Linux';
    if (os === 'darwin' || os === 'macos') return 'macOS';
    if (os === 'win32' || os === 'windows') return 'Windows';
    return null;
}

/**
 * One picker row per computer: selectable only when it is online, its link is
 * up, `--manage` is on and the viewer is in its `commands` audience — exactly
 * what the platform would accept, so the UI never offers a machine the server
 * would refuse (spec U4). The reason is the FIRST that applies, in the order
 * the platform checks.
 */
export function commandPickRow(node: FleetNodeView): CommandPickRow {
    const base = {
        nodeId: node.id,
        name: node.name,
        os: commandOsLabel(node.platform),
        lastHeartbeatAt: node.lastHeartbeatAt ?? null,
    };
    const reason = ((): CommandPickReason | null => {
        if (node.kind === 'k8s') return 'cluster';
        if (node.status === 'enrolling') return 'enrolling';
        if (node.status === 'paused') return 'paused';
        if (node.status === 'disabled') return 'disabled';
        const role = node.viewerRole ?? 'owner';
        if (
            !fleetFamilyAllows(
                {
                    controlPolicy: node.controlPolicy,
                    controlPolicyFamilies: node.controlPolicyFamilies,
                },
                role,
                'commands',
            )
        ) {
            return 'notAllowed';
        }
        const consents = effectiveConsents({
            consents: node.consents,
            capabilities: node.capabilities ?? [],
            workerState: node.workerState ?? null,
        });
        if (!consents.manage) return 'manageOff';
        if (node.status === 'offline') return 'offline';
        if (node.link && node.link.state !== 'connected') return 'linkDown';
        return null;
    })();
    return { ...base, selectable: reason === null, reason };
}

/** Every computer's row: selectable ones first (in the order given), then the rest. */
export function commandPickRows(nodes: readonly FleetNodeView[]): CommandPickRow[] {
    const rows = nodes.map(commandPickRow);
    return [...rows.filter((row) => row.selectable), ...rows.filter((row) => !row.selectable)];
}

/**
 * The preselection (spec FR-15): every selectable computer — or, when a
 * computer page asked for one (`?node=<id>`, P2), only that one when it is
 * selectable.
 */
export function commandPreselection(rows: readonly CommandPickRow[], only?: string | null): string[] {
    if (only) {
        const row = rows.find((entry) => entry.nodeId === only);
        return row?.selectable ? [row.nodeId] : [];
    }
    return rows.filter((row) => row.selectable).map((row) => row.nodeId);
}

/** `m:ss` (or `h:mm:ss`) for a duration in ms. */
export function formatCommandClock(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const two = (value: number) => String(value).padStart(2, '0');
    return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

/** `0.8 s` under a minute, else the clock. */
export function formatCommandDuration(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
    return formatCommandClock(ms);
}

/** What a card's end line says, as a key under `fleet.commands.card` and its values. */
export interface CommandCardEnd {
    key:
        | 'running'
        | 'linkDown'
        | 'done'
        | 'exit'
        | 'timedOut'
        | 'killSwitch'
        | 'drain'
        | 'linkLost'
        | 'nodeRestart'
        | 'cancelled'
        | 'shellFailed'
        | 'refused'
        | 'failed';
    tone: 'neutral' | 'success' | 'danger' | 'warning';
    values: Record<string, string | number>;
}

export function commandCardEnd(run: FleetCommandRunView): CommandCardEnd {
    const duration = formatCommandDuration(run.durationMs);
    if (run.status === 'running') {
        return run.linkDown
            ? { key: 'linkDown', tone: 'warning', values: { name: run.nodeName ?? '' } }
            : { key: 'running', tone: 'neutral', values: { duration } };
    }
    if (run.status === 'done') return { key: 'done', tone: 'success', values: { duration } };
    if (run.status === 'timeout') {
        return { key: 'timedOut', tone: 'danger', values: { clock: formatCommandClock(run.durationMs ?? 0) } };
    }
    switch (run.failedReason) {
        case 'kill-switch':
            return { key: 'killSwitch', tone: 'danger', values: {} };
        case 'drain':
            return { key: 'drain', tone: 'danger', values: {} };
        case 'link-lost':
            return { key: 'linkLost', tone: 'warning', values: { name: run.nodeName ?? '' } };
        case 'node-restart':
            return { key: 'nodeRestart', tone: 'warning', values: { name: run.nodeName ?? '' } };
        case 'cancelled-by-user':
            return { key: 'cancelled', tone: 'neutral', values: {} };
        case 'shell-failed':
            return { key: 'shellFailed', tone: 'danger', values: { hint: run.error?.hint ?? '' } };
        default:
            break;
    }
    if (run.error) {
        return { key: 'refused', tone: 'danger', values: { code: run.error.code, hint: run.error.hint } };
    }
    if (typeof run.exitCode === 'number') {
        return { key: 'exit', tone: 'danger', values: { code: run.exitCode, duration } };
    }
    return { key: 'failed', tone: 'danger', values: { duration } };
}

/** The summary line (spec S1, FR-16) as a key under `fleet.commands.summary` and its values. */
export function commandSummaryLine(summary: FleetCommandSummary): {
    key: 'running' | 'allDone' | 'someFailed';
    values: Record<string, string | number>;
} {
    const longest = formatCommandDuration(summary.longestMs);
    if (summary.running > 0) {
        return { key: 'running', values: { running: summary.running, total: summary.total } };
    }
    if (summary.failed === 0) return { key: 'allDone', values: { duration: longest } };
    return {
        key: 'someFailed',
        values: { failed: summary.failed, total: summary.total, duration: longest },
    };
}

/** A card's text: the head, the truncation marker when bytes were dropped, the tail. */
export function commandCardText(run: Pick<FleetCommandRunView, 'outputHead' | 'outputTail' | 'truncated'>): {
    head: string;
    tail: string;
    truncated: boolean;
} {
    return { head: run.outputHead, tail: run.truncated ? run.outputTail : '', truncated: run.truncated };
}

/** True while any run of the Command may still change (the poll keeps going). */
export function commandIsLive(runs: readonly Pick<FleetCommandRunView, 'status'>[]): boolean {
    return runs.some((run) => run.status === 'running');
}

/** Read the 409 `confirmation_required` details of a run request, or null. */
export function readCommandConfirmation(details: Record<string, unknown>): FleetCommandConfirmationDetails | null {
    if (details.class !== 'confirm' || !Array.isArray(details.summary)) return null;
    return details as unknown as FleetCommandConfirmationDetails;
}

/** A refusal as the panel reads it. */
export interface CommandErrorRead {
    code: FleetLinkErrorCode | 'network';
    hint: string | null;
    details: Record<string, unknown>;
    status: number;
}

/** Read the CONTRACTS §8 envelope off a BFF answer. */
export function readCommandError(status: number, body: unknown): CommandErrorRead {
    const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    if (typeof error === 'object' && error !== null) {
        const record = error as Record<string, unknown>;
        if (isFleetLinkErrorCode(record.code)) {
            return {
                code: record.code,
                hint: typeof record.hint === 'string' ? record.hint : null,
                details:
                    typeof record.details === 'object' && record.details !== null
                        ? (record.details as Record<string, unknown>)
                        : {},
                status,
            };
        }
    }
    const code: FleetLinkErrorCode =
        status === 404
            ? 'not_found'
            : status === 403
              ? 'permission_denied'
              : status === 429
                ? 'limit_exceeded'
                : status === 400
                  ? 'invalid'
                  : 'internal';
    return { code, hint: null, details: {}, status };
}
