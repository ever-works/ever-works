import { ExternalIdentityConflictError } from '@ever-works/agent/database';
import { EverIdLinkingService } from './ever-id-linking.service';
import { EverIdSealService } from './ever-id-seal.service';

/**
 * APW-12 (Ever ID) — the linking rules in isolation (spec §5.3, FR-20..FR-28):
 * S3 learns a boolean and never an account id, the FR-28 truth table, and the
 * S24 race compensation. The end-to-end behaviour is covered by
 * `ever-id.flow.integration.spec.ts`.
 */
describe('EverIdLinkingService', () => {
    const SAVED_SECRET = process.env.AUTH_SECRET;
    beforeAll(() => {
        process.env.AUTH_SECRET = 'a-test-secret-that-is-long-enough-for-hkdf-1234';
    });
    afterAll(() => {
        if (SAVED_SECRET === undefined) delete process.env.AUTH_SECRET;
        else process.env.AUTH_SECRET = SAVED_SECRET;
    });

    const ctx = { ipAddress: null, userAgent: null };
    const claims = {
        issuer: 'https://id.example.test',
        subject: 'subject-1',
        email: 'person@example.com',
        emailVerified: true,
        name: 'A Person',
        authTime: null,
        sid: 'sid-1',
    };

    function build(overrides: Record<string, unknown> = {}) {
        const users = {
            findById: jest.fn(),
            findByEmail: jest.fn(),
            findByEmailForSocialAuth: jest.fn(),
            existsByEmailCaseInsensitive: jest.fn().mockResolvedValue(false),
            create: jest.fn(async (data: Record<string, unknown>) => ({ id: 'new-user', ...data })),
            update: jest.fn().mockResolvedValue({}),
        };
        const identities = {
            findByIssuerSubject: jest.fn().mockResolvedValue(null),
            findByUserAndIssuer: jest.fn().mockResolvedValue(null),
            insertLink: jest.fn(),
            touchLogin: jest.fn(),
            listForUser: jest.fn().mockResolvedValue([]),
        };
        const facade = {
            getPublicConfig: jest.fn().mockResolvedValue({ signUpAllowed: true }),
            getDisplayName: jest.fn().mockResolvedValue('Ever ID'),
            getConfigurationStatus: jest.fn().mockRejectedValue(new Error('n/a')),
        };
        const replay = { consumeOnce: jest.fn().mockResolvedValue(true) };
        const deleteUser = jest.fn().mockResolvedValue({});
        const accounts: Array<{ providerId: string; password?: string | null }> = [];
        const dataSource = {
            getRepository: jest.fn((entity: { name?: string }) =>
                entity?.name === 'User'
                    ? { delete: deleteUser }
                    : { find: jest.fn(async () => accounts) },
            ),
        };
        const terms = {
            assertClaimsArePublished: jest.fn(),
            getRequiredDocuments: jest.fn(() => [{ documentId: 'tos:ever-works' }]),
            record: jest.fn(),
        };
        const service = new EverIdLinkingService(
            identities as never,
            users as never,
            facade as never,
            new EverIdSealService(),
            replay as never,
            { endByIdentity: jest.fn() } as never,
            {
                signedIn: jest.fn(),
                signedUp: jest.fn(),
                signInRefused: jest.fn(),
                connected: jest.fn(),
                disconnected: jest.fn(),
            } as never,
            { emit: jest.fn() } as never,
            {
                evaluate: jest
                    .fn()
                    .mockResolvedValue({ preselectedOrganizationId: null, refused: false }),
            } as never,
            terms as never,
            { allocateUsername: jest.fn(async (base: string) => base) } as never,
            { emit: jest.fn() } as never,
            {
                issueSession: jest
                    .fn()
                    .mockResolvedValue({ access_token: 't', user: { id: 'new-user' } }),
            } as never,
            dataSource as never,
        );
        Object.assign(service, overrides);
        return { service, users, identities, facade, replay, deleteUser, accounts };
    }

    it('S3: an address an account uses answers emailInUse from a BOOLEAN — never an account id (FR-22)', async () => {
        const { service, users } = build();
        users.existsByEmailCaseInsensitive.mockResolvedValue(true);

        const outcome = await service.resolveSignIn(claims, null, ctx);

        expect(Object.keys(outcome).sort()).toEqual(['email', 'outcome', 'pending']);
        expect(outcome).toMatchObject({ outcome: 'emailInUse', email: 'person@example.com' });
        expect(users.existsByEmailCaseInsensitive).toHaveBeenCalledWith('person@example.com');
        expect(users.findByEmail).not.toHaveBeenCalled();
        expect(users.findByEmailForSocialAuth).not.toHaveBeenCalled();
        expect(users.findById).not.toHaveBeenCalled();
    });

    it('S11: an unverified e-mail is refused before the address is even looked at', async () => {
        const { service, users } = build();

        await expect(
            service.resolveSignIn({ ...claims, emailVerified: false }, null, ctx),
        ).rejects.toMatchObject({
            response: { code: 'email_not_verified' },
            status: 422,
        });
        expect(users.existsByEmailCaseInsensitive).not.toHaveBeenCalled();
    });

    it.each([
        ['a verified e-mail', true, [], true],
        [
            'a password the person set',
            false,
            [{ providerId: 'credential', password: 'hash' }],
            true,
        ],
        ['another social provider', false, [{ providerId: 'github' }], true],
        ['only a plugin integration token', false, [{ providerId: 'plugin:github' }], false],
        [
            'a credential row without a password',
            false,
            [{ providerId: 'credential', password: null }],
            false,
        ],
        ['nothing else', false, [], false],
    ])('FR-28: canDisconnect with %s is %s', async (_label, emailVerified, rows, expected) => {
        const { service, users, accounts } = build();
        users.findById.mockResolvedValue({ id: 'u', emailVerified });
        accounts.push(...(rows as never[]));

        await expect(service.canDisconnect('u')).resolves.toBe(expected);
    });

    it('S24: when the pair is connected meanwhile, the account just created is removed again', async () => {
        const { service, identities, deleteUser } = build();
        identities.insertLink.mockRejectedValue(new ExternalIdentityConflictError('subjectLinked'));
        const pending = new EverIdSealService().seal('signUp', {
            id: 'pending-1',
            kind: 'signUp',
            issuer: claims.issuer,
            subject: claims.subject,
            email: claims.email,
            name: claims.name,
            sid: null,
            returnTo: null,
        });

        await expect(
            service.confirmSignUp(
                pending,
                [
                    {
                        documentId: 'tos:ever-works',
                        version: '1',
                        sha256: 'a'.repeat(64),
                        locale: 'en',
                    },
                ],
                ctx,
            ),
        ).rejects.toMatchObject({ response: { code: 'subject_linked' }, status: 409 });
        expect(deleteUser).toHaveBeenCalledWith({ id: 'new-user' });
    });

    it('refuses an account-exists hand-off value at the sign-up confirmation', async () => {
        const { service } = build();
        const pending = new EverIdSealService().seal('signUp', {
            id: 'p',
            kind: 'emailInUse',
            email: 'person@example.com',
        });

        await expect(service.confirmSignUp(pending, [], ctx)).rejects.toMatchObject({
            response: { code: 'transaction_invalid' },
        });
    });
});
