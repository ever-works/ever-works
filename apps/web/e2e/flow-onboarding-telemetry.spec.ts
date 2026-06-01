import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * flow-onboarding-telemetry.spec.ts — complex, multi-step INTEGRATION flows for
 * the platform's TWO distinct telemetry ingestion surfaces, probed live against
 * the API at :3100 before any assertion. This file deliberately goes DEEPER than
 * the existing shallow coverage:
 *
 *   - `telemetry.spec.ts`            — only a 4xx/!5xx smoke of both endpoints.
 *   - `flow-onboarding-wizard.spec.ts` Flow 3 — a 10-event funnel + a couple of
 *                                       rejection cases + the 401 on the
 *                                       onboarding relay.
 *
 * The flows here cover the UNCOVERED surface: the FULL 18-event allow-list, the
 * strict `forbidNonWhitelisted` envelope contract, the public funnel endpoint's
 * entire validation lattice (funnelStep bounds / correlationId regex / ISO
 * timestamp / oversized-payload / MaxLength passthrough), the "telemetry never
 * mutates onboarding state" isolation invariant, the disjoint-namespace
 * isolation between the two allow-lists, and a real-Work correlationId
 * passthrough across a zero-friction funnel sequence.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * SHAPES VERIFIED AGAINST THE LIVE API (http://127.0.0.1:3100) BEFORE WRITING:
 *
 *   ONBOARDING RELAY  (OnboardingTelemetryController @Controller('api/onboarding'),
 *                      AUTH-GATED — global AuthSessionGuard)
 *
 *     POST /api/onboarding/telemetry   body: { event, properties? }
 *       -> 204 No Content (empty body) for any allow-listed `event`
 *       allow-list (exactly 18, OnboardingTelemetryBodyDto.ONBOARDING_TELEMETRY_EVENTS):
 *         onboarding_opened, onboarding_closed, onboarding_completed,
 *         onboarding_step_viewed, onboarding_step_next, onboarding_step_back,
 *         onboarding_step_skipped, onboarding_ai_choice_selected,
 *         onboarding_storage_choice_selected, onboarding_deploy_choice_selected,
 *         onboarding_plugin_connected, onboarding_plugin_refresh_clicked,
 *         onboarding_planned_card_clicked, onboarding_byok_skipped,
 *         onboarding_plugins_step_expanded, onboarding_plugins_step_skipped,
 *         onboarding_plugins_step_advanced, onboarding_ever_works_quota_blocked
 *       - `properties` is @IsOptional @IsObject:
 *           absent            -> 204
 *           null              -> 204 (IsOptional treats null as "not provided")
 *           {}                -> 204
 *           [array]           -> 400 ["properties must be an object"]
 *           "string"/number   -> 400 ["properties must be an object"]
 *       - unknown event       -> 400 ["event must be one of the following values: …<18>"]
 *       - missing event       -> 400 (same enumerated message)
 *       - extra top-level key -> 400 ["property <key> should not exist"]
 *                                 (global ValidationPipe forbidNonWhitelisted: true)
 *       - no auth             -> 401 { message: 'Unauthorized' }
 *       - GET (wrong method)  -> 404
 *
 *   ZERO-FRICTION FUNNEL  (TelemetryController @Controller('api/telemetry'),
 *                          @Public() + @Throttle 60/60s/IP)
 *
 *     POST /api/telemetry/funnel  body: FunnelEventDto
 *         { event, funnelStep:1..8, timestamp:ISO8601, correlationId:8-64 [A-Za-z0-9_-],
 *           extra?:object, workId?:<=64, userId?:<=64 }
 *       -> 204 No Content for a well-formed event (anonymous, no auth needed)
 *       allow-list (exactly 8, ZERO_FRICTION_FUNNEL_EVENTS):
 *         zero_friction.landing_prompt_submit, .anon_user_created, .wizard_finished,
 *         .work_created, .repos_pushed, .deploy_started, .deploy_ready, .claim_account
 *       - unknown event       -> 400 ["event must be one of the following values: …<8>"]
 *       - funnelStep 0        -> 400 ["funnelStep must not be less than 1"]
 *       - funnelStep 9        -> 400 ["funnelStep must not be greater than 8"]
 *       - correlationId 'abc' -> 400 ["correlationId must be 8-64 chars, alphanumeric/_-"]
 *       - timestamp not ISO   -> 400 ["timestamp must be a valid ISO 8601 date string"]
 *       - extra top-level key -> 400 ["property <key> should not exist"]
 *       - workId > 64 chars   -> 400 ["workId must be shorter than or equal to 64 characters"]
 *       - payload > 4 KB      -> 400 { message: 'telemetry payload too large' } (controller guard)
 *       - GET (wrong method)  -> 404
 *       - WITH an auth header -> still 204 (Public skips the guard; auth is ignored)
 *
 *   ISOLATION
 *     The two allow-lists are DISJOINT: an onboarding event 400s on the funnel
 *     endpoint and a funnel event 400s on the onboarding endpoint. Telemetry —
 *     whether accepted or rejected — NEVER mutates onboarding state (completedAt /
 *     dismissedAt / lastStep are untouched). The funnel endpoint stays public, so
 *     an opted-out client simply stops emitting with zero server coupling.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * DEVIATIONS / CONSTRAINTS:
 *   • NO PostHog / analytics sink in CI. The relay swallows downstream sink
 *     failures (try/catch → log + drop) so a 204 means "accepted", not
 *     "delivered". We therefore pin the WIRE CONTRACT (status / validation /
 *     state-isolation), never delivery to PostHog.
 *   • The funnel @Throttle is 60/60s/IP — far above what these flows emit, so we
 *     never deliberately trip it (a 429 would be cross-spec-flaky). Sequences are
 *     kept well under the cap.
 *   • CROSS-SPEC ISOLATION: every mutating flow uses a FRESH registerUserViaAPI()
 *     user; the public funnel needs no user at all. Event names carry a per-run
 *     unique correlationId (Date.now) so concurrent specs don't collide in any
 *     downstream log.
 */

// ─── Endpoints + allow-lists (probe-verified) ────────────────────────────────

const ONBOARDING_TELEMETRY = `${API_BASE}/api/onboarding/telemetry`;
const ONBOARDING_STATE = `${API_BASE}/api/onboarding/state`;
const FUNNEL = `${API_BASE}/api/telemetry/funnel`;

/** Exactly the 18 allow-listed onboarding telemetry event names. */
const ONBOARDING_EVENTS = [
    'onboarding_opened',
    'onboarding_closed',
    'onboarding_completed',
    'onboarding_step_viewed',
    'onboarding_step_next',
    'onboarding_step_back',
    'onboarding_step_skipped',
    'onboarding_ai_choice_selected',
    'onboarding_storage_choice_selected',
    'onboarding_deploy_choice_selected',
    'onboarding_plugin_connected',
    'onboarding_plugin_refresh_clicked',
    'onboarding_planned_card_clicked',
    'onboarding_byok_skipped',
    'onboarding_plugins_step_expanded',
    'onboarding_plugins_step_skipped',
    'onboarding_plugins_step_advanced',
    'onboarding_ever_works_quota_blocked',
] as const;

/** Exactly the 8 allow-listed zero-friction funnel event names. */
const FUNNEL_EVENTS = [
    'zero_friction.landing_prompt_submit',
    'zero_friction.anon_user_created',
    'zero_friction.wizard_finished',
    'zero_friction.work_created',
    'zero_friction.repos_pushed',
    'zero_friction.deploy_started',
    'zero_friction.deploy_ready',
    'zero_friction.claim_account',
] as const;

interface OnboardingState {
    completedAt: string | null;
    dismissedAt: string | null;
    state: { lastStep: number; version: number };
}

async function getOnboardingState(
    request: APIRequestContext,
    token: string,
): Promise<OnboardingState> {
    const res = await request.get(ONBOARDING_STATE, { headers: authedHeaders(token) });
    expect(res.status(), `GET state body=${await res.text().catch(() => '')}`).toBe(200);
    return res.json();
}

/** Post an onboarding telemetry event with an authed user. */
function postOnboardingTelemetry(request: APIRequestContext, token: string, data: unknown) {
    return request.post(ONBOARDING_TELEMETRY, { headers: authedHeaders(token), data });
}

/** A unique, regex-valid correlationId for a given run (8-64 [A-Za-z0-9_-]). */
function makeCorrelationId(tag: string): string {
    return `e2e-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A well-formed minimal funnel envelope for a given step + event. */
function funnelEnvelope(event: string, funnelStep: number, correlationId: string) {
    return {
        event,
        funnelStep,
        timestamp: new Date().toISOString(),
        correlationId,
    };
}

// ─── Flow 1: the FULL 18-event allow-list + properties-shape variants ─────────

test.describe('Flow: onboarding telemetry — full allow-list acceptance + properties-shape variants', () => {
    test('every one of the 18 allow-listed events is accepted (204, empty body); properties absent/null/{} are all OK; the rejection message enumerates the exact allow-list', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // ── Step 1: EVERY allow-listed event is accepted with 204 No Content and an
        //    empty body. This is the canonical wizard vocabulary — a single dropped
        //    event from the list would silently break a PostHog funnel, so we pin the
        //    whole surface, not just the handful the wizard spec's funnel touches.
        for (const event of ONBOARDING_EVENTS) {
            const res = await postOnboardingTelemetry(request, token, { event });
            expect(res.status(), `event '${event}' must be accepted`).toBe(204);
            expect((await res.text()).length, `${event} → empty 204 body`).toBe(0);
        }

        // ── Step 2: the `properties` field is @IsOptional @IsObject. The three
        //    "object-or-nothing" shapes a real client emits all succeed: omitted,
        //    explicit null (IsOptional treats null as not-provided), and an empty
        //    object. A populated object is likewise fine.
        const okShapes: Array<{ label: string; body: Record<string, unknown> }> = [
            { label: 'omitted', body: { event: 'onboarding_opened' } },
            { label: 'null', body: { event: 'onboarding_opened', properties: null } },
            { label: 'empty-object', body: { event: 'onboarding_opened', properties: {} } },
            {
                label: 'populated',
                body: {
                    event: 'onboarding_ai_choice_selected',
                    properties: { choice: 'openrouter', stepKind: 'ai-choice', nested: { a: 1 } },
                },
            },
        ];
        for (const shape of okShapes) {
            const res = await postOnboardingTelemetry(request, token, shape.body);
            expect(res.status(), `properties ${shape.label} → 204`).toBe(204);
        }

        // ── Step 3: an unknown event is rejected with a 400 whose message ENUMERATES
        //    the full allow-list (it is the @IsIn message). We assert both the first
        //    and last canonical names appear so a future shrink/grow of the list is
        //    caught — the rejection doubles as the server-authoritative event catalog.
        const unknown = await postOnboardingTelemetry(request, token, {
            event: 'totally_made_up_event',
        });
        expect(unknown.status()).toBe(400);
        const unknownMsg = JSON.stringify((await unknown.json()).message);
        expect(unknownMsg).toContain('must be one of the following values');
        expect(unknownMsg).toContain('onboarding_opened');
        expect(unknownMsg).toContain('onboarding_ever_works_quota_blocked');
        // Every allow-listed name appears in the enumerated message → the message IS
        // the catalog (regression guard against silent allow-list drift).
        for (const event of ONBOARDING_EVENTS) {
            expect(unknownMsg, `allow-list message should enumerate ${event}`).toContain(event);
        }
    });
});

// ─── Flow 2: strict envelope rejection matrix (per-request, never blocks) ─────

test.describe('Flow: onboarding telemetry — strict envelope rejection matrix; rejections are per-request and never poison the session', () => {
    test('extra top-level keys, non-object properties, and a missing event each 400 distinctly; a valid event immediately after every rejection still 204s', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // ── Step 1: forbidNonWhitelisted. The global ValidationPipe runs
        //    `whitelist:true, forbidNonWhitelisted:true`, so any property NOT on the
        //    DTO (here a stray `userId`, which IS a valid field on the *funnel* DTO but
        //    not on the onboarding one) is a hard 400 — telemetry can't smuggle
        //    arbitrary top-level fields past the relay into PostHog.
        const extraKey = await postOnboardingTelemetry(request, token, {
            event: 'onboarding_opened',
            userId: 'sneaky',
        });
        expect(extraKey.status(), 'extra top-level key → 400').toBe(400);
        expect(JSON.stringify((await extraKey.json()).message)).toContain(
            'property userId should not exist',
        );

        // ── Step 2: properties type-narrowing. @IsObject rejects an ARRAY (which is
        //    `typeof === 'object'` in JS but not a plain object) and a primitive, both
        //    with the same precise message — so the funnel's property bag can't be a
        //    list or a scalar that downstream code would mis-handle.
        const arrayProps = await postOnboardingTelemetry(request, token, {
            event: 'onboarding_opened',
            properties: [1, 2, 3],
        });
        expect(arrayProps.status(), 'array properties → 400').toBe(400);
        expect(JSON.stringify((await arrayProps.json()).message)).toContain(
            'properties must be an object',
        );

        const stringProps = await postOnboardingTelemetry(request, token, {
            event: 'onboarding_opened',
            properties: 'not-an-object',
        });
        expect(stringProps.status(), 'string properties → 400').toBe(400);
        expect(JSON.stringify((await stringProps.json()).message)).toContain(
            'properties must be an object',
        );

        // ── Step 3: a missing event is the same @IsIn failure as an unknown one — the
        //    field is required by virtue of having no default and an enum constraint.
        const missing = await postOnboardingTelemetry(request, token, { properties: { a: 1 } });
        expect(missing.status(), 'missing event → 400').toBe(400);
        expect(JSON.stringify((await missing.json()).message)).toContain(
            'must be one of the following values',
        );

        // ── Step 4: rejections are PER-REQUEST. After every 400 above, a clean event
        //    still succeeds — a malformed post never wedges the user's telemetry
        //    channel or leaves the session in a broken state.
        const recover = await postOnboardingTelemetry(request, token, {
            event: 'onboarding_completed',
            properties: { completed: true },
        });
        expect(recover.status(), 'a valid event after the rejection lattice still 204s').toBe(204);
    });
});

// ─── Flow 3: public funnel endpoint — full validation lattice (anonymous) ─────

test.describe('Flow: zero-friction funnel — anonymous acceptance + full validation lattice', () => {
    test('all 8 funnel events accepted anonymously; funnelStep bounds, correlationId regex, ISO timestamp, forbidNonWhitelisted, oversized-payload + MaxLength passthrough are all enforced; an auth header is ignored (still public)', async ({
        request,
    }) => {
        // ── Step 1: the funnel sink is @Public() — landing-page / claim-banner emit
        //    sites POST here BEFORE the user has any session, so auth-required would
        //    silently drop top-of-funnel events. Every one of the 8 canonical events
        //    is accepted ANONYMOUSLY with 204. We assign each its real funnelStep so
        //    the @Min(1)/@Max(8) bounds are exercised across the whole valid range.
        const stepForEvent: Record<string, number> = {
            'zero_friction.landing_prompt_submit': 1,
            'zero_friction.anon_user_created': 2,
            'zero_friction.wizard_finished': 3,
            'zero_friction.work_created': 4,
            'zero_friction.repos_pushed': 5,
            'zero_friction.deploy_started': 6,
            'zero_friction.deploy_ready': 7,
            'zero_friction.claim_account': 8,
        };
        for (const event of FUNNEL_EVENTS) {
            const corr = makeCorrelationId('anon');
            const res = await request.post(FUNNEL, {
                data: funnelEnvelope(event, stepForEvent[event], corr),
            });
            expect(res.status(), `anonymous funnel '${event}' → 204`).toBe(204);
            expect((await res.text()).length, `${event} → empty 204 body`).toBe(0);
        }

        // ── Step 2: unknown event names 400 with the enumerated 8-event allow-list —
        //    distinct from (and disjoint with) the onboarding relay's 18-event list.
        const corr = makeCorrelationId('lattice');
        const unknownEvent = await request.post(FUNNEL, {
            data: funnelEnvelope('zero_friction.not_a_real_event', 1, corr),
        });
        expect(unknownEvent.status()).toBe(400);
        const unknownMsg = JSON.stringify((await unknownEvent.json()).message);
        expect(unknownMsg).toContain('must be one of the following values');
        expect(unknownMsg).toContain('zero_friction.landing_prompt_submit');
        expect(unknownMsg).toContain('zero_friction.claim_account');

        // ── Step 3: funnelStep is a 1..8 integer. Both out-of-range edges are pinned
        //    with their exact @Min/@Max messages so a downstream PostHog funnel can
        //    rely on a dense 1..8 step axis.
        const stepZero = await request.post(FUNNEL, {
            data: funnelEnvelope('zero_friction.landing_prompt_submit', 0, corr),
        });
        expect(stepZero.status(), 'funnelStep 0 → 400').toBe(400);
        expect(JSON.stringify((await stepZero.json()).message)).toContain(
            'funnelStep must not be less than 1',
        );
        const stepNine = await request.post(FUNNEL, {
            data: funnelEnvelope('zero_friction.landing_prompt_submit', 9, corr),
        });
        expect(stepNine.status(), 'funnelStep 9 → 400').toBe(400);
        expect(JSON.stringify((await stepNine.json()).message)).toContain(
            'funnelStep must not be greater than 8',
        );

        // ── Step 4: correlationId is the funnel's cross-service trace key — it must
        //    match /^[A-Za-z0-9_-]{8,64}$/. A 3-char id is rejected with the custom
        //    message, so a malformed trace id can never enter the funnel.
        const badCorr = await request.post(FUNNEL, {
            data: {
                event: 'zero_friction.landing_prompt_submit',
                funnelStep: 1,
                timestamp: new Date().toISOString(),
                correlationId: 'abc',
            },
        });
        expect(badCorr.status(), 'short correlationId → 400').toBe(400);
        expect(JSON.stringify((await badCorr.json()).message)).toContain(
            'correlationId must be 8-64 chars',
        );

        // ── Step 5: timestamp is @IsISO8601. A free-text date is rejected, keeping the
        //    funnel's time axis machine-parseable.
        const badTs = await request.post(FUNNEL, {
            data: {
                event: 'zero_friction.landing_prompt_submit',
                funnelStep: 1,
                timestamp: 'yesterday',
                correlationId: corr,
            },
        });
        expect(badTs.status(), 'non-ISO timestamp → 400').toBe(400);
        expect(JSON.stringify((await badTs.json()).message)).toContain(
            'timestamp must be a valid ISO 8601 date string',
        );

        // ── Step 6: forbidNonWhitelisted applies here too — a stray top-level key is a
        //    400, so the public endpoint can't be used to inject arbitrary fields into
        //    the funnel sink (per-event extras must go through the dedicated `extra`
        //    map, which IS whitelisted).
        const extraTop = await request.post(FUNNEL, {
            data: {
                ...funnelEnvelope('zero_friction.landing_prompt_submit', 1, corr),
                bogusTop: 1,
            },
        });
        expect(extraTop.status(), 'extra top-level key → 400').toBe(400);
        expect(JSON.stringify((await extraTop.json()).message)).toContain(
            'property bogusTop should not exist',
        );

        // ── Step 7: the controller's 4 KB hard cap. A >4 KB `extra` blob is rejected
        //    by the explicit size guard (NOT a class-validator message) — a public
        //    endpoint must bound the wire payload to resist log/PostHog flooding.
        const big = 'x'.repeat(5000);
        const oversized = await request.post(FUNNEL, {
            data: {
                ...funnelEnvelope('zero_friction.landing_prompt_submit', 1, corr),
                extra: { blob: big },
            },
        });
        expect(oversized.status(), 'payload > 4KB → 400').toBe(400);
        expect(JSON.stringify((await oversized.json()).message)).toContain(
            'telemetry payload too large',
        );

        // ── Step 8: the optional `workId` passthrough is @MaxLength(64). A 100-char id
        //    is rejected — the passthrough columns are bounded, not free-form.
        const longWorkId = await request.post(FUNNEL, {
            data: {
                ...funnelEnvelope('zero_friction.work_created', 4, corr),
                workId: 'w'.repeat(100),
            },
        });
        expect(longWorkId.status(), 'workId > 64 → 400').toBe(400);
        expect(JSON.stringify((await longWorkId.json()).message)).toContain(
            'workId must be shorter than or equal to 64 characters',
        );

        // ── Step 9: the endpoint is PUBLIC — supplying an auth header changes nothing
        //    (the guard is skipped, the body still validates and is accepted). This is
        //    the inverse of the onboarding relay, which REQUIRES auth (asserted below).
        const authed = await registerUserViaAPI(request);
        const withAuth = await request.post(FUNNEL, {
            headers: authedHeaders(authed.access_token),
            data: funnelEnvelope(
                'zero_friction.landing_prompt_submit',
                1,
                makeCorrelationId('authed'),
            ),
        });
        expect(withAuth.status(), 'funnel ignores an auth header → still 204').toBe(204);
    });
});

// ─── Flow 4: telemetry NEVER mutates onboarding state (opt-out safety) ────────

test.describe('Flow: telemetry isolation — emitting (or failing to emit) telemetry never touches onboarding state', () => {
    test('a full funnel of valid + rejected onboarding-telemetry posts leaves completedAt/dismissedAt/lastStep pristine; the public funnel needs no session, so an opted-out client simply stops emitting', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // ── Step 1: snapshot the pristine onboarding state for a brand-new user.
        const before = await getOnboardingState(request, token);
        expect(before.completedAt).toBeNull();
        expect(before.dismissedAt).toBeNull();
        expect(before.state.lastStep).toBe(0);

        // ── Step 2: emit a realistic mix of telemetry — including the
        //    `onboarding_completed` / `onboarding_closed` events whose NAMES echo the
        //    state transitions, plus deliberately MALFORMED posts. Telemetry is a pure
        //    side-channel: NONE of these may flip the actual completedAt/dismissedAt
        //    timestamps or advance lastStep. (A naive impl might wire
        //    `onboarding_completed` telemetry to the completion flag — this guards it.)
        const mixed: unknown[] = [
            { event: 'onboarding_opened', properties: { trigger: 'auto' } },
            { event: 'onboarding_step_viewed', properties: { stepKind: 'welcome' } },
            { event: 'onboarding_completed' }, // name echoes a state transition…
            { event: 'onboarding_closed', properties: { completed: false } }, // …so does this
            { event: 'definitely_not_allow_listed' }, // 400
            { event: 'onboarding_opened', properties: [1, 2] }, // 400
            { event: 'onboarding_step_next', properties: {} },
        ];
        for (const body of mixed) {
            const res = await postOnboardingTelemetry(request, token, body);
            // Accept either the 204 (valid) or 400 (malformed) — the point is the
            // SIDE EFFECT on state, asserted next, not the per-post status here.
            expect([204, 400], `telemetry post status for ${JSON.stringify(body)}`).toContain(
                res.status(),
            );
        }

        // ── Step 3: state is byte-for-byte unchanged. completedAt/dismissedAt are
        //    still null and lastStep is still 0 — telemetry and the real onboarding
        //    state machine are fully decoupled.
        const after = await getOnboardingState(request, token);
        expect(after.completedAt, 'completedAt untouched by telemetry').toBeNull();
        expect(after.dismissedAt, 'dismissedAt untouched by telemetry').toBeNull();
        expect(after.state.lastStep, 'lastStep untouched by telemetry').toBe(0);

        // ── Step 4: opt-out / no-coupling proof. The funnel endpoint is public and
        //    stateless: a client that opts OUT of telemetry simply stops POSTing, and
        //    nothing server-side depends on those posts having happened. We demonstrate
        //    the inverse boundary — the funnel accepts an anonymous emit with NO user
        //    context at all, so there is no per-user telemetry record to "leak" or
        //    have to delete on opt-out.
        const anon = await request.post(FUNNEL, {
            data: funnelEnvelope(
                'zero_friction.landing_prompt_submit',
                1,
                makeCorrelationId('optout'),
            ),
        });
        expect(anon.status(), 'anonymous funnel emit needs no session → 204').toBe(204);

        // And the authed user's onboarding state is STILL pristine after the anon
        // funnel emit — the two surfaces share no state.
        const finalState = await getOnboardingState(request, token);
        expect(finalState.completedAt).toBeNull();
        expect(finalState.state.lastStep).toBe(0);
    });
});

// ─── Flow 5: namespace isolation between the two telemetry surfaces ───────────

test.describe('Flow: telemetry namespace isolation — the two allow-lists are disjoint and the auth/method boundaries diverge', () => {
    test('an onboarding event 400s on the funnel endpoint and a funnel event 400s on the onboarding endpoint; onboarding requires auth (401) while funnel is public; GET 404s on both', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;
        const corr = makeCorrelationId('isolation');

        // ── Step 1: the funnel endpoint REJECTS an onboarding event name. The two
        //    vocabularies are namespaced (`onboarding_*` vs `zero_friction.*`) and the
        //    @IsIn allow-lists are disjoint — you cannot cross-fire an onboarding event
        //    into the public funnel sink.
        const onbOnFunnel = await request.post(FUNNEL, {
            data: funnelEnvelope('onboarding_opened', 1, corr),
        });
        expect(onbOnFunnel.status(), 'onboarding event on funnel → 400').toBe(400);
        const onbOnFunnelMsg = JSON.stringify((await onbOnFunnel.json()).message);
        expect(onbOnFunnelMsg).toContain('must be one of the following values');
        // The error enumerates the FUNNEL allow-list, never an onboarding name.
        expect(onbOnFunnelMsg).toContain('zero_friction.landing_prompt_submit');
        expect(onbOnFunnelMsg).not.toContain('onboarding_opened');

        // ── Step 2: symmetric — the onboarding relay REJECTS a funnel event name, and
        //    its error enumerates the onboarding allow-list, never a funnel name.
        const funnelOnOnb = await postOnboardingTelemetry(request, token, {
            event: 'zero_friction.landing_prompt_submit',
        });
        expect(funnelOnOnb.status(), 'funnel event on onboarding → 400').toBe(400);
        const funnelOnOnbMsg = JSON.stringify((await funnelOnOnb.json()).message);
        expect(funnelOnOnbMsg).toContain('onboarding_opened');
        expect(funnelOnOnbMsg).not.toContain('zero_friction');

        // ── Step 3: auth boundaries diverge. The onboarding relay is AUTH-GATED — an
        //    anonymous post is 401. The funnel is PUBLIC — the same anonymous post is
        //    202/204-accepted. Pin BOTH so a future guard refactor that accidentally
        //    makes onboarding public (or funnel private) is caught.
        const onbAnon = await request.post(ONBOARDING_TELEMETRY, {
            data: { event: 'onboarding_opened' },
        });
        expect(onbAnon.status(), 'onboarding relay requires auth → 401').toBe(401);
        expect(JSON.stringify(await onbAnon.json())).toContain('Unauthorized');

        const funnelAnon = await request.post(FUNNEL, {
            data: funnelEnvelope(
                'zero_friction.landing_prompt_submit',
                1,
                makeCorrelationId('anon2'),
            ),
        });
        expect(funnelAnon.status(), 'funnel is public → 204 anonymously').toBe(204);

        // ── Step 4: both endpoints are POST-only. A GET 404s on each (no route is
        //    registered for the verb), so neither telemetry sink can be probed/scraped
        //    via a simple GET.
        expect(
            (await request.get(ONBOARDING_TELEMETRY, { headers: authedHeaders(token) })).status(),
            'GET onboarding telemetry → 404',
        ).toBe(404);
        expect((await request.get(FUNNEL)).status(), 'GET funnel → 404').toBe(404);
    });
});

// ─── Flow 6: step-completion tracking funnel + real-Work correlationId trace ──

test.describe('Flow: step-completion tracking — a full wizard step funnel on the relay, plus a correlated zero-friction sequence carrying a REAL workId through the funnel', () => {
    test('the relay accepts an end-to-end step funnel with stepKind/stepId props; a single correlationId threads a step1→step4 funnel sequence that passes through a really-created workId', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const token = user.access_token;

        // ── Step 1: a realistic STEP-COMPLETION funnel through the onboarding relay.
        //    This mirrors what the wizard emits as a user walks each step: opened →
        //    per-step viewed/next/back/skipped → choice selections → plugins → closed.
        //    Each carries the step-identifying props (stepKind / stepId / choice) the
        //    PostHog funnel breaks down by. All must be accepted (204).
        const stepFunnel: Array<{ event: string; properties?: Record<string, unknown> }> = [
            { event: 'onboarding_opened', properties: { trigger: 'auto' } },
            {
                event: 'onboarding_step_viewed',
                properties: { stepKind: 'welcome', stepId: 'welcome' },
            },
            {
                event: 'onboarding_step_next',
                properties: { stepKind: 'welcome', stepId: 'welcome' },
            },
            {
                event: 'onboarding_step_viewed',
                properties: { stepKind: 'ai-choice', stepId: 'ai-choice' },
            },
            { event: 'onboarding_ai_choice_selected', properties: { choice: 'openrouter' } },
            {
                event: 'onboarding_step_back',
                properties: { stepKind: 'ai-choice', stepId: 'ai-choice' },
            },
            {
                event: 'onboarding_step_next',
                properties: { stepKind: 'ai-choice', stepId: 'ai-choice' },
            },
            { event: 'onboarding_storage_choice_selected', properties: { choice: 'user-github' } },
            { event: 'onboarding_deploy_choice_selected', properties: { choice: 'vercel' } },
            {
                event: 'onboarding_plugins_step_expanded',
                properties: { stepId: 'plugins-catalog' },
            },
            { event: 'onboarding_plugins_step_skipped', properties: { stepId: 'plugins-catalog' } },
            {
                event: 'onboarding_step_skipped',
                properties: { stepKind: 'plugins-catalog', stepId: 'plugins-catalog' },
            },
            { event: 'onboarding_completed', properties: { totalSteps: 6, completedSteps: 6 } },
            { event: 'onboarding_closed', properties: { completed: true } },
        ];
        for (const evt of stepFunnel) {
            const res = await postOnboardingTelemetry(request, token, evt);
            expect(res.status(), `step-funnel event '${evt.event}' → 204`).toBe(204);
        }

        // ── Step 2: create a REAL Work so the funnel passthrough carries a genuine
        //    workId (<=64 chars, matching the FunnelEventDto @MaxLength). This makes
        //    the zero-friction sequence below a true cross-feature integration rather
        //    than a synthetic id.
        const work = await createWorkViaAPI(request, token, {
            name: `telemetry-trace-${Date.now()}`,
        });
        expect(work.id, 'a real workId is needed for the funnel passthrough').toBeTruthy();
        expect(work.id.length, 'workId fits the funnel @MaxLength(64)').toBeLessThanOrEqual(64);

        // ── Step 3: a single correlationId threads the whole zero-friction funnel —
        //    the design goal is that ops can trace ONE user from the landing-prompt
        //    (step 1) through wizard-finished (step 3) and work-created (step 4) by the
        //    shared corrId. We replay a contiguous step1→step4 sequence, each event at
        //    its canonical funnelStep, carrying the SAME corrId and the real workId on
        //    the work-bearing events. All accepted anonymously (the public sink).
        const trace = makeCorrelationId('trace');
        const sequence: Array<{
            event: string;
            step: number;
            extra?: Record<string, unknown>;
            workId?: string;
            userId?: string;
        }> = [
            {
                event: 'zero_friction.landing_prompt_submit',
                step: 1,
                extra: { promptLength: 42, clientKind: 'browser' },
            },
            {
                event: 'zero_friction.anon_user_created',
                step: 2,
                userId: user.user.id,
                extra: { isAnonymous: true },
            },
            {
                event: 'zero_friction.wizard_finished',
                step: 3,
                userId: user.user.id,
                extra: {
                    aiChoice: 'openrouter',
                    storageChoice: 'user-github',
                    deployChoice: 'vercel',
                },
            },
            {
                event: 'zero_friction.work_created',
                step: 4,
                workId: work.id,
                userId: user.user.id,
                extra: { viaQuickCreate: false, workSlug: 'telemetry-trace' },
            },
        ];

        let lastStep = 0;
        for (const item of sequence) {
            const body: Record<string, unknown> = {
                ...funnelEnvelope(item.event, item.step, trace),
                ...(item.extra ? { extra: item.extra } : {}),
                ...(item.workId ? { workId: item.workId } : {}),
                ...(item.userId ? { userId: item.userId } : {}),
            };
            const res = await request.post(FUNNEL, { data: body });
            expect(res.status(), `funnel '${item.event}' (step ${item.step}) → 204`).toBe(204);
            // The funnel steps are strictly ascending across the traced sequence — the
            // contract that lets PostHog reconstruct ordering from the numeric step.
            expect(item.step, 'funnel steps ascend monotonically across the trace').toBeGreaterThan(
                lastStep,
            );
            lastStep = item.step;
        }
        expect(lastStep, 'the traced sequence reached the work-created step (4)').toBe(4);

        // ── Step 4: the real workId passed through the funnel must NOT have leaked into
        //    or mutated the user's onboarding state — the funnel passthrough and the
        //    onboarding state machine remain independent even when they reference the
        //    same Work. State stays pristine (no completion was ever recorded server-
        //    side; only telemetry NAMES said "completed").
        const finalState = await getOnboardingState(request, token);
        expect(
            finalState.completedAt,
            'onboarding_completed telemetry + a funnel work_created never set completedAt',
        ).toBeNull();
        expect(finalState.dismissedAt).toBeNull();
        expect(finalState.state.lastStep).toBe(0);
    });
});
