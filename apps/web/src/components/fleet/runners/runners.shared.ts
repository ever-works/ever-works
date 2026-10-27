import {
    FLEET_ACTIONS_RUNNER_MAX_LABELS,
    FLEET_ACTIONS_RUNNERS_MAX_PER_NODE,
    clampFleetActionsRunnerCount,
    fleetActionsRunnerDefaultNames,
    fleetActionsRunnerModesFor,
    fleetActionsRunnerRemoveSummary,
    fleetActionsRunnerRestartSummary,
    fleetActionsRunnerStopSummary,
    isFleetActionsRunnerName,
    normalizeFleetActionsRunnerLabels,
    type FleetActionsRunnerInstallRequest,
    type FleetActionsRunnerMode,
    type FleetActionsRunnerOptionsView,
    type FleetActionsRunnerPhase,
    type FleetActionsRunnerScope,
    type FleetActionsRunnerState,
    type FleetActionsRunnerTargetOption,
    type FleetActionsRunnerView,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';
import type { ConfirmDialogModel } from '../machine/machine-actions.shared';

/**
 * Actions runners on computers (FL-18 P1, spec §5.1 – §5.3, T-15) — the pure
 * half of the web surface: what a runner row shows for each state, which acts
 * a row offers, the confirmations those acts open, and the Install dialog's
 * form rules (count, names, labels, modes per OS). No React, no I/O; every
 * rule the wire already fixes comes from `@ever-works/contracts`, never
 * re-implemented here (`runners.shared.unit.spec.ts`).
 */

// ─── Deep link (spec §5.7) ──────────────────────────────────────────────────

/** The query the palette's "Install Actions runners on <computer>" opens the computer page with. */
export const RUNNERS_INSTALL_PARAM = 'runners';
export const RUNNERS_INSTALL_VALUE = 'install';

/** The computer's Overview with the Install dialog open (`/fleet/computers/<id>?runners=install`). */
export function runnersInstallHref(nodeId: string): string {
    return `${ROUTES.DASHBOARD_FLEET_COMPUTER(nodeId)}?${RUNNERS_INSTALL_PARAM}=${RUNNERS_INSTALL_VALUE}`;
}

// ─── Row states (spec §5.2) ─────────────────────────────────────────────────

/** The glyph each stored state reads with: `● idle` · `◐ working` · `○ offline` · `■ stopped` · `◌ installing` · `✕ failed` · `? unknown`. */
export const RUNNER_STATE_GLYPHS: Readonly<Record<FleetActionsRunnerState, string>> = {
    installing: '◌',
    idle: '●',
    working: '◐',
    offline: '○',
    stopped: '■',
    failed: '✕',
    removed: '–',
    unknown: '?',
};

/** What a row's state line says — the stored state, plus the two display-only readings. */
export type RunnerStateLabel = FleetActionsRunnerState | 'stoppedByYou' | 'removing';

/** The message key under `fleet.runners.row.states` of each reading. */
export const RUNNER_STATE_KEYS: Readonly<Record<RunnerStateLabel, string>> = {
    installing: 'installing',
    idle: 'idle',
    working: 'working',
    offline: 'offline',
    stopped: 'stopped',
    stoppedByYou: 'stoppedByYou',
    failed: 'failed',
    removed: 'removed',
    unknown: 'unknown',
    removing: 'removing',
};

/** The message key under `fleet.runners.row.phases` of each install phase (camelCase keys). */
export const RUNNER_PHASE_KEYS: Readonly<Record<FleetActionsRunnerPhase, string>> = {
    queued: 'queued',
    downloading: 'downloading',
    verifying: 'verifying',
    'awaiting-token': 'awaitingToken',
    registering: 'registering',
    'installing-service': 'installingService',
    starting: 'starting',
    done: 'done',
    removing: 'removing',
};

/** How a state is coloured: running, waiting, needs a look, broken. */
export type RunnerTone = 'ok' | 'muted' | 'warning' | 'danger';

export interface RunnerStatus {
    glyph: string;
    /** Key under `fleet.runners.row.states`. */
    labelKey: string;
    /** Key under `fleet.runners.row.phases` while installing (FR-11), else null. */
    phaseKey: string | null;
    /** The first line of the failure (`failed`) or the named discrepancy (`unknown`, FR-17), else null. */
    detail: string | null;
    tone: RunnerTone;
}

/** The first non-empty line of a message, at most 200 characters, or null. */
export function firstLine(text: string | null | undefined): string | null {
    if (!text) return null;
    const line = text
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);
    if (!line) return null;
    return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const TONES: Readonly<Record<FleetActionsRunnerState, RunnerTone>> = {
    installing: 'muted',
    idle: 'ok',
    working: 'ok',
    offline: 'warning',
    stopped: 'muted',
    failed: 'danger',
    removed: 'muted',
    unknown: 'warning',
};

/**
 * What one row's state line shows (spec §5.2, FR-13, FR-17): the glyph, the
 * label ("stopped (by you)" for an owner's stop; "removing…" while a remove
 * runs), the phase while installing, and the first line of the error when
 * failed or the discrepancy when unknown — never hidden.
 */
export function runnerStatus(
    runner: Pick<FleetActionsRunnerView, 'state' | 'stoppedByOwner' | 'phase' | 'lastError'>,
): RunnerStatus {
    if (runner.phase === 'removing' && runner.state !== 'removed') {
        return {
            glyph: RUNNER_STATE_GLYPHS.installing,
            labelKey: RUNNER_STATE_KEYS.removing,
            phaseKey: null,
            detail: null,
            tone: 'muted',
        };
    }
    const state = runner.state;
    const label: RunnerStateLabel =
        state === 'stopped' && runner.stoppedByOwner ? 'stoppedByYou' : state;
    return {
        glyph: RUNNER_STATE_GLYPHS[state],
        labelKey: RUNNER_STATE_KEYS[label],
        phaseKey: state === 'installing' && runner.phase ? RUNNER_PHASE_KEYS[runner.phase] : null,
        detail: state === 'failed' || state === 'unknown' ? firstLine(runner.lastError) : null,
        tone: TONES[state],
    };
}

/** Every label the row shows as a chip: GitHub's own first, then the owner's. */
export function runnerLabelChips(
    runner: Pick<FleetActionsRunnerView, 'defaultLabels' | 'labels'>,
): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const label of [...runner.defaultLabels, ...runner.labels]) {
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(label);
    }
    return out;
}

/** `09:41` — the clock time of an instant, in the viewer's time zone; null when unknown. */
export function formatClock(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

// ─── Row acts (spec §4.3, §5.2) ─────────────────────────────────────────────

export type RunnerRowAct = 'start' | 'stop' | 'restart' | 'remove';

export const RUNNER_ROW_ACTS: readonly RunnerRowAct[] = ['start', 'stop', 'restart', 'remove'];

/** Whether a row shows an act, and whether it can be pressed. */
export type RunnerActAvailability = 'enabled' | 'disabled' | 'hidden';

/**
 * Which acts one runner offers (the server still decides each one):
 *
 *  - **Start** while it is stopped or offline;
 *  - **Stop** while it is idle or working;
 *  - **Restart** while it is idle, working or offline;
 *  - **Remove runner…** always — refused `busy` by the server mid-job, with the reason;
 *  - while installing, every act but Remove is shown disabled;
 *  - while a remove runs, nothing can be pressed.
 */
export function runnerActAvailability(
    runner: Pick<FleetActionsRunnerView, 'state' | 'phase'>,
): Record<RunnerRowAct, RunnerActAvailability> {
    const state = runner.state;
    if (state === 'removed')
        return { start: 'hidden', stop: 'hidden', restart: 'hidden', remove: 'hidden' };
    if (runner.phase === 'removing') {
        return { start: 'hidden', stop: 'hidden', restart: 'hidden', remove: 'disabled' };
    }
    if (state === 'installing')
        return { start: 'hidden', stop: 'disabled', restart: 'disabled', remove: 'enabled' };
    const running = state === 'idle' || state === 'working';
    return {
        start: state === 'stopped' || state === 'offline' ? 'enabled' : 'hidden',
        stop: running ? 'enabled' : 'hidden',
        restart: running || state === 'offline' ? 'enabled' : 'hidden',
        remove: 'enabled',
    };
}

/** Split a contracts summary ("Stop X? It stops…") into the dialog's title and body. */
export function splitSummary(summary: string): { title: string; body?: string } {
    const at = summary.indexOf('? ');
    if (at < 0) return { title: summary };
    const body = summary.slice(at + 2).trim();
    return body ? { title: summary.slice(0, at + 1), body } : { title: summary.slice(0, at + 1) };
}

/**
 * The confirmation an act opens before its first call (spec §5.3,
 * CONTRACTS §2.2): Start is `plain` (no dialog); Stop and Restart `confirm`
 * with the contracts' sentence; Remove `confirm-destructive` — type the
 * runner's name. The server's 409 carries the same summary.
 */
export function runnerActDialog(
    act: RunnerRowAct,
    runner: Pick<FleetActionsRunnerView, 'name' | 'target'>,
    computer: string,
): ConfirmDialogModel | null {
    switch (act) {
        case 'start':
            return null;
        case 'stop':
            return {
                class: 'confirm',
                ...splitSummary(fleetActionsRunnerStopSummary(runner.name)),
            };
        case 'restart':
            return {
                class: 'confirm',
                ...splitSummary(fleetActionsRunnerRestartSummary(runner.name)),
            };
        case 'remove':
            return {
                class: 'confirm-destructive',
                ...splitSummary(
                    fleetActionsRunnerRemoveSummary(runner.name, runner.target, computer),
                ),
                typeName: runner.name,
            };
    }
}

// ─── The Install dialog (spec §5.1, FR-2, FR-3, FR-30) ──────────────────────

/** True for a Windows computer (`win32`, as nodes report it). */
export function isWindowsOs(os: string | null | undefined): boolean {
    return os === 'win32' || os === 'windows';
}

/** Container-isolated runners (mode `docker`) are phase 3: P1 never offers them, whatever the server lists. */
export const RUNNER_DOCKER_SHIPPED = false;

/**
 * The run modes the dialog offers (FR-3, FR-9, FR-27): those the server
 * listed for this computer, narrowed by the contracts' rule — Service wherever
 * a service manager exists, the container mode only on Linux hosts that advertise it and only
 * once shipped. Windows is Service only, always.
 */
export function runnerModesFor(
    os: string | null | undefined,
    offered: readonly FleetActionsRunnerMode[],
    dockerShipped: boolean = RUNNER_DOCKER_SHIPPED,
): FleetActionsRunnerMode[] {
    const allowed = fleetActionsRunnerModesFor({
        os: isWindowsOs(os) ? 'win32' : os,
        hasServiceManager: offered.includes('service'),
        hasDocker: offered.includes('docker'),
        dockerShipped,
    });
    return allowed.filter((mode) => offered.includes(mode));
}

/** How many more runners fit on this computer (16 per computer, CONTRACTS §10, existing ones included). */
export function runnersThatFit(
    options: Pick<FleetActionsRunnerOptionsView, 'maxPerNode' | 'existing'>,
): number {
    const max =
        Number.isFinite(options.maxPerNode) && options.maxPerNode > 0
            ? options.maxPerNode
            : FLEET_ACTIONS_RUNNERS_MAX_PER_NODE;
    return Math.max(
        0,
        Math.min(max, FLEET_ACTIONS_RUNNERS_MAX_PER_NODE) - Math.max(0, options.existing),
    );
}

/** A typed count clamped into 1 … what still fits (the contracts' clamp first: nonsense is 1). */
export function clampInstallCount(value: unknown, fit: number): number {
    const n = clampFleetActionsRunnerCount(value);
    return fit <= 0 ? 1 : Math.min(n, fit);
}

/** `<computer>-<n>` for `count` new runners, skipping every name the computer already has (spec FR-3). */
export function defaultRunnerNames(
    computerName: string | null | undefined,
    count: number,
    existing: readonly string[] = [],
): string[] {
    return fleetActionsRunnerDefaultNames(computerName, count, existing);
}

/**
 * The names field after the count changed: the names already shown are kept
 * (with the person's edits), and the new slots take the next suggestions not
 * already used.
 */
export function namesForCount(
    current: readonly string[],
    count: number,
    suggested: readonly string[],
): string[] {
    const kept = current.slice(0, Math.max(0, count));
    const used = new Set(kept.map((name) => name.toLowerCase()));
    for (const name of suggested) {
        if (kept.length >= count) break;
        if (used.has(name.toLowerCase())) continue;
        used.add(name.toLowerCase());
        kept.push(name);
    }
    return kept;
}

/** Why the names cannot be sent, or null: one is not a runner name, or two are the same (case-insensitively). */
export function namesProblem(
    names: readonly string[],
): { kind: 'invalid' | 'duplicate'; index: number } | null {
    const seen = new Set<string>();
    for (let index = 0; index < names.length; index += 1) {
        const name = names[index].trim();
        if (!isFleetActionsRunnerName(name)) return { kind: 'invalid', index };
        const key = name.toLowerCase();
        if (seen.has(key)) return { kind: 'duplicate', index };
        seen.add(key);
    }
    return null;
}

/** The extra labels typed as `gpu, large`: cleaned by the contracts' rule, with the first bad one named. */
export function parseExtraLabels(
    text: string,
    defaults: readonly string[],
): { labels: string[]; invalid: string | null; tooMany: boolean } {
    const { labels, invalid } = normalizeFleetActionsRunnerLabels([text], defaults);
    return { labels, invalid, tooMany: labels.length > FLEET_ACTIONS_RUNNER_MAX_LABELS };
}

/** A target option as one `<select>` value (`repo:acme/api`, `org:acme`). */
export function targetKey(
    target: Pick<FleetActionsRunnerTargetOption, 'scope' | 'target'>,
): string {
    return `${target.scope}:${target.target}`;
}

/** The target a `<select>` value names, among the options; null when it names none. */
export function targetFromKey(
    key: string,
    targets: readonly FleetActionsRunnerTargetOption[],
): FleetActionsRunnerTargetOption | null {
    return targets.find((entry) => targetKey(entry) === key) ?? null;
}

/** The first target the dialog preselects: one that can take runners now, repositories first. */
export function defaultTarget(
    targets: readonly FleetActionsRunnerTargetOption[],
): FleetActionsRunnerTargetOption | null {
    const usable = targets.filter((entry) => entry.permission !== 'missing');
    return usable.find((entry) => entry.scope === 'repo') ?? usable[0] ?? targets[0] ?? null;
}

/** The targets split for the picker's two groups. */
export function groupTargets(
    targets: readonly FleetActionsRunnerTargetOption[],
): Record<FleetActionsRunnerScope, FleetActionsRunnerTargetOption[]> {
    return {
        repo: targets.filter((entry) => entry.scope === 'repo'),
        org: targets.filter((entry) => entry.scope === 'org'),
    };
}

/** What the Install form holds. */
export interface RunnerInstallForm {
    targetKey: string;
    count: number;
    names: string[];
    labelsText: string;
    mode: FleetActionsRunnerMode;
}

/** The request Install sends (the dialog IS the confirmation: `confirm: true`). */
export function installRequestFrom(
    form: RunnerInstallForm,
    target: Pick<FleetActionsRunnerTargetOption, 'scope' | 'target'>,
    labels: readonly string[],
): FleetActionsRunnerInstallRequest {
    const names = form.names.slice(0, form.count).map((name) => name.trim());
    return {
        target: { scope: target.scope, target: target.target },
        count: form.count,
        ...(names.length === form.count ? { names } : {}),
        ...(labels.length > 0 ? { labels: [...labels] } : {}),
        mode: form.mode,
        confirm: true,
    };
}
