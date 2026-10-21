import {
    describeFleetScheduleSkip,
    fleetScheduleCadenceFromForm,
    fleetScheduleFormFromCadence,
    fleetScheduleZonesDiffer,
    formatFleetScheduleInstant,
    previewFleetScheduleFires,
    type FleetCommandRunView,
    type FleetScheduleCadence,
    type FleetScheduleCadenceForm,
    type FleetScheduleConfirmationDetails,
    type FleetScheduleView,
} from '@ever-works/contracts';

/**
 * Schedules on computers (FL-13, spec §5) — the pure half of the computer's
 * Schedules tab: the two-zone time text, the row glyph, the history line and
 * the dialog's preview. No React, no fetch — unit-tested on its own
 * (`schedules.shared.unit.spec.ts`).
 */

/** The viewer's zone (the browser's), or UTC when the runtime cannot say. */
export function viewerTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/**
 * `Tue 02:00 (Mon 20:00 yours)` — an instant on the computer's clock, and on
 * the viewer's in parentheses only when the two read differently (spec §5.1).
 */
export function twoZoneTime(
    at: string | number | null,
    computerZone: string | null,
    viewerZone: string,
): { computer: string; viewer: string | null } | null {
    if (at === null) return null;
    const ms = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(ms)) return null;
    const computer = formatFleetScheduleInstant(ms, computerZone);
    const viewer = fleetScheduleZonesDiffer(computerZone, viewerZone, ms)
        ? formatFleetScheduleInstant(ms, viewerZone)
        : null;
    return { computer, viewer };
}

/** The row glyph (spec §5.1): ● active · ◐ running · ⏸ paused · ⚠ never runs. */
export type ScheduleRowGlyph = 'active' | 'running' | 'paused' | 'neverRuns';

export function scheduleRowGlyph(schedule: Pick<FleetScheduleView, 'enabled' | 'running' | 'neverRuns'>): ScheduleRowGlyph {
    if (schedule.neverRuns) return 'neverRuns';
    if (!schedule.enabled) return 'paused';
    if (schedule.running) return 'running';
    return 'active';
}

export const SCHEDULE_GLYPHS: Record<ScheduleRowGlyph, string> = {
    active: '●',
    running: '◐',
    paused: '⏸',
    neverRuns: '⚠',
};

/** A history row's outcome glyph: ✓ done · ✗ failed / timeout · ⊘ skipped · ◐ running. */
export function runGlyph(status: FleetCommandRunView['status']): string {
    if (status === 'done') return '✓';
    if (status === 'running') return '◐';
    if (status === 'skipped-overlap' || status === 'skipped-offline') return '⊘';
    return '✗';
}

/** A run status as an i18n leaf key (camelCase, CONTRACTS §11.4). */
export type RunStatusKey = 'running' | 'done' | 'failed' | 'timeout' | 'skippedOverlap' | 'skippedOffline';

export function runStatusKey(status: FleetCommandRunView['status']): RunStatusKey {
    if (status === 'skipped-overlap') return 'skippedOverlap';
    if (status === 'skipped-offline') return 'skippedOffline';
    return status;
}

/** The skip sentence of a history row (spec §5.7), or null when it ran. */
export function runSkipText(run: Pick<FleetCommandRunView, 'status'>, computer: string): string | null {
    return describeFleetScheduleSkip(run.status, computer);
}

/** `14 m 02 s` · `3.1 s` · `—`. */
export function formatRunDuration(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    if (minutes < 60) return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h ${String(minutes % 60).padStart(2, '0')} m`;
}

/** The dialog's editable cadence state: one of the six forms, with every field kept while switching. */
export interface CadenceDraft {
    form: FleetScheduleCadenceForm['form'];
    minutes: number;
    at: string;
    days: number[];
    expr: string;
}

export const DEFAULT_CADENCE_DRAFT: CadenceDraft = {
    form: 'weekdays',
    minutes: 30,
    at: '02:00',
    days: [1],
    expr: '0 2 * * 1-5',
};

/** The draft a stored cadence is edited in. */
export function draftFromCadence(cadence: FleetScheduleCadence): CadenceDraft {
    const form = fleetScheduleFormFromCadence(cadence);
    const draft: CadenceDraft = { ...DEFAULT_CADENCE_DRAFT, form: form.form };
    if (form.form === 'every') draft.minutes = form.minutes;
    if (form.form === 'daily' || form.form === 'weekdays') draft.at = form.at;
    if (form.form === 'days') {
        draft.days = form.days;
        draft.at = form.at;
    }
    if (form.form === 'cron') draft.expr = form.expr;
    return draft;
}

/** The stored cadence a draft makes, or the reason it is not one. */
export function cadenceFromDraft(draft: CadenceDraft): { cadence: FleetScheduleCadence | null; error: string | null } {
    switch (draft.form) {
        case 'every':
            return fleetScheduleCadenceFromForm({ form: 'every', minutes: draft.minutes });
        case 'hourly':
            return fleetScheduleCadenceFromForm({ form: 'hourly' });
        case 'daily':
            return fleetScheduleCadenceFromForm({ form: 'daily', at: draft.at });
        case 'weekdays':
            return fleetScheduleCadenceFromForm({ form: 'weekdays', at: draft.at });
        case 'days':
            return fleetScheduleCadenceFromForm({ form: 'days', days: draft.days, at: draft.at });
        case 'cron':
        default:
            return fleetScheduleCadenceFromForm({ form: 'cron', expr: draft.expr });
    }
}

/** The next three fires, in both zones (spec §5.2, ACC-FL13-03). */
export function previewFires(
    cadence: FleetScheduleCadence | null,
    computerZone: string | null,
    viewerZone: string,
    now: number,
): Array<{ computer: string; viewer: string | null }> {
    if (!cadence) return [];
    return previewFleetScheduleFires(cadence, computerZone, now, 3)
        .map((ms) => twoZoneTime(ms, computerZone, viewerZone))
        .filter((entry): entry is { computer: string; viewer: string | null } => entry !== null);
}

/** The confirmation details off a 409 `confirmation_required` body, or null. */
export function readScheduleConfirmation(details: Record<string, unknown>): FleetScheduleConfirmationDetails | null {
    if (details.class !== 'confirm' || typeof details.action !== 'string' || typeof details.nodeName !== 'string') {
        return null;
    }
    return details as unknown as FleetScheduleConfirmationDetails;
}

/** The schedules a page of the Schedules view carries for one computer. */
export function schedulesOfPage(page: unknown): FleetScheduleView[] {
    const items = (page as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) return [];
    return items
        .map((item) => (item as { nodeSchedule?: FleetScheduleView } | null)?.nodeSchedule)
        .filter((schedule): schedule is FleetScheduleView => Boolean(schedule && schedule.kind === 'schedule'));
}
