import * as request from 'supertest';
import { ExternalIdentity, AuthSession, User, Organization } from '@ever-works/agent/entities';
import {
    TERMS,
    TEST_API_KEY,
    completeBrowserSignIn,
    createEverIdHarness,
    type EverIdHarness,
} from './__tests__/ever-id-harness.helper-spec';

/**
 * APW-12 (Ever ID) — the API flow end to end over HTTP: the real controller,
 * services, guard and session path on an in-memory database, against the
 * `oidc-identity` package's fake OpenID Connect provider (see the harness header).
 *
 * Acceptance criteria exercised here (spec §8): ACC-12-01, -04, -06, -09, -10,
 * -12, -13, -14, -15, -16, -17, -18, -20, -21, -22, -23, -24, -25, -28, -29,
 * -30, -33, -34, -35, -36, -37; plus the admin routes (FR-3) and the claim hints.
 */
jest.setTimeout(60_000);

function server(harness: EverIdHarness) {
    return harness.app.getHttpServer();
}

async function count(
    harness: EverIdHarness,
    entity: typeof ExternalIdentity | typeof User | typeof AuthSession,
) {
    return harness.dataSource.getRepository(entity as never).count();
}

/** Every string the fake provider handed out that must never be stored (ACC-12-22). */
function secretsOf(...values: unknown[]): string[] {
    return values.filter(
        (value): value is string => typeof value === 'string' && value.length > 20,
    );
}

describe('Ever ID flow (API, in-memory database, fake provider)', () => {
    describe('while Ever ID is turned off (the default)', () => {
        let harness: EverIdHarness;

        beforeAll(async () => {
            harness = await createEverIdHarness({ enabled: false });
        });
        afterAll(async () => harness.close());

        it('answers 404 ever_id_disabled on the whole sign-in family and never contacts the provider (ACC-12-01)', async () => {
            const before = harness.fake!.calls.length;
            const routes: Array<[string, string, Record<string, unknown>?]> = [
                ['post', '/api/auth/ever-id/authorize', {}],
                ['post', '/api/auth/ever-id/callback', { code: 'c', state: 's', transaction: 't' }],
                ['post', '/api/auth/ever-id/sign-up/confirm', { pending: 'p', terms: [] }],
                ['post', '/api/auth/ever-id/session'],
                ['get', '/api/auth/ever-id/client-config'],
            ];
            for (const [method, path, body] of routes) {
                const response = await (request(server(harness)) as any)
                    [method](path)
                    .send(body ?? {});
                expect({ path, status: response.status, code: response.body.code }).toEqual({
                    path,
                    status: 404,
                    code: 'ever_id_disabled',
                });
            }
            expect(harness.fake!.calls.length).toBe(before);
        });

        it('refuses a token in the query string before anything else (ACC-12-10)', async () => {
            const response = await request(server(harness))
                .post('/api/auth/ever-id/authorize?access_token=abc.def.ghi')
                .send({});
            expect(response.status).toBe(400);
            expect(response.body.code).toBe('token_in_query');
        });
    });

    describe('with Ever ID turned on', () => {
        let harness: EverIdHarness;

        beforeEach(async () => {
            harness = await createEverIdHarness({ enabled: true });
        });
        afterEach(async () => harness.close());

        it('builds an S256 request with fresh 32-byte state and nonce and the exact redirect address (ACC-12-06)', async () => {
            const first = await request(server(harness))
                .post('/api/auth/ever-id/authorize')
                .send({});
            const second = await request(server(harness))
                .post('/api/auth/ever-id/authorize')
                .send({});

            expect(first.status).toBe(200);
            const url = new URL(first.body.authorizationUrl);
            expect(url.searchParams.get('code_challenge_method')).toBe('S256');
            expect(url.searchParams.get('redirect_uri')).toBe(
                'https://app.example.test/api/auth/ever-id/callback',
            );
            expect(Buffer.from(String(url.searchParams.get('state')), 'base64url')).toHaveLength(
                32,
            );
            expect(Buffer.from(String(url.searchParams.get('nonce')), 'base64url')).toHaveLength(
                32,
            );
            expect(url.searchParams.get('scope')).toBe('openid email profile');
            expect(new URL(second.body.authorizationUrl).searchParams.get('state')).not.toBe(
                url.searchParams.get('state'),
            );
            expect(typeof first.body.transaction).toBe('string');
            expect(first.body.transaction.length).toBeLessThanOrEqual(3072);
        });

        it('creates an account only after the confirmation with terms, with exactly one (issuer, subject) row (ACC-12-14)', async () => {
            harness.fake!.setUser({
                subject: 'subject-new',
                email: 'new.person@example.com',
                name: 'New Person',
            });

            const callback = await completeBrowserSignIn(harness, { returnTo: '/works/abc' });
            expect(callback.status).toBe(200);
            expect(callback.body).toMatchObject({
                outcome: 'confirmSignUp',
                identity: { email: 'new.person@example.com', name: 'New Person' },
                returnTo: '/works/abc',
            });
            // Nothing exists yet — closing the screen would create nothing.
            expect(await count(harness, User)).toBe(0);
            expect(await count(harness, ExternalIdentity)).toBe(0);

            // Terms are required.
            const noTerms = await request(server(harness))
                .post('/api/auth/ever-id/sign-up/confirm')
                .send({ pending: callback.body.pending, terms: [TERMS[0]] });
            expect(noTerms.status).toBe(400);
            expect(noTerms.body.code).toBe('terms_required');

            const confirm = await request(server(harness))
                .post('/api/auth/ever-id/sign-up/confirm')
                .send({ pending: callback.body.pending, terms: TERMS });
            expect(confirm.status).toBe(200);
            expect(confirm.body).toMatchObject({
                user: { email: 'new.person@example.com' },
                returnTo: '/works/abc',
            });

            const users = await harness.dataSource.getRepository(User).find();
            expect(users).toHaveLength(1);
            expect(users[0]).toMatchObject({
                registrationProvider: 'ever-id',
                emailVerified: true,
            });
            const identities = await harness.dataSource.getRepository(ExternalIdentity).find();
            expect(identities).toHaveLength(1);
            expect(identities[0]).toMatchObject({
                issuer: harness.fake!.issuer,
                subject: 'subject-new',
                userId: users[0].id,
                linkedVia: 'sign-up',
            });
            const sessions = await harness.dataSource.getRepository(AuthSession).find();
            expect(sessions).toHaveLength(1);
            expect(sessions[0].externalIdentityId).toBe(identities[0].id);
            expect(sessions[0].externalSid).toBe('ever-id-session-1');

            // The pending value is single use.
            const replay = await request(server(harness))
                .post('/api/auth/ever-id/sign-up/confirm')
                .send({ pending: callback.body.pending, terms: TERMS });
            expect(replay.status).toBe(400);
            expect(replay.body.code).toBe('transaction_invalid');
            expect(await count(harness, User)).toBe(1);

            expect(harness.activityRows.map((row) => row.action)).toContain('user.signup.ever-id');
        });

        it('signs a connected identity in, records Activity, and refuses a replayed callback (ACC-12-13, ACC-12-09)', async () => {
            const user = await harness.createUser({ email: 'alice@example.com' });
            await harness.dataSource.getRepository(ExternalIdentity).save(
                harness.dataSource.getRepository(ExternalIdentity).create({
                    userId: user.id,
                    issuer: harness.fake!.issuer,
                    subject: 'subject-alice',
                    emailAtLink: 'alice@example.com',
                    emailVerifiedAtLink: true,
                    linkedVia: 'settings',
                    linkedAt: new Date(),
                }),
            );
            harness.fake!.setUser({ subject: 'subject-alice', email: 'alice@example.com' });

            const start = await request(server(harness))
                .post('/api/auth/ever-id/authorize')
                .send({});
            const redirect = await fetch(start.body.authorizationUrl, { redirect: 'manual' });
            const location = new URL(String(redirect.headers.get('location')));
            const body = {
                code: location.searchParams.get('code'),
                state: location.searchParams.get('state'),
                iss: location.searchParams.get('iss'),
                transaction: start.body.transaction,
            };
            const first = await request(server(harness))
                .post('/api/auth/ever-id/callback')
                .send(body);
            expect(first.status).toBe(200);
            expect(first.body).toMatchObject({ outcome: 'signedIn', user: { id: user.id } });
            expect(typeof first.body.access_token).toBe('string');

            // S17/S21: the same transaction completes at most once.
            const replay = await request(server(harness))
                .post('/api/auth/ever-id/callback')
                .send(body);
            expect(replay.status).toBe(400);
            expect(replay.body.code).toBe('transaction_invalid');

            const login = harness.activityRows.find((row) => row.action === 'user.login.ever-id');
            expect(login).toMatchObject({ userId: user.id, metadata: { provider: 'ever-id' } });

            // The session works and was opened by the identity.
            const identities = await request(server(harness))
                .get('/api/auth/ever-id/identities')
                .set('Authorization', `Bearer ${first.body.access_token}`);
            expect(identities.status).toBe(200);
            expect(identities.body.items).toHaveLength(1);
            expect(identities.body.items[0]).not.toHaveProperty('issuer');
            expect(identities.body.items[0]).not.toHaveProperty('subject');
        });

        it('never links by e-mail: an existing account’s address answers emailInUse and creates nothing (ACC-12-15)', async () => {
            await harness.createUser({ email: 'Existing@Example.com' });
            harness.fake!.setUser({ subject: 'subject-x', email: 'existing@example.com' });

            const callback = await completeBrowserSignIn(harness);

            expect(callback.status).toBe(200);
            expect(callback.body).toMatchObject({
                outcome: 'emailInUse',
                email: 'existing@example.com',
            });
            expect(callback.body).not.toHaveProperty('access_token');
            expect(await count(harness, ExternalIdentity)).toBe(0);
            expect(await count(harness, AuthSession)).toBe(0);
            expect(await count(harness, User)).toBe(1);
            // The address never travels in a URL the flow builds.
            expect(callback.authorizationUrl).not.toContain('existing');
        });

        it('creates and connects nothing for an unverified e-mail (ACC-12-16)', async () => {
            harness.fake!.setUser({
                subject: 'subject-u',
                email: 'unverified@example.com',
                emailVerified: false,
            });

            const callback = await completeBrowserSignIn(harness);

            expect(callback.status).toBe(422);
            expect(callback.body.code).toBe('email_not_verified');
            expect(await count(harness, User)).toBe(0);
        });

        it('answers sign_up_not_allowed when sign-up is turned off', async () => {
            harness.settings.signUpAllowed = false;
            harness.fake!.setUser({ subject: 'subject-s', email: 'someone@example.com' });

            const callback = await completeBrowserSignIn(harness);

            expect(callback.status).toBe(403);
            expect(callback.body.code).toBe('sign_up_not_allowed');
        });

        it('falls back to the dashboard for a return path to another site (ACC-12-12)', async () => {
            harness.fake!.setUser({ subject: 'subject-r', email: 'return@example.com' });

            const callback = await completeBrowserSignIn(harness, {
                returnTo: '//evil.example.test/x',
            });

            expect(callback.body).toMatchObject({ outcome: 'confirmSignUp', returnTo: null });
        });

        it('connects from Settings after a fresh sign-in and refuses an identity connected elsewhere (ACC-12-17, ACC-12-18)', async () => {
            const bob = await harness.createUser({ email: 'bob@example.com' });
            const carol = await harness.createUser({ email: 'carol@example.com' });
            const bobSession = await harness.sessionFor(bob.id);
            harness.fake!.setUser({ subject: 'subject-bob-id', email: 'bob.id@example.com' });

            const callback = await completeBrowserSignIn(harness, {
                intent: 'connect',
                bearer: bobSession,
            });
            expect(callback.status).toBe(200);
            expect(new URL(callback.authorizationUrl).searchParams.get('prompt')).toBe('login');
            expect(new URL(callback.authorizationUrl).searchParams.get('max_age')).toBe('300');
            expect(callback.body).toMatchObject({
                outcome: 'confirmConnect',
                identity: { email: 'bob.id@example.com' },
                accountEmail: 'bob@example.com',
            });

            const confirm = await request(server(harness))
                .post('/api/auth/ever-id/connect/confirm')
                .set('Authorization', `Bearer ${bobSession}`)
                .send({ pending: callback.body.pending });
            expect(confirm.status).toBe(200);
            expect(confirm.body).toMatchObject({
                email: 'bob.id@example.com',
                linkedVia: 'settings',
            });
            expect(
                harness.activityRows.find((row) => row.action === 'auth.ever_id.linked'),
            ).toMatchObject({
                userId: bob.id,
                metadata: { emailsDiffer: true },
            });

            // The same identity, now connected to Bob, cannot be connected to Carol (S12).
            const carolSession = await harness.sessionFor(carol.id);
            const elsewhere = await completeBrowserSignIn(harness, {
                intent: 'connect',
                bearer: carolSession,
            });
            expect(elsewhere.status).toBe(409);
            expect(elsewhere.body.code).toBe('subject_linked');
            expect(JSON.stringify(elsewhere.body)).not.toContain(bob.id);
            expect(JSON.stringify(elsewhere.body)).not.toContain('bob@example.com');
        });

        it('asks for a fresh sign-in when the session is older than 12 hours (ACC-12-17, S15)', async () => {
            const dave = await harness.createUser({ email: 'dave@example.com' });
            const session = await harness.sessionFor(dave.id);
            await harness.dataSource
                .getRepository(AuthSession)
                .update(
                    { userId: dave.id },
                    { createdAt: new Date(Date.now() - 13 * 60 * 60 * 1000) },
                );

            const response = await request(server(harness))
                .post('/api/auth/ever-id/connect/authorize')
                .set('Authorization', `Bearer ${session}`)
                .send({});

            expect(response.status).toBe(403);
            expect(response.body.code).toBe('reauth_required');
        });

        it('refuses an API key on connect and disconnect (ACC-12-21, S27)', async () => {
            await harness.createUser({ email: 'owner-of-key@example.com' });

            const connect = await request(server(harness))
                .post('/api/auth/ever-id/connect/authorize')
                .set('x-api-key', TEST_API_KEY)
                .send({});
            const disconnect = await request(server(harness))
                .delete('/api/auth/ever-id/identities/00000000-0000-4000-8000-000000000000')
                .set('x-api-key', TEST_API_KEY);
            const list = await request(server(harness))
                .get('/api/auth/ever-id/identities')
                .set('x-api-key', TEST_API_KEY);

            for (const response of [connect, disconnect, list]) {
                expect(response.status).toBe(403);
                expect(response.body.code).toBe('session_required');
            }
        });

        it('disconnects while another way to sign in remains, ending only the identity’s other sessions (ACC-12-20, S25)', async () => {
            const erin = await harness.createUser({
                email: 'erin@example.com',
                emailVerified: true,
            });
            const identity = await harness.dataSource.getRepository(ExternalIdentity).save(
                harness.dataSource.getRepository(ExternalIdentity).create({
                    userId: erin.id,
                    issuer: harness.fake!.issuer,
                    subject: 'subject-erin',
                    emailAtLink: 'erin@example.com',
                    emailVerifiedAtLink: true,
                    linkedVia: 'settings',
                    linkedAt: new Date(),
                }),
            );
            const current = await harness.sessionFor(erin.id, {
                externalIdentityId: identity.id,
                externalSid: 'sid-a',
            });
            await harness.sessionFor(erin.id, {
                externalIdentityId: identity.id,
                externalSid: 'sid-b',
            });
            const password = await harness.sessionFor(erin.id);

            const response = await request(server(harness))
                .delete(`/api/auth/ever-id/identities/${identity.id}`)
                .set('Authorization', `Bearer ${current}`);

            expect(response.status).toBe(204);
            expect(await count(harness, ExternalIdentity)).toBe(0);
            const remaining = await harness.dataSource
                .getRepository(AuthSession)
                .find({ where: { userId: erin.id } });
            expect(remaining).toHaveLength(2);
            for (const bearer of [current, password]) {
                const still = await request(server(harness))
                    .get('/api/auth/ever-id/identities')
                    .set('Authorization', `Bearer ${bearer}`);
                expect(still.status).toBe(200);
            }
            expect(
                harness.activityRows.find((row) => row.action === 'auth.ever_id.unlinked'),
            ).toMatchObject({
                metadata: { sessionsEnded: 1 },
            });
        });

        it('refuses the disconnect that would lock the account out (S14)', async () => {
            const frank = await harness.createUser({
                email: 'frank@example.com',
                emailVerified: false,
            });
            const identity = await harness.dataSource.getRepository(ExternalIdentity).save(
                harness.dataSource.getRepository(ExternalIdentity).create({
                    userId: frank.id,
                    issuer: harness.fake!.issuer,
                    subject: 'subject-frank',
                    emailAtLink: 'frank@example.com',
                    emailVerifiedAtLink: true,
                    linkedVia: 'sign-up',
                    linkedAt: new Date(),
                }),
            );
            const session = await harness.sessionFor(frank.id, { externalIdentityId: identity.id });

            const list = await request(server(harness))
                .get('/api/auth/ever-id/identities')
                .set('Authorization', `Bearer ${session}`);
            expect(list.body).toMatchObject({
                canDisconnect: false,
                disconnectBlockedReason: 'last_sign_in_method',
            });

            const response = await request(server(harness))
                .delete(`/api/auth/ever-id/identities/${identity.id}`)
                .set('Authorization', `Bearer ${session}`);
            expect(response.status).toBe(409);
            expect(response.body.code).toBe('last_sign_in_method');
            expect(await count(harness, ExternalIdentity)).toBe(1);
        });

        it('honours back-channel logout by sid, marks the ended session, refuses replays and spares password sessions (ACC-12-23, -24, -25)', async () => {
            const grace = await harness.createUser({ email: 'grace@example.com' });
            const identity = await harness.dataSource.getRepository(ExternalIdentity).save(
                harness.dataSource.getRepository(ExternalIdentity).create({
                    userId: grace.id,
                    issuer: harness.fake!.issuer,
                    subject: 'subject-grace',
                    emailAtLink: 'grace@example.com',
                    emailVerifiedAtLink: true,
                    linkedVia: 'settings',
                    linkedAt: new Date(),
                }),
            );
            const everIdSession = await harness.sessionFor(grace.id, {
                externalIdentityId: identity.id,
                externalSid: 'sid-grace-1',
            });
            const otherEverIdSession = await harness.sessionFor(grace.id, {
                externalIdentityId: identity.id,
                externalSid: 'sid-grace-2',
            });
            const passwordSession = await harness.sessionFor(grace.id);
            const url = `${await serverUrl(harness)}/api/auth/ever-id/backchannel-logout`;
            const token = await harness.fake!.mintLogoutToken({
                sid: 'sid-grace-1',
                subject: 'subject-grace',
            });

            const accepted = await harness.fake!.postBackchannelLogout(url, token);
            expect(accepted.status).toBe(200);
            expect(accepted.cacheControl).toBe('no-store');

            const ended = await request(server(harness))
                .get('/api/auth/ever-id/identities')
                .set('Authorization', `Bearer ${everIdSession}`);
            expect(ended.status).toBe(401);
            expect(ended.body.code).toBe('ever_id_signed_out');
            for (const bearer of [otherEverIdSession, passwordSession]) {
                const still = await request(server(harness))
                    .get('/api/auth/ever-id/identities')
                    .set('Authorization', `Bearer ${bearer}`);
                expect(still.status).toBe(200);
            }

            // A replayed jti, a nonce, or an iat older than 300 s: 400, nothing ends.
            const replayed = await harness.fake!.postBackchannelLogout(url, token);
            expect(replayed.status).toBe(400);
            const withNonce = await harness.fake!.postBackchannelLogout(url, undefined, {
                sid: 'sid-grace-2',
                subject: 'subject-grace',
                extraClaims: { nonce: 'n' },
            });
            expect(withNonce.status).toBe(400);
            const tooOld = await harness.fake!.postBackchannelLogout(url, undefined, {
                sid: 'sid-grace-2',
                subject: 'subject-grace',
                issuedAt: Math.floor(Date.now() / 1000) - 301,
            });
            expect(tooOld.status).toBe(400);
            expect(
                await harness.dataSource
                    .getRepository(AuthSession)
                    .count({ where: { userId: grace.id } }),
            ).toBe(2);

            // `sub` only: every session that identity opened ends; the password session stays.
            const bySub = await harness.fake!.postBackchannelLogout(url, undefined, {
                sid: null,
                subject: 'subject-grace',
            });
            expect(bySub.status).toBe(200);
            const left = await harness.dataSource
                .getRepository(AuthSession)
                .find({ where: { userId: grace.id } });
            expect(left).toHaveLength(1);
            expect(left[0].externalIdentityId ?? null).toBeNull();

            // An unknown sid is acknowledged and changes nothing (S26).
            const unknown = await harness.fake!.postBackchannelLogout(url, undefined, {
                sid: 'sid-nobody',
                subject: 'subject-nobody',
            });
            expect(unknown.status).toBe(200);
            expect(
                harness.activityRows.filter(
                    (row) => row.action === 'auth.ever_id.backchannel_logout',
                ),
            ).toHaveLength(2);
        });

        it('exchanges a terminal client’s token for a session and refuses every FR-40 violation (ACC-12-28, -29, -30)', async () => {
            const henry = await harness.createUser({ email: 'henry@example.com' });
            await harness.dataSource.getRepository(ExternalIdentity).save(
                harness.dataSource.getRepository(ExternalIdentity).create({
                    userId: henry.id,
                    issuer: harness.fake!.issuer,
                    subject: 'subject-henry',
                    emailAtLink: 'henry@example.com',
                    emailVerifiedAtLink: true,
                    linkedVia: 'settings',
                    linkedAt: new Date(),
                }),
            );
            const exchange = (token: string) =>
                request(server(harness))
                    .post('/api/auth/ever-id/session')
                    .set('Authorization', `Bearer ${token}`)
                    .send();

            const good = await harness.fake!.mintAccessToken({
                subject: 'subject-henry',
                authorizedParty: 'ever-works-cli',
            });
            const started = Date.now();
            const ok = await exchange(good);
            expect(ok.status).toBe(200);
            expect(Date.now() - started).toBeLessThan(5_000);
            expect(ok.body.user).toMatchObject({ id: henry.id, email: 'henry@example.com' });
            expect(typeof ok.body.access_token).toBe('string');

            expect((await exchange(good)).status).toBe(401); // reused jti
            const unlisted = await harness.fake!.mintAccessToken({
                subject: 'subject-henry',
                authorizedParty: 'other-client',
            });
            expect((await exchange(unlisted)).status).toBe(401);
            const noScope = await harness.fake!.mintAccessToken({
                subject: 'subject-henry',
                scopes: ['openid'],
            });
            expect((await exchange(noScope)).status).toBe(401);
            const old = await harness.fake!.mintAccessToken({
                subject: 'subject-henry',
                issuedAt: Math.floor(Date.now() / 1000) - 301,
                expiresAt: Math.floor(Date.now() / 1000) + 600,
            });
            expect((await exchange(old)).status).toBe(401);

            const stranger = await harness.fake!.mintAccessToken({ subject: 'subject-stranger' });
            const notConnected = await exchange(stranger);
            expect(notConnected.status).toBe(403);
            expect(notConnected.body.code).toBe('not_connected');
            expect(await count(harness, User)).toBe(1);

            const deviceRow = harness.activityRows.find(
                (row) => row.action === 'user.login.ever-id.device',
            );
            expect(deviceRow).toMatchObject({ userId: henry.id, metadata: { clientKind: 'cli' } });
            expect(JSON.stringify(harness.activityRows)).not.toContain(good);
        });

        it('admits a delegated apps:read token only on the marked handler (ACC-12-33, -34, -35, -36)', async () => {
            const ivy = await harness.createUser({ email: 'ivy@example.com' });
            await harness.dataSource.getRepository(ExternalIdentity).save(
                harness.dataSource.getRepository(ExternalIdentity).create({
                    userId: ivy.id,
                    issuer: harness.fake!.issuer,
                    subject: 'subject-ivy',
                    emailAtLink: 'ivy@example.com',
                    emailVerifiedAtLink: true,
                    linkedVia: 'settings',
                    linkedAt: new Date(),
                }),
            );
            const token = await harness.fake!.mintAccessToken({
                subject: 'subject-ivy',
                scopes: ['apps:read'],
                authorizedParty: 'ever-works-web',
            });

            const marked = await request(server(harness))
                .get('/api/test-delegated/marked')
                .set('Authorization', `Bearer ${token}`);
            expect(marked.status).toBe(200);
            expect(marked.body).toEqual({ userId: ivy.id, authMethod: 'ever-id-delegated' });
            expect(marked.headers['set-cookie']).toBeUndefined();

            const unmarked = await request(server(harness))
                .get('/api/test-delegated/unmarked')
                .set('Authorization', `Bearer ${token}`);
            expect(unmarked.status).toBe(401);

            const noScope = await harness.fake!.mintAccessToken({
                subject: 'subject-ivy',
                scopes: ['ever-works:session'],
            });
            const refused = await request(server(harness))
                .get('/api/test-delegated/marked')
                .set('Authorization', `Bearer ${noScope}`);
            expect(refused.status).toBe(403);
            expect(refused.body.code).toBe('insufficient_scope');

            const now = Math.floor(Date.now() / 1000);
            const tooLong = await harness.fake!.mintAccessToken({
                subject: 'subject-ivy',
                scopes: ['apps:read'],
                issuedAt: now,
                expiresAt: now + 3_601,
            });
            const wrongAudience = await harness.fake!.mintAccessToken({
                subject: 'subject-ivy',
                scopes: ['apps:read'],
                audience: 'someone-else',
            });
            for (const bad of [tooLong, wrongAudience]) {
                const response = await request(server(harness))
                    .get('/api/test-delegated/marked')
                    .set('Authorization', `Bearer ${bad}`);
                expect(response.status).toBe(401);
            }

            // Connect / disconnect are never open to it (S27).
            const connect = await request(server(harness))
                .post('/api/auth/ever-id/connect/authorize')
                .set('Authorization', `Bearer ${token}`)
                .send({});
            expect(connect.status).toBe(401);

            // The card lists the app that read, with its display name (FR-48).
            const session = await harness.sessionFor(ivy.id);
            const card = await request(server(harness))
                .get('/api/auth/ever-id/identities')
                .set('Authorization', `Bearer ${session}`);
            expect(card.body.items[0].delegatedClients).toEqual([
                expect.objectContaining({ clientId: 'ever-works-web', displayName: 'Ever apps' }),
            ]);
            expect(card.body.manageUrl).toBe('https://id.example.test/account');
            expect(
                harness.activityRows.filter((row) => row.action === 'auth.ever_id.delegated_read'),
            ).toHaveLength(1);
        });

        it('hands out the provider sign-out address only for a session Ever ID opened (FR-36)', async () => {
            const jack = await harness.createUser({ email: 'jack@example.com' });
            const identity = await harness.dataSource.getRepository(ExternalIdentity).save(
                harness.dataSource.getRepository(ExternalIdentity).create({
                    userId: jack.id,
                    issuer: harness.fake!.issuer,
                    subject: 'subject-jack',
                    emailAtLink: 'jack@example.com',
                    emailVerifiedAtLink: true,
                    linkedVia: 'settings',
                    linkedAt: new Date(),
                }),
            );
            const everId = await harness.sessionFor(jack.id, { externalIdentityId: identity.id });
            const password = await harness.sessionFor(jack.id);

            const ok = await request(server(harness))
                .get('/api/auth/ever-id/logout-url')
                .set('Authorization', `Bearer ${everId}`);
            expect(ok.status).toBe(200);
            const url = new URL(ok.body.url);
            expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
                'https://app.example.test/api/auth/ever-id/logout-return',
            );
            expect(url.searchParams.get('state')).toBe(ok.body.state);

            const notEverId = await request(server(harness))
                .get('/api/auth/ever-id/logout-url')
                .set('Authorization', `Bearer ${password}`);
            expect(notEverId.status).toBe(404);
        });

        it('gives terminal clients the issuer, the local clients and the scopes — no secret (FR-39)', async () => {
            const response = await request(server(harness)).get('/api/auth/ever-id/client-config');

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                issuer: harness.fake!.issuer,
                localClients: [{ kind: 'cli', clientId: 'ever-works-cli' }],
                scopes: ['openid', 'email', 'ever-works:session'],
            });
            expect(JSON.stringify(response.body)).not.toContain('fake-client-secret');
        });

        it('keeps listing, disconnect and sign-out notices working after it is turned off (ACC-12-04)', async () => {
            const kim = await harness.createUser({ email: 'kim@example.com' });
            const identity = await harness.dataSource.getRepository(ExternalIdentity).save(
                harness.dataSource.getRepository(ExternalIdentity).create({
                    userId: kim.id,
                    issuer: harness.fake!.issuer,
                    subject: 'subject-kim',
                    emailAtLink: 'kim@example.com',
                    emailVerifiedAtLink: true,
                    linkedVia: 'settings',
                    linkedAt: new Date(),
                }),
            );
            const session = await harness.sessionFor(kim.id);
            await harness.sessionFor(kim.id, {
                externalIdentityId: identity.id,
                externalSid: 'sid-kim',
            });
            await harness.setEnabled(false);

            expect(
                (await request(server(harness)).post('/api/auth/ever-id/authorize').send({}))
                    .status,
            ).toBe(404);
            const list = await request(server(harness))
                .get('/api/auth/ever-id/identities')
                .set('Authorization', `Bearer ${session}`);
            expect(list.status).toBe(200);
            expect(list.body.items).toHaveLength(1);

            const notice = await harness.fake!.postBackchannelLogout(
                `${await serverUrl(harness)}/api/auth/ever-id/backchannel-logout`,
                undefined,
                { sid: 'sid-kim', subject: 'subject-kim' },
            );
            expect(notice.status).toBe(200);
            expect(
                await harness.dataSource
                    .getRepository(AuthSession)
                    .count({ where: { userId: kim.id } }),
            ).toBe(1);

            const disconnect = await request(server(harness))
                .delete(`/api/auth/ever-id/identities/${identity.id}`)
                .set('Authorization', `Bearer ${session}`);
            expect(disconnect.status).toBe(204);
        });

        it('preselects an Organization the person already belongs to from the hints, never a filtered one', async () => {
            const lena = await harness.createUser({ email: 'lena@example.com' });
            const tenantId = '99999999-9999-4999-8999-999999999999';
            const filteredOrg = 'aaaaaaaa-0000-4000-8000-000000000001';
            const preselectedOrg = 'aaaaaaaa-0000-4000-8000-000000000002';
            // Fixture rows only: the tenant table is not part of this flow.
            await harness.dataSource.query('PRAGMA foreign_keys = OFF');
            await harness.dataSource.getRepository(Organization).insert([
                { id: filteredOrg, displayName: 'Filtered Co', slug: 'filtered-co', tenantId },
                { id: preselectedOrg, displayName: 'Lena Co', slug: 'lena-co', tenantId },
            ] as never);
            await harness.dataSource
                .getRepository(User)
                .update({ id: lena.id }, { tenantId } as never);
            await harness.dataSource.query('PRAGMA foreign_keys = ON');
            await harness.dataSource.getRepository(ExternalIdentity).save(
                harness.dataSource.getRepository(ExternalIdentity).create({
                    userId: lena.id,
                    issuer: harness.fake!.issuer,
                    subject: 'subject-lena',
                    emailAtLink: 'lena@example.com',
                    emailVerifiedAtLink: true,
                    linkedVia: 'settings',
                    linkedAt: new Date(),
                }),
            );
            harness.fake!.setUser({ subject: 'subject-lena', email: 'lena@example.com' });
            harness.fake!.setIdTokenClaims({
                'urn:ever:claims_ver': 1,
                'urn:ever:orgs': [
                    { id: 'ever-org-filtered', links: [{ product_org_id: filteredOrg }] },
                    { id: 'ever-org-1', links: [{ product_org_id: preselectedOrg }] },
                ],
                'urn:ever:orgs_filtered': [
                    { id: 'ever-org-filtered', handle: 'filtered', reason: 'mfa_required' },
                ],
            });

            const signedIn = await completeBrowserSignIn(harness);

            expect(signedIn.body.outcome).toBe('signedIn');
            const after = await harness.dataSource
                .getRepository(User)
                .findOne({ where: { id: lena.id } });
            expect(after?.lastScopeOrganizationId).toBe(preselectedOrg);
            // Hints never create anything.
            expect(await harness.dataSource.getRepository(Organization).count()).toBe(2);
        });

        it('stores no provider token anywhere (ACC-12-22) and writes no secret into Activity or telemetry (ACC-12-37)', async () => {
            harness.fake!.setUser({ subject: 'subject-scan', email: 'scan@example.com' });
            const idToken = await harness.fake!.mintIdToken();
            const callback = await completeBrowserSignIn(harness);
            await request(server(harness))
                .post('/api/auth/ever-id/sign-up/confirm')
                .send({ pending: callback.body.pending, terms: TERMS });
            const accessToken = await harness.fake!.mintAccessToken({ subject: 'subject-scan' });
            await request(server(harness))
                .post('/api/auth/ever-id/session')
                .set('Authorization', `Bearer ${accessToken}`);

            const tables: Array<{ name: string }> = await harness.dataSource.query(
                `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
            );
            const forbidden = secretsOf(
                idToken,
                accessToken,
                harness.fake!.clientSecret,
                callback.body.pending,
            );
            for (const { name } of tables) {
                const rows = await harness.dataSource.query(`SELECT * FROM "${name}"`);
                const dump = JSON.stringify(rows);
                for (const secret of forbidden) {
                    expect({ table: name, leaked: dump.includes(secret) }).toEqual({
                        table: name,
                        leaked: false,
                    });
                }
            }
            const activity = JSON.stringify(harness.activityRows);
            const telemetry = JSON.stringify(harness.telemetry);
            for (const value of [
                ...forbidden,
                'subject-scan',
                harness.fake!.issuer,
                'scan@example.com',
            ]) {
                expect(activity.includes(value)).toBe(false);
                expect(telemetry.includes(value)).toBe(false);
            }
        });
    });

    describe('administration', () => {
        let harness: EverIdHarness;

        beforeEach(async () => {
            harness = await createEverIdHarness({ enabled: false });
        });
        afterEach(async () => harness.close());

        it('hides every admin route from non-admins (404) and lets an admin test, enable and disable (FR-3, FR-5)', async () => {
            const member = await harness.createUser({ email: 'member@example.com' });
            const admin = await harness.createUser({
                email: 'admin@example.com',
                isPlatformAdmin: true,
            });
            const memberSession = await harness.sessionFor(member.id);
            const adminSession = await harness.sessionFor(admin.id);

            for (const [method, path] of [
                ['post', '/api/auth/ever-id/admin/test'],
                ['get', '/api/auth/ever-id/admin/health'],
                ['get', '/api/auth/ever-id/admin/status'],
                ['post', '/api/auth/ever-id/admin/enable'],
                ['post', '/api/auth/ever-id/admin/disable'],
            ] as const) {
                const response = await (request(server(harness)) as any)
                    [method](path)
                    .set('Authorization', `Bearer ${memberSession}`);
                expect({ path, status: response.status }).toEqual({ path, status: 404 });
            }

            const test = await request(server(harness))
                .post('/api/auth/ever-id/admin/test')
                .set('Authorization', `Bearer ${adminSession}`);
            expect(test.status).toBe(200);
            expect(test.body.map((check: { id: string }) => check.id)).toEqual([
                'discovery',
                'issuerMatch',
                'endpoints',
                'pkceS256',
                'signingAlg',
                'backchannelLogout',
                'deviceAuthorization',
            ]);
            expect(JSON.stringify(test.body)).not.toContain('fake-client-secret');

            const enable = await request(server(harness))
                .post('/api/auth/ever-id/admin/enable')
                .set('Authorization', `Bearer ${adminSession}`);
            expect(enable.status).toBe(200);
            expect(enable.body).toMatchObject({
                enabled: true,
                configured: true,
                clientSecretSet: true,
            });
            expect(JSON.stringify(enable.body)).not.toContain('fake-client-secret');
            expect(
                harness.activityRows.find((row) => row.action === 'auth.ever_id.config_changed'),
            ).toMatchObject({
                userId: admin.id,
                metadata: { fields: ['enabled'] },
            });
            expect(
                (await request(server(harness)).post('/api/auth/ever-id/authorize').send({}))
                    .status,
            ).toBe(200);

            const disable = await request(server(harness))
                .post('/api/auth/ever-id/admin/disable')
                .set('Authorization', `Bearer ${adminSession}`);
            expect(disable.body.enabled).toBe(false);
            expect(
                (await request(server(harness)).post('/api/auth/ever-id/authorize').send({}))
                    .status,
            ).toBe(404);
        });

        it('lets an admin manage the local clients and app names, never the issuer or the client (FR-2, FR-4)', async () => {
            const admin = await harness.createUser({
                email: 'admin3@example.com',
                isPlatformAdmin: true,
            });
            const session = await harness.sessionFor(admin.id);

            const ok = await request(server(harness))
                .patch('/api/auth/ever-id/admin/settings')
                .set('Authorization', `Bearer ${session}`)
                .send({
                    localClients: [
                        { kind: 'cli', clientId: 'cli-client' },
                        { kind: 'node', clientId: 'node-client' },
                    ],
                    displayName: 'Example ID',
                });
            expect(ok.status).toBe(200);
            expect(ok.body).toMatchObject({ localClients: 2, displayName: 'Example ID' });
            // The values come back for the administration page's form; none is a secret.
            // (The account link and the app name are the harness's own settings.)
            expect(ok.body.settings).toEqual({
                displayName: 'Example ID',
                accountManagementUrl: 'https://id.example.test/account',
                localClients: [
                    { kind: 'cli', clientId: 'cli-client' },
                    { kind: 'node', clientId: 'node-client' },
                ],
                delegatedClientNames: [{ clientId: 'ever-works-web', displayName: 'Ever apps' }],
            });
            expect(JSON.stringify(ok.body)).not.toContain(String(harness.fake!.clientSecret));

            // `null` clears the account link (the administration page's empty field).
            const cleared = await request(server(harness))
                .patch('/api/auth/ever-id/admin/settings')
                .set('Authorization', `Bearer ${session}`)
                .send({ accountManagementUrl: null });
            expect(cleared.status).toBe(200);
            expect(cleared.body.settings.accountManagementUrl).toBeNull();
            expect(
                harness.activityRows.find((row) => row.action === 'auth.ever_id.config_changed'),
            ).toMatchObject({
                metadata: { fields: ['localClients', 'displayName'] },
            });

            const issuer = await request(server(harness))
                .patch('/api/auth/ever-id/admin/settings')
                .set('Authorization', `Bearer ${session}`)
                .send({ issuerUrl: 'https://evil.example.test' });
            expect(issuer.status).toBe(400);
            expect(harness.settings.issuerUrl).toBe(harness.fake!.issuer);
        });

        it('refuses to enable while a required check fails', async () => {
            const admin = await harness.createUser({
                email: 'admin2@example.com',
                isPlatformAdmin: true,
            });
            const session = await harness.sessionFor(admin.id);
            harness.settings.issuerUrl = `${harness.fake!.issuer}/drifted`;

            const response = await request(server(harness))
                .post('/api/auth/ever-id/admin/enable')
                .set('Authorization', `Bearer ${session}`);

            expect(response.status).toBe(409);
            expect(['connection_test_failed', 'provider_unavailable']).toContain(
                response.body.code,
            );
            expect(harness.pluginSettingsRow().enabled).not.toBe(true);
        });
    });
});

async function serverUrl(harness: EverIdHarness): Promise<string> {
    const httpServer = harness.app.getHttpServer();
    if (!httpServer.listening) {
        await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    }
    const address = httpServer.address();
    return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}
