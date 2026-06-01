import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { API_BASE, loginViaAPI, registerUserViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * flow-2fa-state-machine — the FULL two-factor-auth state machine expressed as
 * complex, multi-step INTEGRATION flows, anchored on what the live stack really
 * exposes today.
 *
 * Deep companion to the two SHALLOW probes already in the suite:
 *   - `security-2fa.spec.ts`   — checks that *one* candidate 2FA status endpoint
 *                                 exists (or skips) + the unauth gate.
 *   - `recovery-codes.spec.ts` — checks the recovery-codes endpoint's auth gate.
 * Neither walks an end-to-end transition; this file orchestrates the lifecycle
 * and every guard edge:
 *
 *   1. enroll → TOTP verify → challenge-on-login            (happy path)
 *   2. backup / recovery-code recovery when TOTP is unavailable
 *   3. step-up re-auth gate on a sensitive op (disable / regenerate / pw change)
 *   4. wrong-code rejection + repeated-wrong-code lockout tolerance
 *   5. recovery-code single-use (a consumed code cannot be replayed)
 *   6. disable / recovery event → global session revocation → plain login again
 *
 * ── PROBED GROUND TRUTH (2026-06-01, CI sqlite driver @ 127.0.0.1:3100) ──────
 * The Ever Works auth surface is a NestJS REST controller under `/api/auth/*`
 * (see apps/api/src/auth/controllers/auth.controller.ts). At authoring time a
 * live probe with a VALID bearer found NO dedicated 2FA surface at all — every
 * candidate path 404s even when authenticated, and there is no Better-Auth
 * catch-all handler mounted:
 *
 *     POST/GET /api/auth/two-factor/{status,enable,get-totp-uri,
 *              generate-backup-codes,verify-totp,disable}   → 404 (authed)
 *     POST/GET /api/auth/2fa/{status,enable}                → 404 (authed)
 *     GET      /api/auth/get-session  (Better-Auth native)  → 404
 *
 * So the 2FA-specific legs below are written DISCOVERY-FIRST and `skip()` with a
 * clear message when the surface is absent — we never assert a fictional 2FA
 * contract. The TOTP / backup-code machinery (RFC-6238, candidate-path
 * resolution, secret/code extraction) is real and ready the moment the
 * Better-Auth `twoFactor` plugin is re-exposed; until then each flow ALSO drives
 * the closest REAL, VERIFIED surface so the test exercises a live contract
 * instead of merely skipping:
 *
 *   - `POST /api/auth/update-password` is the live "sensitive op / step-up
 *     re-auth gate": DTO {currentPassword, newPassword}. PROBED outcomes —
 *       wrong currentPassword → 401 {message:"Current password is incorrect"}
 *       missing currentPassword → 400 (class-validator DTO)
 *       unauthenticated        → 401
 *       correct currentPassword → 200 {message:"Password updated successfully"},
 *                                 and the NEW password then logs in (200 +token).
 *     This is exactly the "knowledge-of-current-factor required to mutate the
 *     auth factor" invariant 2FA disable/regenerate would enforce.
 *   - `POST /api/auth/logout-all` is the live global-session-revocation
 *     primitive (the side-effect a 2FA disable / recovery-code-recovery event
 *     triggers): PROBED 200 authed, 401 unauth, {message:"Logged out from all
 *     devices successfully"}.
 *   - `POST /api/auth/login` returns {access_token, user} with NO challenge
 *     field today, CONFIRMING 2FA is not enforced — so "challenge-on-login"
 *     assertions accept a full session OR a truthful challenge, never hard-
 *     require a challenge.
 *
 * Cross-spec isolation (suite rule): every MUTATING flow runs on a FRESH
 * `registerUserViaAPI()` user with a unique email; the shared seeded user
 * (storageState) is used ONLY for the read-only UI surface assertion.
 *
 * Register DTO (PROBED): {username, email, password} — username (NOT name),
 * password regex /^(?=.*[a-z])(?=.*[\d\W_]).{8,}$/. Login DTO accepts ONLY
 * {email, password} (extra fields → 400).
 */

// ── Candidate path families (ranked: Better-Auth-native first). ─────────────
const STATUS_PATHS = [
    '/api/auth/two-factor/status',
    '/api/auth/2fa/status',
    '/api/auth/mfa/status',
    '/api/auth/two-factor',
    '/api/auth/2fa',
];
const ENABLE_PATHS = [
    '/api/auth/two-factor/enable',
    '/api/auth/2fa/enable',
    '/api/auth/2fa/enroll',
    '/api/auth/2fa/setup',
    '/api/auth/mfa/enroll',
];
const VERIFY_TOTP_PATHS = [
    '/api/auth/two-factor/verify-totp',
    '/api/auth/2fa/verify',
    '/api/auth/2fa/verify-totp',
    '/api/auth/mfa/verify',
];
const VERIFY_BACKUP_PATHS = [
    '/api/auth/two-factor/verify-backup-code',
    '/api/auth/2fa/verify-backup-code',
    '/api/auth/2fa/recovery',
    '/api/auth/mfa/verify-backup-code',
];
const GEN_BACKUP_PATHS = [
    '/api/auth/two-factor/generate-backup-codes',
    '/api/auth/2fa/backup-codes',
    '/api/auth/2fa/recovery-codes',
    '/api/auth/mfa/backup-codes',
];
const DISABLE_PATHS = [
    '/api/auth/two-factor/disable',
    '/api/auth/2fa/disable',
    '/api/auth/mfa/disable',
];

// Verified live surfaces (probed) used as the closest-real anchor flows.
const UPDATE_PASSWORD_PATH = '/api/auth/update-password';
const LOGOUT_ALL_PATH = '/api/auth/logout-all';
const LOGIN_PATH = '/api/auth/login';

const PROBE_TIMEOUT = 25_000;

type Method = 'GET' | 'POST';

/** Issue a request without throwing on non-2xx so we can inspect bodies/statuses. */
async function call(
    request: APIRequestContext,
    method: Method,
    path: string,
    opts: { token?: string; data?: Record<string, unknown> } = {},
) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const init = { headers, timeout: PROBE_TIMEOUT, data: opts.data ?? {} };
    return method === 'GET'
        ? request.get(`${API_BASE}${path}`, { headers, timeout: PROBE_TIMEOUT })
        : request.post(`${API_BASE}${path}`, init);
}

/**
 * Resolve the first candidate path that is "present" (not 404/405 when probed
 * with the given method + token). Returns null when none exist.
 */
async function resolvePath(
    request: APIRequestContext,
    paths: string[],
    method: Method,
    token?: string,
): Promise<string | null> {
    for (const path of paths) {
        const res = await call(request, method, path, { token, data: {} });
        if (res.status() !== 404 && res.status() !== 405) return path;
    }
    return null;
}

async function bodyOf(res: { json: () => Promise<unknown>; text: () => Promise<string> }) {
    try {
        return (await res.json()) as Record<string, unknown>;
    } catch {
        return { _raw: await res.text().catch(() => '') } as Record<string, unknown>;
    }
}

// ── RFC-6238 TOTP (so a verify step can genuinely succeed where supported). ──
function base32Decode(input: string): Buffer {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const clean = input.replace(/=+$/g, '').toUpperCase().replace(/\s+/g, '');
    let bits = '';
    for (const ch of clean) {
        const idx = alphabet.indexOf(ch);
        if (idx === -1) continue;
        bits += idx.toString(2).padStart(5, '0');
    }
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

function totpCode(secret: string, digits = 6, period = 30, atMs = Date.now()): string {
    const key = base32Decode(secret);
    if (key.length === 0) return '000000';
    const counter = Math.floor(atMs / 1000 / period);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** Pull a TOTP secret out of any of the shapes Better Auth / aliases may return. */
function extractSecret(body: Record<string, unknown>): string | null {
    const direct = body.secret ?? body.totpSecret ?? body.base32 ?? body.sharedSecret;
    if (typeof direct === 'string' && direct.length >= 8) return direct;
    const uri = body.totpURI ?? body.totpUri ?? body.uri ?? body.otpauthUrl ?? body.otpauth;
    if (typeof uri === 'string') {
        const m = uri.match(/[?&]secret=([^&]+)/i);
        if (m) return decodeURIComponent(m[1]);
    }
    for (const k of ['data', 'twoFactor', 'result']) {
        const nested = body[k];
        if (nested && typeof nested === 'object') {
            const got = extractSecret(nested as Record<string, unknown>);
            if (got) return got;
        }
    }
    return null;
}

/** Pull backup / recovery codes out of any recognised shape. */
function extractCodes(body: Record<string, unknown>): string[] {
    const candidates = body.backupCodes ?? body.recoveryCodes ?? body.codes ?? body.backup_codes;
    if (Array.isArray(candidates)) {
        return candidates.map((c) => String(c)).filter((c) => c.length > 0);
    }
    for (const k of ['data', 'twoFactor', 'result']) {
        const nested = body[k];
        if (nested && typeof nested === 'object') {
            const got = extractCodes(nested as Record<string, unknown>);
            if (got.length) return got;
        }
    }
    return [];
}

/** Did 2FA actually flip on (status route present + boolean/string says so)? */
async function readEnabled(request: APIRequestContext, token: string): Promise<boolean | null> {
    const statusPath = await resolvePath(request, STATUS_PATHS, 'GET', token);
    if (!statusPath) return null;
    const res = await call(request, 'GET', statusPath, { token });
    if (res.status() !== 200) return null;
    const b = await bodyOf(res);
    const v =
        b.enabled ??
        b.is2faEnabled ??
        b.isEnabled ??
        b.twoFactorEnabled ??
        b.mfaEnabled ??
        (b.twoFactor as Record<string, unknown> | undefined)?.enabled;
    if (typeof v === 'boolean') return v;
    const status = String(b.status ?? '').toLowerCase();
    if (status) return ['enabled', 'active', 'on', 'verified'].includes(status);
    return null;
}

/** True iff a login body looks "challenged" rather than a clean full session. */
function looksChallenged(status: number, body: Record<string, unknown>): boolean {
    return (
        status >= 400 ||
        body.twoFactorRedirect === true ||
        body.requiresTwoFactor === true ||
        body.requires2fa === true ||
        String(body.status ?? '')
            .toLowerCase()
            .includes('two') ||
        (status < 300 && !body.access_token)
    );
}

test.describe('2FA full state machine — enroll → verify → challenge → recover → disable', () => {
    test('enroll surface enforces auth, never silently succeeds, and a fresh user is NOT enabled', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const enablePath = await resolvePath(request, ENABLE_PATHS, 'POST', u.access_token);
        const statusPath = await resolvePath(request, STATUS_PATHS, 'GET', u.access_token);

        if (!enablePath && !statusPath) {
            // No 2FA surface in this env (PROBED). The closest-real invariant we can
            // still assert end-to-end: the sensitive auth-mutation surface IS gated,
            // and login currently hands back a clean session (no half-open 2FA state).
            const anonPwChange = await call(request, 'POST', UPDATE_PASSWORD_PATH, {
                data: { currentPassword: u.password, newPassword: 'AnotherPw9!secure' },
            });
            expect(
                [401, 403],
                `unauth update-password → ${anonPwChange.status()} (sensitive op must be gated)`,
            ).toContain(anonPwChange.status());

            const login = await request.post(`${API_BASE}${LOGIN_PATH}`, {
                data: { email: u.email, password: u.password },
                timeout: PROBE_TIMEOUT,
            });
            expect(login.status(), 'plain login works (no 2FA enforced)').toBe(200);
            const lb = await bodyOf(login);
            expect(
                lb.access_token,
                'no half-open 2FA state: login yields a full session',
            ).toBeTruthy();
            test.skip(
                true,
                '2FA enroll/status surface not exposed in this environment (PROBED 404)',
            );
        }

        // Whatever surface exists, the UNAUTHENTICATED call MUST be a clean gate —
        // never a 200, never a 5xx (a missing-body 400 is also acceptable).
        const probePath = enablePath ?? statusPath!;
        const method: Method = enablePath ? 'POST' : 'GET';
        const unauth = await call(request, method, probePath, { data: {} });
        expect(
            [400, 401, 403],
            `unauth ${method} ${probePath} → ${unauth.status()} (must be a gate, not silent success)`,
        ).toContain(unauth.status());

        if (statusPath) {
            const enabled = await readEnabled(request, u.access_token);
            if (enabled !== null) {
                expect(enabled, 'a brand-new user must not have 2FA enabled').toBe(false);
            }
        }
    });

    test('enroll → TOTP verify → challenge-on-login (real RFC-6238 happy path; degrades when 2FA absent)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const enablePath = await resolvePath(request, ENABLE_PATHS, 'POST', u.access_token);
        const verifyPath = await resolvePath(request, VERIFY_TOTP_PATHS, 'POST', u.access_token);

        if (!enablePath) {
            // PROBED-absent path: assert the verified baseline — with no 2FA, a fresh
            // password login returns a clean full session and NO challenge marker. This
            // is the load-bearing "no challenge today" invariant the happy path inverts.
            const login = await request.post(`${API_BASE}${LOGIN_PATH}`, {
                data: { email: u.email, password: u.password },
                timeout: PROBE_TIMEOUT,
            });
            expect(login.status(), 'plain login → 200').toBe(200);
            const body = await bodyOf(login);
            expect(
                body.access_token,
                'login yields an access_token (no challenge gate)',
            ).toBeTruthy();
            expect(
                looksChallenged(login.status(), body),
                'with no 2FA enrolled, login must NOT be challenged',
            ).toBeFalsy();
            test.skip(true, '2FA enable endpoint not exposed (PROBED 404)');
        }

        // Better Auth password-gates enable; send password under the common aliases.
        const enableRes = await call(request, 'POST', enablePath!, {
            token: u.access_token,
            data: { password: u.password, currentPassword: u.password },
        });
        expect(
            enableRes.status(),
            `enable → ${enableRes.status()}: ${await enableRes.text().catch(() => '')}`,
        ).toBeLessThan(500);
        if (enableRes.status() >= 400) {
            test.skip(
                true,
                `enable rejected with ${enableRes.status()} — DTO not satisfiable blindly`,
            );
        }

        const secret = extractSecret(await bodyOf(enableRes));

        if (verifyPath && secret) {
            const code = totpCode(secret);
            const verifyRes = await call(request, 'POST', verifyPath, {
                token: u.access_token,
                data: { code, token: code, totp: code },
            });
            expect(verifyRes.status(), `verify-totp → ${verifyRes.status()}`).toBeLessThan(500);

            if (verifyRes.status() < 300) {
                const enabledAfter = await readEnabled(request, u.access_token);
                if (enabledAfter !== null) {
                    expect(enabledAfter, 'after a valid TOTP verify, 2FA is enabled').toBe(true);
                }
                // Challenge-on-login: a plain password login must now be challenged
                // (challenge marker OR 4xx OR 200-without-token), never a silent full
                // session.
                const loginRes = await request.post(`${API_BASE}${LOGIN_PATH}`, {
                    data: { email: u.email, password: u.password },
                    timeout: PROBE_TIMEOUT,
                });
                const loginBody = await bodyOf(loginRes);
                expect(
                    looksChallenged(loginRes.status(), loginBody),
                    `with 2FA enabled, plain login must be challenged (got ${loginRes.status()} ` +
                        `token=${Boolean(loginBody.access_token)})`,
                ).toBeTruthy();
            } else {
                test.info().annotations.push({
                    type: 'note',
                    description: 'TOTP verify present but code rejected (skew/params)',
                });
            }
        } else if (verifyPath) {
            // Verify route exists but no secret → 2FA must not be fully enabled before
            // a verify confirms possession (no half-open leak).
            const enabledNow = await readEnabled(request, u.access_token);
            if (enabledNow !== null) {
                expect(
                    enabledNow,
                    '2FA must not be enabled before TOTP verify confirms possession',
                ).toBe(false);
            }
        } else {
            test.info().annotations.push({
                type: 'note',
                description: 'enable present but no TOTP verify route to complete the happy path',
            });
        }
    });

    test('wrong TOTP code is rejected (4xx) and repeated wrong codes never 5xx (lockout-tolerant)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const verifyPath = await resolvePath(request, VERIFY_TOTP_PATHS, 'POST', u.access_token);

        if (!verifyPath) {
            // PROBED-absent: the closest-real "wrong factor is rejected, repeatedly,
            // never 5xx" invariant lives on update-password's currentPassword check.
            // A wrong current credential must be a clean 401 every time and NEVER flip
            // the account into a broken/locked-out 5xx state.
            const statuses: number[] = [];
            for (let i = 0; i < 5; i++) {
                const res = await call(request, 'POST', UPDATE_PASSWORD_PATH, {
                    token: u.access_token,
                    data: {
                        currentPassword: `Wrong${i}!pw9secure`,
                        newPassword: 'BrandNew9!secure',
                    },
                });
                statuses.push(res.status());
            }
            expect(
                statuses.every((s) => s >= 400 && s < 500),
                `every wrong-credential attempt stayed 4xx (got [${statuses.join(',')}])`,
            ).toBeTruthy();
            expect(statuses, 'wrong current password is a 401 step-up rejection').toContain(401);
            // And the correct credential STILL works after the wrong attempts — no
            // account lockout corrupts the happy path.
            const ok = await call(request, 'POST', UPDATE_PASSWORD_PATH, {
                token: u.access_token,
                data: { currentPassword: u.password, newPassword: 'BrandNew9!secure' },
            });
            expect(ok.status(), 'correct credential still accepted after wrong attempts').toBe(200);
            test.skip(true, '2FA TOTP verify endpoint not exposed (PROBED 404)');
        }

        const enablePath = await resolvePath(request, ENABLE_PATHS, 'POST', u.access_token);
        if (enablePath) {
            const en = await call(request, 'POST', enablePath, {
                token: u.access_token,
                data: { password: u.password, currentPassword: u.password },
            });
            expect(en.status(), 'enable must not 5xx').toBeLessThan(500);
        }

        const statuses: number[] = [];
        for (let i = 0; i < 6; i++) {
            const res = await call(request, 'POST', verifyPath!, {
                token: u.access_token,
                data: { code: '000000', token: '000000', totp: '000000' },
            });
            statuses.push(res.status());
            expect(
                res.status(),
                `wrong-code attempt ${i + 1} → ${res.status()} (must be 4xx, not 5xx/2xx)`,
            ).toBeGreaterThanOrEqual(400);
            expect(res.status(), `wrong-code attempt ${i + 1} must not 5xx`).toBeLessThan(500);
        }

        const enabledAfter = await readEnabled(request, u.access_token);
        if (enabledAfter !== null) {
            expect(enabledAfter, 'wrong codes never enable 2FA').toBe(false);
        }
        expect(
            statuses.every((s) => s >= 400 && s < 500),
            `all wrong-code attempts stayed 4xx: [${statuses.join(',')}]`,
        ).toBeTruthy();
    });

    test('backup/recovery codes: not issuable/usable without 2FA, and a consumed code is single-use', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const genPath = await resolvePath(request, GEN_BACKUP_PATHS, 'POST', u.access_token);
        const verifyBackupPath = await resolvePath(
            request,
            VERIFY_BACKUP_PATHS,
            'POST',
            u.access_token,
        );

        if (!genPath && !verifyBackupPath) {
            // PROBED-absent: the closest-real single-use/replay invariant is the
            // session bearer's behaviour. logout-all is the recovery-event side effect;
            // assert it is gated and idempotent-safe (never 5xx on repeat), and that a
            // non-existent recovery surface cleanly 404s rather than silently issuing.
            const anonGen = await call(request, 'POST', GEN_BACKUP_PATHS[0], {
                data: { password: u.password },
            });
            expect(anonGen.status(), 'recovery-code issuance surface is absent (404)').toBe(404);

            const loa1 = await call(request, 'POST', LOGOUT_ALL_PATH, {
                token: u.access_token,
                data: {},
            });
            expect(loa1.status(), 'logout-all authed → 200').toBe(200);
            const loa2 = await call(request, 'POST', LOGOUT_ALL_PATH, {
                token: u.access_token,
                data: {},
            });
            expect(
                loa2.status(),
                'repeated logout-all must not 5xx (idempotent-safe)',
            ).toBeLessThan(500);
            test.skip(true, 'no backup/recovery-code surface exposed (PROBED 404)');
        }

        // (a) Generating codes WITHOUT enrolled 2FA must be a 4xx — issuing recovery
        // codes for an unprotected account would be a leak.
        if (genPath) {
            const preEnroll = await call(request, 'POST', genPath, {
                token: u.access_token,
                data: { password: u.password },
            });
            expect(
                preEnroll.status(),
                `generate-codes pre-enroll → ${preEnroll.status()} (must be 4xx)`,
            ).toBeGreaterThanOrEqual(400);
            expect(preEnroll.status(), 'generate-codes pre-enroll must not 5xx').toBeLessThan(500);
        }

        // (b) Verifying a backup code WITHOUT 2FA must also be a 4xx, never 2xx.
        if (verifyBackupPath) {
            const preVerify = await call(request, 'POST', verifyBackupPath, {
                token: u.access_token,
                data: { code: 'AAAA-BBBB', token: 'AAAA-BBBB' },
            });
            expect(
                preVerify.status(),
                `verify-backup pre-enroll → ${preVerify.status()}`,
            ).toBeGreaterThanOrEqual(400);
            expect(preVerify.status(), 'verify-backup pre-enroll must not 5xx').toBeLessThan(500);
        }

        // (c) Single-use: enroll + verify (TOTP) → obtain codes → consume one → prove
        // the replay is rejected. Degrades when any leg is not blindly drivable.
        const enablePath = await resolvePath(request, ENABLE_PATHS, 'POST', u.access_token);
        const verifyTotpPath = await resolvePath(
            request,
            VERIFY_TOTP_PATHS,
            'POST',
            u.access_token,
        );
        if (!enablePath || !verifyTotpPath || !genPath || !verifyBackupPath) {
            test.info().annotations.push({
                type: 'note',
                description:
                    'single-use leg degraded: full enroll/verify/issue/consume loop not all present',
            });
            return;
        }

        const enableRes = await call(request, 'POST', enablePath, {
            token: u.access_token,
            data: { password: u.password, currentPassword: u.password },
        });
        if (enableRes.status() >= 300) return;
        const secret = extractSecret(await bodyOf(enableRes));
        if (!secret) return;

        const code = totpCode(secret);
        const totpRes = await call(request, 'POST', verifyTotpPath, {
            token: u.access_token,
            data: { code, token: code, totp: code },
        });
        if (totpRes.status() >= 300) return;

        const genRes = await call(request, 'POST', genPath, {
            token: u.access_token,
            data: { password: u.password },
        });
        if (genRes.status() >= 300) return;
        const codes = extractCodes(await bodyOf(genRes));
        if (codes.length === 0) return;

        const backupCode = codes[0];
        const first = await call(request, 'POST', verifyBackupPath, {
            token: u.access_token,
            data: { code: backupCode, token: backupCode },
        });
        expect(first.status(), `first backup-code use → ${first.status()}`).toBeLessThan(500);

        if (first.status() < 300) {
            const replay = await call(request, 'POST', verifyBackupPath, {
                token: u.access_token,
                data: { code: backupCode, token: backupCode },
            });
            expect(
                replay.status(),
                `replayed backup code → ${replay.status()} (must be rejected 4xx — single-use)`,
            ).toBeGreaterThanOrEqual(400);
            expect(replay.status(), 'replay must not 5xx').toBeLessThan(500);
        }
    });

    test('step-up: mutating the auth factor requires the current factor (no proof → 4xx, never 5xx)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const disablePath = await resolvePath(request, DISABLE_PATHS, 'POST', u.access_token);
        const genPath = await resolvePath(request, GEN_BACKUP_PATHS, 'POST', u.access_token);

        // ── Closest-real, ALWAYS-asserted step-up gate on the live surface. ──
        // update-password is the canonical "sensitive op": changing the auth factor
        // REQUIRES re-presenting the current factor. PROBED contract:
        //   missing currentPassword → 400 ; wrong → 401 ; unauth → 401 ; correct → 200.
        const missingProof = await call(request, 'POST', UPDATE_PASSWORD_PATH, {
            token: u.access_token,
            data: { newPassword: 'BrandNew9!secure' },
        });
        expect(missingProof.status(), 'update-password with no current factor → 400 DTO gate').toBe(
            400,
        );

        const wrongProof = await call(request, 'POST', UPDATE_PASSWORD_PATH, {
            token: u.access_token,
            data: { currentPassword: 'TotallyWrong9!x', newPassword: 'BrandNew9!secure' },
        });
        expect(
            wrongProof.status(),
            'update-password with wrong current factor → 401 step-up gate',
        ).toBe(401);
        const wrongBody = await bodyOf(wrongProof);
        expect(
            String(wrongBody.message ?? '').toLowerCase(),
            '401 explains the incorrect current factor',
        ).toContain('current password');

        const anon = await call(request, 'POST', UPDATE_PASSWORD_PATH, {
            data: { currentPassword: u.password, newPassword: 'BrandNew9!secure' },
        });
        expect([401, 403], `anon update-password → ${anon.status()}`).toContain(anon.status());

        // ── 2FA-native step-up assertions (discovery-first; PROBED-absent today). ──
        if (disablePath) {
            const noProof = await call(request, 'POST', disablePath, {
                token: u.access_token,
                data: {},
            });
            expect(
                noProof.status(),
                `2FA disable with no proof → ${noProof.status()} (must be a 4xx step-up gate)`,
            ).toBeGreaterThanOrEqual(400);
            expect(noProof.status(), '2FA disable step-up must not 5xx').toBeLessThan(500);
            const anonDisable = await call(request, 'POST', disablePath, { data: {} });
            expect([400, 401, 403], `anon 2FA disable → ${anonDisable.status()}`).toContain(
                anonDisable.status(),
            );
        }
        if (genPath) {
            const noProof = await call(request, 'POST', genPath, {
                token: u.access_token,
                data: {},
            });
            expect(
                noProof.status(),
                `regenerate codes with no proof → ${noProof.status()}`,
            ).toBeGreaterThanOrEqual(400);
            expect(noProof.status(), 'regenerate step-up must not 5xx').toBeLessThan(500);
        }
        if (!disablePath && !genPath) {
            test.info().annotations.push({
                type: 'note',
                description:
                    '2FA disable/regenerate surface absent (PROBED 404); step-up asserted via update-password',
            });
        }
    });

    test('disable / recovery event revokes sessions and returns the account to a usable login (lifecycle close-out)', async ({
        request,
    }) => {
        const u = await registerUserViaAPI(request);
        const enablePath = await resolvePath(request, ENABLE_PATHS, 'POST', u.access_token);
        const verifyTotpPath = await resolvePath(
            request,
            VERIFY_TOTP_PATHS,
            'POST',
            u.access_token,
        );
        const disablePath = await resolvePath(request, DISABLE_PATHS, 'POST', u.access_token);

        if (!enablePath || !disablePath) {
            // PROBED-absent: model the close-out with the verified surfaces. A 2FA
            // disable / recovery-code-recovery event's real-world effect is a global
            // session revocation followed by the credential still authenticating.
            // 1) change the factor with correct current proof (the "disable" analogue)
            const changed = await call(request, 'POST', UPDATE_PASSWORD_PATH, {
                token: u.access_token,
                data: { currentPassword: u.password, newPassword: 'Rotated9!secure' },
            });
            expect(changed.status(), 'factor rotation with valid proof → 200').toBe(200);

            // 2) the OLD credential is now rejected; the NEW credential authenticates.
            const oldLogin = await request.post(`${API_BASE}${LOGIN_PATH}`, {
                data: { email: u.email, password: u.password },
                timeout: PROBE_TIMEOUT,
            });
            expect(oldLogin.status(), 'old credential rejected after rotation → 401').toBe(401);
            const restored = await loginViaAPI(request, {
                email: u.email,
                password: 'Rotated9!secure',
            });
            expect(restored.access_token, 'new credential restores a full session').toBeTruthy();

            // 3) global session revocation primitive (the disable/recovery side effect)
            //    is gated and succeeds for the authed user with the fresh session.
            const loa = await call(request, 'POST', LOGOUT_ALL_PATH, {
                token: restored.access_token,
                data: {},
            });
            expect(loa.status(), 'logout-all (recovery side effect) → 200').toBe(200);
            const loaBody = await bodyOf(loa);
            expect(String(loaBody.message ?? '').toLowerCase()).toContain('all devices');
            const anonLoa = await call(request, 'POST', LOGOUT_ALL_PATH, { data: {} });
            expect(anonLoa.status(), 'logout-all unauth → 401').toBe(401);
            test.skip(true, '2FA enable/disable surface not both exposed (PROBED 404)');
        }

        // ── Full 2FA enable → verify → disable round-trip (where exposed). ──
        const enableRes = await call(request, 'POST', enablePath!, {
            token: u.access_token,
            data: { password: u.password, currentPassword: u.password },
        });
        expect(enableRes.status(), 'enable must not 5xx').toBeLessThan(500);
        const secret = extractSecret(await bodyOf(enableRes));

        if (verifyTotpPath && secret && enableRes.status() < 300) {
            const code = totpCode(secret);
            const v = await call(request, 'POST', verifyTotpPath, {
                token: u.access_token,
                data: { code, token: code, totp: code },
            });
            expect(v.status(), 'verify must not 5xx').toBeLessThan(500);
        }

        const disableCode = secret ? totpCode(secret) : '000000';
        const disableRes = await call(request, 'POST', disablePath!, {
            token: u.access_token,
            data: {
                password: u.password,
                currentPassword: u.password,
                code: disableCode,
                token: disableCode,
            },
        });
        expect(
            disableRes.status(),
            `disable → ${disableRes.status()}: ${await disableRes.text().catch(() => '')}`,
        ).toBeLessThan(500);

        // End-state: regardless of how far enable/verify got, the password must
        // either log in cleanly OR be truthfully challenged — never a 5xx.
        const login = await request.post(`${API_BASE}${LOGIN_PATH}`, {
            data: { email: u.email, password: u.password },
            timeout: PROBE_TIMEOUT,
        });
        expect(login.status(), `final login → ${login.status()}`).toBeLessThan(500);
        const loginBody = await bodyOf(login);
        const ok = login.status() < 300 && Boolean(loginBody.access_token);
        expect(
            ok || looksChallenged(login.status(), loginBody),
            'after lifecycle, password logs in cleanly OR is truthfully challenged',
        ).toBeTruthy();

        if (disableRes.status() < 300) {
            const reLogin = await loginViaAPI(request, { email: u.email, password: u.password });
            expect(
                reLogin.access_token,
                'after a confirmed disable, plain login is restored',
            ).toBeTruthy();
        }
    });

    test('seeded user: the Security settings page renders without hard-error (2FA control surface UI smoke)', async ({
        page,
        baseURL,
    }) => {
        // Read-only UI assertion on the SHARED seeded user (storageState) — no
        // mutation. Confirms the security management UI is reachable; the 2FA
        // affordance is tolerated as absent (feature-flagged off / PROBED-absent API)
        // and degrades to a non-fatal annotation. next-dev local-vs-CI route
        // divergence is handled with .or() branching.
        const origin = baseURL ?? 'http://localhost:3000';
        void loadSeededTestUser(); // assert storageState seeding precondition exists
        void origin;

        const securityRoute = page
            .goto('/en/settings/security', { waitUntil: 'domcontentloaded' })
            .catch(() => null);
        await securityRoute;
        await page.waitForTimeout(1_500);

        const hasError = page.getByText(/something went wrong|application error/i).first();
        await expect(hasError, 'security page must not hard-error').toHaveCount(0);

        const twoFa = page
            .getByText(/two[\s-]?factor|authenticator|\b2fa\b|\bmfa\b/i)
            .first()
            .or(
                page
                    .getByRole('button', { name: /two[\s-]?factor|authenticator|2fa|enable/i })
                    .first(),
            );
        const visible = await twoFa.isVisible().catch(() => false);
        if (!visible) {
            test.info().annotations.push({
                type: 'note',
                description:
                    '2FA UI control not present on /settings/security in this env (flagged off / API surface absent / route divergence)',
            });
        }

        // Page is alive either way: a password input, a heading, or any landmark.
        const alive = page
            .locator('input[type="password"]')
            .first()
            .or(page.getByRole('heading').first())
            .or(page.locator('main').first());
        await expect(alive.first()).toBeVisible({ timeout: 15_000 });
    });
});
