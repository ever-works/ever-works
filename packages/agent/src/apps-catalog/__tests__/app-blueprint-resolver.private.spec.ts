import {
    APP_BLUEPRINT_SPEC_PATH,
    APP_BLUEPRINT_TOPIC,
    AppBlueprintResolverService,
    allowsPrivateBlueprint,
} from '../app-blueprint-resolver.service';

/**
 * Decision 2026-10-17 (lane aw-catalog round 2) — private first-party Blueprints, so
 * `ever-works/app-fixture-hello-template` (private) resolves for the APW-13 lanes while a
 * third-party source still only ever sees PUBLIC Blueprints. The spec is still read from
 * `.works/works.yml` only (owner decision 2026-09-25: fix the repositories, not the
 * contract), so the fixture repository carries one there.
 */

const FIXTURE = 'app-fixture-hello-template';

const SPEC = [
    'version: 2',
    'kind: app',
    'name: App fixture (hello)',
    'spec:',
    '  source:',
    '    relation: fork',
    '    upstream: { repo: ever-works/app-fixture-hello, defaultBranch: main }',
    '    branch: main',
    '  blueprint:',
    '    id: app-fixture-hello',
    '    version: 0.1.0',
    `    repo: ever-works/${FIXTURE}`,
    `    sha: '${'0'.repeat(40)}'`,
    '  license:',
    '    spdx: MIT',
    '',
].join('\n');

const FILES: Record<string, string> = { [APP_BLUEPRINT_SPEC_PATH]: SPEC };

function repository(overrides: Record<string, unknown> = {}) {
    return {
        owner: 'ever-works',
        name: FIXTURE,
        fullName: `ever-works/${FIXTURE}`,
        defaultBranch: 'main',
        isPrivate: true,
        visibility: 'private',
        topics: [APP_BLUEPRINT_TOPIC],
        ...overrides,
    };
}

function facade(files: Record<string, string>, repo = repository()) {
    const getRepository = jest.fn(async (_o: string, name: string) =>
        name === repo.name ? repo : null,
    );
    const getFileContent = jest.fn(async (_o: string, _r: string, path: string) =>
        path in files ? { content: files[path], encoding: 'utf-8' } : null,
    );
    return {
        getRepository,
        getFileContent,
        getInstallationTokenForOwner: jest.fn(async () => 'installation-token'),
    };
}

describe('private first-party Blueprints (decision 2026-10-17)', () => {
    const env = process.env.EVER_WORKS_APPS_PRIVATE_BLUEPRINT_OWNERS;
    afterEach(() => {
        if (env === undefined) delete process.env.EVER_WORKS_APPS_PRIVATE_BLUEPRINT_OWNERS;
        else process.env.EVER_WORKS_APPS_PRIVATE_BLUEPRINT_OWNERS = env;
    });

    it('allowsPrivateBlueprint: ever-works itself and listed owners only', () => {
        delete process.env.EVER_WORKS_APPS_PRIVATE_BLUEPRINT_OWNERS;
        expect(allowsPrivateBlueprint('ever-works')).toBe(true);
        expect(allowsPrivateBlueprint('EVER-WORKS')).toBe(true);
        expect(allowsPrivateBlueprint('stranger')).toBe(false);
        expect(allowsPrivateBlueprint('')).toBe(false);
        expect(allowsPrivateBlueprint(undefined)).toBe(false);
        process.env.EVER_WORKS_APPS_PRIVATE_BLUEPRINT_OWNERS = 'e2e-upstreams, Other';
        expect(allowsPrivateBlueprint('e2e-upstreams')).toBe(true);
        expect(allowsPrivateBlueprint('other')).toBe(true);
        expect(allowsPrivateBlueprint('stranger')).toBe(false);
    });

    it('allowsPrivateBlueprint: `*` works on a test install and is ignored in production', () => {
        const nodeEnv = process.env.NODE_ENV;
        try {
            process.env.EVER_WORKS_APPS_PRIVATE_BLUEPRINT_OWNERS = '*';
            process.env.NODE_ENV = 'test';
            expect(allowsPrivateBlueprint('anyone')).toBe(true);
            process.env.NODE_ENV = 'production';
            expect(allowsPrivateBlueprint('anyone')).toBe(false);
            expect(allowsPrivateBlueprint('ever-works')).toBe(true);
        } finally {
            process.env.NODE_ENV = nodeEnv;
        }
    });

    it('resolves the private fixture for an ever-works source (probe), reading only .works/works.yml', async () => {
        const double = facade(FILES);
        const resolver = new AppBlueprintResolverService(double as never);

        const result = await resolver.resolve({ owner: 'ever-works', repo: 'app-fixture-hello' });

        expect(result).toMatchObject({
            status: 'hit',
            source: 'probe',
            id: 'app-fixture-hello',
            repo: `ever-works/${FIXTURE}`,
        });
        expect(double.getFileContent.mock.calls.map((call) => call[2])).toEqual([
            APP_BLUEPRINT_SPEC_PATH,
        ]);
    });

    it('refuses the same private Blueprint for a third-party source and reads no file', async () => {
        delete process.env.EVER_WORKS_APPS_PRIVATE_BLUEPRINT_OWNERS;
        const double = facade(FILES);
        const resolver = new AppBlueprintResolverService(double as never);

        await expect(
            resolver.resolve({
                owner: 'stranger',
                repo: 'gen-1',
                blueprintId: 'app-fixture-hello',
            }),
        ).resolves.toEqual({ status: 'none', reason: 'blueprintNotFound' });
        expect(double.getFileContent).not.toHaveBeenCalled();
    });

    it('offers it explicitly to a listed e2e owner; readBlueprintDocument applies the same rule', async () => {
        process.env.EVER_WORKS_APPS_PRIVATE_BLUEPRINT_OWNERS = 'e2e-upstreams';
        const double = facade(FILES);
        const resolver = new AppBlueprintResolverService(double as never);

        await expect(
            resolver.resolve({
                owner: 'e2e-upstreams',
                repo: 'app-fixture-gen-42',
                blueprintId: 'app-fixture-hello',
            }),
        ).resolves.toMatchObject({ status: 'hit', source: 'explicit' });
        await expect(
            resolver.readBlueprintDocument('app-fixture-hello', { sourceOwner: 'e2e-upstreams' }),
        ).resolves.toMatchObject({ text: SPEC });
        await expect(
            resolver.readBlueprintDocument('app-fixture-hello', { sourceOwner: 'stranger' }),
        ).resolves.toBeNull();
        await expect(resolver.readBlueprintDocument('app-fixture-hello')).resolves.toBeNull();
    });

    it('keeps public Blueprints unchanged for everyone', async () => {
        const double = facade(FILES, repository({ isPrivate: false, visibility: 'public' }));
        const resolver = new AppBlueprintResolverService(double as never);
        await expect(
            resolver.resolve({ owner: 'stranger', repo: 'x', blueprintId: 'app-fixture-hello' }),
        ).resolves.toMatchObject({ status: 'hit' });
    });
});
