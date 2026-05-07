jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/onboarding', () => ({}));

import { OnboardingWorkAdapter } from './onboarding-work.adapter';

describe('OnboardingWorkAdapter', () => {
    const baseInput = {
        accountId: 'user-1',
        githubAccessToken: 'gh-tok',
        manifestRepoUrl: 'https://github.com/octo-org/awesome-mcp',
        manifest: {
            metadata: {
                name: 'Awesome MCP',
                description: 'A directory of MCP servers',
            },
            spec: {
                deployment: { target: 'vercel' },
            },
        },
        subdomain: 'awesome-mcp',
        onboardingId: 'ob-12345678-aaaa-bbbb-cccc-dddd00000000',
    };

    type Mocks = {
        users: { findById: jest.Mock };
        workLifecycle: { createWork: jest.Mock };
    };

    const create = (
        overrides: {
            user?: { id: string } | null;
            createResult?: any;
            createReject?: Error;
        } = {},
    ): { adapter: OnboardingWorkAdapter; mocks: Mocks } => {
        const mocks: Mocks = {
            users: {
                findById: jest
                    .fn()
                    .mockResolvedValue(
                        overrides.user === undefined
                            ? { id: 'user-1', email: 'u@u.com' }
                            : overrides.user,
                    ),
            },
            workLifecycle: {
                createWork: jest.fn(),
            },
        };
        if (overrides.createReject) {
            mocks.workLifecycle.createWork.mockRejectedValue(overrides.createReject);
        } else if ('createResult' in overrides) {
            mocks.workLifecycle.createWork.mockResolvedValue(overrides.createResult);
        } else {
            mocks.workLifecycle.createWork.mockResolvedValue({ work: { id: 'work-42' } });
        }
        const adapter = new OnboardingWorkAdapter(mocks.workLifecycle as any, mocks.users as any);
        return { adapter, mocks };
    };

    it('throws when accountId does not resolve to a user', async () => {
        const { adapter, mocks } = create({ user: null });
        await expect(adapter.createFromManifest(baseInput)).rejects.toThrow(
            /accountId user-1 not found/,
        );
        expect(mocks.workLifecycle.createWork).not.toHaveBeenCalled();
    });

    it('extracts owner from the manifest repo URL and slugifies the work name', async () => {
        const { adapter, mocks } = create({});
        const result = await adapter.createFromManifest(baseInput);

        expect(mocks.workLifecycle.createWork).toHaveBeenCalledTimes(1);
        const dto = mocks.workLifecycle.createWork.mock.calls[0][0];
        expect(dto.owner).toBe('octo-org');
        expect(dto.slug).toBe('awesome-mcp');
        expect(dto.name).toBe('Awesome MCP');
        expect(dto.organization).toBe(false);
        expect(dto.gitProvider).toBe('github');
        expect(dto.deployProvider).toBe('vercel');
        expect(result).toEqual({ workId: 'work-42' });
    });

    it('uses manifest.metadata.slug when provided (overrides slugified name)', async () => {
        const { adapter, mocks } = create({});

        await adapter.createFromManifest({
            ...baseInput,
            manifest: {
                metadata: { name: 'Anything', slug: 'preferred-slug' },
                spec: {},
            },
        });

        const dto = mocks.workLifecycle.createWork.mock.calls[0][0];
        expect(dto.slug).toBe('preferred-slug');
    });

    it('truncates slug to 63 characters', async () => {
        const { adapter, mocks } = create({});
        const longName = 'A'.repeat(80);
        await adapter.createFromManifest({
            ...baseInput,
            manifest: { metadata: { name: longName }, spec: {} },
        });
        const dto = mocks.workLifecycle.createWork.mock.calls[0][0];
        expect(dto.slug.length).toBe(63);
        expect(dto.slug).toBe('a'.repeat(63));
    });

    it('falls back to "work" slug when name slugifies to empty', async () => {
        const { adapter, mocks } = create({});
        await adapter.createFromManifest({
            ...baseInput,
            manifest: { metadata: { name: '!!!' }, spec: {} },
        });
        const dto = mocks.workLifecycle.createWork.mock.calls[0][0];
        expect(dto.slug).toBe('work');
    });

    it('strips leading and trailing hyphens during slugify', async () => {
        const { adapter, mocks } = create({});
        await adapter.createFromManifest({
            ...baseInput,
            manifest: { metadata: { name: '  -hello world!-  ' }, spec: {} },
        });
        const dto = mocks.workLifecycle.createWork.mock.calls[0][0];
        expect(dto.slug).toBe('hello-world');
    });

    it('falls back to "vercel" deployProvider when spec.deployment.target is missing', async () => {
        const { adapter, mocks } = create({});
        await adapter.createFromManifest({
            ...baseInput,
            manifest: { metadata: { name: 'X' }, spec: {} },
        });
        const dto = mocks.workLifecycle.createWork.mock.calls[0][0];
        expect(dto.deployProvider).toBe('vercel');
    });

    it('uses spec.deployment.target when provided', async () => {
        const { adapter, mocks } = create({});
        await adapter.createFromManifest({
            ...baseInput,
            manifest: {
                metadata: { name: 'X' },
                spec: { deployment: { target: 'netlify' } },
            },
        });
        const dto = mocks.workLifecycle.createWork.mock.calls[0][0];
        expect(dto.deployProvider).toBe('netlify');
    });

    it('uses manifest.metadata.description when provided', async () => {
        const { adapter, mocks } = create({});
        await adapter.createFromManifest(baseInput);
        const dto = mocks.workLifecycle.createWork.mock.calls[0][0];
        expect(dto.description).toBe('A directory of MCP servers');
    });

    it('falls back to a synthetic description when manifest description is missing', async () => {
        const { adapter, mocks } = create({});
        await adapter.createFromManifest({
            ...baseInput,
            manifest: { metadata: { name: 'X' }, spec: {} },
        });
        const dto = mocks.workLifecycle.createWork.mock.calls[0][0];
        expect(dto.description).toMatch(/Auto-generated by Ever Works zero-friction onboarding/);
        // First 8 chars of onboardingId
        expect(dto.description).toContain('ob-12345');
    });

    it('returns owner="" when manifestRepoUrl cannot be parsed', async () => {
        const { adapter, mocks } = create({});
        await adapter.createFromManifest({
            ...baseInput,
            manifestRepoUrl: 'not-a-url',
        });
        const dto = mocks.workLifecycle.createWork.mock.calls[0][0];
        expect(dto.owner).toBe('');
    });

    it('strips a trailing .git from the repo URL when extracting owner', async () => {
        const { adapter, mocks } = create({});
        await adapter.createFromManifest({
            ...baseInput,
            manifestRepoUrl: 'https://github.com/owner-x/awesome.git',
        });
        const dto = mocks.workLifecycle.createWork.mock.calls[0][0];
        expect(dto.owner).toBe('owner-x');
    });

    it('throws "createWork returned no work id" when result has no id', async () => {
        const { adapter } = create({ createResult: { work: {} } });
        await expect(adapter.createFromManifest(baseInput)).rejects.toThrow(
            'createWork returned no work id',
        );
    });

    it('throws "createWork returned no work id" when result is undefined', async () => {
        const { adapter } = create({ createResult: undefined });
        await expect(adapter.createFromManifest(baseInput)).rejects.toThrow(
            'createWork returned no work id',
        );
    });

    it('passes the resolved User object as the second arg to createWork', async () => {
        const userRow = { id: 'user-1', email: 'u@u.com', extras: 1 };
        const { adapter, mocks } = create({ user: userRow as any });
        await adapter.createFromManifest(baseInput);
        expect(mocks.workLifecycle.createWork.mock.calls[0][1]).toBe(userRow);
    });

    it('logs a success message including onboardingId, workId and slug', async () => {
        const { adapter } = create({});
        const logSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'log');
        await adapter.createFromManifest(baseInput);
        const msgs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(msgs).toContain('work_created');
        expect(msgs).toContain('onboardingId=ob-12345678-aaaa-bbbb-cccc-dddd00000000');
        expect(msgs).toContain('workId=work-42');
        expect(msgs).toContain('slug=awesome-mcp');
        logSpy.mockRestore();
    });

    it('rethrows errors from createWork after logging a warn', async () => {
        const { adapter } = create({ createReject: new Error('lifecycle exploded') });
        const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');
        await expect(adapter.createFromManifest(baseInput)).rejects.toThrow('lifecycle exploded');
        const msgs = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(msgs).toContain('work_creation_failed');
        expect(msgs).toContain('lifecycle exploded');
        warnSpy.mockRestore();
    });

    it('describeError fallback: stringifies non-Error throwables in the warn log', async () => {
        const { adapter, mocks } = create({});
        mocks.workLifecycle.createWork.mockImplementation(() => Promise.reject('weird'));
        const warnSpy = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');
        await expect(adapter.createFromManifest(baseInput)).rejects.toBe('weird');
        const msgs = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(msgs).toContain('reason=weird');
        warnSpy.mockRestore();
    });
});
