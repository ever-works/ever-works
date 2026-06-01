import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-work-sync-conflict — the DATA-SYNC STATE-FIELD contract (EW-628),
 * driven end-to-end through the per-Work sync surface + the persisted Work row.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE SIBLING SPECS STOP — AND WHERE THIS ONE STARTS.
 *   flow-data-sync-dispatch-deep / flow-data-sync-platform / data-sync /
 *   data-sync-idempotency all reconstruct the dispatcher FOLD and the
 *   force-sync OUTCOME ENVELOPE / ACTIVITY FEED. NONE of them assert against
 *   the *persisted Work sync-state columns* — the very fields the conflict
 *   detector and the dispatcher's due-set selection read:
 *     - `lastSyncedDataRepoSha`  (varchar(40), the rendered-against SHA; the
 *        SHA the poller diffs `ls-remote HEAD` against to detect a CONFLICT /
 *        delta. NULL until a sync SUCCEEDS — never written on a CI failure.)
 *     - `pendingSyncRequestedAt` (timestamp; the webhook flush flag the
 *        dispatcher Path-A debounces ≥30 s on. Cleared ONLY by a successful
 *        sync; a CI failure leaves it untouched per `runGates` catch branch.)
 *     - `syncIntervalMinutes`    (int, default 5, range 1–60; the poller cadence
 *        denominator. NOT writable via the public Work update DTO → 400.)
 *     - `githubAppInstalled`     (bool, default false; Path-A vs Path-B selector)
 *     - `lastPolledAt`           (timestamp; poll-moment denominator)
 *   THIS file pins those fields as an OBSERVABLE CONTRACT through the live
 *   surface, plus the concurrent-dispatch DEDUP race and the sync-vs-generation
 *   mutex gate from the state-field side.
 *
 * PROBED LIVE (CI: sqlite in-memory, NO connected git account) — exact shapes:
 *   GET /api/works/:id → 200, work row serializes ALL sync fields:
 *     { lastSyncedDataRepoSha:null, pendingSyncRequestedAt:null,
 *       syncIntervalMinutes:5, githubAppInstalled:false, lastPolledAt:null, … }
 *   POST /api/works/:id/sync (owner) → 202 ACCEPTED, envelope is one of:
 *     { status:'failed',  errorClass:'unknown',
 *       errorTail:'No connected account found for user <id> with provider github' }
 *       (CI: render gate throws because no git account is connected)
 *     { status:'skipped', reason:'retry-backoff' }      (in-window suppression)
 *     { status:'enqueued', outcome:'success', stats }   (non-CI: git connected)
 *   FIVE simultaneous force-syncs → EXACTLY ONE non-skipped (lock winner) + the
 *     rest { skipped: retry-backoff | sync-in-progress } — never two attempts.
 *   PATCH /api/works/:id { syncIntervalMinutes:15 } → 400 (field not in the
 *     UpdateWorkDto allow-list) → interval stays the default 5 (immutable here).
 *   POST /api/works/:id/generate { name, prompt } → 400 in CI (search/AI
 *     provider not configured) → `generateStatus` stays null → the generation
 *     gate is NOT reachable in CI; we assert the gate is NOT falsely tripped.
 *   GET /api/activity-log?workId=<id> → 200 { activities:[…], total } — each
 *     data_sync row carries details:{ kind, source:'manual', reason|errorClass }.
 *     `createdAt` is SECOND-resolution (ties possible inside a 1 s window).
 *   Access gates: stranger 403 {status:'error',message:/permission/};
 *     unknown/deleted work 404 {status:'error',message:/not found/}; unauth 401.
 *
 * GOTCHAS honored: every mutation runs on a FRESH registerUserViaAPI() user
 * (never the shared seeded user — a user-scoped retry-backoff/lock key must not
 * shadow sibling data-sync specs); unique Date.now()-suffixed names; outcomes
 * are environment-adaptive (success IFF a git account is connected — non-CI;
 * else failed/skipped) so EVERY assertion keeps a tolerant branch; the 5-min
 * retry-backoff is never waited out — only its in-window effect is asserted; no
 * fictional sync-conflict HTTP route is invented (conflict state is observed via
 * the persisted `lastSyncedDataRepoSha` SHA the poller would diff). The 202
 * ACCEPTED HttpCode and never-a-5xx invariant hold across every branch.
 */

const SYNC_HTTP_ACCEPTED = 202;

/** The force-sync envelope statuses (controller `ForceSyncResponse`). */
const ENVELOPE_STATUSES = ['enqueued', 'skipped', 'failed'] as const;
type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

/** Closed skip-reason vocabulary from `@ever-works/contracts` SyncEventSkipReason. */
const SKIP_REASONS = [
    'retry-backoff',
    'sync-in-progress',
    'generation-in-progress',
    'no-changes',
    'app-not-installed-and-no-credentials',
] as const;

/** Closed error-class vocabulary from `@ever-works/contracts` SyncEventErrorClass. */
const ERROR_CLASSES = [
    'data-repo-unreachable',
    'main-repo-push-rejected',
    'work-not-found',
    'timeout',
    'unknown',
] as const;

interface ForceSyncBody {
    status: EnvelopeStatus | string;
    outcome?: string;
    reason?: string;
    errorClass?: string;
    errorTail?: string;
    stats?: unknown;
    message?: string;
    [key: string]: unknown;
}

/** The subset of Work sync-state columns we assert on. */
interface WorkSyncState {
    id: string;
    lastSyncedDataRepoSha?: string | null;
    pendingSyncRequestedAt?: string | null;
    syncIntervalMinutes?: number;
    githubAppInstalled?: boolean;
    lastPolledAt?: string | null;
    [key: string]: unknown;
}

interface ActivityRow {
    actionType?: string;
    action?: string;
    status?: string;
    summary?: string;
    details?: {
        kind?: string;
        reason?: string;
        source?: string;
        errorClass?: string;
        [k: string]: unknown;
    };
    createdAt?: string;
    [key: string]: unknown;
}

function uniqueSuffix(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** POST /api/works/:id/sync as an owner; returns the parsed envelope + http. */
async function forceSync(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<{ http: number; body: ForceSyncBody }> {
    const res = await request.post(`${API_BASE}/api/works/${workId}/sync`, {
        headers: authedHeaders(token),
    });
    let body: ForceSyncBody = { status: 'failed' };
    try {
        body = (await res.json()) as ForceSyncBody;
    } catch {
        // non-JSON is unexpected; http code carries the truth.
    }
    return { http: res.status(), body };
}

/** GET /api/works/:id and pull the (possibly nested) Work row. */
async function getWorkState(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<WorkSyncState | null> {
    const res = await request.get(`${API_BASE}/api/works/${workId}`, {
        headers: authedHeaders(token),
    });
    if (!res.ok()) return null;
    const json = await res.json();
    return (json?.work ?? json?.data ?? json) as WorkSyncState;
}

async function listActivity(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<ActivityRow[]> {
    const res = await request.get(`${API_BASE}/api/activity-log?workId=${workId}`, {
        headers: authedHeaders(token),
    });
    if (!res.ok()) return [];
    const json = await res.json();
    return (json.activities ?? json.data ?? json.items ?? []) as ActivityRow[];
}

function dataSyncRows(rows: ActivityRow[]): ActivityRow[] {
    return rows.filter(
        (a) =>
            (a.actionType ?? '').startsWith('data_sync_') ||
            (a.action ?? '').startsWith('data-sync.'),
    );
}

/**
 * Whether the env has a connected git account (non-CI). When the FIRST sync of
 * a fresh Work enqueues a success, the render gate passed → git is connected.
 * Used to branch every assertion truthfully.
 */
function isGitConnected(firstSync: ForceSyncBody): boolean {
    return firstSync.status === 'enqueued';
}

test.describe('flow: work data-sync state-field + conflict contract (EW-628, deep)', () => {
    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 1 — A FAILED SYNC NEVER ADVANCES THE CONFLICT BASELINE.
    // `lastSyncedDataRepoSha` is the SHA the poller diffs `ls-remote HEAD`
    // against to decide a Work is "due" (a delta == a conflict to reconcile).
    // On a CI render-gate FAILURE the service catch branch must NOT write the
    // SHA and must NOT clear `pendingSyncRequestedAt` — otherwise a broken sync
    // would silently mark the Work "up to date" and the conflict would be lost.
    // We assert the baseline stays NULL across a failed attempt (+ its backoff
    // dup), proving a failure is non-advancing for conflict detection.
    // (Non-CI: a success legitimately advances the SHA — asserted in the branch.)
    // ───────────────────────────────────────────────────────────────────────────
    test('a failed sync leaves lastSyncedDataRepoSha unchanged (the conflict baseline never advances on failure)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner = await registerUserViaAPI(request, {
            name: `Sync Baseline ${uniqueSuffix()}`,
        });
        const token = owner.access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `sync-baseline-${uniqueSuffix()}`,
        });
        expect(work.id, 'work created').toBeTruthy();

        // A brand-new Work has never synced — baseline is NULL, default cadence.
        const before = await getWorkState(request, token, work.id);
        expect(before, 'work detail readable').toBeTruthy();
        expect(before!.lastSyncedDataRepoSha ?? null, 'fresh work has no synced SHA').toBeNull();
        expect(before!.pendingSyncRequestedAt ?? null, 'no pending webhook flush').toBeNull();
        expect(before!.syncIntervalMinutes, 'default poller cadence is 5').toBe(5);

        const first = await forceSync(request, token, work.id);
        expect(first.http, 'force-sync resolves with 202 ACCEPTED').toBe(SYNC_HTTP_ACCEPTED);
        expect(ENVELOPE_STATUSES, 'envelope status is well-formed').toContain(first.body.status);

        if (isGitConnected(first.body)) {
            // Non-CI: a real success legitimately advances the baseline + clears
            // the pending flag. Poll the persisted row to reflect the write.
            test.info().annotations.push({
                type: 'git-connected',
                description:
                    'render gate passed (git connected — non-CI); a success advances lastSyncedDataRepoSha. Asserting the success-path state transition instead.',
            });
            await expect
                .poll(
                    async () =>
                        (await getWorkState(request, token, work.id))?.lastSyncedDataRepoSha
                            ? 'stamped'
                            : 'pending',
                    {
                        timeout: 20_000,
                        message: 'a successful sync should stamp lastSyncedDataRepoSha',
                    },
                )
                .toBe('stamped');
            const post = await getWorkState(request, token, work.id);
            expect(
                post!.pendingSyncRequestedAt ?? null,
                'success clears the pending flush flag',
            ).toBeNull();
            return;
        }

        // CI path: the render gate threw → failed. The baseline must NOT advance.
        expect(first.body.status, 'CI render gate fails').toBe('failed');
        expect(ERROR_CLASSES, 'errorClass is from the closed union').toContain(
            first.body.errorClass,
        );
        expect(String(first.body.errorTail), 'errorTail names the missing git account').toMatch(
            /No connected account|github|not found/i,
        );

        // Drive a duplicate (suppressed) tick too — neither the failure nor its
        // backoff dup may touch the conflict baseline.
        await forceSync(request, token, work.id);

        const after = await getWorkState(request, token, work.id);
        expect(
            after!.lastSyncedDataRepoSha ?? null,
            'failed sync did NOT advance the baseline SHA',
        ).toBeNull();
        expect(
            after!.pendingSyncRequestedAt ?? null,
            'failed sync did NOT clear/set the pending flag',
        ).toBeNull();
        // The failure recorded a row but the persisted conflict state is untouched.
        const ds = dataSyncRows(await listActivity(request, token, work.id));
        expect(
            ds.some((r) => r.actionType === 'data_sync_failed' || r.status === 'failed'),
            'a data_sync_failed row was recorded',
        ).toBe(true);
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 2 — CONCURRENT DISPATCH DEDUP (the single-flight lock).
    // Five simultaneous force-syncs of ONE Work race for the per-Work
    // `task-lock:data-sync:<id>` mutex. EXACTLY ONE may run the gates (the lock
    // winner); the losers must short-circuit — either as `sync-in-progress`
    // (lost the lock race) or, once the winner's failure arms the backoff, as
    // `retry-backoff`. The invariant: AT MOST ONE non-skipped outcome across the
    // burst — a Work is NEVER double-dispatched. Every response is a clean 202.
    // ───────────────────────────────────────────────────────────────────────────
    test('five concurrent force-syncs dedup to at most one real attempt (single-flight lock + backoff)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner = await registerUserViaAPI(request, { name: `Sync Dedup ${uniqueSuffix()}` });
        const token = owner.access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `sync-dedup-${uniqueSuffix()}`,
        });

        const BURST = 5;
        const results = await Promise.all(
            Array.from({ length: BURST }, () => forceSync(request, token, work.id)),
        );

        // Every concurrent response is a clean 202 with a well-formed status — no 5xx.
        for (const r of results) {
            expect(r.http, 'each concurrent sync is 202 ACCEPTED (never a 5xx)').toBe(
                SYNC_HTTP_ACCEPTED,
            );
            expect(ENVELOPE_STATUSES, 'each envelope status is well-formed').toContain(
                r.body.status,
            );
        }

        const nonSkipped = results.filter((r) => r.body.status !== 'skipped');
        const skipped = results.filter((r) => r.body.status === 'skipped');

        if (results.some((r) => isGitConnected(r.body))) {
            // Non-CI: a connected git account may let more than one resolve a
            // success if the lock is released between calls; still assert no 5xx
            // and that skipped outcomes carry a valid reason. (Lock dedup still
            // holds, but timing is environment-sensitive — keep it tolerant.)
            test.info().annotations.push({
                type: 'git-connected',
                description:
                    'git connected (non-CI); asserting the no-5xx + valid-reason invariant only.',
            });
        } else {
            // CI: the lock winner runs the gates (fails → arms backoff); the rest
            // are suppressed. AT MOST ONE non-skipped outcome — never two attempts.
            expect(
                nonSkipped.length,
                'a Work is never double-dispatched: at most one non-skipped outcome in the burst',
            ).toBeLessThanOrEqual(1);
            expect(skipped.length, 'the rest of the burst is suppressed').toBeGreaterThanOrEqual(
                BURST - 1,
            );
        }

        // Every skipped outcome carries a reason from the closed dedup vocabulary.
        for (const r of skipped) {
            expect(
                SKIP_REASONS,
                `skip reason "${r.body.reason}" is from the closed union`,
            ).toContain(r.body.reason);
            expect(
                ['retry-backoff', 'sync-in-progress'],
                'a concurrent-dedup skip is a single-flight reason',
            ).toContain(r.body.reason);
        }

        // The persisted conflict baseline is unchanged by a deduped CI burst.
        const state = await getWorkState(request, token, work.id);
        if (!results.some((r) => isGitConnected(r.body))) {
            expect(
                state!.lastSyncedDataRepoSha ?? null,
                'no SHA advance from a deduped failing burst',
            ).toBeNull();
        }
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 3 — syncIntervalMinutes IS IMMUTABLE VIA THE PUBLIC WORK DTO.
    // The poller cadence (default 5, range 1–60) is a server-managed sync column,
    // NOT a user-editable Work field: the UpdateWorkDto allow-list rejects it
    // with 400. A confused client can never widen/narrow its own poll cadence (or
    // disable the poller by zeroing the interval) through the Work update path.
    // We attempt several interval mutations (incl. out-of-range + zero) and prove
    // the persisted cadence stays the default — the dispatcher's due-set
    // denominator is tamper-proof from the public API.
    // ───────────────────────────────────────────────────────────────────────────
    test('syncIntervalMinutes cannot be changed through the public Work update DTO (cadence is tamper-proof)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner = await registerUserViaAPI(request, { name: `Sync Cadence ${uniqueSuffix()}` });
        const token = owner.access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `sync-cadence-${uniqueSuffix()}`,
        });

        const before = await getWorkState(request, token, work.id);
        expect(before!.syncIntervalMinutes, 'default cadence is 5 minutes').toBe(5);
        expect(
            before!.githubAppInstalled,
            'fresh work has the App not installed (poller path)',
        ).toBe(false);

        // Each attempt: a non-allowlisted sync field on the Work update DTO. The
        // API must reject (400 most likely) OR silently ignore — but the persisted
        // cadence must NEVER change to the attacker-supplied value.
        const attempts = [15, 1, 60, 0, 999];
        for (const interval of attempts) {
            const res = await request.patch(`${API_BASE}/api/works/${work.id}`, {
                headers: { ...authedHeaders(token), 'content-type': 'application/json' },
                data: { syncIntervalMinutes: interval },
            });
            // 400 (rejected by the DTO whitelist) is the observed behavior; a
            // tolerant 200/forbidIfNonWhitelisted strip is also acceptable as long
            // as the value does not stick. Never a 5xx.
            expect(
                res.status(),
                `update with syncIntervalMinutes=${interval} is a client-level response (not 5xx)`,
            ).toBeLessThan(500);

            const after = await getWorkState(request, token, work.id);
            expect(
                after!.syncIntervalMinutes,
                `syncIntervalMinutes did not change to the supplied ${interval}`,
            ).toBe(5);
        }

        // And the other server-managed sync columns are equally untouched.
        const final = await getWorkState(request, token, work.id);
        expect(final!.lastSyncedDataRepoSha ?? null, 'SHA still null').toBeNull();
        expect(final!.pendingSyncRequestedAt ?? null, 'pending flag still null').toBeNull();
        expect(final!.githubAppInstalled, 'App-installed selector still false').toBe(false);
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 4 — SYNC DURING GENERATION: the mutex gate is not falsely tripped.
    // The sync↔generation mutex (gate 2) skips a sync with
    // `generation-in-progress` ONLY while `work.generateStatus.status` is
    // GENERATING. In CI no AI/search provider is configured, so generate() CANNOT
    // start a run → `generateStatus` stays null → the gate is correctly NOT
    // tripped and a concurrent force-sync still resolves its own (failed) outcome
    // rather than a false generation-in-progress skip. We assert that truthfully,
    // with a tolerant branch that IF a run ever does flip GENERATING, the sync is
    // skipped:generation-in-progress (the documented behavior).
    // ───────────────────────────────────────────────────────────────────────────
    test('a sync issued alongside a generation attempt is not falsely gated as generation-in-progress', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner = await registerUserViaAPI(request, { name: `Sync vs Gen ${uniqueSuffix()}` });
        const token = owner.access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `sync-vs-gen-${uniqueSuffix()}`,
        });

        // Kick a generation. In CI this 400s (provider not configured) and the
        // run never starts; outside CI it may enqueue. Tolerate both.
        const genRes = await request.post(`${API_BASE}/api/works/${work.id}/generate`, {
            headers: { ...authedHeaders(token), 'content-type': 'application/json' },
            data: {
                name: 'Sync Gate Probe',
                prompt: 'A directory exercising the sync-vs-generation mutex gate.',
            },
        });
        expect(genRes.status(), 'generate responds at the client level (no 5xx)').toBeLessThan(500);

        // Read whether a run actually flipped GENERATING.
        const stateMid = await getWorkState(request, token, work.id);
        const genStatus = (stateMid?.generateStatus as { status?: string } | null | undefined)
            ?.status;
        const isGenerating = genStatus === 'GENERATING' || genStatus === 'generating';

        const sync = await forceSync(request, token, work.id);
        expect(sync.http, 'concurrent force-sync resolves 202').toBe(SYNC_HTTP_ACCEPTED);
        expect(ENVELOPE_STATUSES).toContain(sync.body.status);

        if (isGenerating) {
            // Mutex engaged: the sync MUST defer with the documented reason.
            expect(sync.body.status, 'sync defers while generation is mid-flight').toBe('skipped');
            expect(sync.body.reason, 'the defer reason is generation-in-progress').toBe(
                'generation-in-progress',
            );
        } else {
            // CI: generation never started → the gate is NOT tripped. The sync
            // resolves its own outcome; it must NOT be a false generation skip.
            expect(
                stateMid!.lastSyncedDataRepoSha ?? null,
                'no generation == no SHA from gen',
            ).toBeNull();
            if (sync.body.status === 'skipped') {
                expect(
                    sync.body.reason,
                    'a skip here is NOT a false generation-in-progress (no run is active)',
                ).not.toBe('generation-in-progress');
                expect(['retry-backoff', 'sync-in-progress']).toContain(sync.body.reason);
            } else {
                expect(['failed', 'enqueued'], 'sync resolved its own gate-3 outcome').toContain(
                    sync.body.status,
                );
            }
        }
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 5 — A DELETED WORK PURGES ITS SYNC STATE & DROPS OUT OF THE DUE-SET.
    // Works have NO soft-delete. When a Work the dispatcher might still reference
    // is deleted, its persisted sync state (SHA / pending flag / cadence) is gone
    // with the row, GET 404s, and a force-sync resolves a clean controller 404
    // {status:'error',message:/not found/} — never a 5xx, never a phantom
    // dispatch. We capture the live sync state, delete, then prove both the read
    // and the dispatch surface treat the Work as fully purged (no orphaned
    // conflict baseline can resurrect it).
    // ───────────────────────────────────────────────────────────────────────────
    test('deleting a work purges its sync state and removes it from the dispatch due-set (clean 404, no 5xx)', async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const owner = await registerUserViaAPI(request, { name: `Sync Purge ${uniqueSuffix()}` });
        const token = owner.access_token;
        const work = await createWorkViaAPI(request, token, {
            name: `sync-purge-${uniqueSuffix()}`,
        });

        // Capture the live sync state pre-delete (proves the columns existed).
        const live = await getWorkState(request, token, work.id);
        expect(live, 'sync state readable before delete').toBeTruthy();
        expect(live!.syncIntervalMinutes, 'cadence present pre-delete').toBe(5);

        // Hard-delete via the REAL route: POST /api/works/:id/delete (there is NO
        // DELETE /api/works/:id route — it 404s as "Cannot DELETE"). The live
        // controller @HttpCode(200)s and returns a success envelope.
        const del = await request.post(`${API_BASE}/api/works/${work.id}/delete`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect([200, 202, 204], `delete responds cleanly (got ${del.status()})`).toContain(
            del.status(),
        );
        const delBody = await del.json();
        expect(delBody, 'delete envelope is a success').toMatchObject({ status: 'success' });

        // The persisted sync state is gone — GET 404s (hard delete, no soft-delete).
        const gone = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(token),
        });
        expect(gone.status(), 'deleted work detail is 404 (sync state purged)').toBe(404);

        // The dispatch surface drops it from the due-set: a force-sync is a clean
        // controller 404 with the canonical error envelope — never a 5xx.
        const sync = await request.post(`${API_BASE}/api/works/${work.id}/sync`, {
            headers: authedHeaders(token),
        });
        expect(
            sync.status(),
            `deleted-work force-sync is a clean 404, never a 5xx (got ${sync.status()})`,
        ).toBe(404);
        const body = (await sync.json()) as ForceSyncBody;
        expect(body, 'error envelope shape').toMatchObject({ status: 'error' });
        expect(String(body.message), 'deleted-work 404 message names "not found"').toMatch(
            /not found/i,
        );
    });

    // ───────────────────────────────────────────────────────────────────────────
    // FLOW 6 — SYNC-STATE ISOLATION: a stranger can neither read nor mutate
    // another user's conflict state. Owner A creates a Work and drives a sync
    // (writing A's data_sync activity rows). Stranger B must be 403 on A's
    // force-sync (cannot perturb A's pending flag / SHA / backoff), and B's view
    // of A's persisted sync state is inaccessible — while A's own state and
    // activity feed remain intact and owner-scoped. Pins the per-principal
    // scoping the dispatcher's owner-gated manual surface relies on.
    // ───────────────────────────────────────────────────────────────────────────
    test("a stranger cannot read or perturb another user's sync state (403, state stays owner-scoped)", async ({
        request,
    }) => {
        test.setTimeout(90_000);
        const suffix = uniqueSuffix();
        const ownerA = await registerUserViaAPI(request, { name: `Sync Iso A ${suffix}` });
        const tokenA = ownerA.access_token;
        const work = await createWorkViaAPI(request, tokenA, { name: `sync-iso-a-${suffix}` });

        // A drives a sync — records A's data_sync rows + (CI) arms A's backoff.
        const aFirst = await forceSync(request, tokenA, work.id);
        expect(aFirst.http, "A's force-sync resolves 202").toBe(SYNC_HTTP_ACCEPTED);
        expect(ENVELOPE_STATUSES).toContain(aFirst.body.status);

        const aStateBefore = await getWorkState(request, tokenA, work.id);
        expect(aStateBefore, "A can read A's sync state").toBeTruthy();

        // Stranger B.
        const ownerB = await registerUserViaAPI(request, { name: `Sync Iso B ${suffix}` });
        const tokenB = ownerB.access_token;

        // B cannot force-sync A's Work — 403, canonical envelope, never 2xx/5xx.
        const bSync = await request.post(`${API_BASE}/api/works/${work.id}/sync`, {
            headers: authedHeaders(tokenB),
        });
        expect(bSync.status(), "stranger cannot force-sync A's work").toBe(403);
        const bBody = (await bSync.json()) as ForceSyncBody;
        expect(bBody, 'forbidden envelope shape').toMatchObject({ status: 'error' });
        expect(String(bBody.message), 'stranger 403 message names permission').toMatch(
            /permission/i,
        );

        // B cannot read A's persisted sync state — the Work detail is not visible
        // (403/404). Whatever the exact code, B never sees A's sync columns.
        const bRead = await request.get(`${API_BASE}/api/works/${work.id}`, {
            headers: authedHeaders(tokenB),
        });
        expect(
            [401, 403, 404],
            `stranger read of A's work is access-gated (got ${bRead.status()})`,
        ).toContain(bRead.status());

        // B's force-sync attempt left NO data_sync row of B's making in A's feed:
        // every data_sync row in A's feed is attributed to A's sync activity.
        const aRows = dataSyncRows(await listActivity(request, tokenA, work.id));
        expect(aRows.length, "A's feed has A's own data_sync row(s)").toBeGreaterThanOrEqual(1);
        for (const row of aRows) {
            expect(row.details?.source, "A's sync rows came from the manual transport").toBe(
                'manual',
            );
        }

        // A's persisted sync state is unchanged by the stranger's probe — the
        // stranger could not perturb the conflict baseline or pending flag.
        const aStateAfter = await getWorkState(request, tokenA, work.id);
        expect(
            aStateAfter!.lastSyncedDataRepoSha ?? null,
            "A's baseline unchanged by stranger",
        ).toBe(aStateBefore!.lastSyncedDataRepoSha ?? null);
        expect(
            aStateAfter!.pendingSyncRequestedAt ?? null,
            "A's pending flag unchanged by stranger",
        ).toBe(aStateBefore!.pendingSyncRequestedAt ?? null);
        expect(aStateAfter!.syncIntervalMinutes, "A's cadence unchanged by stranger").toBe(
            aStateBefore!.syncIntervalMinutes,
        );
    });
});
