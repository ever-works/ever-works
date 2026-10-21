import {
    FLEET_LOGS_MAX_MERGED_SOURCES,
    FLEET_LOGS_VIEWER_MAX_LINES,
    fleetLogLineMatches,
    fleetLogSourceId,
    isFleetLogSourceId,
    type FleetLogLine,
    type FleetLogSource,
    type FleetNodeView,
} from '@ever-works/contracts';
import type { SessionErrorRead } from '../sessions/sessions.shared';

/**
 * Logs on computers (FL-08, T-12) — the pure half of the Logs tab: the state
 * card the computer calls for, the source groups, the held-lines window, the
 * filter, the follow state and the footer, copy text and small formatting.
 * No React, no I/O — the tab, the viewer and the spec all read the same
 * answers.
 */

export type LogsError = SessionErrorRead;

// ─── The tab's state card (spec §5.7, U1 … U4, U13) ──────────────────────────

export type LogsTabCard =
    | { kind: 'offline'; lastSeenAt: string | null }
    | { kind: 'consent-missing'; command: string }
    | { kind: 'permission-denied'; hint: string | null }
    | { kind: 'kill-switch' }
    | { kind: 'desktop-node' }
    | { kind: 'unreachable'; hint: string | null }
    | { kind: 'error'; code: string; hint: string | null };

export const LOGS_CONSENT_COMMAND = 'ever-works-node start --manage';

/**
 * The one card the tab shows instead of its sources, or null to show them.
 * The computer's own state first (a desktop node cannot manage yet — R-10; an
 * offline one says when it was last seen), then what the platform answered.
 */
export function logsTabCard(node: Pick<FleetNodeView, 'kind' | 'status' | 'lastHeartbeatAt'>, error: LogsError | null): LogsTabCard | null {
    if (node.kind === 'desktop-node') return { kind: 'desktop-node' };
    if (node.status === 'offline') return { kind: 'offline', lastSeenAt: node.lastHeartbeatAt ?? null };
    if (!error) return null;
    switch (error.code) {
        case 'consent_missing':
            return { kind: 'consent-missing', command: LOGS_CONSENT_COMMAND };
        case 'permission_denied':
            return { kind: 'permission-denied', hint: error.hint };
        case 'kill_switch':
            return { kind: 'kill-switch' };
        case 'unreachable':
        case 'network':
            return { kind: 'unreachable', hint: error.hint };
        default:
            return { kind: 'error', code: error.code, hint: error.hint };
    }
}

// ─── Source groups (FR-1, spec §5.1) ────────────────────────────────────────

export interface LogSourceGroups {
    system: FleetLogSource[];
    /** Files by root (the tree's sub-groups), in listing order. */
    files: Array<{ root: string; sources: FleetLogSource[] }>;
    containers: FleetLogSource[];
    services: FleetLogSource[];
    fileCount: number;
}

export function groupLogSources(sources: readonly FleetLogSource[]): LogSourceGroups {
    const groups: LogSourceGroups = { system: [], files: [], containers: [], services: [], fileCount: 0 };
    const byRoot = new Map<string, FleetLogSource[]>();
    for (const source of sources) {
        switch (source.kind) {
            case 'system':
                groups.system.push(source);
                break;
            case 'file': {
                const list = byRoot.get(source.group) ?? [];
                if (list.length === 0) byRoot.set(source.group, list);
                list.push(source);
                groups.fileCount += 1;
                break;
            }
            case 'container':
                groups.containers.push(source);
                break;
            case 'service':
                groups.services.push(source);
                break;
            default:
                break;
        }
    }
    groups.files = [...byRoot.entries()].map(([root, list]) => ({ root, sources: list }));
    return groups;
}

/**
 * The source a deep link names (FR-38, T-20): `?source=<id>` (`service:nginx.service`),
 * or the kind with its own parameter, as FL-09's Services tab links
 * (`?source=service&unit=nginx.service`, `?source=container&container=acme-api`,
 * `?source=file&path=/var/log/syslog`). Null for anything that is not one.
 */
export function logsDeepLinkSource(get: (name: string) => string | null): string | null {
    const source = get('source');
    if (isFleetLogSourceId(source)) return source;
    const candidate =
        source === 'service' && get('unit')
            ? fleetLogSourceId('service', get('unit')!)
            : source === 'container' && get('container')
              ? fleetLogSourceId('container', get('container')!)
              : source === 'file' && get('path')
                ? fleetLogSourceId('file', get('path')!)
                : null;
    return candidate && isFleetLogSourceId(candidate) ? candidate : null;
}

/**
 * Every source a deep link names (P2, FR-35/FR-36): repeated `?source=<id>`
 * (`?tab=logs&source=container:acme-api&source=container:acme-db`), each a full
 * id, at most {@link FLEET_LOGS_MAX_MERGED_SOURCES}, de-duplicated; else the one
 * {@link logsDeepLinkSource} reads. Empty when nothing valid is named.
 */
export function logsDeepLinkSources(
    getAll: (name: string) => string[],
    get: (name: string) => string | null,
): string[] {
    const all = getAll('source').filter((value) => isFleetLogSourceId(value));
    if (all.length > 1) return [...new Set(all)].slice(0, FLEET_LOGS_MAX_MERGED_SOURCES);
    const one = logsDeepLinkSource(get);
    return one ? [one] : [];
}

/** Add or remove a source from a merged view (ctrl/cmd-click), never past the bound, never empty. */
export function toggleMergedSource(current: readonly string[], id: string): string[] {
    if (current.includes(id)) {
        const rest = current.filter((value) => value !== id);
        return rest.length > 0 ? rest : [id];
    }
    if (current.length >= FLEET_LOGS_MAX_MERGED_SOURCES) return [...current];
    return [...current, id];
}

/** One colour per merged source (spec §5.10 chips), by its index; the list wraps past twelve. */
export const LOG_CHIP_CLASSES: readonly string[] = [
    'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    'bg-violet-500/15 text-violet-700 dark:text-violet-300',
    'bg-rose-500/15 text-rose-700 dark:text-rose-300',
    'bg-teal-500/15 text-teal-700 dark:text-teal-300',
    'bg-orange-500/15 text-orange-700 dark:text-orange-300',
    'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
    'bg-lime-500/15 text-lime-700 dark:text-lime-300',
    'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
    'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
    'bg-stone-500/15 text-stone-700 dark:text-stone-300',
];

export function logChipClass(src: number): string {
    return LOG_CHIP_CLASSES[((src % LOG_CHIP_CLASSES.length) + LOG_CHIP_CLASSES.length) % LOG_CHIP_CLASSES.length]!;
}

/** The short name a chip shows for a source id: the label when listed, else the id's key, last segment. */
export function logChipLabel(id: string, listed: readonly FleetLogSource[]): string {
    const source = listed.find((entry) => entry.id === id);
    const raw = source?.label ?? id.slice(id.indexOf(':') + 1);
    const last = raw.split(/[\\/]/).pop() ?? raw;
    return last.length > 24 ? `${last.slice(0, 23)}…` : last;
}

/** A typed path → a file source id; null for a path that is not absolute (the field says so). */
export function typedPathSourceId(path: string): string | null {
    const value = path.trim();
    if (value.length === 0 || value.length > 390 || value.includes('\0')) return null;
    if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)) return null;
    return `file:${value}`;
}

// ─── Held lines (FR-17, FR-21) ──────────────────────────────────────────────

export interface HeldLine {
    /** Monotonic per viewer: the React key and the selection anchor. */
    seq: number;
    line: FleetLogLine;
}

export interface HeldWindow {
    lines: HeldLine[];
    /** Lines discarded because the window was full (the footer says so). */
    discarded: number;
    nextSeq: number;
}

export const EMPTY_WINDOW: HeldWindow = { lines: [], discarded: 0, nextSeq: 1 };

/** Append lines, keeping the newest {@link FLEET_LOGS_VIEWER_MAX_LINES}; the oldest go first. */
export function appendHeld(window: HeldWindow, incoming: readonly FleetLogLine[], max = FLEET_LOGS_VIEWER_MAX_LINES): HeldWindow {
    if (incoming.length === 0) return window;
    let seq = window.nextSeq;
    const added = incoming.map((line) => ({ seq: seq++, line }));
    const all = window.lines.concat(added);
    const over = Math.max(0, all.length - max);
    return { lines: over > 0 ? all.slice(over) : all, discarded: window.discarded + over, nextSeq: seq };
}

/** Prepend an older page (P2); a full window keeps its newest lines and takes only what fits of the page. */
export function prependHeld(window: HeldWindow, older: readonly FleetLogLine[], max = FLEET_LOGS_VIEWER_MAX_LINES): HeldWindow {
    if (older.length === 0) return window;
    const room = Math.max(0, max - window.lines.length);
    const kept = older.slice(Math.max(0, older.length - room));
    let seq = window.nextSeq;
    const added = kept.map((line) => ({ seq: seq++, line }));
    return { lines: added.concat(window.lines), discarded: window.discarded, nextSeq: seq };
}

/** The held lines the filter keeps (FR-17: case-insensitive substring). */
export function filterHeld(lines: readonly HeldLine[], filter: string): HeldLine[] {
    const needle = filter.trim();
    if (needle.length === 0) return lines as HeldLine[];
    return lines.filter((held) => fleetLogLineMatches(held.line, needle));
}

/**
 * P3 (FR-39): the index of the first line stamped at or after `at` (both ISO,
 * UTC), or -1 when none is — the viewer scrolls there and highlights it.
 */
export function firstHeldAtOrAfter(lines: readonly HeldLine[], at: string): number {
    const target = Date.parse(at);
    if (Number.isNaN(target)) return -1;
    for (let index = 0; index < lines.length; index += 1) {
        const ts = lines[index]!.line.ts;
        if (ts && Date.parse(ts) >= target) return index;
    }
    return -1;
}

// ─── Follow state (FR-14 … FR-16) ───────────────────────────────────────────

export type LogFollowPhase = 'connecting' | 'live' | 'reconnecting' | 'stopped' | 'error';

export type LogStopReason = 'gone' | 'stopped' | 'kill-switch' | 'lost' | 'closed' | 'not-following' | null;

/** Scrolled up by more than one viewport stops the follow (FR-16). */
export function shouldStopFollowing(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
    return scrollHeight - (scrollTop + clientHeight) > clientHeight;
}

/** At (or within a line of) the bottom: following may resume. */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number, slack = 24): boolean {
    return scrollHeight - (scrollTop + clientHeight) <= slack;
}

// ─── Footer (spec §5.1 … §5.4) ──────────────────────────────────────────────

export interface LogFooterInput {
    phase: LogFollowPhase;
    following: boolean;
    paused: boolean;
    pausedCount: number;
    held: number;
    shown: number;
    filter: string;
    bytes: number;
    redactions: number;
    dropped: number;
    discarded: number;
}

/** The footer as ordered message keys + values (`fleet.logs.viewer.*`); the component translates. */
export function logFooterParts(input: LogFooterInput): Array<{ key: string; values?: Record<string, string | number> }> {
    const parts: Array<{ key: string; values?: Record<string, string | number> }> = [];
    if (input.paused) parts.push({ key: 'footerPaused', values: { count: input.pausedCount } });
    else if (input.phase === 'live' && input.following) parts.push({ key: 'footerFollowing' });
    else if (input.phase === 'reconnecting') parts.push({ key: 'reconnecting' });
    else parts.push({ key: 'notFollowing' });
    if (input.filter.trim().length > 0) {
        parts.push({ key: 'footerFiltered', values: { shown: input.shown, held: input.held, filter: input.filter.trim() } });
    } else {
        parts.push({ key: 'footerHeld', values: { count: input.held } });
    }
    parts.push({ key: 'footerBytes', values: { bytes: formatLogBytes(input.bytes) } });
    parts.push({ key: 'footerRedactions', values: { count: input.redactions } });
    if (input.dropped > 0) parts.push({ key: 'footerDropped', values: { count: input.dropped } });
    if (input.discarded > 0) parts.push({ key: 'footerDiscarded', values: { count: input.discarded } });
    return parts;
}

export function formatLogBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** `09:41:02` in the viewer's zone, or '' for a line without a stamp. */
export function formatLogTime(ts: string | null): string {
    if (!ts) return '';
    const at = new Date(ts);
    if (Number.isNaN(at.getTime())) return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** Copy text (FR-19): plain text, one line per line, the time first when the line has one. */
export function logsCopyText(lines: readonly HeldLine[]): string {
    return lines
        .map((held) => {
            const time = held.line.ts ? `${held.line.ts} ` : '';
            return `${time}${held.line.text}`;
        })
        .join('\n');
}

/** `build-01-nginx.service-20261021-094102.log` (P3 download name, spec FR-40). */
export function logsDownloadName(computer: string, source: string, at: Date): string {
    const safe = (value: string) =>
        value
            .replace(/^[a-z]+:/, '')
            .replace(/[^A-Za-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'log';
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
    return `${safe(computer)}-${safe(source)}-${stamp}.log`;
}

/** The kinds a viewer header names (spec S5/S6: `acme-api · container · build-01`). */
export function sourceKindKey(source: Pick<FleetLogSource, 'kind'>): 'system' | 'file' | 'container' | 'service' {
    return source.kind;
}
