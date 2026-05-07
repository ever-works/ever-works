jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/onboarding', () => ({}));

import { OnboardingAccountAdapter } from './onboarding-account.adapter';

describe('OnboardingAccountAdapter', () => {
    type Mocks = {
        users: {
            findById: jest.Mock;
            findByEmail: jest.Mock;
            findByUsername: jest.Mock;
            create: jest.Mock;
        };
        authAccounts: {
            findProviderAccountByAccountId: jest.Mock;
            upsertProviderAccount: jest.Mock;
        };
        githubLinks: {
            findByGithubUserId: jest.Mock;
            upsertLink: jest.Mock;
        };
    };

    const baseInput = {
        githubUserId: '12345',
        login: 'octocat',
        email: 'octo@example.com',
        avatarUrl: 'https://example.com/avatar.png',
        accessToken: 'gh_token',
    };

    const create = (
        overrides: {
            link?: { userId: string } | null;
            userById?: { id: string } | null;
            providerAccount?: { userId: string } | null;
            userByEmail?: { id: string } | null;
            existingUsernames?: string[];
        } = {},
    ): { adapter: OnboardingAccountAdapter; mocks: Mocks } => {
        const usernameQueue = new Set(overrides.existingUsernames ?? []);
        const mocks: Mocks = {
            users: {
                findById: jest
                    .fn()
                    .mockImplementation(async (id: string) =>
                        overrides.userById && overrides.userById.id === id
                            ? overrides.userById
                            : null,
                    ),
                findByEmail: jest.fn().mockResolvedValue(overrides.userByEmail ?? null),
                findByUsername: jest
                    .fn()
                    .mockImplementation(async (name: string) =>
                        usernameQueue.has(name) ? { id: 'taken', username: name } : null,
                    ),
                create: jest
                    .fn()
                    .mockImplementation(async (data: any) => ({ id: 'new-user-id', ...data })),
            },
            authAccounts: {
                findProviderAccountByAccountId: jest
                    .fn()
                    .mockResolvedValue(overrides.providerAccount ?? null),
                upsertProviderAccount: jest.fn().mockResolvedValue(undefined),
            },
            githubLinks: {
                findByGithubUserId: jest.fn().mockResolvedValue(overrides.link ?? null),
                upsertLink: jest.fn().mockResolvedValue(undefined),
            },
        };
        const adapter = new OnboardingAccountAdapter(
            mocks.users as any,
            mocks.authAccounts as any,
            mocks.githubLinks as any,
        );
        return { adapter, mocks };
    };

    it('returns the linked user when github_app_user_link exists', async () => {
        const { adapter, mocks } = create({
            link: { userId: 'user-from-link' },
            userById: { id: 'user-from-link' },
        });

        const result = await adapter.upsertFromGithub(baseInput);

        expect(result).toEqual({ accountId: 'user-from-link' });
        expect(mocks.githubLinks.findByGithubUserId).toHaveBeenCalledWith('12345');
        expect(mocks.users.findById).toHaveBeenCalledWith('user-from-link');
        expect(mocks.authAccounts.findProviderAccountByAccountId).not.toHaveBeenCalled();
        expect(mocks.users.findByEmail).not.toHaveBeenCalled();
        expect(mocks.users.create).not.toHaveBeenCalled();
    });

    it('falls back to auth_accounts provider lookup when no link exists', async () => {
        const { adapter, mocks } = create({
            link: null,
            providerAccount: { userId: 'user-from-provider' },
            userById: { id: 'user-from-provider' },
        });

        const result = await adapter.upsertFromGithub(baseInput);

        expect(result.accountId).toBe('user-from-provider');
        expect(mocks.authAccounts.findProviderAccountByAccountId).toHaveBeenCalledWith(
            'github',
            '12345',
        );
        expect(mocks.users.findByEmail).not.toHaveBeenCalled();
        expect(mocks.users.create).not.toHaveBeenCalled();
    });

    it('falls back to email lookup when neither link nor provider account exists', async () => {
        const { adapter, mocks } = create({
            link: null,
            providerAccount: null,
            userByEmail: { id: 'user-from-email' },
        });

        const result = await adapter.upsertFromGithub(baseInput);

        expect(result.accountId).toBe('user-from-email');
        expect(mocks.users.findByEmail).toHaveBeenCalledWith('octo@example.com');
        expect(mocks.users.create).not.toHaveBeenCalled();
    });

    it('skips email fallback when input.email is missing', async () => {
        const { adapter, mocks } = create({
            link: null,
            providerAccount: null,
        });

        await adapter.upsertFromGithub({ ...baseInput, email: undefined });

        expect(mocks.users.findByEmail).not.toHaveBeenCalled();
        expect(mocks.users.create).toHaveBeenCalledTimes(1);
    });

    it('creates a new user using login as username and provided email when nothing matches', async () => {
        const { adapter, mocks } = create({});

        const result = await adapter.upsertFromGithub(baseInput);

        expect(mocks.users.create).toHaveBeenCalledTimes(1);
        const created = mocks.users.create.mock.calls[0][0];
        expect(created.username).toBe('octocat');
        expect(created.email).toBe('octo@example.com');
        expect(created.registrationProvider).toBe('github');
        expect(created.avatar).toBe('https://example.com/avatar.png');
        expect(created.emailVerified).toBe(false);
        expect(created.isActive).toBe(true);
        expect(created.lastLoginAt).toBeInstanceOf(Date);
        // password is randomUUID() — never used for login but must be set
        expect(typeof created.password).toBe('string');
        expect(created.password.length).toBeGreaterThan(0);
        expect(result.accountId).toBe('new-user-id');
    });

    it('falls back to a synthetic noreply email when input.email is not provided', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub({ ...baseInput, email: undefined });

        const created = mocks.users.create.mock.calls[0][0];
        expect(created.email).toBe('agent-12345@users.noreply.ever.works');
    });

    it('falls back to agent-<id> username when login is empty', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub({ ...baseInput, login: '' });

        const created = mocks.users.create.mock.calls[0][0];
        expect(created.username).toBe('agent-12345');
    });

    it('sanitizes the username (strips non [a-zA-Z0-9_-])', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub({ ...baseInput, login: 'oct.o cat!' });

        const created = mocks.users.create.mock.calls[0][0];
        expect(created.username).toBe('octocat');
    });

    it('truncates the sanitized base to 32 chars', async () => {
        const { adapter, mocks } = create({});
        const longLogin = 'a'.repeat(50);
        await adapter.upsertFromGithub({ ...baseInput, login: longLogin });
        const created = mocks.users.create.mock.calls[0][0];
        expect(created.username).toBe('a'.repeat(32));
    });

    it('falls back to agent when login sanitizes to an empty string', async () => {
        const { adapter, mocks } = create({});
        await adapter.upsertFromGithub({ ...baseInput, login: '!!!' });
        const created = mocks.users.create.mock.calls[0][0];
        expect(created.username).toBe('agent');
    });

    it('appends -<n> when username is taken', async () => {
        const { adapter, mocks } = create({ existingUsernames: ['octocat'] });

        await adapter.upsertFromGithub(baseInput);

        const created = mocks.users.create.mock.calls[0][0];
        expect(created.username).toBe('octocat-2');
        // Looked up base + 1 suffix only
        expect(mocks.users.findByUsername).toHaveBeenCalledWith('octocat');
        expect(mocks.users.findByUsername).toHaveBeenCalledWith('octocat-2');
    });

    it('falls back to a UUID-suffixed username after 50 attempts', async () => {
        const taken: string[] = ['octocat'];
        for (let i = 2; i <= 51; i++) taken.push(`octocat-${i}`);
        const { adapter, mocks } = create({ existingUsernames: taken });

        await adapter.upsertFromGithub(baseInput);

        const created = mocks.users.create.mock.calls[0][0];
        expect(created.username).toMatch(/^octocat-[0-9a-f]{8}$/);
    });

    it('upserts the provider account row with the expected fields', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub(baseInput);

        expect(mocks.authAccounts.upsertProviderAccount).toHaveBeenCalledTimes(1);
        const arg = mocks.authAccounts.upsertProviderAccount.mock.calls[0][0];
        expect(arg.userId).toBe('new-user-id');
        expect(arg.providerId).toBe('github');
        expect(arg.accountId).toBe('12345');
        expect(arg.username).toBe('octocat');
        expect(arg.email).toBe('octo@example.com');
        expect(arg.accessToken).toBe('gh_token');
        expect(arg.tokenType).toBe('Bearer');
        expect(arg.metadata).toEqual({
            providerUserId: '12345',
            login: 'octocat',
            onboardingChannel: 'agent-zero-friction',
        });
        expect(arg.refreshToken).toBeNull();
        expect(arg.scope).toBeNull();
    });

    it('passes email=null to upsertProviderAccount when input.email omitted', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub({ ...baseInput, email: undefined });

        const arg = mocks.authAccounts.upsertProviderAccount.mock.calls[0][0];
        expect(arg.email).toBeNull();
    });

    it('upserts the github link row with the expected fields', async () => {
        const { adapter, mocks } = create({});

        await adapter.upsertFromGithub(baseInput);

        expect(mocks.githubLinks.upsertLink).toHaveBeenCalledTimes(1);
        const arg = mocks.githubLinks.upsertLink.mock.calls[0][0];
        expect(arg.userId).toBe('new-user-id');
        expect(arg.githubUserId).toBe('12345');
        expect(arg.githubLogin).toBe('octocat');
        expect(arg.accessToken).toBe('gh_token');
        expect(arg.refreshToken).toBeNull();
        expect(arg.githubNodeId).toBeNull();
        expect(arg.scope).toBeNull();
    });

    it('swallows errors from upsertProviderAccount (logs warn, returns accountId)', async () => {
        const { adapter, mocks } = create({});
        mocks.authAccounts.upsertProviderAccount.mockRejectedValue(new Error('db unavailable'));
        const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');

        const result = await adapter.upsertFromGithub(baseInput);

        expect(result.accountId).toBe('new-user-id');
        expect(mocks.githubLinks.upsertLink).toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
        expect(String(warnSpy.mock.calls[0][0])).toContain('account_link_failed');
        warnSpy.mockRestore();
    });

    it('swallows errors from githubLinks.upsertLink (logs warn, returns accountId)', async () => {
        const { adapter, mocks } = create({});
        mocks.githubLinks.upsertLink.mockRejectedValue('plain string error');
        const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');

        const result = await adapter.upsertFromGithub(baseInput);

        expect(result.accountId).toBe('new-user-id');
        expect(warnSpy).toHaveBeenCalled();
        expect(String(warnSpy.mock.calls[0][0])).toContain('gh_link_failed');
        // describeError fallback for non-Error values: String(err)
        expect(String(warnSpy.mock.calls[0][0])).toContain('plain string error');
        warnSpy.mockRestore();
    });

    it('logs account_created when a new user is provisioned', async () => {
        const { adapter } = create({});
        const logSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'log');

        await adapter.upsertFromGithub(baseInput);

        expect(logSpy).toHaveBeenCalled();
        const msg = String(logSpy.mock.calls[0][0]);
        expect(msg).toContain('account_created');
        expect(msg).toContain('userId=new-user-id');
        expect(msg).toContain('login=octocat');
        logSpy.mockRestore();
    });

    it('logs account_linked when an existing user is reused', async () => {
        const { adapter } = create({
            link: { userId: 'preexisting' },
            userById: { id: 'preexisting' },
        });
        const logSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'log');

        await adapter.upsertFromGithub(baseInput);

        const msgs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(msgs).toContain('account_linked');
        expect(msgs).toContain('userId=preexisting');
        logSpy.mockRestore();
    });
});
