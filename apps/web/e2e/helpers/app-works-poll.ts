import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders } from './api';

/**
 * App Works polling — one deadline table, one polling shape, no sleeps.
 *
 * APW-13 plan §8.6 (`docs/specs/features/app-works/APW-13-golden-paths/plan.md:628-635`)
 * and ACCEPTANCE §0.5's harness rule "**Polling, never sleeping.** Every wait is
 * `expect.poll` (or the harness's `waitForActivity(workId, type, deadline)`) with
 * an explicit deadline and interval." A fixed Playwright page sleep is banned in
 * these specs — `__tests__/app-works-poll.unit.spec.ts` greps the harness for one,
 * so this module deliberately never names the banned call outside the spec.
 *
 * This module is the mechanism behind that rule:
 *
 * - {@link APW_DEADLINES} is **the single deadline table** of plan §8.6, so every
 *   budget is reviewed in one place instead of being re-typed per spec.
 * - Every wait polls ({@link pollIntervalMs}: 5 s, or 15 s for a wait longer than
 *   10 minutes) until its deadline, and **every poll also scans the same read for
 *   the step's terminal failure events**, throwing at once with the event's
 *   payload rather than timing out silently
 *   (`ACCEPTANCE.md:151-155` lists the events).
 * - On expiry the thrown `Error` *reports the last observed state*, so a red lane
 *   says what it saw instead of only how long it waited.
 * - The clock and the sleep are injectable ({@link PollClock}), so the unit spec
 *   runs instantly and deterministically and nothing here ever calls a Playwright
 *   wait.
 */

/** Injected time source. Defaults to the real clock. */
export interface PollClock {
    /** Milliseconds since the epoch. Defaults to `Date.now`. */
    now?: () => number;
    /** Sleep. Defaults to a real `setTimeout` promise. */
    sleep?: (ms: number) => Promise<void>;
    /** Overrides the derived interval (see {@link pollIntervalMs}). */
    intervalMs?: number;
}

/** The default poll interval of plan §8.6. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** The interval plan §8.6 gives a Build longer than 10 minutes. */
export const LONG_POLL_INTERVAL_MS = 15_000;

/** "longer than 10 minutes" — the threshold the 15 s interval keys off. */
export const LONG_POLL_THRESHOLD_MS = 10 * 60_000;

/**
 * **The single deadline table of plan §8.6** (`plan.md:632-634`). Every step's
 * budget is here and nowhere else: "Deadlines per step live in one table in
 * `app-works-poll.ts` so budgets are reviewed in one place".
 *
 * | Step                 | Budget | Field                     |
 * | -------------------- | ------ | ------------------------- |
 * | fork ready           | 3 min  | `forkReadyMs`             |
 * | fixture Build        | 6 min  | `fixtureBuildMs`          |
 * | Cal.diy Build        | 65 min | `calDiyBuildMs`           |
 * | fixture Deployment   | 3 min  | `fixtureDeploymentMs`     |
 * | Cal.diy Deployment   | 15 min | `calDiyDeploymentMs`      |
 * | smoke                | 2 min  | `smokeMs`                 |
 * | provisioner proposal | 20 min | `provisionerProposalMs`   |
 * | evolve PR            | 15 min | `evolvePrMs`              |
 * | upstream PR status   | 5 min  | `upstreamPrStatusMs`      |
 */
export const APW_DEADLINES = {
    forkReadyMs: 3 * 60_000,
    fixtureBuildMs: 6 * 60_000,
    calDiyBuildMs: 65 * 60_000,
    fixtureDeploymentMs: 3 * 60_000,
    calDiyDeploymentMs: 15 * 60_000,
    smokeMs: 2 * 60_000,
    provisionerProposalMs: 20 * 60_000,
    evolvePrMs: 15 * 60_000,
    upstreamPrStatusMs: 5 * 60_000,
} as const;

/** One key of the plan §8.6 deadline table. */
export type ApwDeadline = keyof typeof APW_DEADLINES;

/**
 * The interval a wait polls at (plan §8.6: "polls every 5 s (15 s for Builds
 * longer than 10 minutes) until the deadline").
 *
 * `step` is the CONTRACTS §6 family of the waited-for event (`build` for
 * `app.build.succeeded`), which `waitForActivity` derives from the event name. The
 * slow interval applies to a **Build** longer than 10 minutes and to nothing else:
 * the Cal.diy Deployment's 15-minute budget still polls every 5 s, exactly as the
 * plan says, and a caller that passes no step polls every 5 s.
 */
export function pollIntervalMs(deadlineMs: number, step?: string): number {
    const isLongBuild = deadlineMs > LONG_POLL_THRESHOLD_MS && step === 'build';
    return isLongBuild ? LONG_POLL_INTERVAL_MS : DEFAULT_POLL_INTERVAL_MS;
}

/** The CONTRACTS §6 family of an event name: `app.build.succeeded` → `build`. */
export function eventStep(type: string): string {
    const parts = type.split('.');
    return parts.length > 2 ? parts[1] : type;
}

/**
 * The terminal failure events every wait scans for, from ACCEPTANCE §0.5
 * (`ACCEPTANCE.md:151-155`) and the CONTRACTS §6 event list
 * (`CONTRACTS.md:511-534`). `app.provision.needs_input` is on the list on
 * purpose: a question can wait 14 days, so a wait that sees one must fail now.
 */
export const APP_FAILURE_EVENTS: readonly string[] = [
    'app.fork.timeout',
    'app.source.failed',
    'app.spec.invalid',
    'app.blueprint.apply_failed',
    'app.provision.failed',
    'app.provision.needs_input',
    'app.build.failed',
    'app.build.cancelled',
    'app.deploy.failed',
    'app.deploy.rolled_back',
    'app.job.failed',
    'app.smoke.failed',
    'app.health.unreachable',
    'app.change.failed',
    'app.upstream_pr.refused',
    'app.upstream_pr.failed',
    'app.upstream_pr.expired',
    'app.dependency.failed',
];

/**
 * The failure events belonging to one step, for a caller that wants to narrow the
 * scan to "the terminal failure events of the same step". Falls back to the whole
 * {@link APP_FAILURE_EVENTS} list when the step names none.
 */
export function failureEventsForStep(step: string): readonly string[] {
    const matching = APP_FAILURE_EVENTS.filter((event) => event.startsWith(`${step}.`));
    return matching.length > 0 ? matching : APP_FAILURE_EVENTS;
}

/** One Activity row, as `GET /api/activity-log` returns it. */
export interface ActivityEvent {
    id?: string;
    /** The dotted event name of CONTRACTS §6, e.g. `app.build.succeeded` (R-2). */
    action?: string;
    /** The snake-case family, e.g. `app_build` (R-2). */
    actionType?: string;
    status?: string;
    summary?: string;
    details?: unknown;
    createdAt?: string;
    workId?: string;
    [key: string]: unknown;
}

/** The dotted event name of a row, tolerating either field. */
function eventName(event: ActivityEvent): string {
    return String(event.action ?? event.actionType ?? '');
}

/** A short, value-free description of an event, for an error message. */
function describeEvent(event: ActivityEvent): string {
    const name = eventName(event) || '(unnamed event)';
    const status = event.status ? ` status=${event.status}` : '';
    const at = event.createdAt ? ` at=${event.createdAt}` : '';
    return `${name}${status}${at}`;
}

/** Serialise an observed value for an error message, capped so a body cannot flood it. */
export function describeState(value: unknown, limit = 800): string {
    let text: string;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch {
            text = String(value);
        }
    }
    if (text === undefined) text = String(value);
    return text.length > limit ? `${text.slice(0, limit)}… (${text.length} chars)` : text;
}

/** The real sleep, used when the caller injects no clock. */
function realSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/** Options shared by every wait in this module. */
export interface WaitOptions extends PollClock {
    /** The step's budget. Take it from {@link APW_DEADLINES}. */
    deadlineMs: number;
    /** A label used in failure messages; defaults to the waited-for event. */
    label?: string;
}

/** Options for {@link waitForActivity}. */
export interface WaitForActivityOptions extends WaitOptions {
    /**
     * Terminal failure events that short-circuit the wait. Defaults to
     * {@link APP_FAILURE_EVENTS} — a failure anywhere in the step fails the wait
     * at once with that event's payload.
     */
    failOn?: readonly string[];
    /** Overrides {@link API_BASE}. */
    baseUrl?: string;
    /** Rows to pull per poll. */
    limit?: number;
}

/** What one activity read answered. */
interface ActivityRead {
    events: ActivityEvent[];
    /** A human description of the read itself, used when it did not answer 200. */
    note: string;
}

/**
 * Read one page of a Work's Activity rows. Never throws: a non-200 answer is
 * reported through `note` so the wait can keep polling and still report what it
 * last saw on expiry.
 */
async function readActivity(
    request: APIRequestContext,
    token: string,
    workId: string,
    options: WaitForActivityOptions,
): Promise<ActivityRead> {
    const base = (options.baseUrl ?? API_BASE).replace(/\/+$/, '');
    const limit = options.limit ?? 50;
    const url = `${base}/api/activity-log?workId=${encodeURIComponent(workId)}&limit=${limit}`;
    try {
        const response = await request.get(url, { headers: authedHeaders(token) });
        const status = response.status();
        const text = await response.text();
        if (status !== 200) {
            return { events: [], note: `GET ${url} answered ${status}` };
        }
        const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
        const rows = (body.activities ?? body.items ?? body.data ?? []) as ActivityEvent[];
        const events = Array.isArray(rows) ? rows : [];
        return { events, note: `GET ${url} answered 200 with ${events.length} row(s)` };
    } catch (error) {
        return {
            events: [],
            note: `GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/**
 * Wait for one Activity event of a Work, failing at once on a failure event.
 *
 * Signature per plan §8.2 (`plan.md:499`):
 * `waitForActivity(request, token, workId, type, { deadlineMs, failOn })` — with
 * the clock, the interval and the base URL injectable on the same options object.
 *
 * @throws Error when a failure event of the step is observed (message carries the
 * event's payload) or when `deadlineMs` expires (message reports the last observed
 * state).
 */
export async function waitForActivity(
    request: APIRequestContext,
    token: string,
    workId: string,
    type: string,
    options: WaitForActivityOptions,
): Promise<ActivityEvent> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? realSleep;
    const intervalMs = options.intervalMs ?? pollIntervalMs(options.deadlineMs, eventStep(type));
    const failOn = options.failOn ?? APP_FAILURE_EVENTS;
    const startedAt = now();
    let lastState = 'no Activity read has completed yet';

    for (;;) {
        const read = await readActivity(request, token, workId, options);
        const match = read.events.find((event) => eventName(event) === type);
        if (match) return match;

        const failure = read.events.find((event) => failOn.includes(eventName(event)));
        if (failure) {
            throw new Error(
                `${type}: step failed with ${describeEvent(failure)} — payload ` +
                    `${describeState(failure)} (after ${now() - startedAt}ms)`,
            );
        }

        const observed = read.events.map(describeEvent);
        lastState =
            observed.length > 0
                ? `${read.note}; last observed: ${observed.slice(0, 8).join(', ')}`
                : `${read.note}; no ${type} and no failure event observed`;

        const elapsed = now() - startedAt;
        if (elapsed >= options.deadlineMs) {
            throw new Error(
                `${options.label ?? type}: deadline of ${options.deadlineMs}ms expired after ` +
                    `${elapsed}ms; last observed state: ${lastState}`,
            );
        }
        await sleep(intervalMs);
    }
}

/** The `/marker` body the fixture serves (plan §4.2). */
export interface LiveMarker {
    marker?: string;
    sha?: string;
    buildLabel?: string;
    publicUrl?: string;
    greeting?: string;
    [key: string]: unknown;
}

/** Options for {@link waitForLiveMarker}. */
export interface WaitForLiveMarkerOptions extends PollClock {
    /** Injected fetch. Defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
    /** The path appended to the base URL. Defaults to `/marker`. */
    path?: string;
    /** Per-request timeout for the default fetch. */
    requestTimeoutMs?: number;
}

/**
 * Poll a live App's `/marker` until it reports the prompted marker **and** the
 * Build's commit, then return the parsed body.
 *
 * Signature per plan §8.2 (`plan.md:499`): `waitForLiveMarker(url, marker, sha, deadlineMs)`.
 * ACC-13-02 requires both halves, so a body whose `marker` already matches but
 * whose `sha` is the previous Build keeps the wait going and is reported as the
 * last observed state on expiry.
 *
 * @throws Error on expiry, reporting the last observed marker body.
 */
export async function waitForLiveMarker(
    url: string,
    marker: string,
    sha: string,
    deadlineMs: number,
    options: WaitForLiveMarkerOptions = {},
): Promise<LiveMarker> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? realSleep;
    const intervalMs = options.intervalMs ?? pollIntervalMs(deadlineMs);
    const doFetch = options.fetchImpl ?? fetch;
    const markerPath = options.path ?? '/marker';
    const target = /\/marker$/.test(url.replace(/\/+$/, ''))
        ? url.replace(/\/+$/, '')
        : `${url.replace(/\/+$/, '')}${markerPath}`;
    const startedAt = now();
    let lastState = 'no marker read has completed yet';

    for (;;) {
        try {
            const response = await doFetch(target, {
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(options.requestTimeoutMs ?? 5_000),
            });
            const status = response.status;
            const text = await response.text();
            if (status !== 200) {
                lastState = `GET ${target} answered ${status}: ${describeState(text, 200)}`;
            } else {
                const body = JSON.parse(text) as LiveMarker;
                lastState = `GET ${target} answered 200: ${describeState(body)}`;
                if (body.marker === marker && body.sha === sha) return body;
            }
        } catch (error) {
            lastState = `GET ${target} failed: ${
                error instanceof Error ? error.message : String(error)
            }`;
        }

        const elapsed = now() - startedAt;
        if (elapsed >= deadlineMs) {
            throw new Error(
                `live marker ${marker}@${sha}: deadline of ${deadlineMs}ms expired after ` +
                    `${elapsed}ms; last observed state: ${lastState}`,
            );
        }
        await sleep(intervalMs);
    }
}

/** Options for {@link expectAbsentThenPresent}. */
export interface ExpectAbsentThenPresentOptions<T> extends WaitOptions {
    /** Decides whether an observation counts as present. */
    isPresent: (value: T) => boolean;
    /** A probe name for failure messages. */
    label?: string;
}

/**
 * Prove a state was **absent first**, then wait for it to appear.
 *
 * ACC-13-09/ACC-13-13's shape ("the lane first proves the marker is absent, then
 * sees it on the live page"): a value that is already present on the first
 * observation fails — the absence is the evidence, and a change that was never
 * absent cannot be attributed to the change under test.
 *
 * @throws Error when the first observation is already present, or when the value
 * has not appeared before `deadlineMs` (message reports the last observed state).
 */
export async function expectAbsentThenPresent<T>(
    probe: () => Promise<T>,
    options: ExpectAbsentThenPresentOptions<T>,
): Promise<T> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? realSleep;
    const intervalMs = options.intervalMs ?? pollIntervalMs(options.deadlineMs);
    const name = options.label ?? 'expectAbsentThenPresent';
    const startedAt = now();

    const first = await probe();
    if (options.isPresent(first)) {
        throw new Error(
            `${name}: value was present on the first observation, before it was ever observed ` +
                `absent — last observed state: ${describeState(first)}`,
        );
    }
    let lastState = describeState(first);

    for (;;) {
        const elapsed = now() - startedAt;
        if (elapsed >= options.deadlineMs) {
            throw new Error(
                `${name}: deadline of ${options.deadlineMs}ms expired after ${elapsed}ms without ` +
                    `the value appearing; last observed state: ${lastState}`,
            );
        }
        await sleep(intervalMs);
        const value = await probe();
        if (options.isPresent(value)) return value;
        lastState = describeState(value);
    }
}
