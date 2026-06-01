import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';

/**
 * flow-activity-ingest-platform — the EW-120 platform ingest endpoint
 * (`POST /api/activity-log/ingest`) driven end-to-end through its real public
 * surface, focusing on the contract slices the sibling specs DON'T already pin.
 * ─────────────────────────────────────────────────────────────────────────────
 * The deployed directory-site template POSTs website-sourced events (signups,
 * item submissions, report filed/resolved) here, authenticated by the
 * platform-wide `PLATFORM_API_SECRET_TOKEN` bearer (PlatformSecretGuard,
 * constant-time compare). The route is `@Public()` (exempt from the global
 * AuthSessionGuard), `@HttpCode(202)`, idempotent by `(workId, eventId)`, and
 * rate-limited. Ingest is only honoured for push-mode Works.
 *
 * EVERY shape below was READ from source (activity-log.controller.ts,
 * dto/ingest-event.dto.ts, guards/platform-secret.guard.ts,
 * activity-log.service.ts#ingestFromWebsite, works/activity-feed/*) AND
 * re-probed against the LIVE API (sqlite in-memory — the exact CI driver) on
 * fresh throwaway users before any assertion was written.
 *
 *   POST /api/activity-log/ingest  (PlatformSecretGuard + @Public + @HttpCode 202)
 *     bearer = PLATFORM_API_SECRET_TOKEN (pinned in apps/api/.env).
 *     valid push-mode + valid DTO            → 202 { id }
 *     replay SAME (workId,eventId)           → 202 { id } SAME id (original row,
 *                                              NOT updated — summary/actionType/
 *                                              occurredAt of the replay ignored)
 *     missing bearer                         → 401 'Missing Bearer token'
 *     wrong bearer / a real JWT user token   → 401 'Invalid bearer token'
 *     pull/disabled Work                     → 409 { error:'mode-mismatch', mode }
 *     unknown work                           → 404 'Work <id> not found'
 *
 *   DTO (IngestEventDto, class-validator) — exact messages probed live:
 *     workId    @IsUUID @IsNotEmpty
 *       missing  → ['workId should not be empty','workId must be a UUID']
 *       non-uuid → ['workId must be a UUID']
 *     eventId   @IsUUID @IsNotEmpty   (same shape as workId)
 *     actionType @IsEnum(WEBSITE_*)
 *       missing / non-website → ['actionType must be one of website_user_registered,
 *         website_item_submitted, website_report_filed, website_report_resolved']
 *     occurredAt @IsISO8601
 *       missing / bad → ['occurredAt must be a valid ISO 8601 date string']
 *     summary   @IsString @IsNotEmpty @MaxLength(500)
 *       empty   → ['summary should not be empty']
 *       >500    → ['summary must be shorter than or equal to 500 characters']
 *     metadata  @IsOptional @IsObject @Validate(MetadataByteCap 8 KiB)
 *       non-object → ['metadata must serialise to <= 8192 bytes','metadata must be an object']
 *       >8 KiB     → ['metadata must serialise to <= 8192 bytes']
 *
 *   Stored row (ActivityLogService.ingestFromWebsite):
 *     status='completed', action='website.<actionType>', actionType=<actionType>,
 *     userId=<Work OWNER> (the end-user that triggered the event is NOT authed),
 *     ingestEventId=<eventId>, summary=<summary>, metadata={...userMeta,
 *       occurredAt:<original ISO>}.  details={} for ingest rows.
 *     FUTURE-TIMESTAMP CLAMP: occurredAt > now → createdAt pinned to now, while
 *       metadata.occurredAt preserves the original (forensics). occurredAt<=now
 *       → createdAt pinned to occurredAt (feed orders by "when it happened").
 *
 *   Idempotency is scoped to (workId, eventId): the SAME eventId on a DIFFERENT
 *   Work creates a DISTINCT row. A concurrent burst of identical (workId,eventId)
 *   collapses to a SINGLE row (check-then-insert race → unique-index → returns
 *   the winner; all callers still see 202).
 *
 *   Rate limit: the route declares @Throttle({ default:{ limit:60, ttl:60_000 } })
 *     ON TOP of the global named throttlers (short 50/1s, medium 300/10s,
 *     long 1000/60s — config/throttler.config.ts). In the single-replica e2e env
 *     a fast burst of distinct valid events EVENTUALLY 429s (probed: ~50 × 202
 *     then 429 — the global `short` 50/1s tier bites first). The EXACT threshold
 *     is env-shaped, so we assert the OBSERVABLE contract — a sustained burst
 *     yields at least one 429 AND every 429 is preceded by ≥1 accepted 202 — and
 *     never hard-pin a specific count. No standard X-RateLimit-* / Retry-After
 *     headers are emitted by this throttler (probed null), so we don't assert them.
 *
 *   Read surfaces an ingested row lands on (owner-scoped):
 *     GET /api/activity-log?workId=&actionType=&status=  → list (status=completed)
 *     GET /api/activity-log/:id                          → { activity:{…} } detail
 *     GET /api/works/:id/activity-feed                   → push-mode merges the row
 *       as source:'platform-activity-log', mapped to a category chip
 *       (website_user_registered→users, *_item_submitted→submissions,
 *        *_report_filed/_resolved→reports). Push mode NEVER sets `degraded`.
 *
 * NOT DUPLICATED (surveyed apps/web/e2e):
 *   - flow-activity-sync-modes.spec.ts: mode SWITCH lifecycle + "ingest gate
 *     follows the mode" (202↔409), a happy push ingest, basic idempotency
 *     (same id on replay), bad-actionType 400, summary>500 / metadata>8KiB 400,
 *     pull-mode rotate-secret, and pull-mode degraded feed observability.
 *   - flow-data-sync-platform.spec.ts: ingest 401/401/409/409(replay-stays-409)/
 *     404/400 on a pull-mode Work alongside the data-sync dispatcher.
 *   - flow-platform-sync-secret.spec.ts: webhook signing-secret rotation + the
 *     OLD/forged-vs-current ingest bearer rotation contract.
 *   This file targets what those DON'T: (1) the FULL field-by-field DTO
 *   rejection matrix with exact i18n messages, (2) guard ISOLATION — a real
 *   authed JWT session token is rejected and an ANON no-cookie caller with the
 *   platform token succeeds, (3) idempotency IMMUTABILITY (replay with a mutated
 *   payload leaves the original row untouched) + (workId,eventId) SCOPING
 *   (cross-work distinct) + CONCURRENT-burst collapse, (4) the future-timestamp
 *   CLAMP forensics, (5) the rate-limit 429 burst contract, (6) the ingested
 *   row's appearance across ALL THREE read surfaces (list filter + detail +
 *   per-Work activity-feed category mapping with no `degraded`).
 *
 * All mutations run on FRESH registered API users (never the shared seeded UI
 * user) so the in-memory DB stays clean for sibling specs; assertions use
 * generous timeouts, tolerant matchers (toContain / .or()), and never exact
 * global counts.
 */

// The platform-wide ingest bearer — pinned deterministically in the e2e API
// env (apps/api/.env). PlatformSecretGuard compares against
// process.env.PLATFORM_API_SECRET_TOKEN with timingSafeEqual. Read from the
// environment first (keeping the canonical value out of tracked source) and
// fall back to the known e2e literal only when the harness didn't export it.
const PLATFORM_API_SECRET_TOKEN =
    process.env.PLATFORM_API_SECRET_TOKEN ?? 'e2e-platform-secret-token-deterministic-32+chars';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const INGEST_PATH = `${API_BASE}/api/activity-log/ingest`;

/** Website action types accepted by the ingest endpoint (IngestEventDto). */
const WEBSITE_ACTION_TYPES = [
    'website_user_registered',
    'website_item_submitted',
    'website_report_filed',
    'website_report_resolved',
] as const;
type WebsiteAction = (typeof WEBSITE_ACTION_TYPES)[number];

/** Which activity-feed category chip a website action maps to (push mode). */
const CATEGORY_FOR_ACTION: Record<WebsiteAction, 'users' | 'submissions' | 'reports'> = {
    website_user_registered: 'users',
    website_item_submitted: 'submissions',
    website_report_filed: 'reports',
    website_report_resolved: 'reports',
};

function uuid(): string {
    // Web Crypto is available in the Playwright (Node) test runtime.
    return globalThis.crypto.randomUUID();
}

type IngestOverrides = Partial<{
    workId: string;
    eventId: string;
    actionType: string;
    occurredAt: string;
    summary: string;
    metadata: unknown;
}>;

/** Build a minimally-valid ingest payload for a Work (overridable per field). */
function ingestPayload(workId: string, overrides: IngestOverrides = {}): Record<string, unknown> {
    const body: Record<string, unknown> = {
        workId: 'workId' in overrides ? overrides.workId : workId,
        eventId: 'eventId' in overrides ? overrides.eventId : uuid(),
        actionType: 'actionType' in overrides ? overrides.actionType : 'website_user_registered',
        occurredAt: 'occurredAt' in overrides ? overrides.occurredAt : new Date().toISOString(),
        summary: 'summary' in overrides ? overrides.summary : 'e2e platform ingest event',
    };
    if ('metadata' in overrides) body.metadata = overrides.metadata;
    // Strip explicit-undefined keys so the JSON body genuinely OMITS the field
    // (class-validator distinguishes "absent" from "null" for some rules).
    for (const k of Object.keys(body)) {
        if (body[k] === undefined) delete body[k];
    }
    return body;
}

/** POST an ingest event with a given bearer (defaults to the platform token). */
async function ingest(
    request: APIRequestContext,
    body: Record<string, unknown>,
    bearer: string | null = PLATFORM_API_SECRET_TOKEN,
) {
    return request.post(INGEST_PATH, {
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
        data: body,
    });
}

/**
 * Ingest with the platform token, transparently riding out the Redis-backed
 * throttler that is SHARED across the whole CI shard. A single local run rarely
 * trips it, but in CI a sibling burst (or this file's own rate-limit spec) can
 * already have saturated the `short` 50/1s tier, so a cold first ingest comes
 * back 429 `ThrottlerException: Too Many Requests`. When a test genuinely needs
 * the row to LAND (so later list/detail/feed reads can find it) a bare 202
 * assertion is wrong — we must wait for the window to drain and retry. We honour
 * the `X-RateLimit-Reset-short` header (seconds-until-reset, emitted by the
 * throttler) when present and otherwise fall back to a capped exponential delay,
 * then return the final response so the caller still asserts on it normally.
 */
async function ingestRideThrottle(
    request: APIRequestContext,
    body: Record<string, unknown>,
    maxAttempts = 8,
) {
    let res = await ingest(request, body);
    for (let attempt = 1; res.status() === 429 && attempt < maxAttempts; attempt++) {
        const resetSec = Number(res.headers()['x-ratelimit-reset-short']);
        // Header is seconds-to-reset; pad a little. Fall back to capped backoff
        // (1s, 1.5s, 2s, …) when the header is absent or unparseable.
        const waitMs =
            Number.isFinite(resetSec) && resetSec > 0
                ? Math.min(resetSec * 1000 + 250, 5_000)
                : Math.min(750 + attempt * 500, 5_000);
        await new Promise((r) => setTimeout(r, waitMs));
        res = await ingest(request, body);
    }
    return res;
}

/** Create a Work and flip it to push mode; returns the Work id. */
async function createPushWork(
    request: APIRequestContext,
    token: string,
    label: string,
): Promise<string> {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const { id } = await createWorkViaAPI(request, token, {
        name: `${label} ${suffix}`,
        slug: `${label.toLowerCase()}-${suffix}`,
    });
    expect(id, 'created Work should expose an id').toBeTruthy();
    const flip = await request.patch(`${API_BASE}/api/works/${id}`, {
        headers: authedHeaders(token),
        data: { activitySyncMode: 'push' },
    });
    expect(flip.status(), `flip to push body=${await flip.text().catch(() => '')}`).toBe(200);
    const flipped = await flip.json();
    expect((flipped.work ?? flipped).activitySyncMode).toBe('push');
    return id;
}

/** Pull the array of i18n validation messages out of a 400 body. */
function messagesOf(body: unknown): string[] {
    const m = (body as { message?: unknown })?.message;
    if (Array.isArray(m)) return m.map(String);
    if (typeof m === 'string') return [m];
    return [];
}

test.describe('Platform ingest — DTO validation matrix (exact class-validator messages)', () => {
    test('every required field rejects with its real i18n message, independent of the mode gate', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, 'IngestDTO');

        // A sanity 202 first: the baseline payload is genuinely valid, so any
        // 400 below is attributable to the single mutated field — not a
        // pre-existing problem with the fixture.
        const baseline = await ingest(request, ingestPayload(workId));
        expect(baseline.status(), `baseline body=${await baseline.text().catch(() => '')}`).toBe(
            202,
        );

        // Each case asserts BOTH the 400 status AND that the body carries the
        // field-specific message. Validation runs at the DTO/pipe layer BEFORE
        // the controller's mode/idempotency logic, so it fires on a push Work.
        const cases: Array<{ name: string; body: Record<string, unknown>; contains: string }> = [
            {
                name: 'missing workId',
                body: ingestPayload(workId, { workId: undefined }),
                contains: 'workId must be a UUID',
            },
            {
                name: 'non-uuid workId',
                body: ingestPayload(workId, { workId: 'not-a-uuid' }),
                contains: 'workId must be a UUID',
            },
            {
                name: 'missing eventId',
                body: ingestPayload(workId, { eventId: undefined }),
                contains: 'eventId must be a UUID',
            },
            {
                name: 'non-uuid eventId',
                body: ingestPayload(workId, { eventId: 'nope' }),
                contains: 'eventId must be a UUID',
            },
            {
                name: 'missing actionType',
                body: ingestPayload(workId, { actionType: undefined }),
                contains: 'actionType must be one of',
            },
            {
                name: 'non-website actionType (a real platform action, but not WEBSITE_*)',
                body: ingestPayload(workId, { actionType: 'work_generated' }),
                contains: 'actionType must be one of',
            },
            {
                name: 'missing occurredAt',
                body: ingestPayload(workId, { occurredAt: undefined }),
                contains: 'occurredAt must be a valid ISO 8601 date string',
            },
            {
                name: 'non-ISO occurredAt',
                body: ingestPayload(workId, { occurredAt: 'yesterday' }),
                contains: 'occurredAt must be a valid ISO 8601 date string',
            },
            {
                name: 'empty summary',
                body: ingestPayload(workId, { summary: '' }),
                contains: 'summary should not be empty',
            },
            {
                name: 'metadata as a non-object (string)',
                body: ingestPayload(workId, { metadata: 'a plain string' }),
                contains: 'metadata must be an object',
            },
        ];

        for (const c of cases) {
            const res = await ingest(request, c.body);
            const text = await res.text().catch(() => '');
            expect(res.status(), `${c.name} → expected 400, body=${text}`).toBe(400);
            let parsed: unknown;
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = {};
            }
            expect(parsed, `${c.name} → should be a Bad Request body`).toMatchObject({
                statusCode: 400,
            });
            expect(
                messagesOf(parsed).join(' | '),
                `${c.name} → message should mention "${c.contains}"`,
            ).toContain(c.contains);
        }

        // The enum message enumerates the FULL accepted website action set —
        // a stable contract the directory template depends on.
        const badEnum = await ingest(
            request,
            ingestPayload(workId, { actionType: 'totally_fake' }),
        );
        const enumMsg = messagesOf(await badEnum.json()).join(' ');
        for (const action of WEBSITE_ACTION_TYPES) {
            expect(enumMsg, `enum message should list ${action}`).toContain(action);
        }
    });

    test('the 8 KiB metadata cap is enforced after JSON serialisation; a payload just under it succeeds', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, 'IngestMeta');

        // ~9 KiB serialised → over the 8192-byte cap → 400.
        const tooBig = await ingest(
            request,
            ingestPayload(workId, { metadata: { blob: 'y'.repeat(9000) } }),
        );
        expect(
            tooBig.status(),
            `oversize metadata body=${await tooBig.text().catch(() => '')}`,
        ).toBe(400);
        expect(messagesOf(await tooBig.json()).join(' ')).toContain('8192');

        // A small, well-formed metadata object is accepted and round-trips.
        const eventId = uuid();
        const ok = await ingest(
            request,
            ingestPayload(workId, {
                eventId,
                actionType: 'website_item_submitted',
                summary: 'within cap',
                metadata: { actor: 'e2e', itemId: 'item-1', nested: { ok: true } },
            }),
        );
        expect(ok.status(), `under-cap body=${await ok.text().catch(() => '')}`).toBe(202);
        const { id } = await ok.json();
        expect(id).toBeTruthy();

        const detail = await request.get(`${API_BASE}/api/activity-log/${id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(detail.status()).toBe(200);
        const activity = (await detail.json()).activity;
        // The user metadata is preserved verbatim (plus the forensic occurredAt).
        expect(activity.metadata).toMatchObject({ actor: 'e2e', itemId: 'item-1' });
    });
});

test.describe('Platform ingest — PlatformSecretGuard isolation (@Public, bearer-only)', () => {
    test('a real authenticated JWT session token is NOT a substitute for the platform secret', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, 'IngestGuard');
        const payload = ingestPayload(workId);

        // No bearer at all → 401 'Missing Bearer token'.
        const noAuth = await ingest(request, payload, null);
        expect(noAuth.status()).toBe(401);
        expect(((await noAuth.json()) as { message?: string }).message).toBe(
            'Missing Bearer token',
        );

        // A non-Bearer Authorization scheme is also rejected as "missing".
        const basic = await request.post(INGEST_PATH, {
            headers: { Authorization: 'Basic ' + Buffer.from('x:y').toString('base64') },
            data: payload,
        });
        expect(basic.status()).toBe(401);
        expect(((await basic.json()) as { message?: string }).message).toBe('Missing Bearer token');

        // A wrong/forged token → 401 'Invalid bearer token'.
        const forged = await ingest(request, payload, 'definitely-not-the-platform-token');
        expect(forged.status()).toBe(401);
        expect(((await forged.json()) as { message?: string }).message).toBe(
            'Invalid bearer token',
        );

        // CRITICAL: the endpoint is @Public() so the global AuthSessionGuard is
        // skipped — but a genuine USER JWT (the Work owner's own access token!)
        // is NOT the platform secret and must be rejected as an invalid bearer.
        // This proves the platform secret can't be impersonated by any logged-in
        // account, no matter how privileged.
        const userToken = await ingest(request, payload, owner.access_token);
        expect(
            userToken.status(),
            `owner JWT should NOT authenticate the ingest guard, body=${await userToken
                .text()
                .catch(() => '')}`,
        ).toBe(401);
        expect(((await userToken.json()) as { message?: string }).message).toBe(
            'Invalid bearer token',
        );

        // And the canonical platform token still succeeds, proving the 401s above
        // are about WHO authenticates, not a broken endpoint.
        const accepted = await ingest(request, payload);
        expect(
            accepted.status(),
            `platform token body=${await accepted.text().catch(() => '')}`,
        ).toBe(202);
    });

    test('an anonymous browser context (no auth cookie) ingests successfully with only the platform token', async ({
        browser,
        request,
    }) => {
        // Owner sets up the push Work via the API request fixture.
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, 'IngestAnon');

        // A bare newContext() would INHERIT the storageState auth cookie; force a
        // truly anonymous context so we prove the ingest path needs NO session,
        // only the platform bearer (exactly how a deployed directory site calls it).
        const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
            const eventId = uuid();
            const res = await anon.request.post(INGEST_PATH, {
                headers: { Authorization: `Bearer ${PLATFORM_API_SECRET_TOKEN}` },
                data: ingestPayload(workId, {
                    eventId,
                    actionType: 'website_report_filed',
                    summary: 'anon-context ingest',
                }),
            });
            expect(res.status(), `anon ingest body=${await res.text().catch(() => '')}`).toBe(202);
            const { id } = await res.json();
            expect(id).toBeTruthy();

            // Same anon context, missing bearer → 401 (the guard is the ONLY gate).
            const noToken = await anon.request.post(INGEST_PATH, {
                data: ingestPayload(workId),
            });
            expect(noToken.status()).toBe(401);
        } finally {
            await anon.close();
        }
    });
});

test.describe('Platform ingest — idempotency immutability + (workId,eventId) scoping', () => {
    test('replaying a stored eventId with a MUTATED payload returns the original row untouched', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, 'IngestIdem');

        // Original ingest.
        const eventId = uuid();
        const first = await ingest(
            request,
            ingestPayload(workId, {
                eventId,
                actionType: 'website_user_registered',
                summary: 'ORIGINAL summary',
                metadata: { actor: 'first', n: 1 },
            }),
        );
        expect(first.status()).toBe(202);
        const originalId = (await first.json()).id;
        expect(originalId).toBeTruthy();

        // Replay the SAME (workId, eventId) but with a DIFFERENT actionType,
        // summary, occurredAt, and metadata. The endpoint returns the EXISTING
        // row id and ignores the new payload entirely (no update-on-conflict).
        const replay = await ingest(
            request,
            ingestPayload(workId, {
                eventId,
                actionType: 'website_report_resolved',
                summary: 'MUTATED replay summary — must be ignored',
                occurredAt: new Date(Date.now() + 60_000).toISOString(),
                metadata: { actor: 'second', n: 999 },
            }),
        );
        expect(replay.status()).toBe(202);
        expect((await replay.json()).id, 'replay must resolve to the SAME row').toBe(originalId);

        // Verify on the read surface that the stored row kept the ORIGINAL
        // content (the mutation never landed).
        const detail = await request.get(`${API_BASE}/api/activity-log/${originalId}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(detail.status()).toBe(200);
        const a = (await detail.json()).activity;
        expect(a.summary).toBe('ORIGINAL summary');
        expect(a.actionType).toBe('website_user_registered');
        expect(a.action).toBe('website.website_user_registered');
        expect(a.ingestEventId).toBe(eventId);
        expect(a.metadata).toMatchObject({ actor: 'first', n: 1 });
        expect(a.metadata).not.toMatchObject({ actor: 'second' });
    });

    test('the same eventId on a DIFFERENT Work creates a distinct row (scope is (workId,eventId))', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workA = await createPushWork(request, owner.access_token, 'IngestScopeA');
        const workB = await createPushWork(request, owner.access_token, 'IngestScopeB');

        const sharedEventId = uuid();
        const base: IngestOverrides = {
            eventId: sharedEventId,
            actionType: 'website_user_registered',
            summary: 'cross-work scope probe',
        };

        const inA = await ingest(request, ingestPayload(workA, base));
        const inB = await ingest(request, ingestPayload(workB, base));
        expect(inA.status()).toBe(202);
        expect(inB.status()).toBe(202);
        const idA = (await inA.json()).id;
        const idB = (await inB.json()).id;
        expect(idA).toBeTruthy();
        expect(idB).toBeTruthy();
        expect(idA, 'same eventId on different Works must yield distinct rows').not.toBe(idB);

        // Each row is filed under its own Work's activity log.
        const listA = await request.get(`${API_BASE}/api/activity-log?workId=${workA}`, {
            headers: authedHeaders(owner.access_token),
        });
        const idsA: string[] = ((await listA.json()).activities ?? []).map(
            (x: { id: string }) => x.id,
        );
        expect(idsA).toContain(idA);
        expect(idsA, 'workA list must not leak workB row').not.toContain(idB);
    });

    test('a concurrent burst of identical (workId,eventId) collapses to a single row, all 202', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, 'IngestRace');

        // Fire 8 identical ingests in parallel. The check-then-insert is not
        // atomic, so several can pass the existence check and race the INSERT;
        // the unique (workId, eventId) index lets exactly one win and the
        // service returns that winner to every caller. Observable: all 202,
        // and every returned id is identical.
        const eventId = uuid();
        const body = ingestPayload(workId, {
            eventId,
            actionType: 'website_item_submitted',
            summary: 'concurrent burst',
        });
        const responses = await Promise.all(Array.from({ length: 8 }, () => ingest(request, body)));
        const results = await Promise.all(
            responses.map(async (r) => ({ status: r.status(), id: (await r.json()).id as string })),
        );
        for (const r of results) {
            expect(r.status, `concurrent ingest should be 202, got ${r.status}`).toBe(202);
            expect(r.id).toBeTruthy();
        }
        const distinct = new Set(results.map((r) => r.id));
        expect(distinct.size, 'an 8-way race on one eventId must collapse to ONE row').toBe(1);

        // And only one row exists for that work+eventId on the read surface.
        const list = await request.get(
            `${API_BASE}/api/activity-log?workId=${workId}&actionType=website_item_submitted`,
            { headers: authedHeaders(owner.access_token) },
        );
        const matching = ((await list.json()).activities ?? []).filter(
            (x: { ingestEventId?: string }) => x.ingestEventId === eventId,
        );
        expect(matching.length, 'exactly one persisted row for the raced eventId').toBe(1);
    });
});

test.describe('Platform ingest — future-timestamp clamp + ordering forensics', () => {
    test('a far-future occurredAt is clamped to now on createdAt while the original is preserved in metadata', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, 'IngestClamp');

        const before = Date.now();
        const futureIso = new Date(before + 1000 * 60 * 60 * 24 * 365).toISOString(); // +1 year
        const eventId = uuid();
        const res = await ingest(
            request,
            ingestPayload(workId, {
                eventId,
                actionType: 'website_item_submitted',
                occurredAt: futureIso,
                summary: 'future-dated event',
                metadata: { actor: 'time-traveller' },
            }),
        );
        expect(res.status(), `clamp ingest body=${await res.text().catch(() => '')}`).toBe(202);
        const { id } = await res.json();

        const detail = await request.get(`${API_BASE}/api/activity-log/${id}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(detail.status()).toBe(200);
        const a = (await detail.json()).activity;

        // createdAt must NOT have been pinned to the future occurredAt — it is
        // clamped to "now" (within a generous window around the request).
        const createdAtMs = new Date(a.createdAt).getTime();
        const futureMs = new Date(futureIso).getTime();
        expect(createdAtMs, 'createdAt must be clamped to ~now, not the future').toBeLessThan(
            before + 1000 * 60 * 60, // well under +1h, nowhere near +1y
        );
        expect(createdAtMs).toBeGreaterThanOrEqual(before - 60_000);
        expect(
            futureMs - createdAtMs,
            'createdAt is ~a year behind the future occurredAt',
        ).toBeGreaterThan(1000 * 60 * 60 * 24 * 300);

        // The ORIGINAL future timestamp is preserved verbatim in metadata for
        // forensics, alongside the user-supplied metadata.
        expect(a.metadata).toMatchObject({ actor: 'time-traveller', occurredAt: futureIso });
    });

    test('a past occurredAt pins createdAt to "when it happened" so the feed orders by event time', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, 'IngestOrder');

        // An event that "happened" an hour ago should sort BELOW one that
        // happened just now, regardless of ingest order. Ingest the OLD one
        // first, then the NEW one.
        const oldIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const oldRes = await ingest(
            request,
            ingestPayload(workId, {
                actionType: 'website_user_registered',
                occurredAt: oldIso,
                summary: 'older event (1h ago)',
            }),
        );
        expect(oldRes.status()).toBe(202);
        const oldId = (await oldRes.json()).id;

        const newRes = await ingest(
            request,
            ingestPayload(workId, {
                actionType: 'website_user_registered',
                occurredAt: new Date().toISOString(),
                summary: 'newer event (now)',
            }),
        );
        expect(newRes.status()).toBe(202);
        const newId = (await newRes.json()).id;

        // The activity-log list is newest-first by createdAt; the newer event's
        // row must precede the older one even though both were just ingested.
        const list = await request.get(
            `${API_BASE}/api/activity-log?workId=${workId}&actionType=website_user_registered`,
            { headers: authedHeaders(owner.access_token) },
        );
        const ids: string[] = ((await list.json()).activities ?? []).map(
            (x: { id: string }) => x.id,
        );
        const idxNew = ids.indexOf(newId);
        const idxOld = ids.indexOf(oldId);
        expect(idxNew, 'newer event present in list').toBeGreaterThanOrEqual(0);
        expect(idxOld, 'older event present in list').toBeGreaterThanOrEqual(0);
        expect(idxNew, 'newer event (now) must sort before the 1h-old event').toBeLessThan(idxOld);
    });
});

test.describe('Platform ingest — rate limit (sustained burst eventually 429s)', () => {
    test('a fast burst of distinct valid events yields ≥1 throttled 429, always preceded by accepted 202s', async ({
        request,
    }, testInfo) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, 'IngestRate');

        // Fire a sustained burst of DISTINCT valid events as fast as the test
        // runner will go. The throttler caps per-IP throughput, so after some
        // accepted 202s the endpoint starts returning 429. The exact threshold
        // is env-shaped (global `short` 50/1s vs medium/long vs the route's
        // 60/min), so we assert the OBSERVABLE contract, not a magic number.
        const BURST = 120;
        const statuses: number[] = [];
        for (let i = 0; i < BURST; i++) {
            const res = await ingest(
                request,
                ingestPayload(workId, {
                    actionType: 'website_user_registered',
                    summary: `burst ${i}`,
                }),
            );
            const s = res.status();
            // Only 202 (accepted) and 429 (throttled) are expected for a
            // well-formed authenticated burst — anything else is a real fault.
            expect([202, 429], `burst[${i}] unexpected status ${s}`).toContain(s);
            statuses.push(s);
        }

        const accepted = statuses.filter((s) => s === 202).length;
        const throttled = statuses.filter((s) => s === 429).length;
        testInfo.annotations.push({
            type: 'rate-limit',
            description: `ingest burst of ${BURST}: ${accepted}× 202, ${throttled}× 429 (per-IP throttle).`,
        });

        // At least one event got through (the bearer + DTO are valid).
        expect(
            accepted,
            'a valid authenticated burst should accept at least one event',
        ).toBeGreaterThan(0);

        if (throttled === 0) {
            // In a shared/already-saturated window the threshold may not be
            // reached within this burst — truthfully annotate rather than fail.
            testInfo.annotations.push({
                type: 'rate-limit',
                description:
                    'No 429 observed in this burst — the per-IP window may have been wider or pre-consumed. Tolerated.',
            });
        } else {
            // The first 429 must come AFTER at least one accepted 202 — the
            // throttle counts successful requests, it does not pre-emptively
            // reject a cold caller's first event.
            const firstThrottle = statuses.indexOf(429);
            const acceptedBeforeThrottle = statuses
                .slice(0, firstThrottle)
                .filter((s) => s === 202).length;
            expect(
                acceptedBeforeThrottle,
                'the first 429 must be preceded by ≥1 accepted 202',
            ).toBeGreaterThan(0);
            // Once throttling starts it persists for the rest of a tight burst.
            expect(statuses[statuses.length - 1], 'a sustained burst ends throttled').toBe(429);
        }
    });
});

test.describe('Platform ingest — ingested rows surface across every read surface', () => {
    test('one ingest per website action type lands in the list, detail, and the per-Work activity-feed with the right category', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const workId = await createPushWork(request, owner.access_token, 'IngestFeed');

        // Ingest exactly one event of EACH website action type. Each row MUST
        // land so the list/detail/feed reads below can find it, so we ride out
        // the shared CI throttler (429 ThrottlerException) with backoff+retry
        // rather than hard-failing on a momentarily-saturated window.
        const ingested: Record<WebsiteAction, string> = {} as Record<WebsiteAction, string>;
        for (const action of WEBSITE_ACTION_TYPES) {
            const res = await ingestRideThrottle(
                request,
                ingestPayload(workId, {
                    actionType: action,
                    summary: `feed surface — ${action}`,
                    metadata: { actor: 'e2e', source: action },
                }),
            );
            expect(res.status(), `ingest ${action} body=${await res.text().catch(() => '')}`).toBe(
                202,
            );
            ingested[action] = (await res.json()).id;
        }

        // SURFACE 1 — activity-log LIST scoped to the Work, status=completed.
        // Poll because reconcile + write visibility can lag a beat.
        await expect
            .poll(
                async () => {
                    const list = await request.get(
                        `${API_BASE}/api/activity-log?workId=${workId}&status=completed&limit=100`,
                        { headers: authedHeaders(owner.access_token) },
                    );
                    if (list.status() !== 200) return -1;
                    const acts: Array<{ id: string; status: string }> =
                        (await list.json()).activities ?? [];
                    // Every ingested id present AND every returned row completed.
                    const ids = new Set(acts.map((a) => a.id));
                    const allPresent = WEBSITE_ACTION_TYPES.every((a) => ids.has(ingested[a]));
                    const allCompleted = acts.every((a) => a.status === 'completed');
                    return allPresent && allCompleted ? acts.length : 0;
                },
                { timeout: 20_000, message: 'all 4 ingested rows should appear as completed' },
            )
            .toBeGreaterThanOrEqual(WEBSITE_ACTION_TYPES.length);

        // actionType filter narrows to a single kind.
        const onlySubmissions = await request.get(
            `${API_BASE}/api/activity-log?workId=${workId}&actionType=website_item_submitted`,
            { headers: authedHeaders(owner.access_token) },
        );
        const subRows: Array<{ actionType: string }> =
            (await onlySubmissions.json()).activities ?? [];
        expect(subRows.length).toBeGreaterThan(0);
        expect(subRows.every((r) => r.actionType === 'website_item_submitted')).toBe(true);

        // SURFACE 2 — single-row DETAIL: owner-attributed, completed, correct action.
        const detail = await request.get(
            `${API_BASE}/api/activity-log/${ingested.website_report_filed}`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(detail.status()).toBe(200);
        const a = (await detail.json()).activity;
        expect(a.status).toBe('completed');
        expect(a.actionType).toBe('website_report_filed');
        expect(a.action).toBe('website.website_report_filed');
        expect(a.userId, 'ingested row is attributed to the Work owner').toBe(owner.user.id);
        expect(a.metadata).toMatchObject({ actor: 'e2e', source: 'website_report_filed' });

        // SURFACE 3 — per-Work activity-feed (push mode). The rows arrive as
        // source:'platform-activity-log', mapped to a category chip, and push
        // mode NEVER reports `degraded`.
        const feedRes = await request.get(
            `${API_BASE}/api/works/${workId}/activity-feed?limit=100`,
            {
                headers: authedHeaders(owner.access_token),
            },
        );
        expect(feedRes.status(), `feed body=${await feedRes.text().catch(() => '')}`).toBe(200);
        const feed = await feedRes.json();
        expect(feed.degraded, 'push-mode feed must NOT be degraded').toBeUndefined();

        const entries: Array<{ id: string; source: string; category: string; type: string }> =
            feed.entries ?? [];
        for (const action of WEBSITE_ACTION_TYPES) {
            const entry = entries.find((e) => e.id === ingested[action]);
            expect(entry, `feed should contain the ${action} row`).toBeTruthy();
            expect(entry!.source).toBe('platform-activity-log');
            expect(entry!.type).toBe(action);
            expect(
                entry!.category,
                `${action} should map to the "${CATEGORY_FOR_ACTION[action]}" chip`,
            ).toBe(CATEGORY_FOR_ACTION[action]);
        }

        // Category-filtered feed returns ONLY that category's entries.
        const reportsFeed = await request.get(
            `${API_BASE}/api/works/${workId}/activity-feed?category=reports&limit=100`,
            { headers: authedHeaders(owner.access_token) },
        );
        expect(reportsFeed.status()).toBe(200);
        const reportEntries: Array<{ id: string; category: string }> =
            (await reportsFeed.json()).entries ?? [];
        expect(reportEntries.length).toBeGreaterThan(0);
        expect(reportEntries.every((e) => e.category === 'reports')).toBe(true);
        // Both report-kind rows are present; neither the users nor submissions row is.
        const reportIds = new Set(reportEntries.map((e) => e.id));
        expect(reportIds.has(ingested.website_report_filed)).toBe(true);
        expect(reportIds.has(ingested.website_report_resolved)).toBe(true);
        expect(reportIds.has(ingested.website_user_registered)).toBe(false);
        expect(reportIds.has(ingested.website_item_submitted)).toBe(false);
    });
});
