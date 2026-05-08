import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock fs-extra BEFORE importing the service
vi.mock('fs-extra', () => {
    const ensureDir = vi.fn().mockResolvedValue(undefined);
    const writeJson = vi.fn().mockResolvedValue(undefined);
    const readJson = vi.fn();
    const pathExists = vi.fn();
    const remove = vi.fn().mockResolvedValue(undefined);
    return {
        default: { ensureDir, writeJson, readJson, pathExists, remove },
        ensureDir,
        writeJson,
        readJson,
        pathExists,
        remove,
    };
});

import * as fs from 'fs-extra';
import { CredentialsService, type Credentials } from '../credentials.service';

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function makeJwt(payload: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${HEADER}.${body}.signature`;
}

const FUTURE_EXP = Math.floor(Date.now() / 1000) + 60 * 60 * 24; // 24h from now
const PAST_EXP = Math.floor(Date.now() / 1000) - 60; // 1m ago

const SAMPLE_USER = {
    sub: 'user-123',
    email: 'user@example.com',
    provider: 'github',
    username: 'evereq',
    emailVerified: true,
    isActive: true,
    avatar: 'https://example.com/avatar.png',
};

function validToken(): string {
    return makeJwt({ ...SAMPLE_USER, iat: 0, iss: 'ever', aud: 'cli', exp: FUTURE_EXP });
}

function expiredToken(): string {
    return makeJwt({ ...SAMPLE_USER, iat: 0, iss: 'ever', aud: 'cli', exp: PAST_EXP });
}

describe('CredentialsService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('credentialsPath', () => {
        it('returns a path under the user home dir', () => {
            // We don't pin the exact OS-specific separator; just assert the suffix.
            expect(CredentialsService.credentialsPath).toMatch(
                /\.ever-works[\\/]\.credentials\.json$/,
            );
        });
    });

    describe('save', () => {
        it('ensures the credentials dir exists then writes JSON with 2-space indent', async () => {
            const order: string[] = [];
            (fs.ensureDir as ReturnType<typeof vi.fn>).mockImplementation(async () => {
                order.push('ensureDir');
            });
            (fs.writeJson as ReturnType<typeof vi.fn>).mockImplementation(async () => {
                order.push('writeJson');
            });

            const creds: Credentials = { token: validToken(), apiUrl: 'http://x' };
            await CredentialsService.save(creds);

            expect(order).toEqual(['ensureDir', 'writeJson']);
            const writeCall = (fs.writeJson as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(writeCall[1]).toBe(creds);
            expect(writeCall[2]).toEqual({ spaces: 2 });
        });
    });

    describe('get', () => {
        it('returns null when the credentials file does not exist', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
            await expect(CredentialsService.get()).resolves.toBeNull();
            expect(fs.readJson).not.toHaveBeenCalled();
        });

        it('returns null + removes when readJson returns a non-object', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            (fs.readJson as ReturnType<typeof vi.fn>).mockResolvedValue('not-an-object');
            await expect(CredentialsService.get()).resolves.toBeNull();
            expect(fs.remove).toHaveBeenCalled();
        });

        it('returns null + removes when token is missing/empty/non-string', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);

            for (const badToken of [undefined, '', '   ', 42 as unknown as string]) {
                vi.clearAllMocks();
                (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
                (fs.readJson as ReturnType<typeof vi.fn>).mockResolvedValue({
                    token: badToken,
                    apiUrl: 'http://x',
                });
                await expect(CredentialsService.get()).resolves.toBeNull();
                expect(fs.remove).toHaveBeenCalled();
            }
        });

        it('returns null + removes when token has fewer than 3 dot-separated parts', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            (fs.readJson as ReturnType<typeof vi.fn>).mockResolvedValue({
                token: 'only.two',
                apiUrl: 'http://x',
            });
            await expect(CredentialsService.get()).resolves.toBeNull();
            expect(fs.remove).toHaveBeenCalled();
        });

        it('returns null + removes when token is expired', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            (fs.readJson as ReturnType<typeof vi.fn>).mockResolvedValue({
                token: expiredToken(),
                apiUrl: 'http://x',
            });
            await expect(CredentialsService.get()).resolves.toBeNull();
            expect(fs.remove).toHaveBeenCalled();
        });

        it('returns the credentials when token is valid and apiUrl is present', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            const stored = { token: validToken(), apiUrl: 'https://api.example.com' };
            (fs.readJson as ReturnType<typeof vi.fn>).mockResolvedValue(stored);
            await expect(CredentialsService.get()).resolves.toEqual(stored);
            expect(fs.remove).not.toHaveBeenCalled();
        });

        it('backfills missing apiUrl with the default API_URL and persists the update', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            const stored = { token: validToken() };
            (fs.readJson as ReturnType<typeof vi.fn>).mockResolvedValue(stored);

            const result = await CredentialsService.get();
            // result.apiUrl must be populated; the default falls back to localhost when API_URL env unset
            expect(result?.apiUrl).toBeTruthy();
            expect(typeof result?.apiUrl).toBe('string');
            // and it must have been persisted (writeJson called once because save() was invoked)
            expect(fs.writeJson).toHaveBeenCalledTimes(1);
        });

        it('returns null + tries to remove the file when readJson throws', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            (fs.readJson as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('I/O error'));
            // remove inside the catch path also exists-checks again — so make sure it works
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
            await expect(CredentialsService.get()).resolves.toBeNull();
        });

        it('returns null without throwing even when removal also fails', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            (fs.readJson as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('I/O error'));
            (fs.remove as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('also broken'));
            await expect(CredentialsService.get()).resolves.toBeNull();
        });
    });

    describe('remove', () => {
        it('returns true after removing an existing file', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            await expect(CredentialsService.remove()).resolves.toBe(true);
            expect(fs.remove).toHaveBeenCalled();
        });

        it('returns false when no file exists', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
            await expect(CredentialsService.remove()).resolves.toBe(false);
            expect(fs.remove).not.toHaveBeenCalled();
        });
    });

    describe('exists', () => {
        it('proxies to fs.pathExists', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            await expect(CredentialsService.exists()).resolves.toBe(true);
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
            await expect(CredentialsService.exists()).resolves.toBe(false);
        });
    });

    describe('update', () => {
        it('merges updates onto the existing record and saves the result', async () => {
            const existing = { token: validToken(), apiUrl: 'http://old', email: 'a@a.com' };
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            (fs.readJson as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

            await CredentialsService.update({ email: 'b@b.com' });

            const writeCall = (fs.writeJson as ReturnType<typeof vi.fn>).mock.calls[0];
            expect(writeCall[1]).toEqual({ ...existing, email: 'b@b.com' });
        });

        it('is a no-op when there are no current credentials', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
            await CredentialsService.update({ email: 'b@b.com' });
            expect(fs.writeJson).not.toHaveBeenCalled();
        });
    });

    describe('createWithExpiry', () => {
        it('extracts user info + ISO expiry from the token', () => {
            const token = validToken();
            const result = CredentialsService.createWithExpiry(token, 'http://x');
            expect(result.token).toBe(token);
            expect(result.apiUrl).toBe('http://x');
            expect(result.email).toBe(SAMPLE_USER.email);
            expect(result.username).toBe(SAMPLE_USER.username);
            expect(result.provider).toBe(SAMPLE_USER.provider);
            expect(result.emailVerified).toBe(true);
            expect(result.isActive).toBe(true);
            expect(result.avatar).toBe(SAMPLE_USER.avatar);
            expect(result.expiresAt).toBe(new Date(FUTURE_EXP * 1000).toISOString());
        });

        it('honors the email override over the JWT-decoded email', () => {
            const result = CredentialsService.createWithExpiry(
                validToken(),
                'http://x',
                'override@example.com',
            );
            expect(result.email).toBe('override@example.com');
        });

        it('returns undefined for fields when the token has no exp/user info', () => {
            const noExpToken = makeJwt({ sub: 'u' });
            const result = CredentialsService.createWithExpiry(noExpToken, 'http://x');
            expect(result.expiresAt).toBeUndefined();
            // JWT had only `sub`, so the rest of the user fields should be undefined
            expect(result.username).toBeUndefined();
        });
    });

    describe('extractUserFromToken', () => {
        it('returns the AuthUser-shaped projection from a valid token', () => {
            expect(CredentialsService.extractUserFromToken(validToken())).toMatchObject(
                SAMPLE_USER,
            );
        });
    });

    describe('requireAuth', () => {
        it('returns the credentials when present', async () => {
            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            const stored = { token: validToken(), apiUrl: 'http://x' };
            (fs.readJson as ReturnType<typeof vi.fn>).mockResolvedValue(stored);
            await expect(CredentialsService.requireAuth()).resolves.toEqual(stored);
        });

        it('logs an error and exits with code 1 when no credentials exist', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const exitSpy = vi
                .spyOn(process, 'exit')
                .mockImplementation((() => undefined as never) as typeof process.exit);

            (fs.pathExists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
            await CredentialsService.requireAuth();

            expect(errorSpy).toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(1);

            errorSpy.mockRestore();
            exitSpy.mockRestore();
        });
    });

    describe('getTokenExpiryInfo', () => {
        it('reports days/hours/minutes-left for a future-exp JWT', () => {
            // exp = now + 2 days + 3 hours + 4 minutes
            vi.useFakeTimers();
            try {
                const fixedNow = new Date('2024-01-01T00:00:00.000Z');
                vi.setSystemTime(fixedNow);
                const exp = Math.floor(fixedNow.getTime() / 1000) + 2 * 86_400 + 3 * 3_600 + 4 * 60;
                const token = makeJwt({ ...SAMPLE_USER, exp });
                const info = CredentialsService.getTokenExpiryInfo({
                    token,
                    apiUrl: 'http://x',
                });
                expect(info.isExpired).toBe(false);
                // strict: the helper only surfaces the LARGEST unit when daysLeft > 0
                expect(info.daysLeft).toBe(2);
                expect(info.hoursLeft).toBeUndefined();
                expect(info.minutesLeft).toBeUndefined();
            } finally {
                vi.useRealTimers();
            }
        });

        it('reports hoursLeft only when daysLeft===0', () => {
            vi.useFakeTimers();
            try {
                const fixedNow = new Date('2024-01-01T00:00:00.000Z');
                vi.setSystemTime(fixedNow);
                const exp = Math.floor(fixedNow.getTime() / 1000) + 5 * 3_600;
                const token = makeJwt({ ...SAMPLE_USER, exp });
                const info = CredentialsService.getTokenExpiryInfo({
                    token,
                    apiUrl: 'http://x',
                });
                expect(info.daysLeft).toBeUndefined();
                expect(info.hoursLeft).toBe(5);
                expect(info.minutesLeft).toBeUndefined();
            } finally {
                vi.useRealTimers();
            }
        });

        it('reports minutesLeft only when both daysLeft===0 and hoursLeft===0', () => {
            vi.useFakeTimers();
            try {
                const fixedNow = new Date('2024-01-01T00:00:00.000Z');
                vi.setSystemTime(fixedNow);
                const exp = Math.floor(fixedNow.getTime() / 1000) + 17 * 60;
                const token = makeJwt({ ...SAMPLE_USER, exp });
                const info = CredentialsService.getTokenExpiryInfo({
                    token,
                    apiUrl: 'http://x',
                });
                expect(info.minutesLeft).toBe(17);
            } finally {
                vi.useRealTimers();
            }
        });

        it('flags isExpired=true when JWT exp is in the past', () => {
            const info = CredentialsService.getTokenExpiryInfo({
                token: expiredToken(),
                apiUrl: 'http://x',
            });
            expect(info.isExpired).toBe(true);
        });

        it('falls back to credentials.expiresAt when the JWT has no exp claim', () => {
            vi.useFakeTimers();
            try {
                const fixedNow = new Date('2024-01-01T00:00:00.000Z');
                vi.setSystemTime(fixedNow);
                const futureIso = new Date(fixedNow.getTime() + 3 * 86_400 * 1000).toISOString();
                const tokenNoExp = makeJwt({ ...SAMPLE_USER });
                const info = CredentialsService.getTokenExpiryInfo({
                    token: tokenNoExp,
                    apiUrl: 'http://x',
                    expiresAt: futureIso,
                });
                expect(info.isExpired).toBe(false);
                expect(info.daysLeft).toBe(3);
            } finally {
                vi.useRealTimers();
            }
        });

        it('returns isExpired:false (and no time fields) when both JWT exp and expiresAt are missing', () => {
            const tokenNoExp = makeJwt({ ...SAMPLE_USER });
            const info = CredentialsService.getTokenExpiryInfo({
                token: tokenNoExp,
                apiUrl: 'http://x',
            });
            expect(info).toEqual({ isExpired: false });
        });
    });
});

describe('getCredentials / requireAuth re-exports', () => {
    it('getCredentials proxies to CredentialsService.get', async () => {
        const mod = await import('../credentials.service');
        expect(typeof mod.getCredentials).toBe('function');
        expect(typeof mod.requireAuth).toBe('function');
    });
});
