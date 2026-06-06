import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { API_BASE, registerUserViaAPI, authedHeaders, createWorkViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * Flow: Work item-source-validation lifecycle (deep cross-feature integration)
 *
 * Source validation is the scheduled "are the source URLs in my directory
 * still alive?" feature. The owner enables it + picks a cadence; an hourly cron
 * (`ItemSourceValidationCronService` -> `ItemSourceValidationSchedulerService
 * .processDueSchedules`) sweeps every Work whose `sourceValidationNextRunAt
 * <= now`, runs `ItemHealthService.runScheduledCheck`, and re-stamps lastRun/
 * nextRun. PUT computes `nextRunAt` from the cadence via
 * `WorkScheduleService.calculateNextRun`.
 *
 * PROBED CONTRACT — verified live against http://127.0.0.1:3100 (sqlite CI
 * driver, subscriptions DISABLED) on 2026-06-01, cross-checked against
 *   apps/api/src/works/works.controller.ts (get/updateSourceValidationSettings),
 *   packages/agent/src/services/item-source-validation-scheduler.service.ts,
 *   packages/agent/src/subscriptions/subscription.service.ts (getCadenceAllowances),
 *   packages/agent/src/dto/update-source-validation.dto.ts (enum order):
 *
 *   GET /api/works/:id/source-validation   (requires ensureAccess -> owner-only)
 *     200 -> {
 *       enabled: boolean,
 *       cadence: Cadence | null,
 *       nextRunAt: string | null,   // ISO; computed only while enabled+cadence
 *       lastRunAt: string | null,   // ISO; stamped by the cron sweep
 *       allowedCadences: Array<{ cadence: Cadence; allowed: boolean; payPerUse: boolean; reason?: string }>
 *     }
 *     NOTE: there is NO `lastValidationStatus`/`minIntervalMinutes` field.
 *     Fresh Work default -> { enabled:false, cadence:null, nextRunAt:null, lastRunAt:null, allowedCadences:[7] }.
 *
 *   Cadence enum (DTO order): hourly, every_3_hours, every_8_hours,
 *     every_12_hours, daily, weekly, monthly.
 *
 *   SUBSCRIPTION GATING is ENV-ADAPTIVE: when subscriptions are DISABLED
 *     (CI default — `SubscriptionService.isEnabled()` false) `getCadenceAllowances`
 *     returns ALL 7 cadences with `allowed:true, payPerUse:false`, so every cadence
 *     PUT succeeds with 200. When ENABLED, free tier exposes only the slowest
 *     cadences and a disallowed cadence PUT -> 400 "Cadence '<c>' is not allowed
 *     by your subscription plan". Tests assert env-adaptively: a disallowed-cadence
 *     PUT is `200 (gating off)` OR `400 with that message (gating on)` — never 5xx.
 *
 *   PUT /api/works/:id/source-validation  body { enabled:boolean, cadence?:Cadence }
 *     (requires ensureCanEdit; UpdateSourceValidationDto)
 *     enable weekly  -> 200, cadence:'weekly',  nextRunAt ~= now + 7d
 *     enable monthly -> 200, cadence:'monthly', nextRunAt ~= now + 30d (and > weekly's)
 *     enable on a PRISTINE work with NO cadence -> 200 { cadence:null, nextRunAt:null }
 *       (the service only computes nextRunAt when BOTH enabled AND a cadence exist;
 *        it does NOT silently default a cadence).
 *     disable -> 200, enabled:false, nextRunAt:null, cadence RETAINED (sticky).
 *     re-enable with NO cadence AFTER a sticky cadence -> 200, reuses the sticky
 *       cadence and recomputes nextRunAt.
 *     invalid cadence enum -> 400 ["cadence must be one of the following values: ..."]
 *     missing `enabled` -> 400 ["enabled must be a boolean value"]
 *
 *   Access isolation: unauth -> 401; cross-user GET/PUT -> 403
 *     {status:'error', message:'You do not have permission to access this work'};
 *     nonexistent id -> 404 "Work with id '...' not found" (existence checked after access).
 *
 *   GET /api/works/:id/items -> { status:'success', items: [] } for a fresh Work.
 *   POST /api/works/:id/check-item-health { item_slug } on a NONEXISTENT slug ->
 *     HTTP 500 (the per-item probe throws when the item can't be loaded). The
 *     scheduled sweep swallows such throws per-work; the single-item endpoint
 *     surfaces it. Asserted as the real (>=500) outcome, not a fictional graceful 200.
 *
 * Cross-spec isolation: ALL mutations run on FRESH registerUserViaAPI() owners
 * with unique Date.now-suffixed names; the seeded user (storageState) is used
 * READ-ONLY in the last flow. login DTO accepts ONLY {email,password}.
 */

const ALL_CADENCES = [
    'hourly',
    'every_3_hours',
    'every_8_hours',
    'every_12_hours',
    'daily',
    'weekly',
    'monthly',
] as const;

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const SV_PATH = (workId: string) => `${API_BASE}/api/works/${workId}/source-validation`;

async function loginSeeded(request: APIRequestContext): Promise<string> {
    // Lazy: read the seeded creds at call time (inside a test), NOT at module load.
    // A module-scope loadSeededTestUser() runs during Playwright COLLECTION — before
    // the setup project writes .auth/test-user.json — and since sharding collects
    // every file in every shard, a collection-time throw here reddens ALL shards.
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.ok()).toBeTruthy();
    return (await res.json()).access_token as string;
}

/** Register a fresh isolated owner + a Work owned by them. */
async function freshOwnerWork(
    request: APIRequestContext,
    label: string,
): Promise<{ token: string; workId: string }> {
    const owner = await registerUserViaAPI(request);
    const { id } = await createWorkViaAPI(request, owner.access_token, {
        name: `SV ${label} ${Date.now().toString(36)}`,
    });
    expect(id, 'created Work should expose an id').toBeTruthy();
    return { token: owner.access_token, workId: id };
}

function approxDaysFromNow(iso: string): number {
    return (new Date(iso).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
}

/** Validate the allowedCadences matrix shape (env-agnostic). */
function assertAllowedCadencesShape(allowedCadences: unknown): void {
    expect(Array.isArray(allowedCadences)).toBe(true);
    const arr = allowedCadences as Array<{ cadence: string; allowed: boolean; payPerUse: boolean }>;
    expect(arr.length).toBeGreaterThan(0);
    for (const a of arr) {
        expect(ALL_CADENCES).toContain(a.cadence as (typeof ALL_CADENCES)[number]);
        expect(typeof a.allowed).toBe('boolean');
        expect(typeof a.payPerUse).toBe('boolean');
    }
}

test.describe('Work source validation', () => {
    test('default settings shape: disabled, no schedule, full cadence matrix', async ({
        request,
    }) => {
        const { token, workId } = await freshOwnerWork(request, 'defaults');

        const res = await request.get(SV_PATH(workId), { headers: authedHeaders(token) });
        expect(res.status()).toBe(200);
        const body = await res.json();

        // A fresh Work has source validation OFF with no computed schedule.
        expect(body.enabled).toBe(false);
        expect(body.cadence).toBeNull();
        expect(body.nextRunAt).toBeNull();
        expect(body.lastRunAt).toBeNull();

        // The cadence matrix is always present and lists EVERY supported cadence
        // (gating only flips the per-row `allowed` flag, never removes rows).
        assertAllowedCadencesShape(body.allowedCadences);
        const cadences = (body.allowedCadences as Array<{ cadence: string }>).map((a) => a.cadence);
        for (const c of ALL_CADENCES) {
            expect(cadences).toContain(c);
        }
    });

    test('enable -> nextRunAt computed from cadence; switching cadence recomputes the schedule', async ({
        request,
    }) => {
        const { token, workId } = await freshOwnerWork(request, 'enable');

        // Enable WEEKLY: nextRunAt should land ~7 days out, no run yet.
        const weeklyRes = await request.put(SV_PATH(workId), {
            headers: authedHeaders(token),
            data: { enabled: true, cadence: 'weekly' },
        });
        expect(weeklyRes.status()).toBe(200);
        const weekly = await weeklyRes.json();
        expect(weekly.enabled).toBe(true);
        expect(weekly.cadence).toBe('weekly');
        expect(weekly.lastRunAt).toBeNull();
        expect(typeof weekly.nextRunAt).toBe('string');
        expect(approxDaysFromNow(weekly.nextRunAt)).toBeGreaterThan(6.5);
        expect(approxDaysFromNow(weekly.nextRunAt)).toBeLessThan(7.5);

        // Switch to MONTHLY: cadence + nextRunAt both move out to ~30 days.
        const monthlyRes = await request.put(SV_PATH(workId), {
            headers: authedHeaders(token),
            data: { enabled: true, cadence: 'monthly' },
        });
        expect(monthlyRes.status()).toBe(200);
        const monthly = await monthlyRes.json();
        expect(monthly.cadence).toBe('monthly');
        expect(approxDaysFromNow(monthly.nextRunAt)).toBeGreaterThan(27);
        expect(approxDaysFromNow(monthly.nextRunAt)).toBeLessThan(32);

        // The new schedule must be strictly later than the weekly one.
        expect(new Date(monthly.nextRunAt).getTime()).toBeGreaterThan(
            new Date(weekly.nextRunAt).getTime(),
        );

        // GET reflects the persisted state (write-then-read coherency).
        const getRes = await request.get(SV_PATH(workId), { headers: authedHeaders(token) });
        expect(getRes.status()).toBe(200);
        const persisted = await getRes.json();
        expect(persisted.enabled).toBe(true);
        expect(persisted.cadence).toBe('monthly');
        expect(persisted.nextRunAt).toBe(monthly.nextRunAt);
    });

    test('disable keeps cadence sticky; re-enabling with no cadence reuses it and recomputes nextRun', async ({
        request,
    }) => {
        const { token, workId } = await freshOwnerWork(request, 'sticky');

        // Establish a weekly cadence + schedule.
        const enable = await request.put(SV_PATH(workId), {
            headers: authedHeaders(token),
            data: { enabled: true, cadence: 'weekly' },
        });
        expect(enable.status()).toBe(200);
        expect((await enable.json()).cadence).toBe('weekly');

        // Disable: schedule is torn down (nextRunAt null) but the cadence stays so
        // the user's prior choice is restored on re-enable.
        const disableRes = await request.put(SV_PATH(workId), {
            headers: authedHeaders(token),
            data: { enabled: false },
        });
        expect(disableRes.status()).toBe(200);
        const disabled = await disableRes.json();
        expect(disabled.enabled).toBe(false);
        expect(disabled.nextRunAt).toBeNull();
        expect(disabled.cadence).toBe('weekly'); // sticky

        // A fresh GET confirms the disabled-but-sticky persisted state.
        const afterDisable = await request.get(SV_PATH(workId), { headers: authedHeaders(token) });
        expect((await afterDisable.json()).cadence).toBe('weekly');

        // Re-enable with NO cadence in the body: the service falls back to the
        // sticky cadence and recomputes nextRunAt (~7d for weekly).
        const reEnable = await request.put(SV_PATH(workId), {
            headers: authedHeaders(token),
            data: { enabled: true },
        });
        expect(reEnable.status()).toBe(200);
        const reEnabled = await reEnable.json();
        expect(reEnabled.enabled).toBe(true);
        expect(reEnabled.cadence).toBe('weekly');
        expect(typeof reEnabled.nextRunAt).toBe('string');
        expect(approxDaysFromNow(reEnabled.nextRunAt)).toBeGreaterThan(6.5);
        expect(approxDaysFromNow(reEnabled.nextRunAt)).toBeLessThan(7.5);
    });

    test('enabling a PRISTINE work without a cadence does NOT auto-schedule (no silent default)', async ({
        request,
    }) => {
        const { token, workId } = await freshOwnerWork(request, 'pristine');

        // enabled:true but the work has never had a cadence -> cadence stays null
        // and nextRunAt is NOT computed (the sweep would skip it as "missing
        // prerequisites"). This documents that the API does not invent a cadence.
        const res = await request.put(SV_PATH(workId), {
            headers: authedHeaders(token),
            data: { enabled: true },
        });
        expect(res.status()).toBe(200);
        const body = await res.json();
        expect(body.enabled).toBe(true);
        expect(body.cadence).toBeNull();
        expect(body.nextRunAt).toBeNull();

        // Now supply a cadence: nextRunAt is computed and the work becomes a real
        // sweep candidate.
        const withCadence = await request.put(SV_PATH(workId), {
            headers: authedHeaders(token),
            data: { enabled: true, cadence: 'daily' },
        });
        expect(withCadence.status()).toBe(200);
        const withCadenceBody = await withCadence.json();
        expect(withCadenceBody.cadence).toBe('daily');
        expect(typeof withCadenceBody.nextRunAt).toBe('string');
        expect(approxDaysFromNow(withCadenceBody.nextRunAt)).toBeGreaterThan(0.5);
        expect(approxDaysFromNow(withCadenceBody.nextRunAt)).toBeLessThan(1.5);
    });

    test('cadence subscription gating is environment-adaptive across every cadence', async ({
        request,
    }) => {
        const { token, workId } = await freshOwnerWork(request, 'gating');

        // Read which cadences the current plan/env reports as allowed.
        const settings = await (
            await request.get(SV_PATH(workId), { headers: authedHeaders(token) })
        ).json();
        assertAllowedCadencesShape(settings.allowedCadences);
        const allowedMap = new Map<string, boolean>(
            (settings.allowedCadences as Array<{ cadence: string; allowed: boolean }>).map((a) => [
                a.cadence,
                a.allowed,
            ]),
        );

        // PUT every cadence: an ALLOWED cadence must persist with a computed
        // schedule; a DISALLOWED cadence must be rejected with a 400 + the gating
        // message (and never 5xx). In CI subscriptions are off so all are allowed.
        for (const cadence of ALL_CADENCES) {
            const res = await request.put(SV_PATH(workId), {
                headers: authedHeaders(token),
                data: { enabled: true, cadence },
            });
            expect(res.status(), `PUT cadence=${cadence} must never 5xx`).toBeLessThan(500);

            const isAllowed = allowedMap.get(cadence) ?? true;
            if (res.status() === 200) {
                const body = await res.json();
                expect(body.cadence).toBe(cadence);
                expect(body.enabled).toBe(true);
                expect(typeof body.nextRunAt).toBe('string');
            } else {
                // The only non-200, non-5xx outcome for a valid-enum cadence is the
                // subscription-gating 400.
                expect(res.status()).toBe(400);
                expect(isAllowed).toBe(false);
                const msg = JSON.stringify(await res.json()).toLowerCase();
                expect(msg).toContain('not allowed');
            }
        }

        // Whatever the env, the work must still be in a coherent enabled state
        // using one of the cadences that succeeded.
        const final = await request.get(SV_PATH(workId), { headers: authedHeaders(token) });
        expect(final.status()).toBe(200);
        const finalBody = await final.json();
        expect(finalBody.enabled).toBe(true);
        expect(ALL_CADENCES).toContain(finalBody.cadence as (typeof ALL_CADENCES)[number]);
    });

    test('body validation + access isolation (bad DTO 400, unauth 401, cross-user 403, bogus id 404)', async ({
        request,
    }) => {
        const { token, workId } = await freshOwnerWork(request, 'isolation');

        // --- DTO validation (ValidationPipe whitelist + enum) ---
        const badEnum = await request.put(SV_PATH(workId), {
            headers: authedHeaders(token),
            data: { enabled: true, cadence: 'yearly' },
        });
        expect(badEnum.status()).toBe(400);
        expect(JSON.stringify(await badEnum.json()).toLowerCase()).toContain('cadence');

        const missingEnabled = await request.put(SV_PATH(workId), {
            headers: authedHeaders(token),
            data: { cadence: 'weekly' },
        });
        expect(missingEnabled.status()).toBe(400);
        expect(JSON.stringify(await missingEnabled.json()).toLowerCase()).toContain('enabled');

        // --- unauthenticated (empty bearer) ---
        const anon = await request.get(SV_PATH(workId), { headers: { Authorization: 'Bearer ' } });
        expect(anon.status()).toBe(401);

        // --- cross-user: a different registered user is forbidden (403, not a leak) ---
        const stranger = await registerUserViaAPI(request);
        const strangerGet = await request.get(SV_PATH(workId), {
            headers: authedHeaders(stranger.access_token),
        });
        expect(strangerGet.status()).toBe(403);
        expect(JSON.stringify(await strangerGet.json()).toLowerCase()).toContain('permission');

        const strangerPut = await request.put(SV_PATH(workId), {
            headers: authedHeaders(stranger.access_token),
            data: { enabled: true, cadence: 'weekly' },
        });
        expect(strangerPut.status()).toBe(403);

        // --- bogus (well-formed) work id: access check passes for any authed user
        //     then existence check fails -> 404. ---
        const bogus = await request.get(SV_PATH(ZERO_UUID), { headers: authedHeaders(token) });
        expect(bogus.status()).toBe(404);

        // Owner state is untouched by all the failed/cross-user calls.
        const ownerState = await request.get(SV_PATH(workId), { headers: authedHeaders(token) });
        expect(ownerState.status()).toBe(200);
        const owner = await ownerState.json();
        expect(owner.enabled).toBe(false);
        expect(owner.cadence).toBeNull();
        expect(owner.nextRunAt).toBeNull();
    });

    test('interaction with items + the manual single-item health probe', async ({ request }) => {
        const { token, workId } = await freshOwnerWork(request, 'items');

        // A brand-new Work's item list is empty (git-backed; no push in CI).
        const itemsRes = await request.get(`${API_BASE}/api/works/${workId}/items`, {
            headers: authedHeaders(token),
            timeout: 60_000,
        });
        expect(itemsRes.status()).toBe(200);
        const itemsBody = await itemsRes.json();
        expect(Array.isArray(itemsBody.items)).toBe(true);
        expect(itemsBody.items.length).toBe(0);

        // Enable source validation so the work is a real sweep candidate.
        const enableRes = await request.put(SV_PATH(workId), {
            headers: authedHeaders(token),
            data: { enabled: true, cadence: 'weekly' },
        });
        expect(enableRes.status()).toBe(200);
        expect((await enableRes.json()).enabled).toBe(true);

        // The manual single-item health check is the same probe the scheduled
        // sweep runs per item. For a slug that does not exist the per-item path
        // THROWS -> the endpoint surfaces a 5xx (the cron sweep, by contrast,
        // swallows per-work errors and just leaves the row "due"). We assert the
        // REAL behaviour (probed live), not a fictional graceful envelope.
        const ghostSlug = `ghost-${Date.now().toString(36)}`;
        const healthRes = await request.post(`${API_BASE}/api/works/${workId}/check-item-health`, {
            headers: authedHeaders(token),
            data: { item_slug: ghostSlug },
            timeout: 60_000,
        });
        // Either a structured failure (>=500) or — if the implementation later
        // hardens to a graceful envelope — a <500 error status. Both are accepted;
        // a silent success on a nonexistent slug would be the bug.
        if (healthRes.status() < 500) {
            const health = await healthRes.json();
            expect(health.status).not.toBe('success');
        } else {
            expect(healthRes.status()).toBeGreaterThanOrEqual(500);
        }

        // Source-validation settings survive the (failed) health-check round-trip:
        // still enabled, still scheduled, schedule unchanged.
        const after = await request.get(SV_PATH(workId), { headers: authedHeaders(token) });
        expect(after.status()).toBe(200);
        const state = await after.json();
        expect(state.enabled).toBe(true);
        expect(state.cadence).toBe('weekly');
        expect(typeof state.nextRunAt).toBe('string');
        // No run has occurred via the manual probe, so lastRunAt is still null.
        expect(state.lastRunAt).toBeNull();
    });

    test('seeded user (storageState owner) reads source-validation for their own Work', async ({
        request,
    }) => {
        // Read-only assertions on the SEEDED user. We create a throwaway Work for
        // them and validate the GET contract — no destructive mutation of any
        // pre-existing seeded Work, no cross-spec interference.
        const token = await loginSeeded(request);
        const { id } = await createWorkViaAPI(request, token, {
            name: `SV seeded read ${Date.now().toString(36)}`,
        });
        expect(id).toBeTruthy();

        const res = await request.get(SV_PATH(id), { headers: authedHeaders(token) });
        expect(res.status()).toBe(200);
        const body = await res.json();

        // Same shape contract holds for the seeded user.
        expect(typeof body.enabled).toBe('boolean');
        expect(body.cadence === null || typeof body.cadence === 'string').toBe(true);
        expect(body.nextRunAt === null || typeof body.nextRunAt === 'string').toBe(true);
        expect(body.lastRunAt === null || typeof body.lastRunAt === 'string').toBe(true);
        assertAllowedCadencesShape(body.allowedCadences);
    });
});
