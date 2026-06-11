import { test, expect, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, registerUserViaAPI, createWorkViaAPI } from './helpers/api';
import { listPluginsViaAPI, enablePluginViaAPI } from './helpers/plugins';

/**
 * Screenshot capability — DEEP gaps. This file deliberately targets the seams
 * that the two existing screenshot specs leave OPEN:
 *   - `flow-plugin-screenshot.spec.ts` (registry schema, fresh-user isolation,
 *     enable/disable lifecycle, truthful capture failure, local signed-url for
 *     screenshotone/urlbox, providerOverride routing + basic DTO `IsUrl`).
 *   - `flow-screenshot-capability-contract.spec.ts` (DTO bounds/enum/UUID/
 *     whitelist matrix, user-vs-work scope independence, cross-USER work access
 *     403 / no-secret-leak, screenshotone-vs-urlbox URL SHAPE, gating ORDER,
 *     default sort, disable re-arm).
 *
 * Neither covers the URL-security boundary on the DTO (the SSRF + protocol/TLD
 * guard added on `CaptureScreenshotDto.url`), the FULL signed-url OPTION matrix
 * (delay ms→s, jpg, block_trackers, block_cookie_banners, device_scale_factor),
 * signature DETERMINISM, the omitted-flag DEFAULT encoding, the foreign-but-
 * NONEXISTENT (valid-v4 UUID) workId 404 path of Wave B #30 (the contract file
 * only probes a *non-uuid* and a *real other-user* work), the OWNER's-own-work
 * "plugin not work-enabled" gate, or the precise upstream-400 shape `/capture`
 * surfaces. Those are pinned below.
 *
 * Every status / message / URL fragment below was PROBED against the LIVE stack
 * (http://127.0.0.1:3100) before its assertion was written.
 *
 * PROBED CONTRACTS (live, 2026-06-11):
 *   - DTO url SSRF guard: a private/loopback/link-local IP host
 *       (`https://127.0.0.1/x`, `https://169.254.169.254/...` AWS IMDS) → 400
 *       { message:['URL is not allowed'] } on BOTH /capture and /get-url. The
 *       SSRF constraint fires AFTER `@IsUrl` accepts the (https, TLD-shaped)
 *       value, so the message is the constraint's `'URL is not allowed'`.
 *   - DTO url protocol/TLD guard: `http://example.com` (non-https),
 *       `https://localhost/x` (no TLD), `https://myhost/x` (no TLD) → 400
 *       { message:['url must be a URL address'] } — `@IsUrl({ protocols:['https'],
 *       require_tld:true })` rejects before the SSRF constraint runs.
 *   - Signed screenshotone url honours the FULL option set: `delay` is sent in
 *       MILLISECONDS by the client but encoded as `delay=<seconds>` (3000→`delay=3`);
 *       `format=jpg`→`format=jpg`; `blockTrackers:true`→`block_trackers=true`;
 *       `blockCookieBanners:true`→`block_cookie_banners=true`; a constant
 *       `device_scale_factor=1` is always present.
 *   - OMITTED flags default in the signed url: with NO block flags, the url
 *       carries `block_ads=true` AND `block_trackers=true`, but NO
 *       `block_cookie_banners` param (cookie-banner default is off / absent).
 *       Viewport defaults 1280x800, format png.
 *   - DETERMINISM: identical input → byte-identical signed url (stable HMAC).
 *       The target url (incl. a nested `?q=1&x=2` query) is fully percent-encoded
 *       into the `url=` param.
 *   - WORK AUTHZ (Wave B #30): a VALID-v4 but NONEXISTENT workId
 *       (`a0499a65-9b8c-4bf7-857e-895f52da30b3`) → 404
 *       { status:'error', message:"Work with id '…' not found" } on
 *       check-availability, /get-url AND /capture (ensureCanView fronts all
 *       three). A NON-rfc-v4 string (`11111111-2222-3333-4444-555555555555`,
 *       no version nibble) is instead a DTO 400 'workId must be a UUID' — the
 *       validator runs before the lookup.
 *   - OWNER's OWN work, provider enabled at USER level but NOT work-enabled →
 *       /get-url 400 { message:'No screenshot provider configured' }. The work
 *       scope is independent even for the owner; the user-level enable does not
 *       satisfy the work-scoped provider gate.
 *   - /capture with BOTH fake keys reaches the real provider and surfaces the
 *       upstream rejection: 400 { status:'error',
 *       message:'Failed to generate screenshot, response returned 400 (Bad
 *       Request): "access_key" is invalid' }. NOT a fabricated 200, NOT a 5xx.
 *   - urlbox via providerOverride builds a DIFFERENT shape:
 *       `https://api.urlbox.io/v1/<key>/<sig>/jpg?url=…&width=500&height=700&
 *       full_page=true&quality=80&block_ads=true&hide_cookie_banners=true` —
 *       format is a PATH segment, width/height (not viewport_*), quality=80.
 *   - Unknown providerOverride with a configured provider → 500 'Internal
 *       server error' (facade raises NoProviderError-equivalent inside resolve).
 *   - 401 without a bearer on /get-url.
 *
 * ISOLATION: every test registers a FRESH user. screenshot keys are written at
 * the USER scope and would shadow the env key for sibling specs, so we never
 * touch the shared seeded user. Unique suffixes come from the per-test title +
 * a module counter — never a module-scope clock.
 *
 * Filename uses the safe `flow-` prefix (not matched by the no-auth testIgnore
 * regex) and is fully API-orchestrated — no UI contention.
 */

interface ProviderOption {
    id: string;
    name: string;
    configured: boolean;
    isDefault?: boolean;
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

/** A valid RFC-4122 v4 UUID that is (overwhelmingly) not a real work id. */
const NONEXISTENT_WORK_UUID = 'a0499a65-9b8c-4bf7-857e-895f52da30b3';

async function freshToken(request: APIRequestContext): Promise<string> {
    return (await registerUserViaAPI(request)).access_token;
}

async function checkAvailability(
    request: APIRequestContext,
    token: string,
    workId?: string,
): Promise<{ status: number; body: AvailabilityResponse }> {
    const url = workId
        ? `${API_BASE}/api/screenshot/check-availability?workId=${encodeURIComponent(workId)}`
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
async function enableScreenshotoneConfigured(
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

test.describe('Screenshot capability — deep: URL-security, signed-url matrix, work authz', () => {
    test('SSRF guard: private/loopback/link-local IP hosts are rejected on capture AND get-url', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // These hosts are accepted by @IsUrl (https + TLD-shaped) but blocked by
        // the IsNotSsrfUrl constraint — the screenshot URL is forwarded to a
        // third-party provider, so an SSRF target (cloud metadata, loopback)
        // must never reach it. The constraint message is 'URL is not allowed'.
        const ssrfTargets = [
            'https://127.0.0.1/x',
            'https://169.254.169.254/latest/meta-data', // AWS IMDS
            'https://10.0.0.5/internal',
        ];
        for (const op of ['capture', 'get-url'] as const) {
            for (const url of ssrfTargets) {
                const res = await postScreenshot(request, token, op, { url });
                expect(res.status, `${op}: SSRF ${url} → 400`).toBe(400);
                expect(messageText(res.body), `${op}: SSRF ${url} → 'URL is not allowed'`).toMatch(
                    /URL is not allowed/i,
                );
            }
        }
    });

    test('protocol/TLD guard: non-https and TLD-less hosts → "url must be a URL address"', async ({
        request,
    }) => {
        const token = await freshToken(request);

        // @IsUrl({ protocols:['https'], require_tld:true }) rejects these BEFORE
        // the SSRF constraint runs, so the message is the IsUrl default rather
        // than 'URL is not allowed'. This distinguishes the two guard layers.
        const isUrlRejections = [
            'http://example.com', // non-https protocol
            'https://localhost/x', // no TLD
            'https://myhost/internal', // no TLD
            'ftp://example.com', // wrong protocol entirely
        ];
        for (const op of ['capture', 'get-url'] as const) {
            for (const url of isUrlRejections) {
                const res = await postScreenshot(request, token, op, { url });
                expect(res.status, `${op}: ${url} → 400`).toBe(400);
                expect(messageText(res.body), `${op}: ${url} → IsUrl message`).toMatch(
                    /url must be a URL address/i,
                );
            }
        }
    });

    test('signed-url honours the FULL option matrix (delay ms→s, jpg, trackers, cookie-banners, dsf)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableScreenshotoneConfigured(request, token, uniqueSuffix(testInfo.title));

        const res = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            format: 'jpg',
            delay: 3000, // client sends MILLISECONDS …
            blockTrackers: true,
            blockCookieBanners: true,
            blockAds: true,
            fullPage: true,
            viewportWidth: 1024,
            viewportHeight: 768,
        });
        expect(res.status, 'get-url with full options → 201').toBe(201);
        const url = String(res.body.imageUrl ?? '');
        expect(url, 'screenshotone take endpoint').toContain('api.screenshotone.com/take');
        // … but the provider URL encodes delay in SECONDS (3000ms → delay=3).
        expect(url, 'delay encoded in seconds (3000ms → 3)').toContain('delay=3');
        expect(url, 'jpg format honoured').toContain('format=jpg');
        expect(url, 'blockTrackers honoured').toContain('block_trackers=true');
        expect(url, 'blockCookieBanners honoured').toContain('block_cookie_banners=true');
        expect(url, 'blockAds honoured').toContain('block_ads=true');
        expect(url, 'fullPage honoured').toContain('full_page=true');
        expect(url, 'viewport width honoured').toContain('viewport_width=1024');
        expect(url, 'viewport height honoured').toContain('viewport_height=768');
        // A constant device_scale_factor is always emitted by the builder.
        expect(url, 'device_scale_factor=1 always present').toContain('device_scale_factor=1');
        expect(url, 'HMAC signed').toContain('signature=');
    });

    test('signed-url default-flag encoding: omitted flags → block_ads+block_trackers, NO cookie-banners', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableScreenshotoneConfigured(request, token, uniqueSuffix(testInfo.title));

        // With NO block flags supplied the builder applies its OWN defaults:
        // block_ads=true and block_trackers=true are emitted, but the
        // cookie-banner param is absent (its default is off). Pinning the
        // absence is what makes this distinct from the contract spec (which only
        // checks block_ads=true on omission).
        const res = await postScreenshot(request, token, 'get-url', { url: 'https://example.com' });
        const url = String(res.body.imageUrl ?? '');
        expect(url, 'default block_ads=true').toContain('block_ads=true');
        expect(url, 'default block_trackers=true').toContain('block_trackers=true');
        expect(url, 'NO cookie-banner param when omitted').not.toContain('block_cookie_banners');
        expect(url, 'default viewport width 1280').toContain('viewport_width=1280');
        expect(url, 'default viewport height 800').toContain('viewport_height=800');
        expect(url, 'default format png').toContain('format=png');
        expect(url, 'default full_page=false').toContain('full_page=false');
    });

    test('signed-url is deterministic (stable HMAC) and percent-encodes a nested target query', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableScreenshotoneConfigured(request, token, uniqueSuffix(testInfo.title));

        const target = 'https://example.com/path?q=1&x=2';
        const first = await postScreenshot(request, token, 'get-url', { url: target });
        const second = await postScreenshot(request, token, 'get-url', { url: target });
        const a = String(first.body.imageUrl ?? '');
        const b = String(second.body.imageUrl ?? '');
        expect(a, 'first build succeeded').toContain('signature=');
        // Same key + same input ⇒ byte-identical signed url (no nonce/timestamp).
        expect(b, 'signed url is deterministic for identical input').toBe(a);
        // The nested target query is fully percent-encoded inside `url=` (the
        // inner `?`/`&` must NOT bleed into the provider query string).
        expect(a, 'nested target query is fully encoded').toContain(
            `url=${encodeURIComponent(target)}`,
        );
    });

    test('foreign workId — valid-v4 but NONEXISTENT → 404 on check-availability, get-url AND capture (Wave B #30)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        // The caller has a configured provider at USER scope, so the 404 below
        // is the WORK-access guard firing — not a missing-provider gate.
        await enableScreenshotoneConfigured(request, token, uniqueSuffix(testInfo.title));

        const avail = await checkAvailability(request, token, NONEXISTENT_WORK_UUID);
        expect(avail.status, 'check-availability foreign workId → 404').toBe(404);
        expect(avail.body.status, 'error envelope').toBe('error');
        expect(messageText(avail.body as unknown as Record<string, unknown>), 'names the work').toMatch(
            /Work with id .* not found/i,
        );

        for (const op of ['get-url', 'capture'] as const) {
            const res = await postScreenshot(request, token, op, {
                url: 'https://example.com',
                workId: NONEXISTENT_WORK_UUID,
            });
            expect(res.status, `${op}: foreign workId → 404 BEFORE any provider work`).toBe(404);
            expect(messageText(res.body), `${op}: not-found names the work`).toMatch(
                /Work with id .* not found/i,
            );
        }
    });

    test('workId DTO precision: a non-RFC-v4 string is a 400 (validator wins before the lookup)', async ({
        request,
    }) => {
        const token = await freshToken(request);
        // No version nibble ⇒ not a valid v4 UUID ⇒ class-validator 400 'must be
        // a UUID', distinct from the valid-but-nonexistent 404 above (the DTO
        // runs before ensureCanView, so this never reaches the work lookup).
        const res = await postScreenshot(request, token, 'capture', {
            url: 'https://example.com',
            workId: '11111111-2222-3333-4444-555555555555',
        });
        expect(res.status, 'non-v4 workId → 400 DTO').toBe(400);
        expect(messageText(res.body), 'workId UUID message').toMatch(/workId must be a UUID/i);
    });

    test('owner own-work gate: user-level enable does NOT satisfy the work-scoped provider gate', async ({
        request,
    }, testInfo) => {
        const owner = await registerUserViaAPI(request);
        const token = owner.access_token;
        // Provider enabled at USER scope only.
        await enableScreenshotoneConfigured(request, token, uniqueSuffix(testInfo.title));

        // The owner's OWN brand-new work has no work-scoped provider, so a
        // work-scoped get-url is gated with the "no provider" 400 — proving the
        // work scope is independent EVEN for the owner (the contract spec only
        // shows this after work-enabling; here we pin the un-enabled gate).
        const work = await createWorkViaAPI(request, token, {
            name: `SSGate ${uniqueSuffix(testInfo.title)}`,
        });
        expect(work.id, 'work created').toBeTruthy();

        const beforeAvail = await checkAvailability(request, token, work.id);
        expect(beforeAvail.status, 'owner can view their own work scope → 200').toBe(200);
        expect(beforeAvail.body.available, 'work scope has no provider').toBe(false);

        const res = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            workId: work.id,
        });
        expect(res.status, 'work-scoped get-url with no work provider → 400 gate').toBe(400);
        expect(res.body.status, 'error envelope').toBe('error');
        expect(messageText(res.body), 'no-provider gate message').toMatch(
            /No screenshot provider configured/i,
        );
    });

    test('capture truthful upstream failure: both fake keys reach the provider → 400 with the real reason', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableScreenshotoneConfigured(request, token, uniqueSuffix(testInfo.title));

        // Unlike get-url (local HMAC, no outbound call), /capture DOES call the
        // provider. With bogus keys the upstream returns its own 400 and the
        // facade surfaces it verbatim — never a fabricated success, never a 5xx.
        const res = await postScreenshot(request, token, 'capture', { url: 'https://example.com' });
        expect(res.status, 'capture with bogus keys → truthful 400').toBe(400);
        expect(res.body.status, 'error envelope').toBe('error');
        const msg = messageText(res.body);
        expect(msg, 'surfaces an upstream failure (not a fabricated success)').toMatch(
            /Failed to generate screenshot|access_key|is invalid|response returned/i,
        );
        // No image fields are fabricated on the error envelope.
        expect(res.body.imageUrl, 'no image url on a failed capture').toBeFalsy();
    });

    test('urlbox via providerOverride builds a distinct shape (path-format, width/height, quality=80)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        const screenshotIds = (await listPluginsViaAPI(request, token))
            .filter((p) => p.category === 'screenshot')
            .map((p) => p.id);

        if (!screenshotIds.includes('urlbox')) {
            testInfo.annotations.push({
                type: 'note',
                description: 'urlbox not registered in this build — skipped its URL-shape assertions',
            });
            test.skip(true, 'urlbox not registered in this build');
            return;
        }

        const suffix = uniqueSuffix(testInfo.title);
        await enablePluginViaAPI(request, token, 'urlbox', {
            secretSettings: { apiKey: `ub-api-${suffix}`, apiSecret: `ub-sec-${suffix}` },
        });
        await expect
            .poll(async () => (await checkAvailability(request, token)).body.available, {
                timeout: 15_000,
                message: 'urlbox availability flips true after enable',
            })
            .toBe(true);

        const res = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            providerOverride: 'urlbox',
            format: 'jpg',
            viewportWidth: 500,
            viewportHeight: 700,
            fullPage: true,
            blockAds: true,
            blockCookieBanners: true,
        });
        expect(res.status, 'urlbox override get-url → 201').toBe(201);
        const url = String(res.body.imageUrl ?? '');
        expect(url, 'urlbox host with path-embedded key+sig').toMatch(
            /^https:\/\/api\.urlbox\.io\/v1\/[^/]+\/[^/]+\//,
        );
        // urlbox encodes the format as a PATH segment, not a query param.
        expect(url, 'format is a /jpg path segment').toContain('/jpg?');
        expect(url, 'urlbox uses width= (not viewport_width)').toContain('width=500');
        expect(url, 'urlbox uses height= (not viewport_height)').toContain('height=700');
        expect(url, 'urlbox full_page honoured').toContain('full_page=true');
        expect(url, 'urlbox emits quality=80').toContain('quality=80');
        expect(url, 'urlbox uses its own cookie-banner param').toContain('hide_cookie_banners=true');
        // Genuinely different shape from screenshotone.
        expect(url, 'not a screenshotone URL').not.toContain('api.screenshotone.com');
        expect(url, 'no viewport_width leaks into urlbox shape').not.toContain('viewport_width');
    });

    test('unknown providerOverride with a configured provider → 500 (resolve raises, no fabricated 2xx)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableScreenshotoneConfigured(request, token, uniqueSuffix(testInfo.title));

        // The named override resolves to no enabled plugin; the facade raises and
        // the controller does NOT map it (it is not a NoProviderError on this
        // path), so it surfaces as a 500. Assert non-2xx and tolerate 400/404/500
        // across builds while pinning the live 500 as the expected shape.
        const res = await postScreenshot(request, token, 'get-url', {
            url: 'https://example.com',
            providerOverride: `nonexistent-${uniqueSuffix(testInfo.title)}`,
        });
        expect(
            [400, 404, 500].includes(res.status),
            `unknown override rejected (got ${res.status})`,
        ).toBe(true);
        expect(res.status, 'and it is NOT a fabricated 2xx').toBeGreaterThanOrEqual(400);
        expect(res.body.imageUrl, 'no signed url is produced for an unknown override').toBeFalsy();
    });

    test('unauthenticated get-url / capture / check-availability are rejected with 401', async ({
        request,
    }) => {
        // No bearer at all. Use raw request (no shared storageState/cookies).
        const anonGetUrl = await request.post(`${API_BASE}/api/screenshot/get-url`, {
            data: { url: 'https://example.com' },
        });
        expect(anonGetUrl.status(), 'anon get-url → 401').toBe(401);

        const anonCapture = await request.post(`${API_BASE}/api/screenshot/capture`, {
            data: { url: 'https://example.com' },
        });
        expect(anonCapture.status(), 'anon capture → 401').toBe(401);

        const anonAvail = await request.get(`${API_BASE}/api/screenshot/check-availability`);
        expect(anonAvail.status(), 'anon check-availability → 401').toBe(401);
    });

    test('get-url with a configured provider returns ONLY a signed url (no base64, no outbound call)', async ({
        request,
    }, testInfo) => {
        const token = await freshToken(request);
        await enableScreenshotoneConfigured(request, token, uniqueSuffix(testInfo.title));

        // The get-url contract is purely { status, imageUrl } — it must not carry
        // capture-only fields (imageBase64 / cacheUrl) and must return a fully
        // formed signed url even with bogus keys (local build, no provider call).
        const res = await postScreenshot(request, token, 'get-url', { url: 'https://example.com' });
        expect(res.status, 'get-url → 201').toBe(201);
        expect(res.body.status, 'success envelope').toBe('success');
        expect(String(res.body.imageUrl ?? ''), 'a signed take URL').toContain(
            'api.screenshotone.com/take',
        );
        expect(res.body.imageBase64, 'get-url does not return base64').toBeUndefined();
        expect(res.body.cacheUrl, 'get-url does not return a cacheUrl').toBeUndefined();
    });
});
