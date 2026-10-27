import type { FleetCommandRunView, FleetCommandSummary } from '@ever-works/contracts';

/**
 * Commands on computers (FL-12, spec FR-19, §5.5) — the pure half of
 * `ever-works fleet commands run`: which computers `--on` names, what new
 * output a poll brought for each computer (printed `build-01 ▸ <line>`), and
 * the closing summary line — the same words the hub uses.
 */

export interface FleetNodeRef {
    id: string;
    name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve `--on a,b` against the computers the person sees: an id matches
 * itself, a name matches case-insensitively. Answers the ids in the order
 * given, and every token that matched nothing (or matched two computers).
 */
export function resolveNodeTokens(
    raw: string,
    nodes: readonly FleetNodeRef[],
): { ids: string[]; unknown: string[]; ambiguous: string[] } {
    const ids: string[] = [];
    const unknown: string[] = [];
    const ambiguous: string[] = [];
    for (const token of raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)) {
        if (UUID.test(token)) {
            const byId = nodes.find((node) => node.id.toLowerCase() === token.toLowerCase());
            if (byId) {
                if (!ids.includes(byId.id)) ids.push(byId.id);
            } else unknown.push(token);
            continue;
        }
        const matches = nodes.filter((node) => node.name.toLowerCase() === token.toLowerCase());
        if (matches.length === 1) {
            if (!ids.includes(matches[0].id)) ids.push(matches[0].id);
        } else if (matches.length === 0) unknown.push(token);
        else ambiguous.push(token);
    }
    return { ids, unknown, ambiguous };
}

/** What has been printed of one run so far. */
export interface RunPrintState {
    /** Characters of `outputHead` already handed out. */
    headPrinted: number;
    /** A partial last line held until it ends (or the run does). */
    partial: string;
    /** The truncation marker and the tail were printed. */
    tailPrinted: boolean;
    ended: boolean;
}

export function newRunPrintState(): RunPrintState {
    return { headPrinted: 0, partial: '', tailPrinted: false, ended: false };
}

/**
 * The lines a poll adds for one run. While it runs only whole lines are
 * handed out; once it ended the rest is, then — when bytes were dropped — the
 * marker and the tail.
 */
export function takeNewLines(run: FleetCommandRunView, state: RunPrintState): string[] {
    if (state.ended) return [];
    const lines: string[] = [];
    const fresh =
        run.outputHead.length > state.headPrinted ? run.outputHead.slice(state.headPrinted) : '';
    state.headPrinted = Math.max(state.headPrinted, run.outputHead.length);
    let text = state.partial + fresh;
    const live = run.status === 'running';
    const parts = text.split(/\r?\n/);
    const last = parts.pop() ?? '';
    lines.push(...parts);
    if (live) {
        state.partial = last;
        return lines;
    }
    if (last.length > 0) lines.push(last);
    state.partial = '';
    text = '';
    if (run.truncated && !state.tailPrinted) {
        lines.push('… first 64 KiB and last 64 KiB shown …');
        const tail = run.outputTail.split(/\r?\n/);
        if (tail.length > 0 && tail[tail.length - 1] === '') tail.pop();
        lines.push(...tail);
        state.tailPrinted = true;
    }
    state.ended = true;
    return lines;
}

/** `0.8 s` under a minute, else `m:ss`. */
export function formatDuration(ms: number | null | undefined): string {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
    const total = Math.round(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** How one run ended, in the hub's words. */
export function describeRunEnd(run: FleetCommandRunView): string {
    const duration = formatDuration(run.durationMs);
    if (run.status === 'running') return `running · ${duration}`;
    if (run.status === 'done') return `✓ ${duration}`;
    if (run.status === 'timeout') return `Timed out after ${formatDuration(run.durationMs)}`;
    switch (run.failedReason) {
        case 'kill-switch':
            return 'Stopped by the fleet kill switch';
        case 'drain':
            return 'Stopped — the fleet is draining';
        case 'link-lost':
            return 'Connection lost — the full output stays on the computer';
        case 'node-restart':
            return 'The computer restarted while it ran';
        case 'cancelled-by-user':
            return 'Stopped';
        case 'shell-failed':
            return `The shell could not start: ${run.error?.hint ?? ''}`.trim();
        default:
            break;
    }
    if (run.error) return `${run.error.code}: ${run.error.hint}`;
    if (typeof run.exitCode === 'number') return `Exit ${run.exitCode} · ${duration}`;
    return `Failed · ${duration}`;
}

/** "All done · 0.9 s" / "1 of 2 failed · 1.2 s". */
export function describeSummary(summary: FleetCommandSummary): string {
    const longest = formatDuration(summary.longestMs);
    if (summary.running > 0) return `${summary.running} of ${summary.total} running`;
    if (summary.failed === 0) return `All done · ${longest}`;
    return `${summary.failed} of ${summary.total} failed · ${longest}`;
}
