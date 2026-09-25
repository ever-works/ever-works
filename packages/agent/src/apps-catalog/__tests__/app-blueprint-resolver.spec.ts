import {
    BLUEPRINT_PROBE_MAX_READS,
    BLUEPRINT_RESOLVE_HIT_TTL_MS,
    BLUEPRINT_RESOLVE_MISS_TTL_MS,
} from '@ever-works/contracts';
import {
    APP_BLUEPRINT_RESOLVE_CACHE_MAX_ENTRIES,
    APP_BLUEPRINT_SPEC_PATH,
    APP_BLUEPRINT_TOPIC,
    AppBlueprintResolverService,
    AppsCatalogCredentialUnavailableError,
    probeCandidateNames,
} from '../app-blueprint-resolver.service';

/**
 * APW-03 T26 (explicit + probe halves) — `AppBlueprintResolverService`.
 *
 * The facade is a jest double and nothing here touches a network. Every case reads the
 * two facade methods the resolver is allowed to call (`getRepository`,
 * `getFileContent`) as its "provider reads", which is what FR-43's cap of 3 counts.
 *
 * The Blueprint file is inline YAML: the smallest document that validates in
 * `blueprint` mode with zero errors (root `version: 2` / `kind: app`, a full
 * `spec.blueprint`, a licence, a display name and one prompted env entry).
 */

interface BlueprintYamlOptions {
    id?: string;
    repo?: string;
    kind?: string;
    version?: string;
    spdx?: string | null;
    displayName?: string | null;
    env?: string;
}

function blueprintYaml(options: BlueprintYamlOptions = {}): string {
    const id = options.id ?? 'app-fixture-hello';
    const repo = options.repo ?? `ever-works/${id}-template`;
    const lines = [
        'version: 2',
        `kind: ${options.kind ?? 'app'}`,
        'name: Fixture',
        'spec:',
        '  blueprint:',
        `    id: ${id}`,
        `    version: ${options.version ?? '0.1.0'}`,
        `    repo: ${repo}`,
        `    sha: '${'0'.repeat(40)}'`,
    ];
    if (options.spdx !== null) {
        lines.push('  license:', `    spdx: ${options.spdx ?? 'MIT'}`);
    }
    if (options.displayName !== null) {
        lines.push('  display:', `    name: '${options.displayName ?? 'App fixture (hello)'}'`);
    }
    lines.push(
        options.env ??
            [
                '  env:',
                '    - name: MARKER',
                '      prompt:',
                "        description: 'Any text; GET /marker returns it'",
                '        example: hello-world',
            ].join('\n'),
    );
    return `${lines.join('\n')}\n`;
}

/** A repository as the GitHub plugin reports it, with only what a case overrides changed. */
function blueprintRepository(name: string, overrides: Record<string, unknown> = {}) {
    return {
        owner: 'ever-works',
        name,
        fullName: `ever-works/${name}`,
        defaultBranch: 'main',
        isPrivate: false,
        visibility: 'public',
        url: `https://github.com/ever-works/${name}`,
        cloneUrl: `https://github.com/ever-works/${name}.git`,
        topics: [APP_BLUEPRINT_TOPIC, 'ever-works'],
        permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
        ...overrides,
    };
}

type RepositoryAnswer = ReturnType<typeof blueprintRepository> | null | Error;
type FileAnswer = string | null | Error;

interface FacadeDouble {
    getRepository: jest.Mock;
    getFileContent: jest.Mock;
    getInstallationTokenForOwner: jest.Mock;
    /** Every provider read, in order — the FR-43 counter's witness. */
    reads: () => number;
}

/**
 * A facade whose repositories and files are keyed by repository NAME under `ever-works`.
 * Anything not listed answers `null` — GitHub's 404, as the plugin maps it.
 */
function facade(
    input: {
        repositories?: Record<string, RepositoryAnswer>;
        files?: Record<string, FileAnswer>;
        installationToken?: string | null;
    } = {},
): FacadeDouble {
    const getRepository = jest.fn(async (_owner: string, name: string) => {
        const answer = input.repositories?.[name];
        if (answer instanceof Error) throw answer;
        return answer ?? null;
    });
    const getFileContent = jest.fn(async (_owner: string, name: string, path: string) => {
        if (path !== APP_BLUEPRINT_SPEC_PATH) return null;
        const answer = input.files?.[name];
        if (answer instanceof Error) throw answer;
        return typeof answer === 'string' ? { content: answer, encoding: 'utf-8' } : null;
    });
    const getInstallationTokenForOwner = jest.fn(async () =>
        input.installationToken === undefined ? 'installation-token' : input.installationToken,
    );
    return {
        getRepository,
        getFileContent,
        getInstallationTokenForOwner,
        reads: () => getRepository.mock.calls.length + getFileContent.mock.calls.length,
    };
}

function resolverFor(double: FacadeDouble | undefined): AppBlueprintResolverService {
    return new AppBlueprintResolverService(double as never);
}

/** The per-run repository the acceptance harness generates (ACC-E2E-05). */
const PER_RUN = { owner: 'someone', repo: 'gen-123' };

describe('AppBlueprintResolverService', () => {
    const savedEnv = {
        catalog: process.env.EVER_WORKS_APPS_CATALOG_TOKEN,
        github: process.env.GITHUB_TOKEN,
    };
    let now = 1_750_000_000_000;

    beforeEach(() => {
        delete process.env.EVER_WORKS_APPS_CATALOG_TOKEN;
        delete process.env.GITHUB_TOKEN;
        now = 1_750_000_000_000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        for (const [key, value] of [
            ['EVER_WORKS_APPS_CATALOG_TOKEN', savedEnv.catalog],
            ['GITHUB_TOKEN', savedEnv.github],
        ] as const) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    describe('the probe path (FR-43)', () => {
        it('(a) probes ever-works/<slug(repo)>-template first and hits in two reads', async () => {
            const double = facade({
                repositories: { 'cal-diy-template': blueprintRepository('cal-diy-template') },
                files: { 'cal-diy-template': blueprintYaml({ id: 'cal-diy' }) },
            });

            const result = await resolverFor(double).resolve({ owner: 'calcom', repo: 'cal.diy' });

            expect(double.getRepository).toHaveBeenNthCalledWith(
                1,
                'ever-works',
                'cal-diy-template',
                { token: 'installation-token', providerId: 'github' },
            );
            expect(double.getFileContent).toHaveBeenCalledWith(
                'ever-works',
                'cal-diy-template',
                '.works/works.yml',
                { token: 'installation-token', providerId: 'github' },
                'main',
            );
            expect(double.reads()).toBe(2);
            expect(result).toEqual({
                status: 'hit',
                source: 'probe',
                repo: 'ever-works/cal-diy-template',
                id: 'cal-diy',
                version: '0.1.0',
                name: 'App fixture (hello)',
                displayName: 'App fixture (hello)',
                spdx: 'MIT',
                prompts: [
                    {
                        name: 'MARKER',
                        description: 'Any text; GET /marker returns it',
                        required: true,
                    },
                ],
            });
        });

        it('(b) falls back to <slug(owner)>-<slug(repo)>-template, within three reads', async () => {
            const double = facade({
                repositories: {
                    'calcom-cal-diy-template': blueprintRepository('calcom-cal-diy-template'),
                },
                files: {
                    'calcom-cal-diy-template': blueprintYaml({
                        id: 'cal-diy',
                        repo: 'ever-works/calcom-cal-diy-template',
                    }),
                },
            });

            const result = await resolverFor(double).resolve({ owner: 'calcom', repo: 'cal.diy' });

            expect(double.getRepository.mock.calls.map((call) => call[1])).toEqual([
                'cal-diy-template',
                'calcom-cal-diy-template',
            ]);
            expect(double.reads()).toBe(3);
            expect(double.reads()).toBeLessThanOrEqual(BLUEPRINT_PROBE_MAX_READS);
            expect(result).toMatchObject({ status: 'hit', source: 'probe', id: 'cal-diy' });
        });

        it('answers notListed when neither name exists, in two reads', async () => {
            const double = facade();

            const result = await resolverFor(double).resolve({ owner: 'calcom', repo: 'cal.diy' });

            expect(result).toEqual({ status: 'none', reason: 'notListed' });
            expect(double.reads()).toBe(2);
            expect(double.getFileContent).not.toHaveBeenCalled();
        });

        it.each([
            ['no topics', { topics: [] }],
            ['topics not reported', { topics: undefined }],
            ['another topic only', { topics: ['ever-works'] }],
        ])('(c) refuses a repository with %s', async (_label, overrides) => {
            const double = facade({
                repositories: {
                    'cal-diy-template': blueprintRepository('cal-diy-template', overrides),
                    'calcom-cal-diy-template': blueprintRepository(
                        'calcom-cal-diy-template',
                        overrides,
                    ),
                },
                files: { 'cal-diy-template': blueprintYaml({ id: 'cal-diy' }) },
            });

            const result = await resolverFor(double).resolve({ owner: 'calcom', repo: 'cal.diy' });

            expect(result).toEqual({ status: 'none', reason: 'notListed' });
            expect(double.getFileContent).not.toHaveBeenCalled();
        });

        it('(d) reads ONLY .works/works.yml — a root app-spec.yml is not a Blueprint', async () => {
            // Today's three live repositories keep their spec at `app-spec.yml` behind
            // `.works/template.yml`'s `specPath`; the normative contract (FR-43, CONTRACTS §8,
            // catalog.md §5) is `.works/works.yml`, and the owner decided to fix the
            // repositories rather than the contract.
            const double = facade({
                repositories: { 'cal-diy-template': blueprintRepository('cal-diy-template') },
            });
            double.getFileContent.mockImplementation(
                async (_owner: string, _name: string, path: string) =>
                    path === 'app-spec.yml'
                        ? { content: blueprintYaml({ id: 'cal-diy' }), encoding: 'utf-8' }
                        : null,
            );

            const result = await resolverFor(double).resolve({ owner: 'calcom', repo: 'cal.diy' });

            expect(result).toEqual({ status: 'none', reason: 'notListed' });
            expect(double.getFileContent.mock.calls.map((call) => call[2])).toEqual([
                '.works/works.yml',
            ]);
        });

        it.each([
            ['a root kind other than app', blueprintYaml({ id: 'cal-diy', kind: 'directory' })],
            ['a validator error', blueprintYaml({ id: 'cal-diy', version: 'one' })],
            [
                'blueprint.repo naming another repository',
                blueprintYaml({ id: 'cal-diy', repo: 'ever-works/umami-template' }),
            ],
            [
                'a declared licence the registry classifies red',
                blueprintYaml({ id: 'cal-diy', spdx: 'PolyForm-Noncommercial-1.0.0' }),
            ],
            ['text that is not YAML at all', ':\n  - ]['],
            ['a directory document', 'version: 2\nkind: directory\nspec: {}\n'],
        ])('(e) refuses %s', async (_label, text) => {
            const double = facade({
                repositories: { 'cal-diy-template': blueprintRepository('cal-diy-template') },
                files: { 'cal-diy-template': text },
            });

            const result = await resolverFor(double).resolve({ owner: 'calcom', repo: 'cal.diy' });

            expect(result).toEqual({ status: 'none', reason: 'notListed' });
            // ONE file read after the repository that carried the topic — never a second.
            expect(double.getFileContent).toHaveBeenCalledTimes(1);
        });

        it('accepts a Blueprint that declares no licence (the class is the adapter’s business)', async () => {
            const double = facade({
                repositories: { 'cal-diy-template': blueprintRepository('cal-diy-template') },
                files: { 'cal-diy-template': blueprintYaml({ id: 'cal-diy', spdx: null }) },
            });

            const result = await resolverFor(double).resolve({ owner: 'calcom', repo: 'cal.diy' });

            expect(result).toMatchObject({ status: 'hit', id: 'cal-diy' });
            expect(result).not.toHaveProperty('spdx');
        });

        it('(f) refuses a repository that resolved OUT of the ever-works org (rename or transfer)', async () => {
            const moved = blueprintRepository('x-template', {
                owner: 'evil',
                fullName: 'evil/x-template',
                movedFrom: 'ever-works/cal-diy-template',
            });
            const double = facade({
                repositories: { 'cal-diy-template': moved, 'calcom-cal-diy-template': moved },
                files: {
                    'cal-diy-template': blueprintYaml({
                        id: 'cal-diy',
                        repo: 'ever-works/x-template',
                    }),
                },
            });

            const result = await resolverFor(double).resolve({ owner: 'calcom', repo: 'cal.diy' });

            expect(result).toEqual({ status: 'none', reason: 'notListed' });
            expect(double.getFileContent).not.toHaveBeenCalled();
        });

        it.each([
            ['isPrivate', { isPrivate: true, visibility: 'private' }],
            ['internal (GitHub Enterprise)', { isPrivate: false, visibility: 'internal' }],
        ])(
            'refuses a %s repository — catalog.md §5 requires a public Blueprint',
            async (_label, overrides) => {
                const double = facade({
                    repositories: {
                        'cal-diy-template': blueprintRepository('cal-diy-template', overrides),
                    },
                    files: { 'cal-diy-template': blueprintYaml({ id: 'cal-diy' }) },
                });

                const result = await resolverFor(double).resolve({
                    owner: 'calcom',
                    repo: 'cal.diy',
                });

                expect(result).toEqual({ status: 'none', reason: 'notListed' });
                expect(double.getFileContent).not.toHaveBeenCalled();
            },
        );
    });

    describe('the explicit path (FR-81)', () => {
        it('(g) reads only ever-works/<id>-template for a per-run repository and hits as explicit', async () => {
            const double = facade({
                repositories: {
                    'app-fixture-hello-template': blueprintRepository('app-fixture-hello-template'),
                },
                files: { 'app-fixture-hello-template': blueprintYaml() },
            });

            const result = await resolverFor(double).resolve({
                ...PER_RUN,
                blueprintId: 'app-fixture-hello',
            });

            expect(double.getRepository.mock.calls.map((call) => [call[0], call[1]])).toEqual([
                ['ever-works', 'app-fixture-hello-template'],
            ]);
            expect(double.getFileContent.mock.calls.map((call) => [call[0], call[1]])).toEqual([
                ['ever-works', 'app-fixture-hello-template'],
            ]);
            expect(result).toMatchObject({
                status: 'hit',
                source: 'explicit',
                id: 'app-fixture-hello',
                repo: 'ever-works/app-fixture-hello-template',
            });
        });

        it('answers blueprintNotFound for an id with no Blueprint repository', async () => {
            const double = facade();

            const result = await resolverFor(double).resolve({ ...PER_RUN, blueprintId: 'nope' });

            expect(result).toEqual({ status: 'none', reason: 'blueprintNotFound' });
            expect(double.getRepository).toHaveBeenCalledTimes(1);
        });

        it.each(['Bad_ID', '../x', 'a/b', '', '-leading', 'x'.repeat(65)])(
            'answers blueprintNotFound for the malformed id %j with zero reads',
            async (blueprintId) => {
                const double = facade();

                const result = await resolverFor(double).resolve({ ...PER_RUN, blueprintId });

                expect(result).toEqual({ status: 'none', reason: 'blueprintNotFound' });
                expect(double.reads()).toBe(0);
            },
        );

        it('answers blueprintNotFound when the file names a different Blueprint id', async () => {
            const double = facade({
                repositories: {
                    'app-fixture-hello-template': blueprintRepository('app-fixture-hello-template'),
                },
                files: {
                    'app-fixture-hello-template': blueprintYaml({
                        id: 'umami',
                        repo: 'ever-works/app-fixture-hello-template',
                    }),
                },
            });

            const result = await resolverFor(double).resolve({
                ...PER_RUN,
                blueprintId: 'app-fixture-hello',
            });

            expect(result).toEqual({ status: 'none', reason: 'blueprintNotFound' });
        });

        it('applies the same acceptance rules as the probe (topic, org, public, valid file)', async () => {
            const double = facade({
                repositories: {
                    'app-fixture-hello-template': blueprintRepository(
                        'app-fixture-hello-template',
                        {
                            topics: [],
                        },
                    ),
                },
                files: { 'app-fixture-hello-template': blueprintYaml() },
            });

            const result = await resolverFor(double).resolve({
                ...PER_RUN,
                blueprintId: 'app-fixture-hello',
            });

            expect(result).toEqual({ status: 'none', reason: 'blueprintNotFound' });
            expect(double.getFileContent).not.toHaveBeenCalled();
        });
    });

    describe('failures and the cache (FR-44)', () => {
        it('(h) answers lookupFailed on a provider error, caches it 10 minutes, then reads again', async () => {
            const double = facade({
                repositories: { 'cal-diy-template': new Error('GitHub 502') },
            });
            const resolver = resolverFor(double);

            await expect(resolver.resolve({ owner: 'calcom', repo: 'cal.diy' })).resolves.toEqual({
                status: 'none',
                reason: 'lookupFailed',
            });
            const afterFirst = double.reads();
            expect(afterFirst).toBe(1);

            now += BLUEPRINT_RESOLVE_MISS_TTL_MS - 1;
            await expect(resolver.resolve({ owner: 'calcom', repo: 'cal.diy' })).resolves.toEqual({
                status: 'none',
                reason: 'lookupFailed',
            });
            expect(double.reads()).toBe(afterFirst);

            now += 2;
            await resolver.resolve({ owner: 'calcom', repo: 'cal.diy' });
            expect(double.reads()).toBe(afterFirst * 2);
        });

        it('answers lookupFailed when the file read throws', async () => {
            const double = facade({
                repositories: { 'cal-diy-template': blueprintRepository('cal-diy-template') },
                files: { 'cal-diy-template': new Error('GitHub 500') },
            });

            await expect(
                resolverFor(double).resolve({ owner: 'calcom', repo: 'cal.diy' }),
            ).resolves.toEqual({ status: 'none', reason: 'lookupFailed' });
        });

        it('caches a miss for 10 minutes and a hit for one hour', async () => {
            const double = facade({
                repositories: { 'cal-diy-template': blueprintRepository('cal-diy-template') },
                files: { 'cal-diy-template': blueprintYaml({ id: 'cal-diy' }) },
            });
            const resolver = resolverFor(double);

            await resolver.resolve({ owner: 'calcom', repo: 'cal.diy' });
            expect(double.reads()).toBe(2);

            now += BLUEPRINT_RESOLVE_HIT_TTL_MS - 1;
            await expect(
                resolver.resolve({ owner: 'calcom', repo: 'cal.diy' }),
            ).resolves.toMatchObject({
                status: 'hit',
            });
            expect(double.reads()).toBe(2);

            now += 2;
            await resolver.resolve({ owner: 'calcom', repo: 'cal.diy' });
            expect(double.reads()).toBe(4);

            // A miss, on another repository.
            await resolver.resolve({ owner: 'nobody', repo: 'nothing' });
            expect(double.reads()).toBe(6);
            now += BLUEPRINT_RESOLVE_MISS_TTL_MS - 1;
            await resolver.resolve({ owner: 'nobody', repo: 'nothing' });
            expect(double.reads()).toBe(6);
            now += 2;
            await resolver.resolve({ owner: 'nobody', repo: 'nothing' });
            expect(double.reads()).toBe(8);
        });

        it('keys the cache on the canonical, lower-cased coordinates and the id', async () => {
            const double = facade();
            const resolver = resolverFor(double);

            await resolver.resolve({ owner: 'CalCom', repo: 'Cal.DIY' });
            await resolver.resolve({ owner: 'calcom', repo: 'cal.diy' });
            expect(double.reads()).toBe(2);

            // The same repository asked about an explicit id is a different question.
            await resolver.resolve({ owner: 'calcom', repo: 'cal.diy', blueprintId: 'cal-diy' });
            expect(double.reads()).toBe(3);
        });

        it(`holds at most ${APP_BLUEPRINT_RESOLVE_CACHE_MAX_ENTRIES} entries and evicts the oldest`, async () => {
            const double = facade();
            const resolver = resolverFor(double);

            for (let index = 0; index <= APP_BLUEPRINT_RESOLVE_CACHE_MAX_ENTRIES; index += 1) {
                await resolver.resolve({ owner: 'owner', repo: `repo-${index}` });
            }
            const filled = double.reads();

            // The newest is still cached; the very first was evicted by the 501st.
            await resolver.resolve({
                owner: 'owner',
                repo: `repo-${APP_BLUEPRINT_RESOLVE_CACHE_MAX_ENTRIES}`,
            });
            expect(double.reads()).toBe(filled);
            await resolver.resolve({ owner: 'owner', repo: 'repo-0' });
            expect(double.reads()).toBeGreaterThan(filled);
        });
    });

    describe('the platform credential', () => {
        it('(i) rejects with AppsCatalogCredentialUnavailableError when no credential resolves, and does not cache it', async () => {
            const double = facade({ installationToken: null });
            const resolver = resolverFor(double);

            await expect(
                resolver.resolve({ owner: 'calcom', repo: 'cal.diy' }),
            ).rejects.toBeInstanceOf(AppsCatalogCredentialUnavailableError);
            expect(double.reads()).toBe(0);

            process.env.EVER_WORKS_APPS_CATALOG_TOKEN = 'catalog-token';
            await expect(resolver.resolve({ owner: 'calcom', repo: 'cal.diy' })).resolves.toEqual({
                status: 'none',
                reason: 'notListed',
            });
            expect(double.getRepository).toHaveBeenCalledWith('ever-works', 'cal-diy-template', {
                token: 'catalog-token',
                providerId: 'github',
            });
        });

        it('prefers the installation token, then EVER_WORKS_APPS_CATALOG_TOKEN, then GITHUB_TOKEN', async () => {
            process.env.EVER_WORKS_APPS_CATALOG_TOKEN = 'catalog-token';
            process.env.GITHUB_TOKEN = 'github-token';

            const withInstallation = facade();
            await resolverFor(withInstallation).resolve({ owner: 'a', repo: 'b' });
            expect(withInstallation.getInstallationTokenForOwner).toHaveBeenCalledWith(
                'ever-works',
            );
            expect(withInstallation.getRepository.mock.calls[0][2]).toEqual({
                token: 'installation-token',
                providerId: 'github',
            });

            const noInstallation = facade({ installationToken: null });
            await resolverFor(noInstallation).resolve({ owner: 'a', repo: 'b' });
            expect(noInstallation.getRepository.mock.calls[0][2].token).toBe('catalog-token');

            delete process.env.EVER_WORKS_APPS_CATALOG_TOKEN;
            const githubOnly = facade({ installationToken: null });
            await resolverFor(githubOnly).resolve({ owner: 'a', repo: 'b' });
            expect(githubOnly.getRepository.mock.calls[0][2].token).toBe('github-token');
        });

        it('treats an installation lookup that throws as "no installation"', async () => {
            process.env.GITHUB_TOKEN = 'github-token';
            const double = facade();
            double.getInstallationTokenForOwner.mockRejectedValue(new Error('db down'));

            await resolverFor(double).resolve({ owner: 'a', repo: 'b' });

            expect(double.getRepository.mock.calls[0][2].token).toBe('github-token');
        });

        it('rejects with the credential error when the git facade is not in the graph', async () => {
            process.env.GITHUB_TOKEN = 'github-token';

            await expect(
                resolverFor(undefined).resolve({ owner: 'calcom', repo: 'cal.diy' }),
            ).rejects.toBeInstanceOf(AppsCatalogCredentialUnavailableError);
        });
    });

    describe('SSRF containment (plan §2.4)', () => {
        it('(j) reads only ever-works/<[a-z0-9-]+> and only the Blueprint file, whatever it is asked', async () => {
            const double = facade({
                repositories: new Proxy(
                    {},
                    {
                        get: (_target, name) =>
                            typeof name === 'string' ? blueprintRepository(name) : undefined,
                    },
                ),
            });
            const resolver = resolverFor(double);

            for (const input of [
                { owner: '../../etc', repo: 'passwd' },
                { owner: 'evil.example.com', repo: 'x?y=z#w' },
                { owner: 'UPPER', repo: 'Case_Repo' },
                { owner: 'a', repo: 'https://169.254.169.254/latest' },
                { owner: '   ', repo: '...' },
                { owner: 'calcom', repo: 'cal.diy', blueprintId: 'app-fixture-hello' },
                { owner: 'calcom', repo: 'cal.diy', blueprintId: '../../x' },
            ]) {
                await resolver.resolve(input);
            }

            expect(double.getRepository).toHaveBeenCalled();
            for (const [owner, name] of double.getRepository.mock.calls) {
                expect(owner).toBe('ever-works');
                expect(name).toMatch(/^[a-z0-9-]+$/);
            }
            for (const [owner, name, path] of double.getFileContent.mock.calls) {
                expect(owner).toBe('ever-works');
                expect(name).toMatch(/^[a-z0-9-]+$/);
                expect(path).toBe('.works/works.yml');
            }
        });

        it('slugifies both probe names and drops one that cannot be a repository name', () => {
            expect(probeCandidateNames('calcom', 'cal.diy')).toEqual([
                'cal-diy-template',
                'calcom-cal-diy-template',
            ]);
            expect(probeCandidateNames('UPPER', 'Case_Repo')).toEqual([
                'case-repo-template',
                'upper-case-repo-template',
            ]);
            expect(probeCandidateNames('   ', '...')).toEqual([]);
            expect(probeCandidateNames('', 'widgets')).toEqual(['widgets-template']);
        });
    });

    describe('prompts (FR-55)', () => {
        it('(k) maps prompt descriptors only — never an example, a value or a generator', async () => {
            const env = [
                '  env:',
                '    - name: MARKER',
                '      prompt:',
                "        description: 'Any text'",
                '        example: hello-world',
                '    - name: OPTIONAL_NOTE',
                '      prompt:',
                "        description: 'A note'",
                '        required: false',
                '    - name: SESSION_SECRET',
                '      secret: true',
                '      generate: { kind: chars, length: 32, rotate: never }',
                "    - { name: BUILD_LABEL, phase: build, value: 'label' }",
            ].join('\n');
            const double = facade({
                repositories: { 'cal-diy-template': blueprintRepository('cal-diy-template') },
                files: { 'cal-diy-template': blueprintYaml({ id: 'cal-diy', env }) },
            });

            const result = await resolverFor(double).resolve({ owner: 'calcom', repo: 'cal.diy' });

            expect(result).toMatchObject({ status: 'hit' });
            expect((result as { prompts: unknown[] }).prompts).toEqual([
                { name: 'MARKER', description: 'Any text', required: true },
                { name: 'OPTIONAL_NOTE', description: 'A note', required: false },
            ]);
            expect(JSON.stringify(result)).not.toContain('hello-world');
            expect(JSON.stringify(result)).not.toContain('label');
        });

        it('falls back to the id for the name when the Blueprint declares no display name', async () => {
            const double = facade({
                repositories: { 'cal-diy-template': blueprintRepository('cal-diy-template') },
                files: { 'cal-diy-template': blueprintYaml({ id: 'cal-diy', displayName: null }) },
            });

            const result = await resolverFor(double).resolve({ owner: 'calcom', repo: 'cal.diy' });

            expect(result).toMatchObject({ status: 'hit', name: 'cal-diy' });
            expect(result).not.toHaveProperty('displayName');
        });
    });
});
