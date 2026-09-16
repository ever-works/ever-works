import { ServiceUnavailableException } from '@nestjs/common';
import {
    SharedViewSessionService,
    readBearerSession,
    sessionThrottleBucket,
} from './shared-view-session.service';
import { SharedViewViewDedupe } from './shared-view-view-dedupe';

describe('SharedViewSessionService', () => {
    const envBackup = { ...process.env };
    const view = { id: 'view-1', rotationCount: 3 };
    const NOW = Date.parse('2026-09-14T12:00:00.000Z');

    beforeEach(() => {
        delete process.env.SHARED_VIEW_SESSION_SECRET;
        delete process.env.BETTER_AUTH_SECRET;
        delete process.env.AUTH_SECRET;
        process.env.SHARED_VIEW_SESSION_SECRET = 'a-long-enough-shared-view-secret';
    });

    afterEach(() => {
        process.env = { ...envBackup };
    });

    it('round-trips a session for fifteen minutes', () => {
        const service = new SharedViewSessionService();
        const { viewSession, expiresAt } = service.mint(view, NOW);

        expect(expiresAt).toBe(new Date(NOW + 15 * 60_000).toISOString());
        expect(service.verify(viewSession, NOW + 60_000)).toEqual({
            v: 1,
            sid: 'view-1',
            rot: 3,
            exp: NOW + 15 * 60_000,
        });
    });

    it('carries no token, no token hash, no Organization and no person in its claims', () => {
        const service = new SharedViewSessionService();
        const { viewSession } = service.mint(view, NOW);
        const claims = JSON.parse(
            Buffer.from(viewSession.split('.')[0], 'base64url').toString('utf8'),
        );
        expect(Object.keys(claims).sort()).toEqual(['exp', 'rot', 'sid', 'v']);
    });

    it('refuses an expired, tampered or malformed session identically', () => {
        const service = new SharedViewSessionService();
        const { viewSession } = service.mint(view, NOW);
        const [body, mac] = viewSession.split('.');
        const forged = Buffer.from(
            JSON.stringify({ v: 1, sid: 'view-2', rot: 3, exp: NOW + 60_000 }),
        ).toString('base64url');

        expect(service.verify(viewSession, NOW + 15 * 60_000)).toBeNull();
        expect(service.verify(`${forged}.${mac}`, NOW)).toBeNull();
        expect(service.verify(`${body}.${mac.slice(0, -2)}AA`, NOW)).toBeNull();
        for (const junk of [
            '',
            'abc',
            `${body}.`,
            `.${mac}`,
            `${body}.${mac}.x`,
            42,
            null,
            'x'.repeat(600),
        ]) {
            expect(service.verify(junk, NOW)).toBeNull();
        }
    });

    it('does not verify a session minted under a different secret', () => {
        const { viewSession } = new SharedViewSessionService().mint(view, NOW);
        process.env.SHARED_VIEW_SESSION_SECRET = 'a-completely-different-secret-value';
        expect(new SharedViewSessionService().verify(viewSession, NOW)).toBeNull();
    });

    it('falls back to the auth secret, and fails closed with no secret at all', () => {
        delete process.env.SHARED_VIEW_SESSION_SECRET;
        process.env.BETTER_AUTH_SECRET = 'the-better-auth-fallback-secret';
        const service = new SharedViewSessionService();
        const { viewSession } = service.mint(view, NOW);
        expect(service.verify(viewSession, NOW)).not.toBeNull();

        delete process.env.BETTER_AUTH_SECRET;
        expect(() => service.mint(view, NOW)).toThrow(ServiceUnavailableException);
        expect(service.verify(viewSession, NOW)).toBeNull();

        process.env.AUTH_SECRET = 'short';
        expect(() => service.mint(view, NOW)).toThrow(ServiceUnavailableException);
    });

    it('reads only a Bearer authorization header', () => {
        expect(readBearerSession('Bearer abc.def')).toBe('abc.def');
        expect(readBearerSession(['bearer abc.def'])).toBe('abc.def');
        expect(readBearerSession('Basic abc')).toBeNull();
        expect(readBearerSession(undefined)).toBeNull();
    });

    it('buckets a presented session by the view it names, without trusting it', () => {
        const { viewSession } = new SharedViewSessionService().mint(view, NOW);
        expect(sessionThrottleBucket(viewSession)).toBe('view:view-1');
        expect(sessionThrottleBucket('not-a-session')).toMatch(/^raw:[0-9a-f]{32}$/);
        expect(sessionThrottleBucket(null)).toBe('none');
    });
});

describe('SharedViewViewDedupe', () => {
    const NOW = Date.parse('2026-09-14T12:00:00.000Z');

    it('counts a client once per ten-minute window per view', () => {
        const dedupe = new SharedViewViewDedupe();
        expect(dedupe.shouldCount('ip:203.0.113.7', 'view-1', NOW)).toBe(true);
        expect(dedupe.shouldCount('ip:203.0.113.7', 'view-1', NOW + 9 * 60_000)).toBe(false);
        expect(dedupe.shouldCount('ip:203.0.113.8', 'view-1', NOW + 60_000)).toBe(true);
        expect(dedupe.shouldCount('ip:203.0.113.7', 'view-2', NOW + 60_000)).toBe(true);
        expect(dedupe.shouldCount('ip:203.0.113.7', 'view-1', NOW + 10 * 60_000)).toBe(true);
    });

    it('never holds the client identity in its keys', () => {
        const dedupe = new SharedViewViewDedupe();
        dedupe.shouldCount('ip:203.0.113.7', 'view-1', NOW);
        const keys = [...(dedupe as unknown as { seen: Map<string, number> }).seen.keys()];
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^[0-9a-f]{16}$/);
        expect(keys[0]).not.toContain('203.0.113.7');
    });

    it('forgets every bucket when its salt rotates after a day', () => {
        const dedupe = new SharedViewViewDedupe();
        const start = Date.now();
        dedupe.shouldCount('ip:203.0.113.7', 'view-1', start);
        expect(dedupe.size()).toBe(1);
        expect(dedupe.shouldCount('ip:203.0.113.7', 'view-1', start + 24 * 60 * 60_000 + 1)).toBe(
            true,
        );
        expect(dedupe.size()).toBe(1);
    });
});
