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
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        expect(expiresAtMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
        expect(expiresAtMs).toBeLessThanOrEqual(after + sevenDaysMs + 1000);

        expect(response.user.isAnonymous).toBe(true);
        expect(response.user.email).toBeNull();
        expect(response.user.anonymousExpiresAt).toBe(
            (insertedUser.anonymousExpiresAt as Date).toISOString(),
        );
    });

    it('persists an AuthSession with a generated token bound to the user', async () => {
        const { service, savedSessions } = buildService();

        const response = await service.createAnonymousUser({
            ipAddress: '1.2.3.4',
            userAgent: 'test-agent',
        });

        expect(savedSessions).toHaveLength(1);
        const session = savedSessions[0];
        expect(session.userId).toBe(response.user.id);
        expect(session.token).toBe(response.access_token);
        expect(session.token.length).toBeGreaterThan(20); // base64url(32 bytes) >= 43 chars
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

    it('falls back to 7 days when ANONYMOUS_USER_TTL_DAYS is garbage', async () => {
        process.env.ANONYMOUS_USER_TTL_DAYS = 'not-a-number';
        const { service, created } = buildService();

        const before = Date.now();
        await service.createAnonymousUser();
        const after = Date.now();

        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const ttl = (created[0].anonymousExpiresAt as Date).getTime();
        expect(ttl).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
        expect(ttl).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
    });

    it('mints unique usernames + tokens across consecutive calls', async () => {
        const { service } = buildService();

        const a = await service.createAnonymousUser();
        const b = await service.createAnonymousUser();

        expect(a.user.username).not.toBe(b.user.username);
        expect(a.access_token).not.toBe(b.access_token);
    });
});
