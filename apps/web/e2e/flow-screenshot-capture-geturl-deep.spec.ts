import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI } from './helpers/api';
import { enablePluginViaAPI } from './helpers/plugins';

/**
 * Screenshot capture / get-url — FINAL deep batch. This file is the third
 * screenshot spec and deliberately pins ONLY the seams the prior three leave
 * open. The covered ground (do NOT re-assert it here) is:
 *   - `flow-plugin-screenshot.spec.ts`: registry schema, fresh-user isolation,
 *     enable/disable lifecycle, half-key vs both-key capture failure, png signed
 *     url, multi-provider sort, providerOverride routing, basic IsUrl/missing-url.
 *   - `flow-screenshot-capability-contract.spec.ts`: the full DTO bounds/enum/
 *     UUID/whitelist REJECTION matrix + exact messages, user-vs-work scope
 *     independence, work-enable 403, cross-USER 403 + no-secret-leak, gating
 *     ORDER (DTO→gate), default sort, disable re-arm, explicit blockAds:false.
 *   - `flow-screenshot-capability-deep.spec.ts`: SSRF on 127.0.0.1/169.254/10.x,
 *     protocol/TLD IsUrl layer, the delay-ms→s + jpg + trackers + cookie-banners
 *     option set, omitted-flag defaults, determinism, foreign-but-NONEXISTENT
 *     workId 404 (+ non-v4 400), owner own-work gate, both-key upstream 400,
 *     urlbox override shape, unknown-override non-2xx, anon 401, get-url
 *     no-base64/no-cacheUrl.
 *
 * GAPS pinned below (each PROBED live, 127.0.0.1:3100, 2026-06-12) — the prior
 * specs only ever assert option REJECTIONS or a couple of accepted options;
 * none pin the ACCEPTED bound boundaries, the webp encoding, the explicit-false
 * permutation that DROPS the cookie-banner param, the empty-string override
 * fall-back, the providerOverride/viewport TYPE messages, the broader SSRF
 * vectors (IPv6 / decimal-IP / 172.16 / 192.168), the empty-string `workId=`
 * query coercion, the capture error-envelope KEY SET, or activeProvider===
 * providers[0] identity:
 *
 * PROBED CONTRACTS (live, 2026-06-12):
 *   - get-url ACCEPTED bound boundaries are inclusive: viewportWidth 320 & 3840,
 *       viewportHeight 240 & 2160, delay 0 & 10000 all → 201 and encode into the
 *       signed url. delay encodes in SECONDS (0→`delay=0`, 10000ms→`delay=10`).
 *   - `format:'webp'` → `format=webp` (the deep spec only pinned jpg; contract
 *       used webp once but for an EXPLICIT-false-flag url, not the boundary set).
 *   - EXPLICIT-false permutation `{blockAds:false,blockTrackers:false,
 *       blockCookieBanners:false}` → `block_ads=false` AND `block_trackers=false`
 *       are emitted, but `block_cookie_banners` is ABSENT entirely (the cookie
 *       param is emitted ONLY when true — there is no `block_cookie_banners=false`
 *       form). This is the inverse of the deep spec's omitted-default case.
 *   - EMPTY-STRING providerOverride (`providerOverride:''`) is treated as "no
 *       override": → 201 routed to the default (screenshotone) signed url — NOT a
 *       400 and NOT an unknown-override rejection.
 *   - providerOverride of the WRONG TYPE (number) → 400
 *       { message:['providerOverride must be a string'] }.
 *   - viewportWidth as a STRING ('500') → 400; class-validator emits all three
 *       failing constraints together: 'must not be greater than 3840',
 *       'must not be less than 320', AND 'must be a number conforming to the
 *       specified constraints' (IsNumber rejects the string; Min/Max also fire).
 *   - delay below min (-1) → 400 { message:['delay must not be less than 0'] }
 *       (the contract spec only pins the ABOVE-max message).
 *   - SSRF breadth: `https://[::1]/x` (IPv6 loopback) and `https://192.168.1.1/x`
 *       / `https://172.16.0.1/x` (RFC-1918) → 400 ['URL is not allowed'] (they
 *       pass @IsUrl but the SSRF constraint blocks). A DECIMAL-IP host
 *       `https://2130706433/x` (=127.0.0.1) → 400 with BOTH messages
 *       ['URL is not allowed','url must be a URL address'] (it ALSO trips IsUrl's
 *       require_tld). Both ops (capture+get-url) share the guard.
 *   - EMPTY-STRING `workId=` query on check-availability → 200 personal scope
 *       (NOT a 404). An empty string coerces to "no work", so it returns the
 *       USER-level providers — distinct from a populated foreign workId (404).
 *   - capture FAILURE envelope (bogus keys) carries EXACTLY keys
 *       {status:'error', message:'…'} — NO imageUrl / cacheUrl / imageBase64 keys
 *       at all (not merely falsy: ABSENT). Full options still reach the provider
 *       and surface a truthful upstream 400, never a fabricated 2xx, never a 5xx.
 *   - activeProvider on check-availability is the SAME ProviderOption as the
 *       configured default in `providers` (id + icon descriptor match) and the
 *       icon is { type:'lucide', value:'Camera', backgroundColor:'#4f46e5' }.
 *
 * ISOLATION: every test registers a FRESH user; screenshot keys are written at
 * the USER scope and would shadow the env key for sibling specs, so the shared
 * seeded user is never touched. Unique suffixes come from the per-test title +
 * a module counter — never a module-scope clock or module-scope await.
 *
 * Filename uses the safe `flow-` prefix (not matched by the no-auth testIgnore
 * regex in playwright.config.ts) and is fully API-orchestrated — no UI contention.
 */

interface ProviderOption {
    id: string;
    name: string;
    description?: string;
    configured: boolean;
    isDefault?: boolean;
    icon?: { type?: string; value?: string; backgroundColor?: string };
}

interface AvailabilityResponse {
    status: string;
    available: boolean;
    providers: ProviderOption[];
    activeProvider: ProviderOption | null;
}

let SUFFIX_COUNTER = 0;
/** Per-test unique suffix — built from the test title, never a module-scope clock. */
function uniqueSuffix(title: string): string {
    SUFFIX_COUNTER += 1;
    return `${title.replace(/[^a-z0-9]+/gi, '').slice(0, 8)}${SUFFIX_COUNTER}${Math.random()
        .toString(36)
        .slice(2, 7)}`;
}

const FAKE_SO_KEYS = (s: string) => ({ accessKey: `acc-${s}`, secretKey: `sec-${s}` });

async function freshToken(request: APIRequestContext): Promise<string> {
    return (await registerUserViaAPI(request)).access_token;
}

async function checkAvailability(
    request: APIRequestContext,
    token: string,
    rawWorkIdParam?: string,
): Promise<{ status: number; body: AvailabilityResponse }> {
    // `rawWorkIdParam` is appended verbatim (NOT re-encoded) so we can probe the
    // empty-string `workId=` coercion case faithfully.
    const url =
        rawWorkIdParam !== undefined
            ? `${API_BASE}/api/screenshot/check-availability?workId=${rawWorkIdParam}`
            : `${API_BASE}/api/screenshot/check-availability`;
    const res = await request.get(url, { headers: authedHeaders(token) });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as AvailabilityResponse,
    };
}

async function postScreenshot(
    request: APIRequestContext,
    token: string,
    op: 'capture' | 'get-url',
    data: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await request.post(`${API_BASE}/api/screenshot/${op}`, {
        headers: authedHeaders(token),
        data,
    });
    return {
        status: res.status(),
        body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
}

/** Flatten class-validator `message` (string | string[]) into one string. */
function messageText(body: Record<string, unknown>): string {
    const m = body.message;
    if (Array.isArray(m)) return m.join(' | ');
    return String(m ?? '');
}

/** Enable screenshotone with both fake keys and wait until availability flips. */
async function enableConfigured(
    request: APIRequestContext,
    token: string,
    suffix: string,
): Promise<void> {
    await enablePluginViaAPI(request, token, 'screenshotone', {
        secretSettings: FAKE_SO_KEYS(suffix),
    });
    await expect
        .poll(async () => (await checkAvailability(request, token)).body.available, {
            timeout: 15_000,
            message: 'screenshotone availability flips true after enable',
        })
        .toBe(true);
}

test.describe('Screenshot capture/get-url — final deep: bounds, type guards, SSRF breadth, envelopes', () => {
    test('get-url accepts the INCLUSIVE bound boundaries (viewport 320/3840 & 240/2160, delay 0/10000)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableConfigured(request, token, uniqueSuffix(testInfo.title));

        // The contract spec pins only REJECTIONS just outside each bound; here we
        // prove the bounds are INCLUSIVE and that the accepted values are encoded.
        const min = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            viewportWidth: 320,
            viewportHeight: 240,
            delay: 0,
        });
        expect(min.status, 'min boundaries accepted → 201').toBe(201);
        const minUrl = String(min.body.imageUrl ?? '');
        expect(minUrl, 'viewport_width=320 (min) honoured').toContain('viewport_width=320');
        expect(minUrl, 'viewport_height=240 (min) honoured').toContain('viewport_height=240');
        // delay=0 is emitted verbatim (the seconds conversion of 0ms is still 0).
        expect(minUrl, 'delay=0 encoded').toContain('delay=0');

        const max = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            viewportWidth: 3840,
            viewportHeight: 2160,
            delay: 10000,
        });
        expect(max.status, 'max boundaries accepted → 201').toBe(201);
        const maxUrl = String(max.body.imageUrl ?? '');
        expect(maxUrl, 'viewport_width=3840 (max) honoured').toContain('viewport_width=3840');
        expect(maxUrl, 'viewport_height=2160 (max) honoured').toContain('viewport_height=2160');
        // 10000ms is the inclusive max and encodes as 10 SECONDS.
        expect(maxUrl, 'delay 10000ms → delay=10 (seconds)').toContain('delay=10');
    });

    test('get-url honours format:webp (third enum member) in the signed url', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableConfigured(request, token, uniqueSuffix(testInfo.title));

        // The deep spec pins jpg; the contract uses webp only on an explicit-false
        // url. Here webp is the sole knob, so the encoding is unambiguous.
        const res = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            format: 'webp',
        });
        expect(res.status, 'webp get-url → 201').toBe(201);
        const url = String(res.body.imageUrl ?? '');
        expect(url, 'screenshotone take endpoint').toContain('api.screenshotone.com/take');
        expect(url, 'format=webp honoured').toContain('format=webp');
        expect(url, 'still HMAC signed').toContain('signature=');
    });

    test('explicit-false flags: block_ads=false & block_trackers=false emitted, cookie-banner DROPPED', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableConfigured(request, token, uniqueSuffix(testInfo.title));

        // The contract spec pins block_ads=false alone. The distinctive seam is
        // that block_cookie_banners has NO `=false` form: it is simply absent when
        // not true. This is the inverse of the deep spec's omitted-default case
        // (where ads+trackers default to TRUE).
        const res = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            blockAds: false,
            blockTrackers: false,
            blockCookieBanners: false,
        });
        expect(res.status, 'explicit-false flags → 201').toBe(201);
        const url = String(res.body.imageUrl ?? '');
        expect(url, 'explicit block_ads=false survives').toContain('block_ads=false');
        expect(url, 'explicit block_trackers=false survives').toContain('block_trackers=false');
        // There is NO `block_cookie_banners=false` form — the param is dropped.
        expect(url, 'no block_cookie_banners param when false').not.toContain(
            'block_cookie_banners',
        );
    });

    test('empty-string providerOverride is treated as "no override" → routed to the default provider', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableConfigured(request, token, uniqueSuffix(testInfo.title));

        // An empty string must NOT be treated as an unknown provider (which would
        // be a non-2xx) — it falls back to the configured default (screenshotone).
        const res = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            providerOverride: '',
        });
        expect(res.status, 'empty override falls back → 201').toBe(201);
        expect(res.body.status, 'success envelope').toBe('success');
        expect(String(res.body.imageUrl ?? ''), 'routed to the default screenshotone').toContain(
            'api.screenshotone.com/take',
        );
    });

    test('DTO type guards: providerOverride must be a string; viewportWidth string trips IsNumber+bounds', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // These run BEFORE the provider gate (no provider enabled), so they are
        // pure class-validator 400s — distinct messages the other specs miss.
        const overrideType = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            providerOverride: 123,
        });
        expect(overrideType.status, 'numeric providerOverride → 400').toBe(400);
        expect(messageText(overrideType.body), 'providerOverride type message').toMatch(
            /providerOverride must be a string/i,
        );

        // A STRING viewportWidth fails IsNumber AND (because the string isn't a
        // number) the Min/Max comparisons too — all three messages are surfaced.
        const vpString = await postScreenshot(request, token, 'capture', {
            url: 'https://example.com',
            viewportWidth: '500',
        });
        expect(vpString.status, 'string viewportWidth → 400').toBe(400);
        const msg = messageText(vpString.body);
        expect(msg, 'IsNumber message present').toMatch(
            /viewportWidth must be a number conforming to the specified constraints/i,
        );
        expect(msg, 'Min message also fires for a non-number').toMatch(
            /viewportWidth must not be less than 320/i,
        );

        // delay BELOW min (-1) — the contract spec only pins the above-max form.
        const delayLow = await postScreenshot(request, token, 'capture', {
            url: 'https://example.com',
            delay: -1,
        });
        expect(delayLow.status, 'delay below min → 400').toBe(400);
        expect(messageText(delayLow.body), 'delay min message').toMatch(
            /delay must not be less than 0/i,
        );
    });

    test('SSRF breadth: IPv6 loopback & RFC-1918 private hosts → "URL is not allowed" on both ops', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // These all pass @IsUrl (https + TLD-shaped or bracketed-IPv6) but are
        // blocked by the IsNotSsrfUrl constraint. The deep spec covers 127.0.0.1
        // / 169.254 / 10.x; this widens to IPv6 loopback and the other two
        // RFC-1918 ranges (172.16/12 and 192.168/16).
        const ssrfAllowedByIsUrl = [
            'https://[::1]/x', // IPv6 loopback
            'https://192.168.1.1/x', // RFC-1918 192.168/16
            'https://172.16.0.1/x', // RFC-1918 172.16/12
        ];
        for (const op of ['capture', 'get-url'] as const) {
            for (const url of ssrfAllowedByIsUrl) {
                const res = await postScreenshot(request, token, op, { url });
                expect(res.status, `${op}: SSRF ${url} → 400`).toBe(400);
                expect(messageText(res.body), `${op}: ${url} → 'URL is not allowed'`).toMatch(
                    /URL is not allowed/i,
                );
            }
        }
    });

    test('SSRF decimal-IP host trips BOTH the SSRF guard AND IsUrl require_tld', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // `https://2130706433/x` is the integer form of 127.0.0.1. It has no TLD
        // (so @IsUrl require_tld rejects it) AND the host is loopback (so the SSRF
        // constraint rejects it) — class-validator surfaces BOTH messages, which
        // is a distinct two-message envelope from the single-message cases above.
        const res = await postScreenshot(request, token, 'get-url', {
            url: 'https://2130706433/x',
        });
        expect(res.status, 'decimal-IP → 400').toBe(400);
        const msg = messageText(res.body);
        expect(msg, 'SSRF constraint fires').toMatch(/URL is not allowed/i);
        expect(msg, 'IsUrl require_tld also fires').toMatch(/url must be a URL address/i);
    });

    test('empty-string workId= query coerces to personal scope (200), NOT a foreign-work 404', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableConfigured(request, token, uniqueSuffix(testInfo.title));

        // A populated foreign workId is a 404 (deep spec). An EMPTY workId= query
        // must instead coerce to "no work" → the caller's personal scope, so it
        // returns the user-level provider with available:true. Pins that the
        // empty string never reaches the work lookup / ensureCanView.
        const res = await checkAvailability(request, token, '');
        expect(res.status, 'empty workId= → 200 personal scope').toBe(200);
        expect(res.body.available, 'personal scope sees the user-level provider').toBe(true);
        expect(
            res.body.providers.map((p) => p.id),
            'personal scope lists screenshotone',
        ).toContain('screenshotone');
    });

    test('check-availability activeProvider is the SAME option as the configured default (id + icon)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableConfigured(request, token, uniqueSuffix(testInfo.title));

        const { body } = await checkAvailability(request, token);
        expect(body.activeProvider, 'an active provider resolves').toBeTruthy();
        const active = body.activeProvider!;
        const inList = body.providers.find((p) => p.id === active.id);
        expect(inList, 'activeProvider also appears in the providers list').toBeTruthy();
        // The default screenshotone is the active one and is flagged default.
        expect(active.id, 'screenshotone is active').toBe('screenshotone');
        expect(inList!.isDefault, 'the active provider is the default').toBe(true);
        expect(inList!.configured, 'the active provider is configured').toBe(true);
        // The icon descriptor is exposed verbatim from the manifest.
        expect(active.icon?.type, 'icon type lucide').toBe('lucide');
        expect(active.icon?.value, 'icon value Camera').toBe('Camera');
        expect(active.icon?.backgroundColor, 'icon background colour pinned').toBe('#4f46e5');
    });

    test('capture FAILURE envelope carries ONLY {status,message} — no imageUrl/cacheUrl/imageBase64 keys', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableConfigured(request, token, uniqueSuffix(testInfo.title));

        // capture DOES reach the provider; with bogus keys it returns a truthful
        // 400. The distinctive assertion is on the KEY SET: the error body must
        // not even CARRY the success-only fields (not merely falsy — absent).
        const res = await postScreenshot(request, token, 'capture', { url: 'https://example.com' });
        expect(res.status, 'capture with bogus keys → 400').toBe(400);
        expect(res.body.status, 'error envelope').toBe('error');
        expect(messageText(res.body), 'a truthful upstream reason is surfaced').toMatch(
            /Failed to generate screenshot|access_key|is invalid|response returned/i,
        );
        const keys = Object.keys(res.body).sort();
        expect(keys, 'failure body keys are exactly {message,status}').toEqual([
            'message',
            'status',
        ]);
        expect('imageUrl' in res.body, 'no imageUrl key on failure').toBe(false);
        expect('cacheUrl' in res.body, 'no cacheUrl key on failure').toBe(false);
        expect('imageBase64' in res.body, 'no imageBase64 key on failure').toBe(false);
    });

    test('capture with a FULL option set still reaches the provider and fails truthfully (no fabricated 2xx)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableConfigured(request, token, uniqueSuffix(testInfo.title));

        // Passing every knob must not change the truthful-failure guarantee:
        // capture forwards to the real provider and surfaces its 400, never a
        // fabricated success and never an unhandled 5xx.
        const res = await postScreenshot(request, token, 'capture', {
            url: 'https://example.com',
            format: 'jpg',
            fullPage: true,
            viewportWidth: 800,
            viewportHeight: 600,
            delay: 500,
            blockAds: true,
            blockTrackers: true,
        });
        expect(res.status, 'full-option capture with bogus keys → truthful 400').toBe(400);
        expect(res.status, 'and NEVER a 5xx stacktrace').toBeLessThan(500);
        expect(res.body.status, 'error envelope').toBe('error');
        expect(
            messageText(res.body),
            'surfaces an upstream failure, not a fabricated image',
        ).toMatch(/Failed to generate screenshot|response returned|not valid|access_key|invalid/i);
        expect(res.body.imageUrl, 'no fabricated image url').toBeFalsy();
    });

    test('unauthenticated capture / get-url / check-availability are all rejected with 401', async ({
        request,
    }) => {
        // No bearer at all. The shared storageState cookie is not a valid API
        // bearer, so the Bearer-guarded screenshot routes reject with 401.
        const anonCapture = await request.post(`${API_BASE}/api/screenshot/capture`, {
            data: { url: 'https://example.com' },
        });
        expect(anonCapture.status(), 'anon capture → 401').toBe(401);

        const anonGetUrl = await request.post(`${API_BASE}/api/screenshot/get-url`, {
            data: { url: 'https://example.com' },
        });
        expect(anonGetUrl.status(), 'anon get-url → 401').toBe(401);

        const anonAvail = await request.get(`${API_BASE}/api/screenshot/check-availability`);
        expect(anonAvail.status(), 'anon check-availability → 401').toBe(401);
    });
});
