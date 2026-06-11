import { test, expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * sec-pin-dto-bounds — pins the security Wave M (EW-722 #36/#143/#165)
 * DTO BOUNDS contracts with exact, live-probed assertions so a future
 * refactor cannot silently drop a MaxLength/ArrayMaxSize/cardinality cap.
 *
 * ── NON-DUPLICATION ──────────────────────────────────────────────────────────
 *   - flow-work-items-crud-deep.spec.ts pins the submit-item PRESENCE/TYPE
 *     matrix (IsNotEmpty / IsUrl / category-vs-categories ValidateIf) and the
 *     git-gate-vs-validation ordering — but NONE of the MaxLength /
 *     ArrayMaxSize bounds added by security Wave M. This file pins ONLY the
 *     length/cardinality caps (over-bound 400 + boundary-exact accept).
 *   - flow-onboarding-catalog-choices.spec.ts + flow-onboarding-wizard-deep
 *     .spec.ts already pin onboarding state.prompt: short prompt → 200 and
 *     5001 chars → 400 ("prompt must be shorter than or equal to 5000
 *     characters"). The GAP pinned here is the BOUNDARY-EXACT case only:
 *     a prompt of exactly 5000 chars is accepted AND persists verbatim.
 *   - flow-notifications-preferences / flow-notifications-per-event /
 *     flow-notification-email-channel pin event-key validity, channel
 *     ownership and delivery scoping for SMALL channelIds lists — none pins
 *     the 20-unique-ids cardinality cap (or its dedupe-before-cap semantics).
 *
 * ── PROBED CONTRACTS (live against http://127.0.0.1:3100, 2026-06-11) ───────
 *  POST /api/works/:id/submit-item  (SubmitItemDto, owner, non-git work)
 *    A *validation* 400 carries a `message` ARRAY + error:'Bad Request';
 *    a DTO-VALID body instead reaches the GIT GATE → 400 with a `message`
 *    STRING envelope { status:'error', slug, item_name, message:'Please
 *    reconnect your Git account to continue.' } — used throughout as the
 *    "passed DTO validation" discriminator for boundary-exact values.
 *      name        201 chars → ["name must be shorter than or equal to 200 characters"]
 *      name        200 chars → git gate (item_name echoes the full 200 chars)
 *      description 5001      → ["description must be shorter than or equal to 5000 characters"]
 *      description 5000      → git gate
 *      category    201       → ["category must be shorter than or equal to 200 characters"]
 *      category    200       → git gate
 *      categories  [201]     → ["each value in categories must be shorter than or equal to 200 characters"]
 *      tags        ['x'*51]  → ["each value in tags must be shorter than or equal to 50 characters"]
 *      tags        ['x'*50]  → git gate
 *      tags        51 items  → ["tags must contain no more than 50 elements"]
 *      tags        50 items  → git gate
 *      name+description+tags all over-bound at once → ONE 400 whose message
 *      array contains all three strings (ValidationPipe aggregates).
 *  PATCH /api/onboarding/state { state: { prompt: 'p'.repeat(5000) } }
 *      → 200; response state.prompt has length 5000 and an independent
 *      GET /api/onboarding/state round-trips it verbatim.
 *  PUT /api/notifications/preferences/event/agent_run_finished { channelIds }
 *      21 unique ids → 400 { message:'Too many notification channels:
 *        maximum 20 allowed per subscription.' } (STRING — service throw,
 *        not ValidationPipe) and the rejected PUT persists NOTHING:
 *        GET /api/notifications/preferences → { subscriptions:[],
 *        preference:null, mutes:[] } for the fresh user.
 *      20 unique ids ('in-app' + 19 unowned UUIDs) → the cardinality gate
 *        PASSES at the boundary and the next gate fires instead: 400
 *        'Unknown or unauthorized notification channel: <first fake id>'.
 *      30 duplicates of 'in-app' (unique=1) → 200 { subscription } with
 *        channelIds deduped to exactly ['in-app'] — the cap counts UNIQUE
 *        ids, so duplicates alone can never trip it.
 *  ('agent_run_finished' verified present via GET /api/notifications/event-types.)
 *
 * Isolation: every test runs on a FRESH registerUserViaAPI() user (and a
 * fresh work where needed) with Date.now()-suffixed names. API-only — no UI.
 */

const REQ_TIMEOUT = 20_000;
const GIT_GATE_MESSAGE = 'Please reconnect your Git account to continue.';

/** Validation 400 envelope (ValidationPipe): message is an ARRAY. */
interface ValidationErrorBody {
    message: string[];
    error: string;
    statusCode: number;
}

/** Domain 400 envelope (git gate / service throw): message is a STRING. */
interface GitGateBody {
    status: string;
    slug?: string;
    item_name?: string;
    message: string;
}

interface SubscriptionEnvelope {
    subscription: {
        id: string;
        userId: string;
        eventTypeKey: string;
        channelIds: string[];
    };
}

/** Fresh user + fresh non-git-connected work (the submit-item fixture). */
async function freshUserWork(
    request: APIRequestContext,
): Promise<{ token: string; workId: string }> {
    const user = await registerUserViaAPI(request);
    const work = await createWorkViaAPI(request, user.access_token, {
        name: `sec-dto-bounds-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    });
    expect(work.id, 'fixture work id resolved').toBeTruthy();
    return { token: user.access_token, workId: work.id };
}

/** A DTO-valid submit-item body; tests override a single field. */
function validItemBody(): Record<string, unknown> {
    return {
        name: `Bound Item ${Date.now()}`,
        description: 'dto-bounds probe item',
        source_url: 'https://example.com/dto-bounds',
        category: 'tools',
    };
}

async function postSubmitItem(
    request: APIRequestContext,
    token: string,
    workId: string,
    overrides: Record<string, unknown>,
): Promise<APIResponse> {
    const body = { ...validItemBody(), ...overrides };
    // `undefined` override removes the field (e.g. drop `category` when
    // exercising the `categories` array branch).
    for (const key of Object.keys(body)) {
        if (body[key] === undefined) delete body[key];
    }
    return request.post(`${API_BASE}/api/works/${workId}/submit-item`, {
        headers: authedHeaders(token),
        data: body,
        timeout: REQ_TIMEOUT,
    });
}

/** Assert the ValidationPipe 400 (message ARRAY) containing the exact string. */
async function expectValidation400(res: APIResponse, expectedMessage: string): Promise<void> {
    expect(res.status(), `validation rejection is 400 (got body ${await res.text()})`).toBe(400);
    const body = (await res.json()) as ValidationErrorBody;
    expect(Array.isArray(body.message), 'validation 400 carries a message ARRAY').toBe(true);
    expect(body.message, `message array names the bound: ${expectedMessage}`).toContain(
        expectedMessage,
    );
    expect(body.error, 'validation envelope error field').toBe('Bad Request');
    expect(body.statusCode).toBe(400);
}

/**
 * Assert the body PASSED DTO validation: on a non-git-connected work the
 * request falls through to the git gate, whose envelope is the STRING-message
 * domain 400 — never the validation array.
 */
async function expectDtoAcceptedGitGate(res: APIResponse): Promise<GitGateBody> {
    expect(res.status(), 'DTO-valid body reaches the git gate (400)').toBe(400);
    const body = (await res.json()) as GitGateBody;
    expect(Array.isArray(body.message), 'NOT a validation array — DTO accepted').toBe(false);
    expect(body.status, 'git-gate envelope is the domain error').toBe('error');
    expect(body.message, 'git-gate message (proof validation passed)').toBe(GIT_GATE_MESSAGE);
    return body;
}

// ─── submit-item: name / description bounds (Wave M #36) ────────────────────

test.describe('submit-item DTO bounds — name and description MaxLength', () => {
    test('name of 201 chars → 400 with the exact 200-char MaxLength message', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request);
        const res = await postSubmitItem(request, token, workId, { name: 'n'.repeat(201) });
        await expectValidation400(res, 'name must be shorter than or equal to 200 characters');
    });

    test('name of exactly 200 chars passes DTO validation (boundary accept) and echoes through to the git gate', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request);
        const name200 = 'n'.repeat(200);
        const res = await postSubmitItem(request, token, workId, { name: name200 });
        const gate = await expectDtoAcceptedGitGate(res);
        // The gate envelope echoes item_name — the full 200-char value made it
        // through the DTO untouched (no silent truncation at the boundary).
        expect(gate.item_name, 'boundary-exact name is preserved verbatim').toBe(name200);
    });

    test('description of 5001 chars → 400 with the exact 5000-char MaxLength message', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request);
        const res = await postSubmitItem(request, token, workId, {
            description: 'd'.repeat(5001),
        });
        await expectValidation400(
            res,
            'description must be shorter than or equal to 5000 characters',
        );
    });

    test('description of exactly 5000 chars passes DTO validation (boundary accept)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request);
        const res = await postSubmitItem(request, token, workId, {
            description: 'd'.repeat(5000),
        });
        await expectDtoAcceptedGitGate(res);
    });
});

// ─── submit-item: category / categories bounds (Wave M #143) ────────────────

test.describe('submit-item DTO bounds — category and categories[] MaxLength', () => {
    test('category of 201 chars → 400 with the exact 200-char MaxLength message', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request);
        const res = await postSubmitItem(request, token, workId, { category: 'c'.repeat(201) });
        await expectValidation400(res, 'category must be shorter than or equal to 200 characters');
    });

    test('category of exactly 200 chars passes DTO validation (boundary accept)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request);
        const res = await postSubmitItem(request, token, workId, { category: 'c'.repeat(200) });
        await expectDtoAcceptedGitGate(res);
    });

    test('a 201-char element inside categories[] → 400 each-value message (array form cannot bypass the singular cap)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request);
        // Drop the singular `category` so the `categories` branch validates.
        const res = await postSubmitItem(request, token, workId, {
            category: undefined,
            categories: ['c'.repeat(201)],
        });
        await expectValidation400(
            res,
            'each value in categories must be shorter than or equal to 200 characters',
        );
    });
});

// ─── submit-item: tags bounds — per-element length + cardinality (Wave M #165) ─

test.describe('submit-item DTO bounds — tags element MaxLength(50) and ArrayMaxSize(50)', () => {
    test('a 51-char tag → 400 with the exact each-value 50-char message', async ({ request }) => {
        const { token, workId } = await freshUserWork(request);
        const res = await postSubmitItem(request, token, workId, { tags: ['t'.repeat(51)] });
        await expectValidation400(
            res,
            'each value in tags must be shorter than or equal to 50 characters',
        );
    });

    test('a tag of exactly 50 chars passes DTO validation (boundary accept)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request);
        const res = await postSubmitItem(request, token, workId, { tags: ['t'.repeat(50)] });
        await expectDtoAcceptedGitGate(res);
    });

    test('51 tags → 400 with the exact ArrayMaxSize(50) cardinality message', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request);
        const res = await postSubmitItem(request, token, workId, {
            tags: Array.from({ length: 51 }, (_, i) => `tag-${i}`),
        });
        await expectValidation400(res, 'tags must contain no more than 50 elements');
    });

    test('exactly 50 tags pass DTO validation (cardinality boundary accept)', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request);
        const res = await postSubmitItem(request, token, workId, {
            tags: Array.from({ length: 50 }, (_, i) => `tag-${i}`),
        });
        await expectDtoAcceptedGitGate(res);
    });

    test('all three bounds blown at once → ONE aggregated validation 400 naming every violated cap, and validation still precedes the git gate', async ({
        request,
    }) => {
        const { token, workId } = await freshUserWork(request);
        const res = await postSubmitItem(request, token, workId, {
            name: 'n'.repeat(201),
            description: 'd'.repeat(5001),
            tags: Array.from({ length: 51 }, (_, i) => `tag-${i}`),
        });
        expect(res.status(), 'aggregated validation rejection is 400').toBe(400);
        const body = (await res.json()) as ValidationErrorBody;
        expect(Array.isArray(body.message), 'aggregate is a validation ARRAY').toBe(true);
        expect(body.message).toContain('name must be shorter than or equal to 200 characters');
        expect(body.message).toContain(
            'description must be shorter than or equal to 5000 characters',
        );
        expect(body.message).toContain('tags must contain no more than 50 elements');
        // Validation fired BEFORE the git gate — the domain envelope's marker
        // fields are absent from a ValidationPipe response.
        expect(
            (body as unknown as GitGateBody).item_name,
            'no git-gate envelope leakage on a validation 400',
        ).toBeUndefined();
    });
});

// ─── onboarding state.prompt — the boundary-exact gap (5001→400 pinned elsewhere) ─

test.describe('onboarding state.prompt — MaxLength(5000) boundary-exact accept', () => {
    test('a prompt of exactly 5000 chars is accepted (200) and round-trips verbatim on an independent GET', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const prompt5000 = 'p'.repeat(5000);

        const patched = await request.patch(`${API_BASE}/api/onboarding/state`, {
            headers: authedHeaders(token),
            data: { state: { prompt: prompt5000 } },
            timeout: REQ_TIMEOUT,
        });
        expect(
            patched.status(),
            `boundary-exact 5000-char prompt is accepted (body ${await patched.text()})`,
        ).toBe(200);
        const patchedBody = (await patched.json()) as { state: { prompt?: string } };
        expect(patchedBody.state.prompt?.length, 'response carries the full prompt').toBe(5000);

        // Independent read-back: persisted verbatim, not truncated to fit.
        const readBack = await request.get(`${API_BASE}/api/onboarding/state`, {
            headers: authedHeaders(token),
            timeout: REQ_TIMEOUT,
        });
        expect(readBack.status()).toBe(200);
        const readBody = (await readBack.json()) as { state: { prompt?: string } };
        expect(readBody.state.prompt, 'boundary-exact prompt persisted verbatim').toBe(prompt5000);
    });
});

// ─── notification-preferences channelIds — 20-unique cardinality cap ─────────

test.describe('notification preferences channelIds — unique-id cardinality cap (20)', () => {
    const EVENT_KEY = 'agent_run_finished'; // probed via GET /api/notifications/event-types

    function fakeChannelId(i: number): string {
        return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    }

    async function putChannelIds(
        request: APIRequestContext,
        token: string,
        channelIds: string[],
    ): Promise<APIResponse> {
        return request.put(`${API_BASE}/api/notifications/preferences/event/${EVENT_KEY}`, {
            headers: authedHeaders(token),
            data: { channelIds },
            timeout: REQ_TIMEOUT,
        });
    }

    test('21 unique channel ids → 400 cardinality rejection BEFORE any ownership lookup, and nothing persists', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // All 21 ids are unowned fakes — yet the error is the CARDINALITY
        // message, proving the cap fires before the per-id ownership queries
        // (the DoS the cap exists to prevent).
        const res = await putChannelIds(
            request,
            token,
            Array.from({ length: 21 }, (_, i) => fakeChannelId(i)),
        );
        expect(res.status(), 'over-bound channelIds is 400').toBe(400);
        const body = (await res.json()) as GitGateBody & { error?: string };
        expect(typeof body.message, 'service throw carries a STRING message').toBe('string');
        expect(body.message).toBe(
            'Too many notification channels: maximum 20 allowed per subscription.',
        );

        // The rejected PUT persisted nothing — the fresh user's preferences
        // read back entirely empty.
        const prefs = await request.get(`${API_BASE}/api/notifications/preferences`, {
            headers: authedHeaders(token),
            timeout: REQ_TIMEOUT,
        });
        expect(prefs.status()).toBe(200);
        const prefsBody = (await prefs.json()) as { subscriptions: unknown[] };
        expect(prefsBody.subscriptions, 'rejected PUT persisted no subscription').toEqual([]);
    });

    test('exactly 20 unique ids pass the cardinality gate (boundary) — the NEXT gate (ownership) rejects the unowned ids instead', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // 'in-app' (built-in, exempt) + 19 unowned fakes = 20 unique. At the
        // boundary the cardinality check passes and the failure shifts to the
        // ownership gate, naming the first unowned id — pinning BOTH the
        // boundary value and the gate ordering.
        const ids = ['in-app', ...Array.from({ length: 19 }, (_, i) => fakeChannelId(i))];
        const res = await putChannelIds(request, token, ids);
        expect(res.status(), '20 unique ids still 400 — but NOT for cardinality').toBe(400);
        const body = (await res.json()) as { message: string };
        expect(body.message, 'cardinality message absent at the boundary').not.toMatch(
            /too many notification channels/i,
        );
        expect(body.message).toBe(
            `Unknown or unauthorized notification channel: ${fakeChannelId(0)}`,
        );
    });

    test('the cap counts UNIQUE ids: 30 duplicates of in-app dedupe to one and are accepted', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        const res = await putChannelIds(
            request,
            token,
            Array.from({ length: 30 }, () => 'in-app'),
        );
        expect(res.status(), '30 duplicate ids dedupe below the cap → 200').toBe(200);
        const body = (await res.json()) as SubscriptionEnvelope;
        expect(body.subscription.eventTypeKey).toBe(EVENT_KEY);
        expect(
            body.subscription.channelIds,
            'persisted list is deduped to the single unique id',
        ).toEqual(['in-app']);
    });
});
