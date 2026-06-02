import { UserAwareThrottlerGuard } from './user-aware-throttler.guard';

class TestUserAwareThrottlerGuard extends UserAwareThrottlerGuard {
    track(req: Record<string, unknown>) {
        return this.getTracker(req);
    }
}

describe('UserAwareThrottlerGuard', () => {
    let guard: TestUserAwareThrottlerGuard;

    beforeEach(() => {
        guard = new TestUserAwareThrottlerGuard({ throttlers: [] } as any, {} as any, {} as any);
    });

    it('tracks authenticated requests by user id instead of shared server IP', async () => {
        await expect(
            guard.track({
                user: { userId: 'user-1' },
                ip: '127.0.0.1',
            }),
        ).resolves.toBe('user:user-1');
    });

    it('falls back to request IP for public requests', async () => {
        await expect(guard.track({ ip: '203.0.113.10' })).resolves.toBe('ip:203.0.113.10');
    });

    it('uses trusted proxy ips when req.ip is unavailable', async () => {
        await expect(guard.track({ ips: ['198.51.100.9'] })).resolves.toBe('ip:198.51.100.9');
    });

    it('uses the socket address when no parsed IP is available', async () => {
        await expect(
            guard.track({ socket: { remoteAddress: '::ffff:127.0.0.1' } }),
        ).resolves.toBe('ip:::ffff:127.0.0.1');
    });

    it('keeps a deterministic fallback for malformed requests', async () => {
        await expect(guard.track({})).resolves.toBe('ip:unknown');
    });
});
