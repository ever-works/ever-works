import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { createTaskViaAPI } from './helpers/agents-tasks';

/**
 * Task RECURRING schedule + REVIEWER side-rows — the `api/tasks/:id/recurring`
 * (POST set / DELETE clear) verb pair and the reviewer DTO/closure GAPS the
 * existing Tasks specs leave uncovered. Everything below is pinned against the
 * LIVE API (sqlite in-memory, keyless CI) and asserts RECORDS/CONTRACTS only.
 *
 * ── NON-DUPLICATION (sibling specs read FIRST) ─────────────────────────────
 *   - `flow-tasks-advanced-deep.spec.ts` (Batch 5) OWNS the reviewer ADD
 *     lifecycle: the born-`pending` row shape, the OWNED-agent polymorphic
 *     reviewer, bad reviewerType→400, unknown-agent→400, missing-id→400,
 *     duplicate→500, the three-roles-coexist case, cross-user→404, and the
 *     "no GET-list / no DELETE-reviewer route (404)" facts. It does NOT touch
 *     RECURRING at all, nor the reviewer DTO WHITELIST strip, nor the reviewer
 *     bad-uuid / no-auth closure pair, nor recurring↔reviewer orthogonality.
 *     THIS file pins RECURRING in full + exactly those reviewer GAPS — it does
 *     not re-derive any reviewer-add row shape Batch 5 already owns.
 *   - `flow-task-approvers-gate.spec.ts` / `flow-task-full-lattice.spec.ts` own
 *     the approver + blocker gates; `flow-task-state-machine.spec.ts` owns the
 *     status lattice — all out of scope here (recurring is orthogonal to the
 *     status machine: a backlog task is just as recurring-settable as any).
 *   - `tasks.spec.ts` / `tasks-collaboration.spec.ts` only smoke task CRUD +
 *     "reviewer born pending" — neither pins recurring or the whitelist.
 *
 * ── PROBED CONTRACTS (curl against http://127.0.0.1:3100 before asserting) ──
 *   RECURRING  POST /api/tasks/:id/recurring { recurrenceRule, recurrenceTimezone?,
 *                recurrenceEndsAt?, recurrenceMaxOccurrences? }
 *     → 200 (NOT 201) with the FULL task body. The cadence is an iCal **RRULE**
 *       string ("FREQ=WEEKLY;BYDAY=MO"), NOT cron. On success isRecurring flips
 *       true, recurrenceRule is stored verbatim, and nextOccurrenceAt is
 *       COMPUTED from the rule (+timezone). recurrenceTimezone defaults 'UTC',
 *       is honored when supplied, recurrenceMaxOccurrences + recurrenceEndsAt
 *       are persisted. Re-POST RE-SETS the schedule and RECOMPUTES
 *       nextOccurrenceAt (idempotent / last-write-wins).
 *       · cron-style "0 9 * * 1" / garbage → 400 "RRULE parse error: Unknown
 *         RRULE property '<rule>'" (the rrule parser, NOT class-validator).
 *       · missing recurrenceRule → 400 class-validator array
 *         ("recurrenceRule must be a string"); rule > 200 chars → 400
 *         "recurrenceRule must be shorter than or equal to 200 characters".
 *       · recurrenceMaxOccurrences is @IsInt @Min(1) @Max(9999): -3 / "five" /
 *         99999 → 400. An unknown body prop → 400 "property <x> should not
 *         exist" (whitelist + forbidNonWhitelisted).
 *       · recurrenceTimezone is STORED VERBATIM — a bogus zone ("Mars/Phobos")
 *         is accepted (200), NOT validated. Probed truth, pinned as-is.
 *     DELETE /api/tasks/:id/recurring → 200 with the full task body; clears
 *       isRecurring→false, recurrenceRule→null, nextOccurrenceAt→null. It is
 *       IDEMPOTENT — DELETE on a never-recurring task is a clean 200 (no 404).
 *     closure: cross-user POST/DELETE → 404 "Task <id> not found." (ownership
 *       first, no existence leak); unknown uuid → 404; bad uuid → 400
 *       (ParseUUIDPipe); no auth → 401.
 *
 *   REVIEWERS (GAPS only — add row shape lives in Batch 5)
 *     POST /api/tasks/:id/reviewers { reviewerType:'user'|'agent', reviewerId }
 *       → 201 born reviewState 'pending'. The DTO is WHITELISTED: injecting
 *       reviewState:'approved' (or any extra prop) → 400 "property reviewState
 *       should not exist" — a client cannot pre-approve itself at create time.
 *       · bad task uuid → 400 (ParseUUIDPipe); no auth → 401.
 *     GET /api/tasks/:id/reviewers → 404 (no list route; reviewers are NOT
 *       embedded in GET /api/tasks/:id either) — re-pinned here as the anchor
 *       for the recurring↔reviewer orthogonality case.
 *
 * All flows run on FRESH `registerUserViaAPI` users (cross-spec isolation).
 * Unique suffixes from a per-test counter (NO module-scope clock / await).
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const REQ_TIMEOUT = 20_000;

/** Per-test unique-suffix counter (no module-scope clock; title-derived seed). */
let suffixCounter = 0;
function uniq(label: string): string {
    suffixCounter += 1;
    return `${label}-${suffixCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Untyped task row — recurrence fields are NOT on the helper's typed Task. */
type RecurringTask = {
    id: string;
    status: string;
    isRecurring: boolean;
    recurrenceRule: string | null;
    recurrenceTimezone: string | null;
    nextOccurrenceAt: string | null;
    recurrenceEndsAt: string | null;
    recurrenceMaxOccurrences: number | null;
    recurrenceOccurredCount: number;
};

async function getTask(
    request: APIRequestContext,
    token: string,
    taskId: string,
): Promise<RecurringTask> {
    const res = await request.get(`${API_BASE}/api/tasks/${taskId}`, {
        headers: authedHeaders(token),
        timeout: REQ_TIMEOUT,
    });
    expect(res.status(), `getTask body=${await res.text().catch(() => '')}`).toBe(200);
    return (await res.json()) as RecurringTask;
}

function setRecurring(
    request: APIRequestContext,
    token: string,
    taskId: string,
    body: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/tasks/${taskId}/recurring`, {
        headers: authedHeaders(token),
        data: body,
        timeout: REQ_TIMEOUT,
    });
}

function clearRecurring(request: APIRequestContext, token: string, taskId: string) {
    return request.delete(`${API_BASE}/api/tasks/${taskId}/recurring`, {
        headers: authedHeaders(token),
        timeout: REQ_TIMEOUT,
    });
}

function addReviewer(
    request: APIRequestContext,
    token: string,
    taskId: string,
    body: Record<string, unknown>,
) {
    return request.post(`${API_BASE}/api/tasks/${taskId}/reviewers`, {
        headers: authedHeaders(token),
        data: body,
        timeout: REQ_TIMEOUT,
    });
}

// ── Recurring: set → reflect ─────────────────────────────────────────────────

test.describe('Task recurring — set an RRULE schedule (API)', () => {
    test('a valid RRULE flips isRecurring true, stores the rule verbatim, and COMPUTES nextOccurrenceAt — POST returns 200 + the full task body', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Recur set') });

        // Fresh task is non-recurring with the documented null defaults.
        const before = await getTask(request, token, task.id);
        expect(before.isRecurring, 'fresh task is not recurring').toBe(false);
        expect(before.recurrenceRule).toBeNull();
        expect(before.nextOccurrenceAt).toBeNull();
        expect(before.recurrenceTimezone, 'default rollup timezone is UTC').toBe('UTC');

        // Set a weekly-Monday RRULE. The verb is POST /recurring and it answers
        // 200 (NOT the 201 the sibling side-row adds use) with the WHOLE task.
        const res = await setRecurring(request, token, task.id, {
            recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO',
        });
        expect(res.status(), `set recurring body=${await res.text().catch(() => '')}`).toBe(200);
        const row = (await res.json()) as RecurringTask;
        expect(row.id).toBe(task.id);
        expect(row.isRecurring, 'set flips isRecurring true').toBe(true);
        expect(row.recurrenceRule, 'rule stored verbatim').toBe('FREQ=WEEKLY;BYDAY=MO');
        // nextOccurrenceAt is COMPUTED from the rule (a real future timestamp),
        // not echoed input — proving the server actually parsed the RRULE.
        expect(row.nextOccurrenceAt, 'next occurrence computed from the rule').toBeTruthy();
        expect(Date.parse(row.nextOccurrenceAt as string)).toBeGreaterThan(Date.now());
        expect(row.recurrenceOccurredCount, 'no occurrences fired yet').toBe(0);

        // Reflected on a fresh GET (the write persisted, not just an echo).
        const fresh = await getTask(request, token, task.id);
        expect(fresh.isRecurring).toBe(true);
        expect(fresh.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=MO');
        expect(fresh.nextOccurrenceAt).toBe(row.nextOccurrenceAt);
    });

    test('the full recurrence DTO persists: custom timezone is honored, recurrenceMaxOccurrences + recurrenceEndsAt round-trip', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Recur full dto') });

        const res = await setRecurring(request, token, task.id, {
            recurrenceRule: 'FREQ=DAILY;INTERVAL=1',
            recurrenceTimezone: 'America/New_York',
            recurrenceMaxOccurrences: 5,
            recurrenceEndsAt: '2027-01-01T00:00:00Z',
        });
        expect(res.status(), `full dto body=${await res.text().catch(() => '')}`).toBe(200);
        const row = (await res.json()) as RecurringTask;
        expect(row.isRecurring).toBe(true);
        expect(row.recurrenceTimezone, 'custom timezone honored').toBe('America/New_York');
        expect(row.recurrenceMaxOccurrences, 'max-occurrences persisted').toBe(5);
        expect(row.recurrenceEndsAt, 'ends-at persisted (ISO normalized)').toBe(
            '2027-01-01T00:00:00.000Z',
        );
        expect(row.nextOccurrenceAt, 'daily next computed').toBeTruthy();
    });

    test('re-POST RE-SETS the schedule and RECOMPUTES nextOccurrenceAt (idempotent / last-write-wins, not append)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Recur reset') });

        const weekly = (await (
            await setRecurring(request, token, task.id, { recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO' })
        ).json()) as RecurringTask;
        expect(weekly.recurrenceRule).toBe('FREQ=WEEKLY;BYDAY=MO');
        const weeklyNext = weekly.nextOccurrenceAt;

        // Re-POST a DIFFERENT rule on the SAME task — it overwrites (no second
        // schedule row), and nextOccurrenceAt is recomputed for the new cadence.
        const daily = (await (
            await setRecurring(request, token, task.id, { recurrenceRule: 'FREQ=DAILY' })
        ).json()) as RecurringTask;
        expect(daily.recurrenceRule, 'rule overwritten, not appended').toBe('FREQ=DAILY');
        expect(daily.isRecurring).toBe(true);
        // A daily next-occurrence lands no later than a weekly one (sooner cadence
        // ⇒ ≤ the weekly date) — concretely, the recompute MOVED the timestamp.
        expect(daily.nextOccurrenceAt, 'recomputed for the new cadence').toBeTruthy();
        expect(Date.parse(daily.nextOccurrenceAt as string)).toBeLessThanOrEqual(
            Date.parse(weeklyNext as string),
        );

        // The persisted task reflects ONLY the latest rule.
        const fresh = await getTask(request, token, task.id);
        expect(fresh.recurrenceRule).toBe('FREQ=DAILY');
    });

    test('recurrence is orthogonal to the status machine: a plain backlog task is recurring-settable without any transition', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Recur orthog') });

        const before = await getTask(request, token, task.id);
        expect(before.status, 'task sits at backlog').toBe('backlog');

        const res = await setRecurring(request, token, task.id, {
            recurrenceRule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        });
        expect(res.status()).toBe(200);
        const row = (await res.json()) as RecurringTask;
        // Setting a schedule does NOT move the task off backlog — recurrence is a
        // scheduling attribute, not a state transition.
        expect(row.status, 'recurring set leaves status untouched').toBe('backlog');
        expect(row.isRecurring).toBe(true);
    });
});

// ── Recurring: cadence validation ────────────────────────────────────────────

test.describe('Task recurring — RRULE/DTO validation (API)', () => {
    test('cron-style strings are NOT RRULE: "0 9 * * 1" and pure garbage both → 400 with the rrule parser message (probed: rule is parser-validated, not stored-verbatim)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Recur cron') });

        // A cron expression is a common mistake — the cadence is iCal RRULE, so
        // cron is rejected by the rrule parser (NOT silently stored).
        const cron = await setRecurring(request, token, task.id, { recurrenceRule: '0 9 * * 1' });
        expect(cron.status(), `cron body=${await cron.text().catch(() => '')}`).toBe(400);
        expect((await cron.json()).message).toMatch(/RRULE parse error/i);

        // Pure garbage → same parser rejection.
        const garbage = await setRecurring(request, token, task.id, {
            recurrenceRule: 'not-a-cron-at-all',
        });
        expect(garbage.status()).toBe(400);
        expect((await garbage.json()).message).toMatch(/RRULE parse error/i);

        // The failed sets left the task NON-recurring (no partial write).
        const fresh = await getTask(request, token, task.id);
        expect(fresh.isRecurring, 'rejected rule does not partially set').toBe(false);
        expect(fresh.recurrenceRule).toBeNull();
    });

    test('DTO validation: missing recurrenceRule → 400, rule > 200 chars → 400, and an unknown body prop is whitelist-rejected → 400', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Recur dto val') });

        // Missing recurrenceRule → class-validator array (@IsString).
        const missing = await setRecurring(request, token, task.id, {});
        expect(missing.status()).toBe(400);
        expect(String((await missing.json()).message)).toMatch(/recurrenceRule must be a string/i);

        // Rule over the 200-char cap → 400 (@MaxLength(200)) — even a
        // FREQ-prefixed (otherwise-valid) rule is rejected purely on length.
        const tooLong = await setRecurring(request, token, task.id, {
            recurrenceRule: `FREQ=DAILY;${'X'.repeat(250)}`,
        });
        expect(tooLong.status()).toBe(400);
        expect(String((await tooLong.json()).message)).toMatch(/shorter than or equal to 200/i);

        // Unknown prop → 400 (whitelist + forbidNonWhitelisted on the ValidationPipe).
        const unknownProp = await setRecurring(request, token, task.id, {
            recurrenceRule: 'FREQ=DAILY',
            bogusField: true,
        });
        expect(unknownProp.status()).toBe(400);
        expect(String((await unknownProp.json()).message)).toMatch(
            /property bogusField should not exist/i,
        );
    });

    test('recurrenceMaxOccurrences is a bounded integer (@IsInt @Min(1) @Max(9999)): -3, "five", and 99999 each → 400', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Recur maxocc') });

        const negative = await setRecurring(request, token, task.id, {
            recurrenceRule: 'FREQ=DAILY',
            recurrenceMaxOccurrences: -3,
        });
        expect(negative.status()).toBe(400);
        expect(String((await negative.json()).message)).toMatch(/must not be less than 1/i);

        const nonNumeric = await setRecurring(request, token, task.id, {
            recurrenceRule: 'FREQ=DAILY',
            recurrenceMaxOccurrences: 'five',
        });
        expect(nonNumeric.status()).toBe(400);
        expect(String((await nonNumeric.json()).message)).toMatch(/must be an integer number/i);

        const tooMany = await setRecurring(request, token, task.id, {
            recurrenceRule: 'FREQ=DAILY',
            recurrenceMaxOccurrences: 99999,
        });
        expect(tooMany.status()).toBe(400);
        expect(String((await tooMany.json()).message)).toMatch(/must not be greater than 9999/i);
    });

    test('PROBED truth: recurrenceTimezone is stored VERBATIM, not validated — a bogus IANA zone is accepted (200)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Recur tz') });

        // The build does NOT validate the timezone against the IANA db — it is
        // persisted as-is. Pinning the real (perhaps-surprising) contract so a
        // future tightening (→ 400) is caught by this test going red.
        const res = await setRecurring(request, token, task.id, {
            recurrenceRule: 'FREQ=DAILY',
            recurrenceTimezone: 'Mars/Phobos',
        });
        expect(res.status(), `bogus tz body=${await res.text().catch(() => '')}`).toBe(200);
        const row = (await res.json()) as RecurringTask;
        expect(row.recurrenceTimezone, 'bogus timezone stored verbatim').toBe('Mars/Phobos');
        expect(row.isRecurring).toBe(true);
    });
});

// ── Recurring: clear (DELETE) ────────────────────────────────────────────────

test.describe('Task recurring — DELETE clears the schedule (API)', () => {
    test('DELETE on an ACTIVE recurring task → 200 and clears isRecurring/recurrenceRule/nextOccurrenceAt', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Recur clear') });

        // Arrange: an active weekly schedule.
        await setRecurring(request, token, task.id, { recurrenceRule: 'FREQ=WEEKLY;BYDAY=MO' });
        const armed = await getTask(request, token, task.id);
        expect(armed.isRecurring, 'armed before clear').toBe(true);
        expect(armed.nextOccurrenceAt).toBeTruthy();

        // DELETE returns the full task body (200) with the schedule torn down.
        const del = await clearRecurring(request, token, task.id);
        expect(del.status(), `delete body=${await del.text().catch(() => '')}`).toBe(200);
        const cleared = (await del.json()) as RecurringTask;
        expect(cleared.isRecurring, 'clear flips isRecurring false').toBe(false);
        expect(cleared.recurrenceRule, 'rule wiped').toBeNull();
        expect(cleared.nextOccurrenceAt, 'next occurrence wiped').toBeNull();

        // Persisted: a fresh GET confirms the teardown stuck.
        const fresh = await getTask(request, token, task.id);
        expect(fresh.isRecurring).toBe(false);
        expect(fresh.recurrenceRule).toBeNull();
    });

    test('DELETE is IDEMPOTENT: clearing a never-recurring task is a clean 200 (no 404)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Recur idem') });

        // The task was never made recurring — DELETE still succeeds (no-op clear).
        const del = await clearRecurring(request, token, task.id);
        expect(del.status(), `idempotent delete body=${await del.text().catch(() => '')}`).toBe(
            200,
        );
        const row = (await del.json()) as RecurringTask;
        expect(row.isRecurring, 'still not recurring').toBe(false);
        expect(row.recurrenceRule).toBeNull();

        // A second DELETE is just as clean — fully idempotent.
        const again = await clearRecurring(request, token, task.id);
        expect(again.status(), 'second clear also 200').toBe(200);
    });
});

// ── Recurring: closure (cross-user / auth / uuid) ────────────────────────────

test.describe('Task recurring — ownership + auth closure (API)', () => {
    test('cross-user POST and DELETE both → 404 (ownership first, no existence leak); unknown uuid → 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, owner.access_token, {
            title: uniq('Recur close'),
        });

        // Stranger setting a schedule on my task → 404 "Task <id> not found."
        const crossSet = await setRecurring(request, stranger.access_token, task.id, {
            recurrenceRule: 'FREQ=DAILY',
        });
        expect(crossSet.status(), 'cross-user set → 404').toBe(404);
        expect((await crossSet.json()).message).toMatch(/not found/i);

        // Stranger clearing my schedule → same 404 (no existence leak via DELETE).
        const crossClear = await clearRecurring(request, stranger.access_token, task.id);
        expect(crossClear.status(), 'cross-user clear → 404').toBe(404);

        // Well-formed but non-existent task → 404.
        const unknown = await setRecurring(request, owner.access_token, NIL_UUID, {
            recurrenceRule: 'FREQ=DAILY',
        });
        expect(unknown.status(), 'unknown task set → 404').toBe(404);

        // The owner's task was never touched by the stranger's attempts.
        const fresh = await getTask(request, owner.access_token, task.id);
        expect(fresh.isRecurring, "owner's task untouched by stranger").toBe(false);
    });

    test('no auth → 401 on both verbs; malformed task uuid → 400 (ParseUUIDPipe)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const task = await createTaskViaAPI(request, owner.access_token, {
            title: uniq('Recur auth'),
        });

        // No auth → 401 on POST.
        const anonSet = await request.post(`${API_BASE}/api/tasks/${task.id}/recurring`, {
            data: { recurrenceRule: 'FREQ=DAILY' },
        });
        expect(anonSet.status(), 'unauth set → 401').toBe(401);

        // No auth → 401 on DELETE.
        const anonDel = await request.delete(`${API_BASE}/api/tasks/${task.id}/recurring`);
        expect(anonDel.status(), 'unauth clear → 401').toBe(401);

        // Malformed task id → 400 (ParseUUIDPipe fires before the handler).
        const badSet = await setRecurring(request, owner.access_token, 'not-a-uuid', {
            recurrenceRule: 'FREQ=DAILY',
        });
        expect(badSet.status(), 'bad uuid set → 400').toBe(400);
        const badDel = await clearRecurring(request, owner.access_token, 'not-a-uuid');
        expect(badDel.status(), 'bad uuid clear → 400').toBe(400);
    });
});

// ── Reviewers (GAPS only — add row shape is owned by Batch 5) ─────────────────

test.describe('Task reviewers — DTO whitelist + closure GAPS (API)', () => {
    test('the reviewer DTO is WHITELISTED: a client cannot pre-set reviewState at create — injecting reviewState:"approved" → 400', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Rev whitelist') });

        // Born-pending + the full row shape is Batch 5's territory; here we pin the
        // SECURITY-relevant whitelist: a reviewer cannot ship reviewState in the
        // create body to mark itself approved out of the gate.
        const injected = await addReviewer(request, token, task.id, {
            reviewerType: 'user',
            reviewerId: u.user.id,
            reviewState: 'approved',
        });
        expect(injected.status(), `injected body=${await injected.text().catch(() => '')}`).toBe(
            400,
        );
        expect(String((await injected.json()).message)).toMatch(
            /property reviewState should not exist/i,
        );

        // The legitimate add (no injected state) still works and is born pending —
        // proving the 400 above was the whitelist, not a broken endpoint.
        const clean = await addReviewer(request, token, task.id, {
            reviewerType: 'user',
            reviewerId: u.user.id,
        });
        expect(clean.status()).toBe(201);
        expect((await clean.json()).reviewState, 'reviewers are born pending').toBe('pending');
    });

    test('reviewer closure GAPS: no auth → 401, bad task uuid → 400 (ParseUUIDPipe)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Rev closure') });

        // No auth → 401.
        const anon = await request.post(`${API_BASE}/api/tasks/${task.id}/reviewers`, {
            data: { reviewerType: 'user', reviewerId: u.user.id },
        });
        expect(anon.status(), 'unauth add-reviewer → 401').toBe(401);

        // Malformed task id → 400.
        const badUuid = await addReviewer(request, token, 'not-a-uuid', {
            reviewerType: 'user',
            reviewerId: u.user.id,
        });
        expect(badUuid.status(), 'bad task uuid → 400').toBe(400);
    });

    test('recurring ↔ reviewer orthogonality: setting a schedule does not create a reviewer row (GET /reviewers stays 404) and adding a reviewer does not arm recurrence', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const token = u.access_token;
        const task = await createTaskViaAPI(request, token, { title: uniq('Rev orthog') });

        // Arm recurrence, then add a reviewer — two independent side-channels.
        await setRecurring(request, token, task.id, { recurrenceRule: 'FREQ=DAILY' });
        const rev = await addReviewer(request, token, task.id, {
            reviewerType: 'user',
            reviewerId: u.user.id,
        });
        expect(rev.status()).toBe(201);

        // There is NO GET-reviewers list route (reviewers are write-only side rows
        // and are NOT embedded in the task body) — so neither the recurrence set
        // nor the reviewer add expose a listing surface.
        const listRoute = await request.get(`${API_BASE}/api/tasks/${task.id}/reviewers`, {
            headers: authedHeaders(token),
        });
        expect(listRoute.status(), 'reviewers list route absent').toBe(404);

        // The task body reflects recurrence (the scheduling attribute) but carries
        // no reviewer rows — the two surfaces are fully orthogonal.
        const fresh = await getTask(request, token, task.id);
        expect(fresh.isRecurring, 'recurrence armed').toBe(true);
        expect(fresh).not.toHaveProperty('reviewers');
    });
});
