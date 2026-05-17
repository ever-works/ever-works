jest.mock('@ever-works/agent/database', () => ({ UserRepository: class {} }));
jest.mock('@ever-works/agent/entities', () => ({ AuthSession: class {} }));

import { AnonymousAuthService } from './anonymous-auth.service';

describe('AnonymousAuthService (EW-617 G2)', () => {
    const buildService = () => {
        const created: any[] = [];
        const userRepository = {
            create: jest.fn(async (data: any) => {
                const row = { id: `u-${created.length + 1}`, ...data };
                created.push(row);
                return row;
            }),
        } as any;

        const savedSessions: any[] = [];
        const sessionRepo = {
            save: jest.fn(async (data: any) => {
                savedSessions.push(data);
                return data;
            }),
        };

        const dataSource = {
            getRepository: jest.fn(() => sessionRepo),
        } as any;

        const authProvider = {} as any;

        const service = new AnonymousAuthService(userRepository, dataSource, authProvider);

        return { service, userRepository, sessionRepo, savedSessions, created };
    };

    afterEach(() => {
        delete process.env.ANONYMOUS_USER_TTL_DAYS;
    });

    it('creates a User row with isAnonymous=true and a future expiry', async () => {
        const { service, userRepository, created } = buildService();

        const before = Date.now();
        const response = await service.createAnonymousUser();
        const after = Date.now();

        expect(userRepository.create).toHaveBeenCalledTimes(1);
        const insertedUser = created[0];
        expect(insertedUser.isAnonymous).toBe(true);
        expect(insertedUser.email).toBeNull();
        expect(insertedUser.password).toBeNull();
        expect(insertedUser.registrationProvider).toBe('anonymous');
        expect(insertedUser.username).toMatch(/^anon-[0-9a-f]{8}$/);

        const expiresAtMs = (insertedUser.anonymousExpiresAt as Date).getTime();
        // H-05: default anon TTL is 3 days (was 7d before the audit).
        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        expect(expiresAtMs).toBeGreaterThanOrEqual(before + threeDaysMs - 1000);
        expect(expiresAtMs).toBeLessThanOrEqual(after + threeDaysMs + 1000);

        expect(response.user.isAnonymous).toBe(true);
        expect(response.user.email).toBeNull();
        expect(response.user.anonymousExpiresAt).toBe(
            (insertedUser.anonymousExpiresAt as Date).toISOString(),
        );
    });

    it('persists an AuthSession with a hashed token bound to the user', async () => {
        const { service, savedSessions } = buildService();

        const response = await service.createAnonymousUser({
            ipAddress: '1.2.3.4',
            userAgent: 'test-agent',
        });

        expect(savedSessions).toHaveLength(1);
        const session = savedSessions[0];
        expect(session.userId).toBe(response.user.id);
        // H-01 (sessions): legacy plaintext column is nulled; `tokenHash`
        // stores sha256(access_token) so a DB leak doesn't surrender a
        // live bearer. The raw `access_token` is the value returned to
        // the caller.
        expect(session.token).toBeNull();
        expect(typeof session.tokenHash).toBe('string');
        const { createHash } = require('node:crypto');
        const expectedHash = createHash('sha256').update(response.access_token).digest('hex');
        expect(session.tokenHash).toBe(expectedHash);
        expect(response.access_token.length).toBeGreaterThan(20); // base64url(32 bytes) >= 43 chars
        expect(session.ipAddress).toBe('1.2.3.4');
        expect(session.userAgent).toBe('test-agent');
    });

    it('respects ANONYMOUS_USER_TTL_DAYS when set', async () => {
        process.env.ANONYMOUS_USER_TTL_DAYS = '1';
        const { service, created } = buildService();

        const before = Date.now();
        await service.createAnonymousUser();
        const after = Date.now();

        const oneDayMs = 24 * 60 * 60 * 1000;
        const ttl = (created[0].anonymousExpiresAt as Date).getTime();
        expect(ttl).toBeGreaterThanOrEqual(before + oneDayMs - 1000);
        expect(ttl).toBeLessThanOrEqual(after + oneDayMs + 1000);
    });

    it('falls back to the 3-day H-05 default when ANONYMOUS_USER_TTL_DAYS is garbage', async () => {
        process.env.ANONYMOUS_USER_TTL_DAYS = 'not-a-number';
        const { service, created } = buildService();

        const before = Date.now();
        await service.createAnonymousUser();
        const after = Date.now();

        const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
        const ttl = (created[0].anonymousExpiresAt as Date).getTime();
        expect(ttl).toBeGreaterThanOrEqual(before + threeDaysMs - 1000);
        expect(ttl).toBeLessThanOrEqual(after + threeDaysMs + 1000);
    });

    it('mints unique usernames + tokens across consecutive calls', async () => {
        const { service } = buildService();

        const a = await service.createAnonymousUser();
        const b = await service.createAnonymousUser();

        expect(a.user.username).not.toBe(b.user.username);
        expect(a.access_token).not.toBe(b.access_token);
    });
});
