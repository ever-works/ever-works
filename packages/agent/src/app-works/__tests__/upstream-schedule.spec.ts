import {
    APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE,
    APP_UPSTREAM_SYNC_JITTER_MAX_MS,
    APP_UPSTREAM_SYNC_MIN_INTERVAL_MS,
} from '@ever-works/contracts';
import {
    computeNextUpstreamSync,
    fnv1a,
    nextUpstreamSyncAt,
    readUpstreamSyncSettings,
    upstreamSyncBranch,
    upstreamSyncJitterMs,
} from '../upstream-schedule';

/**
 * APW-02 T26 — the schedule helper (plan §6.4, `plan.md:756-771`; FR-32, FR-64,
 * ACC-02-28).
 *
 * The claim this spec exists to pin is the plan's own correction: **"Before this
 * note, only `schedule` had a reader, so a spec setting `enabled: false` would
 * have kept syncing on a timer: a task in APW-02 P1 must test all four."** All
 * four `upstreamSync` fields are therefore asserted here — `schedule`, `enabled`,
 * `branch`, `mode` — with their documented defaults, and the three behaviours
 * §6.4 fixes for the clock: the default expression, the hourly clamp and the
 * stable per-Work jitter.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORK_ID = '99999999-9999-4999-8999-999999999999';

/** A Monday, 00:00 UTC — the default schedule's own day, so slots are easy to read. */
const MONDAY = new Date('2026-01-05T00:00:00.000Z');

/** The jitter cancels when it is subtracted, which is how the slots are asserted. */
const JITTER = upstreamSyncJitterMs(WORK_ID);

/** The slot a result sits on, with this Work's jitter removed. */
function slotOf(date: Date | null): string | null {
    return date ? new Date(date.getTime() - JITTER).toISOString() : null;
}

describe('readUpstreamSyncSettings — all four fields, with the documented defaults (plan §6.4)', () => {
    it('reads the four defaults when the block is absent', () => {
        const settings = readUpstreamSyncSettings({
            appSpecVersion: 1,
        } as never);

        expect(settings.schedule).toBe(APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE);
        expect(APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE).toBe('0 6 * * 1');
        expect(settings.enabled).toBe(true);
        expect(settings.branch).toBeNull();
        expect(settings.mode).toBe('merge');
        expect(settings.modeHonoured).toBe(true);
        expect(settings.blockAbsent).toBe(true);
    });

    it('reads the four defaults when there is no spec at all', () => {
        const settings = readUpstreamSyncSettings(null);

        expect(settings.schedule).toBe('0 6 * * 1');
        expect(settings.enabled).toBe(true);
        expect(settings.branch).toBeNull();
        expect(settings.mode).toBe('merge');
        expect(settings.blockAbsent).toBe(true);
    });

    it('reads the four defaults from an empty block', () => {
        const settings = readUpstreamSyncSettings({ upstreamSync: {} } as never);

        expect(settings.schedule).toBe('0 6 * * 1');
        expect(settings.enabled).toBe(true);
        expect(settings.branch).toBeNull();
        expect(settings.mode).toBe('merge');
        expect(settings.blockAbsent).toBe(false);
    });

    it('reads all four fields when the spec sets them', () => {
        const settings = readUpstreamSyncSettings({
            upstreamSync: {
                enabled: false,
                schedule: '30 2 * * *',
                branch: 'develop',
                mode: 'merge',
            },
        } as never);

        expect(settings.schedule).toBe('30 2 * * *');
        expect(settings.enabled).toBe(false);
        expect(settings.branch).toBe('develop');
        expect(settings.mode).toBe('merge');
        expect(settings.modeHonoured).toBe(true);
    });

    it('treats a blank field as absent — "the spec does not say" is not an instruction', () => {
        const settings = readUpstreamSyncSettings({
            upstreamSync: { schedule: '   ', branch: '', mode: '' },
        } as never);

        expect(settings.schedule).toBe('0 6 * * 1');
        expect(settings.branch).toBeNull();
        expect(settings.mode).toBe('merge');
    });

    it('keeps `enabled: true` for anything that is not a boolean, never switching sync off by accident', () => {
        // A spec that was never validated can carry a string where a boolean belongs;
        // reading it as `false` would silently stop syncing the Work.
        const settings = readUpstreamSyncSettings({
            upstreamSync: { enabled: 'no' },
        } as never);

        expect(settings.enabled).toBe(true);
    });

    it('reports a mode this epic cannot honour rather than pretending it can', () => {
        const settings = readUpstreamSyncSettings({
            upstreamSync: { mode: 'rebase' },
        } as never);

        expect(settings.mode).toBe('rebase');
        expect(settings.modeHonoured).toBe(false);
    });

    it('ignores a non-object block (an unvalidated spec) instead of throwing', () => {
        const settings = readUpstreamSyncSettings({ upstreamSync: 'merge' } as never);

        expect(settings.schedule).toBe('0 6 * * 1');
        expect(settings.enabled).toBe(true);
        expect(settings.blockAbsent).toBe(true);
    });
});

describe('upstreamSyncBranch — `branch` is the branch compared and merged (plan §6.4)', () => {
    it('prefers the spec’s branch over the upstream default branch', () => {
        const settings = readUpstreamSyncSettings({
            upstreamSync: { branch: 'develop' },
        } as never);

        expect(upstreamSyncBranch(settings, 'main')).toBe('develop');
    });

    it('falls back to the upstream’s default branch when the spec names none', () => {
        const settings = readUpstreamSyncSettings({ upstreamSync: {} } as never);

        expect(upstreamSyncBranch(settings, 'main')).toBe('main');
    });

    it('answers null when neither is known, never a guessed branch name', () => {
        expect(upstreamSyncBranch(readUpstreamSyncSettings(null), null)).toBeNull();
        expect(upstreamSyncBranch(null, '   ')).toBeNull();
    });
});

describe('computeNextUpstreamSync — the default expression (FR-32)', () => {
    it('schedules the platform default when the schedule is absent', () => {
        expect(slotOf(computeNextUpstreamSync(null, MONDAY, WORK_ID))).toBe(
            '2026-01-05T06:00:00.000Z',
        );
        expect(slotOf(computeNextUpstreamSync(undefined, MONDAY, WORK_ID))).toBe(
            '2026-01-05T06:00:00.000Z',
        );
        expect(slotOf(computeNextUpstreamSync('', MONDAY, WORK_ID))).toBe(
            '2026-01-05T06:00:00.000Z',
        );
    });

    it('schedules the platform default when the expression cannot be parsed', () => {
        // An unreadable spec must sync on the platform's cadence rather than never.
        expect(slotOf(computeNextUpstreamSync('not a cron', MONDAY, WORK_ID))).toBe(
            '2026-01-05T06:00:00.000Z',
        );
        // `manual` is the Agent heartbeat's sentinel, not a schedule this epic honours.
        expect(slotOf(computeNextUpstreamSync('manual', MONDAY, WORK_ID))).toBe(
            '2026-01-05T06:00:00.000Z',
        );
    });

    it('honours a parsed expression, and returns a slot strictly after `from`', () => {
        const next = computeNextUpstreamSync('30 2 * * *', MONDAY, WORK_ID);

        expect(slotOf(next)).toBe('2026-01-05T02:30:00.000Z');
        expect((next as Date).getTime()).toBeGreaterThan(MONDAY.getTime());
    });

    it('returns null only when the engine finds no slot at all', () => {
        // February 30 never occurs: a syntactically valid expression with no slot.
        expect(computeNextUpstreamSync('0 0 30 2 *', MONDAY, WORK_ID)).toBeNull();
    });
});

describe('computeNextUpstreamSync — the hourly clamp (FR-32)', () => {
    it('clamps a five-minute schedule to a slot at least an hour after the first', () => {
        const next = computeNextUpstreamSync('*/5 * * * *', MONDAY, WORK_ID);

        // The first two slots are 00:05 and 00:10 — five minutes apart — so the answer
        // is the first slot at or after 00:05 + 1 h.
        expect(slotOf(next)).toBe('2026-01-05T01:05:00.000Z');
    });

    it('leaves an hourly schedule untouched', () => {
        const next = computeNextUpstreamSync('0 * * * *', MONDAY, WORK_ID);

        expect(slotOf(next)).toBe('2026-01-05T01:00:00.000Z');
    });

    it('leaves a weekly schedule untouched', () => {
        const next = computeNextUpstreamSync('0 6 * * 1', MONDAY, WORK_ID);

        expect(slotOf(next)).toBe('2026-01-05T06:00:00.000Z');
    });

    it('clamps a schedule whose next two slots are just under an hour apart', () => {
        // Every 59 minutes: `0,59 * * * *` fires at 00:59 and 01:00 — 60 000 ms apart,
        // which is not yet the hourly floor.
        const next = computeNextUpstreamSync('0,59 * * * *', MONDAY, WORK_ID);

        expect((next as Date).getTime() - MONDAY.getTime()).toBeGreaterThanOrEqual(
            APP_UPSTREAM_SYNC_MIN_INTERVAL_MS,
        );
    });
});

describe('computeNextUpstreamSync — the stable jitter (FR-32)', () => {
    it('adds this Work’s jitter to the slot, and it never exceeds five minutes', () => {
        const next = computeNextUpstreamSync('0 6 * * 1', MONDAY, WORK_ID) as Date;
        const jitter = next.getTime() - Date.parse('2026-01-05T06:00:00.000Z');

        expect(jitter).toBe(JITTER);
        expect(jitter).toBeGreaterThanOrEqual(0);
        expect(jitter).toBeLessThan(APP_UPSTREAM_SYNC_JITTER_MAX_MS);
        expect(jitter % 1_000).toBe(0);
    });

    it('is stable for one Work — the same input always lands on the same second', () => {
        expect(upstreamSyncJitterMs(WORK_ID)).toBe(upstreamSyncJitterMs(WORK_ID));
        expect(computeNextUpstreamSync('0 6 * * 1', MONDAY, WORK_ID)?.toISOString()).toBe(
            computeNextUpstreamSync('0 6 * * 1', MONDAY, WORK_ID)?.toISOString(),
        );
    });

    it('spreads two Works apart, which is the whole point of the delay', () => {
        expect(upstreamSyncJitterMs(WORK_ID)).not.toBe(upstreamSyncJitterMs(OTHER_WORK_ID));
    });

    it('hashes with FNV-1a, deterministically and in 32-bit space', () => {
        expect(fnv1a('')).toBe(0x811c9dc5);
        expect(fnv1a('a')).toBe(fnv1a('a'));
        expect(fnv1a('a')).not.toBe(fnv1a('b'));
        expect(fnv1a('ä')).toBeGreaterThanOrEqual(0);
    });
});

describe('nextUpstreamSyncAt — `enabled: false` leaves the next run unset (FR-64, ACC-02-28)', () => {
    it('answers null when the spec turns the schedule off', () => {
        const settings = readUpstreamSyncSettings({
            upstreamSync: { enabled: false },
        } as never);

        expect(nextUpstreamSyncAt(settings, MONDAY, WORK_ID)).toBeNull();
    });

    it('still exposes the schedule the manual path uses — Sync now is not locked out', () => {
        const settings = readUpstreamSyncSettings({
            upstreamSync: { enabled: false, schedule: '30 2 * * *' },
        } as never);

        expect(settings.enabled).toBe(false);
        // The clock the *scheduled* dispatcher reads is unset…
        expect(nextUpstreamSyncAt(settings, MONDAY, WORK_ID)).toBeNull();
        // …while the same expression still yields a slot for the manual run, which is
        // what "Sync now still works" means (FR-64, ACC-02-28).
        expect(computeNextUpstreamSync(settings.schedule, MONDAY, WORK_ID)).not.toBeNull();
    });

    it('answers null for a mode this epic cannot honour', () => {
        const settings = readUpstreamSyncSettings({
            upstreamSync: { mode: 'rebase' },
        } as never);

        expect(nextUpstreamSyncAt(settings, MONDAY, WORK_ID)).toBeNull();
    });

    it('answers null when there are no settings at all', () => {
        expect(nextUpstreamSyncAt(null, MONDAY, WORK_ID)).toBeNull();
    });

    it('computes the scheduled slot when the spec enables it', () => {
        const settings = readUpstreamSyncSettings({
            upstreamSync: { enabled: true, schedule: '0 6 * * 1' },
        } as never);

        expect(slotOf(nextUpstreamSyncAt(settings, MONDAY, WORK_ID))).toBe(
            '2026-01-05T06:00:00.000Z',
        );
    });
});
