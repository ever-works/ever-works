import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ENTITIES } from '@ever-works/agent/database';
import { AuthSession } from '@ever-works/agent/entities';
import { EverIdReplayService } from './ever-id-replay.service';
import { EverIdSessionService } from './ever-id-session.service';

/**
 * APW-12 (Ever ID) — ending the sessions an identity opened (plan §5.4): by
 * `sid`, by identity except the current session, and never a session another
 * sign-in method opened (FR-35, ACC-12-25).
 */
describe('EverIdSessionService', () => {
    let dataSource: DataSource;
    let replay: EverIdReplayService;
    let sessions: EverIdSessionService;

    const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

    async function addSession(
        token: string,
        origin?: { externalIdentityId: string; externalSid?: string },
    ) {
        const id = randomUUID();
        await dataSource.getRepository(AuthSession).insert({
            id,
            userId: 'user-1',
            token: null,
            tokenHash: hash(token),
            expiresAt: new Date(Date.now() + 3_600_000),
            externalIdentityId: origin?.externalIdentityId ?? null,
            externalSid: origin?.externalSid ?? null,
        });
        return id;
    }

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        replay = new EverIdReplayService(dataSource);
        sessions = new EverIdSessionService(dataSource, replay);
    });
    afterAll(async () => dataSource.destroy());
    beforeEach(async () => {
        await dataSource.getRepository(AuthSession).clear();
        await dataSource.query('DELETE FROM "verification"');
    });

    it('finds the current session by the bearer’s digest', async () => {
        const id = await addSession('bearer-1', {
            externalIdentityId: 'identity-1',
            externalSid: 'sid-1',
        });
        const headers = new Headers({ authorization: 'Bearer bearer-1' });

        await expect(sessions.currentSession(headers)).resolves.toMatchObject({
            id,
            userId: 'user-1',
            externalIdentityId: 'identity-1',
            externalSid: 'sid-1',
        });
        await expect(sessions.currentSession(new Headers())).resolves.toBeNull();
        await expect(
            sessions.currentSession(new Headers({ authorization: 'Bearer nope' })),
        ).resolves.toBeNull();
    });

    it('ends only the Ever ID sessions with the notice’s sid, and marks them (FR-34, S6)', async () => {
        await addSession('ever-a', { externalIdentityId: 'identity-1', externalSid: 'sid-1' });
        await addSession('ever-b', { externalIdentityId: 'identity-1', externalSid: 'sid-2' });
        await addSession('password');
        // Another identity reusing the sid string is untouched.
        await addSession('other', { externalIdentityId: 'identity-2', externalSid: 'sid-1' });

        const ended = await sessions.endBySid('sid-1', ['identity-1']);

        expect(ended).toBe(1);
        const left = (await dataSource.getRepository(AuthSession).find()).map(
            (row) => row.tokenHash,
        );
        expect(left).toEqual(
            expect.arrayContaining([hash('ever-b'), hash('password'), hash('other')]),
        );
        expect(await sessions.wasSignedOut('ever-a')).toBe(true);
        expect(await sessions.wasSignedOut('password')).toBe(false);
    });

    it('ends every session an identity opened except the current one, never a password session (FR-29, ACC-12-25)', async () => {
        const current = await addSession('current', { externalIdentityId: 'identity-1' });
        await addSession('other-device', { externalIdentityId: 'identity-1' });
        await addSession('password');

        const ended = await sessions.endByIdentity('identity-1', {
            exceptSessionId: current,
            markSignedOut: false,
        });

        expect(ended).toBe(1);
        expect(await dataSource.getRepository(AuthSession).count()).toBe(2);
        // A disconnect is not a provider sign-out: no marker.
        expect(await sessions.wasSignedOut('other-device')).toBe(false);
    });
});
