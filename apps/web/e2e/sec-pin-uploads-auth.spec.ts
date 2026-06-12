import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { API_BASE, authedHeaders, createWorkViaAPI, registerUserViaAPI } from './helpers/api';

/**
 * SEC PIN: UPLOADS AUTH — pins the security-audit Wave M #64 contract
 * (web-tier BFF upload proxies reject anonymous callers with an explicit
 * 401 instead of proxying credential-less requests upstream) plus the
 * full uploads authorization matrix on the API tier: anon 401 on every
 * authed upload route, the owner-only file-serve contract (cross-user
 * read of a REAL stored file → 404 anti-enumeration), the EW-644 workId
 * ownership gate, and the EW-637 anonymous-mint scoping contract.
 *
 * GROUNDING — every status/body below was probed against the LIVE stack
 * (web :3000 next dev + API :3100 sqlite in-memory) with curl + throwaway
 * users before being asserted, and cross-checked against the source:
 *   - apps/web/src/app/api/uploads/route.ts        (BFF guard: no auth
 *     cookie → 401 {error:'Unauthorized'} BEFORE any upstream fetch)
 *   - apps/web/src/app/api/uploads/file/route.ts   (same guard, file proxy)
 *   - apps/api/src/uploads/uploads.controller.ts   (POST /, /image, /file
 *     auth-gated; GET :userId/:filename owner-only → 404 on mismatch;
 *     assertWorkAccess → 404 'Work not found' for foreign/missing workId;
 *     @Public() /anonymous + /anonymous/file anon-mint)
 *
 * PROBED CONTRACTS (live, 2026-06-11):
 *   web POST /api/uploads        anon → 401 {error:'Unauthorized'}
 *   web POST /api/uploads/file   anon → 401 {error:'Unauthorized'}
 *   web GET  /api/uploads(/file)      → 405 (BFF is POST-only; no read proxy)
 *   web POST /api/uploads  seeded cookie + PNG → 201 {id,url,filename,…}
 *   api POST /api/uploads | /image | /file  anon → 401
 *       {message:'Unauthorized', statusCode:401}
 *   api POST /api/uploads authed PNG → 201 { id:<sha256>, hash:<sha256>,
 *       filename:'<sha256>.png', url:'/api/uploads/<userId>/<filename>',
 *       key:'<userId>/<filename>', size, mimeType:'image/png' }
 *   api GET /api/uploads/:userId/:filename
 *       owner    → 200 image/png, bytes match, nosniff,
 *                  CSP "default-src 'none'…", Cache-Control private,
 *                  Content-Disposition inline
 *       stranger → 404 {status:'error', message:'Not found'}  (NOT 403)
 *       anon     → 401 {message:'Unauthorized', statusCode:401}
 *   api POST /api/uploads?workId=<foreign|missing> → 404
 *       {status:'error', message:'Work not found'}   (same on /file)
 *   api POST /api/uploads?workId=<own> → 201, url round-trips '?workId='
 *   api POST /api/uploads/anonymous (no auth) → 201 { uploadId, url,
 *       expiresAt:<ISO ~3d>, anonAccessToken } — anon token reads the file
 *       back 200; a different registered user gets 404
 *   api POST /api/uploads/anonymous (with bearer) → 201 scoped to the
 *       SESSION user (uploadId starts with their userId), NO
 *       anonAccessToken, expiresAt:null
 *
 * NON-DUPLICATION:
 *   - image-uploads.spec.ts path-walks candidate upload paths and pins a
 *     loose [401,403] on the FIRST existing one + per-work POST candidates;
 *     it never pins the exact per-route 401 bodies, the web-tier BFF guard,
 *     the ?workId= gate, the serve-route contract, or the anon-mint scoping.
 *   - flow-injection-xss.spec.ts Flow 3 pins the serve route's path-traversal
 *     allowlist + a cross-user 404 against a SYNTHETIC (never-stored) path;
 *     here the cross-user read targets a REAL stored file, plus the owner
 *     200 + header contract.
 *   - media-mime-sniffing.spec.ts pins MIME/magic-byte validation only.
 *
 * ADAPTIVITY: no LLM key, no mail, no Redis needed — pure authz contracts.
 * Anonymous requests always go through a FRESH empty-storageState request
 *   context (house rule: the project request fixture inherits the seeded
 *   auth cookie for localhost, which would silently authenticate "anon"
 *   web-tier calls).
 * KNOWN ANOMALY (deliberately NOT pinned): a GARBAGE/tampered
 *   everworks_auth_token cookie on web POST /api/uploads currently yields
 *   a 500 (upstream 401 aborts the half-duplex body stream) — that is a
 *   bug to fix, not a contract to pin; GET BFF routes return 401 for the
 *   same cookie.
 */

// Web tier — the seeded auth cookie lives on `localhost`, so authed
// web-tier calls must use the configured baseURL (localhost), while anon
// calls use an explicitly empty storageState context.
const WEB_BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';

// 1x1 transparent PNG — minimum valid bytes (matches image-uploads.spec.ts).
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=',
    'base64',
);

const SHA256_HEX = /^[a-f0-9]{64}$/;

function pngMultipart(name = 'sec-pin.png') {
    return {
        file: { name, mimeType: 'image/png', buffer: TINY_PNG },
    };
}

function stamp(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Fresh request context with NO cookies — genuinely anonymous. */
async function anonContext(): Promise<APIRequestContext> {
    return pwRequest.newContext({
        storageState: { cookies: [], origins: [] },
    });
}

/** Upload a PNG as `user` and return the parsed 201 body. */
async function uploadPng(
    request: APIRequestContext,
    token: string,
    query = '',
): Promise<Record<string, unknown>> {
    const res = await request.post(`${API_BASE}/api/uploads${query}`, {
        headers: authedHeaders(token),
        multipart: pngMultipart(),
    });
    expect(res.status(), `authed upload → 201 (got ${res.status()})`).toBe(201);
    return (await res.json()) as Record<string, unknown>;
}

test.describe('SEC PIN — web BFF upload proxies (Wave M #64)', () => {
    test('anon POST web /api/uploads → 401 {error:"Unauthorized"} from the BFF guard, never proxied upstream', async () => {
        const anon = await anonContext();
        try {
            const res = await anon.post(`${WEB_BASE}/api/uploads`, {
                multipart: pngMultipart(),
            });
            expect(res.status(), 'BFF rejects credential-less upload').toBe(401);
            const body = (await res.json()) as Record<string, unknown>;
            // Exact envelope — the route returns this BEFORE any upstream
            // fetch, so the shape is the web tier's own, not NestJS's
            // {message, statusCode} envelope.
            expect(body).toEqual({ error: 'Unauthorized' });
        } finally {
            await anon.dispose();
        }
    });

    test('anon POST web /api/uploads/file → 401 {error:"Unauthorized"} (file proxy has the same guard)', async () => {
        const anon = await anonContext();
        try {
            const res = await anon.post(`${WEB_BASE}/api/uploads/file`, {
                multipart: {
                    file: {
                        name: 'sec-pin.md',
                        mimeType: 'text/markdown',
                        buffer: Buffer.from(`# sec-pin ${stamp()}\n`, 'utf8'),
                    },
                },
            });
            expect(res.status(), 'file-proxy rejects credential-less upload').toBe(401);
            const body = (await res.json()) as Record<string, unknown>;
            expect(body).toEqual({ error: 'Unauthorized' });
        } finally {
            await anon.dispose();
        }
    });

    test('web BFF upload routes are POST-only — GET → 405 (no web-tier file-read proxy exists)', async () => {
        // The serve path lives ONLY on the API tier behind bearer auth;
        // the web tier deliberately exposes no GET that could leak files
        // to cookie-less callers.
        const anon = await anonContext();
        try {
            for (const path of ['/api/uploads', '/api/uploads/file']) {
                const res = await anon.get(`${WEB_BASE}${path}`);
                expect(res.status(), `GET ${path} is not routable`).toBe(405);
            }
        } finally {
            await anon.dispose();
        }
    });

    test('seeded auth cookie CAN upload through web /api/uploads → 201 (the 401 is the auth gate, not a dead route)', async ({
        request,
    }) => {
        // The project `request` fixture inherits the seeded storageState
        // cookie (domain localhost) — a relative URL resolves against
        // baseURL, so the cookie travels and the BFF forwards upstream.
        // next-dev cold-compile tolerance: the FIRST authed multipart hit on
        // a freshly-compiled BFF route was observed to 401 once under
        // parallel-worker load and never again (2 consecutive full green
        // re-runs) — retry a single time before failing for real.
        let res = await request.post('/api/uploads', {
            multipart: pngMultipart(),
        });
        if (res.status() !== 201) {
            const firstBody = await res.text().catch(() => '');
            console.warn(
                `seeded BFF upload first attempt → ${res.status()} ${firstBody.slice(0, 200)}; retrying once (next-dev cold-compile tolerance)`,
            );
            res = await request.post('/api/uploads', {
                multipart: pngMultipart(),
            });
        }
        expect(
            res.status(),
            `authed BFF upload → 201 (got ${res.status()}: ${(await res.text().catch(() => '')).slice(0, 200)})`,
        ).toBe(201);
        const body = (await res.json()) as Record<string, unknown>;
        expect(String(body.id)).toMatch(SHA256_HEX);
        expect(String(body.url)).toMatch(/^\/api\/uploads\/[^/]+\/[a-f0-9]{64}\.png$/);
        expect(body.mimeType).toBe('image/png');
        expect(body.size).toBe(TINY_PNG.length);
    });
});

test.describe('SEC PIN — API-tier upload routes reject anonymous callers', () => {
    test('anon POST api /api/uploads, /api/uploads/image, /api/uploads/file → 401 {message:"Unauthorized", statusCode:401}', async () => {
        const anon = await anonContext();
        try {
            for (const path of ['/api/uploads', '/api/uploads/image', '/api/uploads/file']) {
                const res = await anon.post(`${API_BASE}${path}`, {
                    multipart: pngMultipart(),
                });
                expect(res.status(), `anon POST ${path} → 401`).toBe(401);
                const body = (await res.json()) as Record<string, unknown>;
                expect(body.message, `anon POST ${path} body`).toBe('Unauthorized');
                expect(body.statusCode, `anon POST ${path} statusCode`).toBe(401);
            }
        } finally {
            await anon.dispose();
        }
    });
});

test.describe('SEC PIN — file-serve ownership (GET /api/uploads/:userId/:filename)', () => {
    test('owner round-trip: 201 sha256-keyed upload, then 200 serve with byte-identical body + hardening headers', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const up = await uploadPng(request, owner.access_token);

        // sha256 content-addressing contract: id === hash, filename is
        // <sha256>.png, url/key embed the OWNER's userId segment.
        expect(String(up.id)).toMatch(SHA256_HEX);
        expect(up.hash).toBe(up.id);
        expect(up.filename).toBe(`${up.id}.png`);
        expect(up.url).toBe(`/api/uploads/${owner.user.id}/${up.filename}`);
        expect(up.key).toBe(`${owner.user.id}/${up.filename}`);
        expect(up.size).toBe(TINY_PNG.length);
        expect(up.mimeType).toBe('image/png');

        const res = await request.get(`${API_BASE}${up.url}`, {
            headers: authedHeaders(owner.access_token),
        });
        expect(res.status(), 'owner can read own file').toBe(200);
        const headers = res.headers();
        expect(headers['content-type']).toBe('image/png');
        expect(headers['x-content-type-options']).toBe('nosniff');
        expect(headers['content-security-policy']).toContain("default-src 'none'");
        expect(headers['cache-control']).toBe('private, max-age=300');
        expect(headers['content-disposition']).toBe(`inline; filename="${up.filename}"`);
        const bytes = await res.body();
        expect(Buffer.compare(bytes, TINY_PNG), 'served bytes identical to upload').toBe(0);
    });

    test('cross-user read of a REAL stored file → 404 {status:"error", message:"Not found"} (anti-enumeration, never 403)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const up = await uploadPng(request, owner.access_token);

        const res = await request.get(`${API_BASE}${up.url}`, {
            headers: authedHeaders(stranger.access_token),
        });
        // The controller deliberately collapses "exists but not yours"
        // into 404 so ownership can't be probed via 403-vs-404 deltas.
        expect(res.status(), 'stranger read is a 404, not 403').toBe(404);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).toEqual({ status: 'error', message: 'Not found' });
    });

    test('anonymous read of a REAL stored file → 401 (serve route is bearer-gated)', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const up = await uploadPng(request, owner.access_token);

        const anon = await anonContext();
        try {
            const res = await anon.get(`${API_BASE}${up.url}`);
            expect(res.status(), 'anon serve request → 401').toBe(401);
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.message).toBe('Unauthorized');
            expect(body.statusCode).toBe(401);
        } finally {
            await anon.dispose();
        }
    });
});

test.describe('SEC PIN — EW-644 workId ownership gate on uploads', () => {
    test('stranger POST ?workId=<another user\'s work> → 404 "Work not found" on BOTH /api/uploads and /api/uploads/file', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const stranger = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `sec-pin-workid-${stamp()}`,
        });
        expect(work.id, 'owner work created').toBeTruthy();

        for (const path of ['/api/uploads', '/api/uploads/file']) {
            const res = await request.post(`${API_BASE}${path}?workId=${work.id}`, {
                headers: authedHeaders(stranger.access_token),
                multipart: pngMultipart(),
            });
            // assertWorkAccess collapses foreign + missing into 404 so a
            // stranger can't enumerate valid Work UUIDs via the status.
            expect(res.status(), `stranger ${path}?workId → 404`).toBe(404);
            const body = (await res.json()) as Record<string, unknown>;
            expect(body).toEqual({ status: 'error', message: 'Work not found' });
        }
    });

    test('owner POST ?workId=<own work> → 201 with workId round-tripped into the serve URL; nonexistent workId → 404', async ({
        request,
    }) => {
        const owner = await registerUserViaAPI(request);
        const work = await createWorkViaAPI(request, owner.access_token, {
            name: `sec-pin-ownwork-${stamp()}`,
        });
        expect(work.id, 'own work created').toBeTruthy();

        const ok = await uploadPng(request, owner.access_token, `?workId=${work.id}`);
        expect(String(ok.url), 'serve URL carries ?workId= for backend round-trip').toContain(
            `?workId=${work.id}`,
        );

        const missing = await request.post(
            `${API_BASE}/api/uploads?workId=00000000-0000-0000-0000-000000000000`,
            {
                headers: authedHeaders(owner.access_token),
                multipart: pngMultipart(),
            },
        );
        expect(missing.status(), 'nonexistent workId → 404').toBe(404);
        const body = (await missing.json()) as Record<string, unknown>;
        expect(body).toEqual({ status: 'error', message: 'Work not found' });
    });
});

test.describe('SEC PIN — EW-637 anonymous-mint upload scoping', () => {
    test('anon POST /api/uploads/anonymous → 201 mints a TTL-bounded anon owner; its token reads the file, a stranger gets 404', async ({
        request,
    }) => {
        const anon = await anonContext();
        try {
            const res = await anon.post(`${API_BASE}/api/uploads/anonymous`, {
                multipart: pngMultipart(),
            });
            expect(res.status(), 'anonymous upload → 201').toBe(201);
            const body = (await res.json()) as Record<string, unknown>;
            expect(String(body.anonAccessToken), 'anon token minted').toMatch(/\S{20,}/);
            expect(String(body.uploadId)).toContain('/');
            // TTL contract: expiresAt is a future ISO timestamp (anon TTL).
            const expiresAt = Date.parse(String(body.expiresAt));
            expect(Number.isNaN(expiresAt), 'expiresAt parses').toBe(false);
            expect(expiresAt).toBeGreaterThan(Date.now());

            // The minted anon user OWNS the file — its bearer reads it back.
            const ownRead = await anon.get(`${API_BASE}${String(body.url)}`, {
                headers: authedHeaders(String(body.anonAccessToken)),
            });
            expect(ownRead.status(), 'anon-minted owner reads own file').toBe(200);
            expect(ownRead.headers()['content-type']).toBe('image/png');

            // …but a regular registered user is a stranger to it → 404.
            const stranger = await registerUserViaAPI(request);
            const crossRead = await request.get(`${API_BASE}${String(body.url)}`, {
                headers: authedHeaders(stranger.access_token),
            });
            expect(crossRead.status(), 'registered stranger → 404').toBe(404);
        } finally {
            await anon.dispose();
        }
    });

    test('authed POST /api/uploads/anonymous honors the session: upload scoped to the caller, NO anon token, expiresAt null', async ({
        request,
    }) => {
        const user = await registerUserViaAPI(request);
        const res = await request.post(`${API_BASE}/api/uploads/anonymous`, {
            headers: authedHeaders(user.access_token),
            multipart: pngMultipart(),
        });
        expect(res.status(), 'authed call still 201s').toBe(201);
        const body = (await res.json()) as Record<string, unknown>;
        // Session honored — no anon user minted, so no token and no TTL,
        // and the storage key is scoped under the REAL user's id.
        expect(body.anonAccessToken, 'no anon token for an authed caller').toBeUndefined();
        expect(body.expiresAt, 'no TTL for an authed caller').toBeNull();
        expect(String(body.uploadId).startsWith(`${user.user.id}/`)).toBe(true);
        expect(body.url).toBe(`/api/uploads/${user.user.id}/${String(body.filename)}`);
    });
});
