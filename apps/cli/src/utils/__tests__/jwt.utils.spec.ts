import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    decodeJWT,
    isJWTExpired,
    getJWTExpiration,
    getJWTUserInfo,
    getJWTFullInfo,
    type JwtPayload,
} from '../jwt.utils';

function makeJwt(payload: object): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = 'signature';
    return `${header}.${body}.${signature}`;
}

const SAMPLE_PAYLOAD: JwtPayload = {
    sub: 'user-123',
    email: 'user@example.com',
    provider: 'github',
    username: 'evereq',
    emailVerified: true,
    isActive: true,
    avatar: 'https://example.com/avatar.png',
    iat: 1_700_000_000,
    iss: 'ever-works',
    aud: 'cli',
    exp: 2_000_000_000,
};

describe('decodeJWT', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
    });

    it('decodes a well-formed JWT and returns the full payload', () => {
        const token = makeJwt(SAMPLE_PAYLOAD);
        expect(decodeJWT(token)).toEqual(SAMPLE_PAYLOAD);
    });

    it('returns null when the token is missing one of the three parts', () => {
        expect(decodeJWT('only.two')).toBeNull();
        expect(decodeJWT('a.b.c.d')).toBeNull();
        expect(decodeJWT('single-string')).toBeNull();
    });

    it('handles base64url URL-safe characters by translating - and _ before decoding', () => {
        // craft a payload whose base64 contains - and _ so the regex replace path is exercised
        const payload = { sub: '???>>>', email: 'edge@example.com' };
        const standard = Buffer.from(JSON.stringify(payload)).toString('base64');
        const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const token = `header.${urlSafe}.sig`;
        expect(decodeJWT(token)).toMatchObject(payload);
    });

    it('returns null and logs when the payload is not valid JSON', () => {
        const broken = `header.${Buffer.from('not-json').toString('base64url')}.sig`;
        expect(decodeJWT(broken)).toBeNull();
        expect(errorSpy).toHaveBeenCalledWith('Failed to decode JWT:', expect.any(String));
    });
});

describe('isJWTExpired', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // freeze "now" at a deterministic instant well before SAMPLE_PAYLOAD.exp
        vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns false for a token whose exp is in the future', () => {
        expect(isJWTExpired(makeJwt(SAMPLE_PAYLOAD))).toBe(false);
    });

    it('returns true for a token whose exp is in the past', () => {
        expect(isJWTExpired(makeJwt({ ...SAMPLE_PAYLOAD, exp: 1_000 }))).toBe(true);
    });

    it('returns false for an undecodable token (graceful degradation)', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(isJWTExpired('not.a.jwt')).toBe(false);
    });

    it('returns false when the payload has no `exp` claim (treat as never-expires)', () => {
        const noExp = { ...SAMPLE_PAYLOAD } as Partial<JwtPayload>;
        delete noExp.exp;
        expect(isJWTExpired(makeJwt(noExp as Record<string, unknown>))).toBe(false);
    });
});

describe('getJWTExpiration', () => {
    it('returns a Date constructed from exp * 1000', () => {
        const result = getJWTExpiration(makeJwt(SAMPLE_PAYLOAD));
        expect(result).toBeInstanceOf(Date);
        expect(result?.getTime()).toBe(SAMPLE_PAYLOAD.exp * 1000);
    });

    it('returns null when token cannot be decoded', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(getJWTExpiration('garbage')).toBeNull();
    });

    it('returns null when payload has no exp', () => {
        const noExp = { ...SAMPLE_PAYLOAD } as Partial<JwtPayload>;
        delete noExp.exp;
        expect(getJWTExpiration(makeJwt(noExp as Record<string, unknown>))).toBeNull();
    });
});

describe('getJWTUserInfo', () => {
    it('projects only the AuthUser-shaped fields from the full payload', () => {
        expect(getJWTUserInfo(makeJwt(SAMPLE_PAYLOAD))).toEqual({
            sub: SAMPLE_PAYLOAD.sub,
            email: SAMPLE_PAYLOAD.email,
            provider: SAMPLE_PAYLOAD.provider,
            username: SAMPLE_PAYLOAD.username,
            emailVerified: SAMPLE_PAYLOAD.emailVerified,
            isActive: SAMPLE_PAYLOAD.isActive,
            avatar: SAMPLE_PAYLOAD.avatar,
        });
    });

    it('returns null when the token cannot be decoded', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(getJWTUserInfo('garbage')).toBeNull();
    });

    it('forwards a null avatar through the projection', () => {
        const result = getJWTUserInfo(makeJwt({ ...SAMPLE_PAYLOAD, avatar: null }));
        expect(result?.avatar).toBeNull();
    });
});

describe('getJWTFullInfo', () => {
    it('is a passthrough alias for decodeJWT', () => {
        const token = makeJwt(SAMPLE_PAYLOAD);
        expect(getJWTFullInfo(token)).toEqual(decodeJWT(token));
    });
});
