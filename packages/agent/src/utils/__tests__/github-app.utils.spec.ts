import {
    createGitHubAppHeaders,
    createGitHubAppJwt,
    createGitHubOAuthHeaders,
    requestGitHubAppInstallationAccessToken,
    requestGitHubAppInstallationAccessTokenDetails,
    verifyGitHubWebhookSignature,
} from '../github-app.utils';
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';

// Generate a test RSA keypair once for the whole suite. JWT signing requires
// a real key; mocking `createSign` would defeat the purpose of the test.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
});
const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const decodeBase64UrlJson = (segment: string): Record<string, unknown> => {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
};

describe('createGitHubAppJwt', () => {
    it('produces a 3-part dotted JWT (header.payload.signature)', () => {
        const jwt = createGitHubAppJwt({ appId: '12345', privateKey: privateKeyPem });

        const parts = jwt.split('.');
        expect(parts).toHaveLength(3);
        expect(parts[0].length).toBeGreaterThan(0);
        expect(parts[1].length).toBeGreaterThan(0);
        expect(parts[2].length).toBeGreaterThan(0);
    });

    it('emits the documented RS256 header { alg: "RS256", typ: "JWT" }', () => {
        const jwt = createGitHubAppJwt({ appId: '12345', privateKey: privateKeyPem });
        const [headerSegment] = jwt.split('.');

        const header = decodeBase64UrlJson(headerSegment);
        expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    });

    it('emits payload with iat = now-60, exp = now+9*60, iss = appId (in seconds)', () => {
        const fixedNowMs = 1_700_000_000_000;
        const fixedNowSec = Math.floor(fixedNowMs / 1000);
        jest.spyOn(Date, 'now').mockReturnValue(fixedNowMs);

        try {
            const jwt = createGitHubAppJwt({
                appId: 'app-id-99',
                privateKey: privateKeyPem,
            });
            const [, payloadSegment] = jwt.split('.');
            const payload = decodeBase64UrlJson(payloadSegment);

            expect(payload).toEqual({
                iat: fixedNowSec - 60,
                exp: fixedNowSec + 9 * 60,
                iss: 'app-id-99',
            });
        } finally {
            (Date.now as jest.Mock).mockRestore();
        }
    });

    it('signs the unsignedToken with RSA-SHA256 against the supplied private key (verifiable via the public key)', () => {
        const jwt = createGitHubAppJwt({ appId: '42', privateKey: privateKeyPem });
        const [headerSegment, payloadSegment, signatureSegment] = jwt.split('.');
        const unsignedToken = `${headerSegment}.${payloadSegment}`;

        // Verify the signature round-trips via the matching public key.
        const verifier = createVerify('RSA-SHA256');
        verifier.update(unsignedToken);
        verifier.end();

        const isValid = verifier.verify(publicKeyPem, Buffer.from(signatureSegment, 'base64url'));
        expect(isValid).toBe(true);
    });

    it('forwards appId verbatim into the iss claim (does NOT coerce numeric strings to numbers)', () => {
        const jwt = createGitHubAppJwt({ appId: '00007', privateKey: privateKeyPem });
        const [, payloadSegment] = jwt.split('.');
        const payload = decodeBase64UrlJson(payloadSegment);

        // Pinned: GitHub's API accepts numeric-string app ids and the leading
        // zero matters for some installations — the JWT payload MUST preserve
        // the caller's exact string.
        expect(payload.iss).toBe('00007');
    });

    it('throws when the private key is malformed (delegates to Node crypto, no swallowing)', () => {
        expect(() =>
            createGitHubAppJwt({ appId: '12345', privateKey: 'not-a-real-key' }),
        ).toThrow();
    });
});

describe('createGitHubAppHeaders', () => {
    it('returns the documented 4-header set with Bearer JWT', () => {
        const headers = createGitHubAppHeaders('jwt-token-abc');

        expect(headers).toEqual({
            Accept: 'application/vnd.github+json',
            Authorization: 'Bearer jwt-token-abc',
            'User-Agent': 'Ever Works',
            'X-GitHub-Api-Version': '2022-11-28',
        });
    });

    it('forwards JWT verbatim into the Authorization header (no trim, no extra prefix munging)', () => {
        const padded = '  jwt-with-spaces  ';
        expect(createGitHubAppHeaders(padded).Authorization).toBe(`Bearer ${padded}`);
    });

    it('produces a fresh object on each call (no shared mutation hazard between callers)', () => {
        const a = createGitHubAppHeaders('a');
        const b = createGitHubAppHeaders('b');
        expect(a).not.toBe(b);
    });
});

describe('createGitHubOAuthHeaders', () => {
    it('returns the same header shape as the App headers but with a user access token', () => {
        const headers = createGitHubOAuthHeaders('gho_xxx');

        expect(headers).toEqual({
            Accept: 'application/vnd.github+json',
            Authorization: 'Bearer gho_xxx',
            'User-Agent': 'Ever Works',
            'X-GitHub-Api-Version': '2022-11-28',
        });
    });

    it('produces a fresh object on each call', () => {
        const a = createGitHubOAuthHeaders('a');
        const b = createGitHubOAuthHeaders('b');
        expect(a).not.toBe(b);
    });
});

describe('requestGitHubAppInstallationAccessTokenDetails', () => {
    const credentials = { appId: '12345', privateKey: privateKeyPem };
    let fetchSpy: jest.SpyInstance;

    afterEach(() => {
        fetchSpy?.mockRestore();
    });

    const makeResponse = (
        body: unknown,
        init: { ok?: boolean; status?: number; statusText?: string } = {},
    ): Response =>
        ({
            ok: init.ok ?? true,
            status: init.status ?? 200,
            statusText: init.statusText ?? 'OK',
            json: jest.fn().mockResolvedValue(body),
        }) as unknown as Response;

    it('POSTs to /app/installations/<id>/access_tokens with App-JWT headers', async () => {
        fetchSpy = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(
                makeResponse({ token: 'ghs_xxx', expires_at: '2026-01-01T00:00:00Z' }),
            );

        await requestGitHubAppInstallationAccessTokenDetails('inst-77', credentials);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];

        expect(url).toBe('https://api.github.com/app/installations/inst-77/access_tokens');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({
            Accept: 'application/vnd.github+json',
            Authorization: expect.stringMatching(
                /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
            ),
            'User-Agent': 'Ever Works',
            'X-GitHub-Api-Version': '2022-11-28',
        });
    });

    it('returns { token, expiresAt } when GitHub responds 200 with both fields', async () => {
        fetchSpy = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(
                makeResponse({ token: 'ghs_xxx', expires_at: '2026-01-01T00:00:00Z' }),
            );

        const result = await requestGitHubAppInstallationAccessTokenDetails('inst-77', credentials);

        expect(result).toEqual({ token: 'ghs_xxx', expiresAt: '2026-01-01T00:00:00Z' });
    });

    it('coerces missing expires_at to null (?? null fallback — the GitHub API documents this as optional)', async () => {
        fetchSpy = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(makeResponse({ token: 'ghs_xxx' }));

        const result = await requestGitHubAppInstallationAccessTokenDetails('inst-77', credentials);

        expect(result).toEqual({ token: 'ghs_xxx', expiresAt: null });
    });

    it('coerces explicit null expires_at to null (defensive — same fallback path)', async () => {
        fetchSpy = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(makeResponse({ token: 'ghs_xxx', expires_at: null }));

        const result = await requestGitHubAppInstallationAccessTokenDetails('inst-77', credentials);

        expect(result.expiresAt).toBeNull();
    });

    it('throws "Failed to create GitHub App installation token: <status> <statusText>" on non-OK', async () => {
        fetchSpy = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(
                makeResponse({}, { ok: false, status: 401, statusText: 'Unauthorized' }),
            );

        await expect(
            requestGitHubAppInstallationAccessTokenDetails('inst-77', credentials),
        ).rejects.toThrow('Failed to create GitHub App installation token: 401 Unauthorized');
    });

    it('throws when response is OK but body is missing the token field', async () => {
        fetchSpy = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(makeResponse({ expires_at: '2026-01-01T00:00:00Z' }));

        await expect(
            requestGitHubAppInstallationAccessTokenDetails('inst-77', credentials),
        ).rejects.toThrow('GitHub App installation token response did not include a token');
    });

    it('throws when response is OK but token field is empty-string (falsy guard)', async () => {
        fetchSpy = jest
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(makeResponse({ token: '', expires_at: '2026-01-01T00:00:00Z' }));

        await expect(
            requestGitHubAppInstallationAccessTokenDetails('inst-77', credentials),
        ).rejects.toThrow('GitHub App installation token response did not include a token');
    });

    it('propagates fetch rejections (network failure → caller decides retry policy)', async () => {
        fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

        await expect(
            requestGitHubAppInstallationAccessTokenDetails('inst-77', credentials),
        ).rejects.toThrow('ECONNRESET');
    });
});

describe('requestGitHubAppInstallationAccessToken (token-only thin wrapper)', () => {
    const credentials = { appId: '12345', privateKey: privateKeyPem };
    let fetchSpy: jest.SpyInstance;

    afterEach(() => {
        fetchSpy?.mockRestore();
    });

    it('returns the token field only (drops expiresAt)', async () => {
        fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            json: jest
                .fn()
                .mockResolvedValue({ token: 'ghs_xxx', expires_at: '2026-01-01T00:00:00Z' }),
        } as unknown as Response);

        const token = await requestGitHubAppInstallationAccessToken('inst-77', credentials);

        expect(token).toBe('ghs_xxx');
    });

    it('rethrows when the underlying details call fails', async () => {
        fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: jest.fn().mockResolvedValue({}),
        } as unknown as Response);

        await expect(
            requestGitHubAppInstallationAccessToken('inst-77', credentials),
        ).rejects.toThrow(
            'Failed to create GitHub App installation token: 500 Internal Server Error',
        );
    });
});

describe('verifyGitHubWebhookSignature', () => {
    const secret = 'webhook-secret';
    const body = '{"action":"opened"}';
    const validHex = createHmac('sha256', secret).update(body).digest('hex');
    const validHeader = `sha256=${validHex}`;

    it('returns true for the canonical "sha256=<hex>" header signed with the same secret+body', () => {
        expect(verifyGitHubWebhookSignature(body, secret, validHeader)).toBe(true);
    });

    it('returns false when signatureHeader is undefined (header missing)', () => {
        expect(verifyGitHubWebhookSignature(body, secret)).toBe(false);
    });

    it('returns false when signatureHeader is empty-string (falsy guard)', () => {
        expect(verifyGitHubWebhookSignature(body, secret, '')).toBe(false);
    });

    it('returns false when signatureHeader does not start with "sha256=" (e.g. legacy "sha1=" or no scheme)', () => {
        const sha1 = require('node:crypto').createHmac('sha1', secret).update(body).digest('hex');
        expect(verifyGitHubWebhookSignature(body, secret, `sha1=${sha1}`)).toBe(false);
        expect(verifyGitHubWebhookSignature(body, secret, validHex)).toBe(false);
        expect(verifyGitHubWebhookSignature(body, secret, 'SHA256=' + validHex)).toBe(false);
    });

    it('returns false when received signature length differs from expected (timingSafeEqual prerequisite)', () => {
        // Pinned: the explicit length-guard runs BEFORE timingSafeEqual to avoid
        // the RangeError that timingSafeEqual throws on mismatched-length inputs.
        // Without the guard, a malformed/truncated header would crash instead of
        // returning false.
        expect(verifyGitHubWebhookSignature(body, secret, 'sha256=tooshort')).toBe(false);
        expect(verifyGitHubWebhookSignature(body, secret, `sha256=${validHex}deadbeef`)).toBe(
            false,
        );
    });

    it('returns false when signature length matches but bytes differ (constant-time compare actually rejects)', () => {
        // Build a same-length-but-wrong hex string by flipping the first character.
        const flipped = validHex[0] === 'a' ? `b${validHex.slice(1)}` : `a${validHex.slice(1)}`;
        expect(verifyGitHubWebhookSignature(body, secret, `sha256=${flipped}`)).toBe(false);
    });

    it('returns false when secret differs (verifies the HMAC actually depends on the secret)', () => {
        const wrongSecretSig = createHmac('sha256', 'different-secret').update(body).digest('hex');
        expect(verifyGitHubWebhookSignature(body, secret, `sha256=${wrongSecretSig}`)).toBe(false);
    });

    it('returns false when body differs (verifies the HMAC actually depends on body)', () => {
        const tamperedBody = '{"action":"closed"}';
        expect(verifyGitHubWebhookSignature(tamperedBody, secret, validHeader)).toBe(false);
    });

    it('returns true even for an empty body when the signature was computed over the empty body', () => {
        const emptySig = createHmac('sha256', secret).update('').digest('hex');
        expect(verifyGitHubWebhookSignature('', secret, `sha256=${emptySig}`)).toBe(true);
    });
});
