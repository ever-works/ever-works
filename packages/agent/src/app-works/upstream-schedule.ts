/**
 * APW-02 T26 — when the next upstream sync runs, and what the App spec says
 * about syncing at all.
 *
 * Spec: `docs/specs/features/app-works/APW-02-fork-lifecycle/spec.md` FR-32,
 * FR-64, ACC-02-28. Plan: §6.4 (`plan.md:756-771`), §6.3 step 8
 * (`plan.md:749-752`). Schema: §19 (`app-spec.types.ts:886-903`).
 *
 * ## The four fields, and why all four are read here
 *
 * `plan.md:765-771` is explicit and it is a correction rather than a
 * description: **"Before this note, only `schedule` had a reader, so a spec
 * setting `enabled: false` would have kept syncing on a timer: a task in APW-02
 * P1 must test all four."** This module is that reader — the single place where
 * the four `spec.upstreamSync` fields
 * (`AppSpecUpstreamSync`: `enabled`, `schedule`, `mode`, `branch`) become the
 * values the sync run acts on, with the documented defaults when the block, or
 * any field in it, is absent:
 *
 * | Field      | Default when absent      | What it decides                                                                 |
 * | ---------- | ------------------------ | ------------------------------------------------------------------------------- |
 * | `schedule` | `0 6 * * 1` (Mondays)    | the next slot, through {@link computeNextUpstreamSync}                          |
 * | `enabled`  | `true`                   | `false` ⇒ `nextSyncAt` stays `null`; **Sync now** still works (FR-64)            |
 * | `branch`   | upstream default branch  | the branch compared and merged (read by the run, not by the clock)               |
 * | `mode`     | `merge`                  | `merge` only; anything else is a desync this epic cannot honour                  |
 *
 * `enabled: false` deliberately does **not** mean "the Work may never sync":
 * FR-64 and ACC-02-28 say the scheduled run is unset while the member's own
 * **Sync now** still works. That is why the settings are returned as data
 * ({@link AppUpstreamSyncSettings}) and only {@link nextUpstreamSyncAt} — the
 * *scheduling* half — answers `null` for a disabled Work. The manual door reads
 * the same settings and ignores `enabled`.
 *
 * ## The clock reuses the Agent heartbeat, not a second cron engine
 *
 * `plan.md:758`: `nextSyncAt = computeNextHeartbeat(schedule, from) + jitter`.
 * `computeNextHeartbeat` (`../agents/heartbeat-cron.ts`) is the platform's
 * existing minute-walking UTC cron reader — the same one the Agent dispatcher
 * uses — so this epic adds no cron dependency and inherits its behaviour
 * exactly: a slot strictly after `from`, `null` for an expression that does not
 * parse, and no double-slip when a dispatcher runs late (callers pass the
 * *previous* scheduled slot, not `now`).
 *
 * ## The hourly clamp is a second pass, not a second parser
 *
 * FR-32: "schedules firing more often than once an hour MUST be treated as
 * hourly". A five-field cron cannot be clamped by rewriting it (a five-minute
 * expression has no hourly equivalent that keeps its phase), so the clamp is
 * applied to the *answer*: the next two slots are computed, and when they are
 * closer together than {@link APP_UPSTREAM_SYNC_MIN_INTERVAL_MS} the reader walks
 * forward to the first slot at least that far after the first one. A schedule that
 * already fires hourly or more slowly is returned untouched — this never pushes a
 * Monday schedule around.
 *
 * APW-03's validator already refuses a too-frequent schedule
 * (`schedule_too_frequent`, `app-spec.rules.ts:1365-1383`), and this clamp is
 * deliberately kept anyway: it is the runtime's own guarantee, it holds for a
 * spec that was never validated (an unreadable spec falls back to the default
 * rather than to `null`), and it is what FR-32 asks the *scheduler* to do rather
 * than the *validator*.
 *
 * ## Jitter is stable per App Work, and that is the whole point
 *
 * FR-32: "each App Work's run MUST be delayed by a stable 0–300 seconds so App
 * Works do not all start at once." The delay is
 * `(fnv1a(workId) mod 300) × 1 000` ms — the same work always lands on the same
 * second, so a Work does not drift across slots run to run, while two Works land
 * on different seconds. It is *added* to the slot, never subtracted, and it
 * never moves a slot more than {@link APP_UPSTREAM_SYNC_JITTER_MAX_MS}.
 */

import {
    APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE,
    APP_UPSTREAM_SYNC_JITTER_MAX_MS,
    APP_UPSTREAM_SYNC_MIN_INTERVAL_MS,
    type AppSpec,
} from '@ever-works/contracts';
import { computeNextHeartbeat } from '../agents/heartbeat-cron';
import { parseCron } from '../missions/cron-matcher';

/**
 * The one `upstreamSync.mode` this epic honours — `merge`
 * (`APP_SPEC_UPSTREAM_SYNC_MODES`, schema.md §19:399).
 *
 * APW-03's validator is what rejects any other value; this reader still checks
 * it, because "the spec was not validated" must never turn into "the platform
 * ran a mode it does not implement".
 */
export const APP_UPSTREAM_SYNC_HONOURED_MODE = 'merge';

/** How the jitter is computed: `fnv1a(workId) mod 300`, in seconds. */
export const APP_UPSTREAM_SYNC_JITTER_SECONDS = APP_UPSTREAM_SYNC_JITTER_MAX_MS / 1_000;

/**
 * The four `spec.upstreamSync` fields, resolved — the answer
 * {@link readUpstreamSyncSettings} gives and the sync run acts on.
 *
 * `schedule` is never empty (the default stands in), `mode` is a plain
 * **string** rather than a two-member union because this package sets
 * `strictNullChecks: false` and a `true`/`false`-style discriminant would not
 * narrow anything a caller switches on — {@link modeHonoured} is the branch a
 * caller takes.
 */
export interface AppUpstreamSyncSettings {
    /** The effective five-field UTC cron: the spec's value, else the default (FR-32). */
    schedule: string;
    /**
     * Whether the **scheduled** dispatch may run. `false` leaves `nextSyncAt`
     * `null` and never cancels a manual **Sync now** (FR-64, ACC-02-28).
     */
    enabled: boolean;
    /**
     * The configured branch, or `null` when the spec does not name one — in
     * which case the branch compared and merged is the **upstream's default
     * branch** (`AppSpecUpstreamSync.branch`'s documented default).
     */
    branch: string | null;
    /** The raw `mode` string (`merge` when absent), kept for the record. */
    mode: string;
    /** `true` ⇔ `mode` is `merge` — the only value this epic can carry out. */
    modeHonoured: boolean;
    /** `true` ⇔ the spec had no `upstreamSync` block at all (for the card/tests). */
    blockAbsent: boolean;
}

/**
 * Read all four `upstreamSync` fields out of an effective App spec.
 *
 * Never throws: a missing block, a missing field, a `null` and an empty string
 * all resolve to the documented default, because "the spec does not say" and
 * "the spec says nothing usable" must schedule the same sync rather than none.
 * A non-object `upstreamSync` (a spec that was never validated) is treated as
 * absent for the same reason.
 *
 * An invalid or unparseable `schedule` is **not** resolved here: it keeps its
 * raw value, and {@link computeNextUpstreamSync} is what falls back to the
 * default when `computeNextHeartbeat` cannot read it. That split is deliberate —
 * this function reports what the spec says, the clock function reports what the
 * platform will do when the spec says something unusable.
 */
export function readUpstreamSyncSettings(
    spec?: AppSpec | null | Record<string, unknown> | null,
): AppUpstreamSyncSettings {
    const raw = (spec as unknown as { upstreamSync?: unknown } | null | undefined)?.upstreamSync;
    const block =
        raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : null;

    const schedule = nonEmptyString(block?.schedule);
    const branch = nonEmptyString(block?.branch);
    const mode = nonEmptyString(block?.mode);
    const enabled = typeof block?.enabled === 'boolean' ? (block.enabled as boolean) : true;

    return {
        schedule: schedule ?? APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE,
        enabled,
        branch: branch ?? null,
        mode: mode ?? APP_UPSTREAM_SYNC_HONOURED_MODE,
        modeHonoured: (mode ?? APP_UPSTREAM_SYNC_HONOURED_MODE) === APP_UPSTREAM_SYNC_HONOURED_MODE,
        blockAbsent: block === null,
    };
}

/**
 * The branch the sync compares and merges: the spec's, else the fallback the
 * caller supplies (the upstream's default branch).
 *
 * `branch` is read here rather than inside the clock because it has nothing to
 * do with scheduling — the run passes the result to `getForkDivergence` and to
 * the merge/PR calls, exactly as `plan.md:767-769` says.
 */
export function upstreamSyncBranch(
    settings: AppUpstreamSyncSettings | null | undefined,
    fallback: string | null | undefined,
): string | null {
    return nonEmptyString(settings?.branch) ?? nonEmptyString(fallback) ?? null;
}

/**
 * The instant a run scheduled from `from` is due: the next slot at or after
 * `from`, clamped to hourly, plus this Work's stable jitter (plan §6.4).
 *
 * Three documented behaviours, in the order the task text gives them:
 *
 *   1. **Default** — an absent, blank or unparseable `schedule` (including the
 *      Agent heartbeat's own `'manual'` sentinel) falls back to
 *      `APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE`. A Work whose spec is unreadable
 *      therefore syncs on the platform's own cadence rather than never.
 *   2. **Hourly clamp** — when the next two slots are closer than
 *      {@link APP_UPSTREAM_SYNC_MIN_INTERVAL_MS}, the answer becomes the first
 *      slot at least that far after the first one.
 *   3. **Stable jitter** — `(fnv1a(workId) mod 300) × 1 000` ms added to the
 *      slot.
 *
 * Returns `null` only when the cron engine finds no slot at all (a valid
 * expression with no occurrence in its ~13-month lookahead) — the caller stores
 * `null`, which is the same "nothing scheduled" state a paused Work has.
 */
export function computeNextUpstreamSync(
    schedule: string | null | undefined,
    from: Date,
    workId: string,
): Date | null {
    const explicit = nonEmptyString(schedule);
    const expression =
        explicit && isParsableCron(explicit) ? explicit : APP_UPSTREAM_SYNC_DEFAULT_SCHEDULE;
    const base = from instanceof Date ? from : new Date();

    const next = slotFor(expression, base);
    if (!next) {
        return null;
    }

    const jitter = upstreamSyncJitterMs(workId);
    return new Date(next.getTime() + jitter);
}

/**
 * The next **scheduled** slot for a Work, or `null` when the spec turns the
 * schedule off (`enabled: false`) or asks for a mode this epic cannot honour
 * (plan §6.4, FR-64, ACC-02-28).
 *
 * This is the function the sync run and the dispatcher's `nextSyncAt` writer
 * call. `null` is the documented "left unset" state — and it is *not* the same
 * statement as "sync is paused" (§3.1: `nextSyncAt` is NULL while paused and
 * for a `link`); the run's own pause states are what say which of the two it is,
 * and **Sync now** is refused by neither.
 */
export function nextUpstreamSyncAt(
    settings: AppUpstreamSyncSettings | null | undefined,
    from: Date,
    workId: string,
): Date | null {
    if (!settings || settings.enabled !== true || settings.modeHonoured !== true) {
        return null;
    }
    return computeNextUpstreamSync(settings.schedule, from, workId);
}

/**
 * This Work's stable jitter in milliseconds — always in
 * `0 … APP_UPSTREAM_SYNC_JITTER_MAX_MS`, and the same for the same `workId`
 * (FR-32's "stable 0–300 seconds").
 */
export function upstreamSyncJitterMs(workId: string): number {
    return (fnv1a(String(workId ?? '')) % APP_UPSTREAM_SYNC_JITTER_SECONDS) * 1_000;
}

/**
 * The 32-bit FNV-1a hash of a string, as an unsigned integer.
 *
 * Chosen because it is four lines, has no dependency, and is stable across
 * processes and platforms: the jitter must be identical in the worker that
 * writes `nextSyncAt`, in the dispatcher that reads it, and in the API that
 * renders the card. `Math.imul` keeps the multiply in 32-bit space, and
 * `>>> 0` returns the unsigned value, so a Work id containing non-ASCII
 * characters hashes the same everywhere.
 */
export function fnv1a(input: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/* -------------------------------------------------------------------------- *
 * internals
 * -------------------------------------------------------------------------- */

/**
 * The first slot at or after `from` whose successor is at least
 * `APP_UPSTREAM_SYNC_MIN_INTERVAL_MS` later (FR-32's hourly floor).
 *
 * The walk is bounded by the same 400-day horizon the heartbeat reader uses, so
 * a pathological expression cannot spin: a schedule with no slot ≥ 1 h after its
 * first one does not exist in practice (a five-field cron with a fixed hour
 * fires at most once a day), and if one somehow did, the walk ends and `null`
 * is returned rather than hanging a job.
 */
function slotFor(expression: string, from: Date): Date | null {
    const first = computeNextHeartbeat(expression, from);
    if (!first) {
        return null;
    }

    const second = computeNextHeartbeat(expression, first);
    if (second && second.getTime() - first.getTime() >= APP_UPSTREAM_SYNC_MIN_INTERVAL_MS) {
        return first;
    }

    const floor = first.getTime() + APP_UPSTREAM_SYNC_MIN_INTERVAL_MS;
    let cursor = second ?? first;
    for (let step = 0; step < MAX_CLAMP_STEPS; step++) {
        if (cursor.getTime() >= floor) {
            return cursor;
        }
        const next = computeNextHeartbeat(expression, cursor);
        if (!next) {
            return null;
        }
        cursor = next;
    }
    return null;
}

/**
 * How many slots the clamp may walk before giving up — one per hour of the
 * heartbeat reader's own 400-day horizon, which makes the bound unreachable for
 * any real expression and finite for any other.
 */
const MAX_CLAMP_STEPS = 24 * 400;

/** A trimmed non-empty string, or `null`. The one "is this field set?" test. */
function nonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether the cron engine can parse an expression.
 *
 * The one reason this module reads {@link parseCron} as well as
 * {@link computeNextHeartbeat}: the heartbeat reader answers `null` for **both**
 * "this is not a cron expression" and "this is one, and it has no occurrence in
 * the lookahead window", and the two need different answers here. The first falls
 * back to the documented default (a spec nobody could read must still sync); the
 * second is a real "nothing scheduled" and stays `null`. The parse is the
 * heartbeat's own, so the two can never disagree about what a valid expression
 * is.
 */
function isParsableCron(expression: string): boolean {
    try {
        parseCron(expression);
        return true;
    } catch {
        return false;
    }
}
