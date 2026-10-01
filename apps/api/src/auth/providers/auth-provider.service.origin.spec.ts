import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ENTITIES, UserRepository } from '@ever-works/agent/database';
import { AuthSession, User } from '@ever-works/agent/entities';
import { AuthProviderService, hashSessionToken } from './auth-provider.service';

/**
 * APW-12 (Ever ID, plan §5.4) — `issueSession`'s optional third argument writes
 * the two origin columns, and ONLY then: every existing caller (two arguments)
 * gets exactly the row it got before (FR-35). The existing behaviour is pinned
 * by `auth-provider.service.spec.ts`, unchanged.
 */
describe('AuthProviderService.issueSession — session origin', () => {
    let dataSource: DataSource;
    let provider: AuthProviderService;
    let userId: string;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        const users = new UserRepository(dataSource.getRepository(User));
        provider = new AuthProviderService({} as never, users, {} as never, dataSource);
        const user = await dataSource.getRepository(User).save(
            dataSource.getRepository(User).create({
                username: 'origin',
                slug: 'origin',
                email: 'o@example.com',
                isActive: true,
            }),
        );
        userId = user.id;
    });
    afterAll(async () => dataSource.destroy());

    it('writes no origin for an existing two-argument caller', async () => {
        const { access_token } = await provider.issueSession(userId, {
            ipAddress: '203.0.113.1',
            userAgent: 'UA',
        });
        const row = await dataSource
            .getRepository(AuthSession)
            .findOne({ where: { tokenHash: hashSessionToken(access_token) } });

        expect(row).toMatchObject({ ipAddress: '203.0.113.1', userAgent: 'UA', token: null });
        expect(row?.externalIdentityId ?? null).toBeNull();
        expect(row?.externalSid ?? null).toBeNull();
    });

    it('records the identity and the provider session id when the Ever ID path passes them', async () => {
        const { access_token } = await provider.issueSession(userId, undefined, {
            externalIdentityId: '33333333-3333-4333-8333-333333333333',
            externalSid: 'sid-1',
        });
        const row = await dataSource
            .getRepository(AuthSession)
            .findOne({ where: { tokenHash: hashSessionToken(access_token) } });

        expect(row).toMatchObject({
            externalIdentityId: '33333333-3333-4333-8333-333333333333',
            externalSid: 'sid-1',
        });
    });

    it('exports the same digest the session rows are keyed by', () => {
        expect(hashSessionToken('abc')).toBe(
            createHash('sha256').update('abc', 'utf8').digest('hex'),
        );
    });
});
