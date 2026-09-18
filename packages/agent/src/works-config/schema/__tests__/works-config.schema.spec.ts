import * as yaml from 'yaml';
import {
    REPO_CHECKS_MAX,
    REPO_CHECK_MAX_LENGTH,
    WORKS_CONFIG_SCHEMA_VERSION,
    validateWorksConfig,
    worksConfigSchema,
} from '../works-config.schema';

describe('worksConfigSchema', () => {
    describe('backwards compatibility with v1 files', () => {
        it('accepts a bare v1 document with no version, kind or spec', () => {
            const result = validateWorksConfig({
                name: 'Awesome Chairs',
                initial_prompt: 'A directory of ergonomic office chairs',
                website_repo: 'ever-works/awesome-chairs-website',
                schedule_cadence: 'weekly',
            });

            expect(result.errors).toEqual([]);
            expect(result.warnings).toEqual([]);
            expect(result.data?.name).toBe('Awesome Chairs');
        });

        it('accepts an empty document', () => {
            const result = validateWorksConfig({});
            expect(result.errors).toEqual([]);
        });

        it('accepts both the snake_case and camelCase deploy-provider spellings', () => {
            expect(validateWorksConfig({ deploy_provider: 'vercel' }).errors).toEqual([]);
            expect(validateWorksConfig({ deployProvider: 'vercel' }).errors).toEqual([]);
        });
    });

    describe('root validation', () => {
        it.each([
            ['null', null],
            ['a string', 'name: x'],
            ['an array', [{ name: 'x' }]],
            ['undefined', undefined],
        ])('rejects %s at the root', (_label, input) => {
            const result = validateWorksConfig(input);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]).toMatch(/must contain a YAML object/);
            expect(result.data).toBeUndefined();
        });

        it('never throws, whatever it is handed', () => {
            for (const input of [Symbol('x'), 42, () => undefined, new Map()]) {
                expect(() => validateWorksConfig(input)).not.toThrow();
            }
        });
    });

    describe('unknown keys', () => {
        /**
         * The writer round-trips the parsed document back into the user's git
         * repository. A stripping schema would silently delete keys written by
         * a newer build — or by hand — so preservation is a correctness
         * requirement, not leniency.
         */
        it('preserves unknown root keys', () => {
            const result = validateWorksConfig({
                name: 'X',
                some_future_key: { nested: ['a', 'b'] },
            });

            expect(result.errors).toEqual([]);
            expect(result.data).toMatchObject({ some_future_key: { nested: ['a', 'b'] } });
        });

        it('preserves unknown keys nested inside a per-kind spec', () => {
            const result = validateWorksConfig({
                kind: 'website',
                spec: { kind: 'website', template: 'web', future_thing: 42 },
            });

            expect(result.errors).toEqual([]);
            expect(result.data?.spec).toMatchObject({ future_thing: 42 });
        });

        it('round-trips a document through YAML unchanged', () => {
            const source = [
                'version: 2',
                'kind: blog',
                'name: Engineering Blog',
                'hand_written_extra: keep me',
                'spec:',
                '  kind: blog',
                '  content_dir: content/posts',
                '  unknown_nested: 7',
                '  generation:',
                '    cadence: weekly',
                '    posts_per_run: 3',
            ].join('\n');

            const first = validateWorksConfig(yaml.parse(source));
            expect(first.errors).toEqual([]);

            const second = validateWorksConfig(yaml.parse(yaml.stringify(first.data)));
            expect(second.errors).toEqual([]);
            expect(second.data).toEqual(first.data);
            expect(second.data).toMatchObject({
                hand_written_extra: 'keep me',
                spec: { unknown_nested: 7 },
            });
        });
    });

    describe('version handling', () => {
        it('is silent about the current version', () => {
            const result = validateWorksConfig({ version: WORKS_CONFIG_SCHEMA_VERSION });
            expect(result.warnings).toEqual([]);
            expect(result.errors).toEqual([]);
        });

        /**
         * Refusing to read a file written by a newer server would strand the
         * user's own repository, so a future version warns and parses.
         */
        it('warns but still parses a newer version', () => {
            const result = validateWorksConfig({
                version: WORKS_CONFIG_SCHEMA_VERSION + 5,
                name: 'From the future',
            });

            expect(result.errors).toEqual([]);
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0]).toMatch(/parsing leniently/i);
            expect(result.data?.name).toBe('From the future');
        });

        it('rejects a non-positive or non-integer version', () => {
            expect(validateWorksConfig({ version: 0 }).errors).not.toEqual([]);
            expect(validateWorksConfig({ version: 2.5 }).errors).not.toEqual([]);
        });
    });

    describe('per-kind spec', () => {
        it.each([
            ['website', { kind: 'website', template: 'web', pages: [{ path: '/pricing' }] }],
            ['landing-page', { kind: 'landing-page', hero: { headline: 'Ship faster' } }],
            ['blog', { kind: 'blog', generation: { cadence: 'daily', posts_per_run: 2 } }],
            [
                'directory',
                { kind: 'directory', submissions: { enabled: true, moderation: 'manual' } },
            ],
            ['awesome-repo', { kind: 'awesome-repo', source: { repo: 'o/r', branch: 'main' } }],
            [
                'repo',
                {
                    kind: 'repo',
                    source: { repo: 'ever-works/ever-works', branch: 'develop' },
                    tasks: { base_branch: 'develop', checks: ['pnpm lint', 'pnpm test'] },
                },
            ],
            ['company', { kind: 'company', departments: [{ name: 'Engineering' }] }],
        ])('accepts a %s spec', (kind, spec) => {
            const result = validateWorksConfig({ version: 2, kind, spec });
            expect(result.errors).toEqual([]);
            expect(result.data?.spec).toMatchObject({ kind });
        });

        /**
         * `spec.tasks.checks` on a Repository Work is authored by anyone who
         * can land a commit in the wrapped repository — a trust boundary, not
         * a setting. Nothing consumes it yet; the bounds are pinned so that
         * whatever does inherits a cap on what a repository can push at it.
         */
        it('bounds a repo spec’s tasks.checks (count and length) — repository contents are untrusted', () => {
            const okChecks = Array.from({ length: REPO_CHECKS_MAX }, (_, i) => `pnpm check-${i}`);
            expect(
                validateWorksConfig({
                    version: 2,
                    kind: 'repo',
                    spec: { kind: 'repo', tasks: { checks: okChecks } },
                }).errors,
            ).toEqual([]);

            const tooMany = validateWorksConfig({
                version: 2,
                kind: 'repo',
                spec: { kind: 'repo', tasks: { checks: [...okChecks, 'one more'] } },
            });
            expect(tooMany.errors).not.toEqual([]);

            const tooLong = validateWorksConfig({
                version: 2,
                kind: 'repo',
                spec: { kind: 'repo', tasks: { checks: ['x'.repeat(REPO_CHECK_MAX_LENGTH + 1)] } },
            });
            expect(tooLong.errors).not.toEqual([]);
        });

        /**
         * Security regression — prototype-chain kinds. `KIND_SPEC_SCHEMAS`
         * is an object literal, so a bare index with `kind: constructor` /
         * `__proto__` / `toString` resolved to a truthy non-schema value and
         * `.safeParse` THREW — breaking the never-throws contract with an
         * attacker-suppliable input, and (on the write path) permanently
         * locking a Work whose committed file carried such a kind, because
         * the throw happens at read, before any rewrite can repair it.
         */
        it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
            'treats the prototype-chain kind %s as unknown instead of throwing',
            (kind) => {
                let result: ReturnType<typeof validateWorksConfig> | undefined;
                expect(() => {
                    result = validateWorksConfig({ version: 2, kind, spec: { kind } });
                }).not.toThrow();

                expect(result?.errors).toEqual([]);
                // Preserved as data, warned as unrecognised — same handling
                // as any other unknown kind.
                expect(result?.data?.spec).toMatchObject({ kind });
                expect(result?.warnings.join(' ')).toMatch(/does not recognise/i);
            },
        );

        /**
         * A newer server may ship a kind this build has never heard of. The
         * writer round-trips whatever it parsed, so rejecting here would
         * corrupt that user's file on the next write.
         */
        it('accepts and preserves a spec for an unrecognised kind', () => {
            const result = validateWorksConfig({
                version: 2,
                kind: 'storefront',
                spec: { kind: 'storefront', catalog: { currency: 'USD' } },
            });

            expect(result.errors).toEqual([]);
            expect(result.data?.spec).toMatchObject({
                kind: 'storefront',
                catalog: { currency: 'USD' },
            });
        });

        it('rejects a spec whose typed field has the wrong type', () => {
            const result = validateWorksConfig({
                kind: 'blog',
                spec: { kind: 'blog', generation: { posts_per_run: 'three' } },
            });
            expect(result.errors.join(' ')).toMatch(/posts_per_run/);
        });

        it('rejects an out-of-range enum', () => {
            const result = validateWorksConfig({
                kind: 'blog',
                spec: { kind: 'blog', generation: { cadence: 'fortnightly' } },
            });
            expect(result.errors).not.toEqual([]);
        });
    });

    describe('field constraints', () => {
        it('rejects an over-long initial_prompt', () => {
            const result = validateWorksConfig({ initial_prompt: 'x'.repeat(8001) });
            expect(result.errors.join(' ')).toMatch(/initial_prompt/);
        });

        it('accepts an initial_prompt at the limit', () => {
            expect(validateWorksConfig({ initial_prompt: 'x'.repeat(8000) }).errors).toEqual([]);
        });

        it('rejects an over-long kind', () => {
            expect(validateWorksConfig({ kind: 'k'.repeat(33) }).errors).not.toEqual([]);
        });

        it('rejects an unknown schedule cadence', () => {
            expect(validateWorksConfig({ schedule_cadence: 'fortnightly' }).errors).not.toEqual([]);
        });
    });

    it('exposes a parseable schema object for JSON Schema emission', () => {
        expect(worksConfigSchema).toBeDefined();
        expect(worksConfigSchema.safeParse({}).success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// APW-03 T7 — `kind: app` goes through the App spec validator
// ---------------------------------------------------------------------------

/**
 * A minimal App spec the App validator accepts: §24.2's shape, trimmed to one
 * component. `build.strategy` is present because R2 requires it with components
 * (§9:170), and `source` because §4:99 requires it in `data-repository` mode.
 */
const APP_DOCUMENT = {
    version: 2,
    kind: 'app',
    spec: {
        kind: 'app',
        appSpecVersion: 1,
        source: {
            relation: 'fork',
            upstream: { repo: 'example-org/analytics', defaultBranch: 'main' },
            branch: 'main',
        },
        build: { strategy: 'dockerfile' },
        components: [{ name: 'web', role: 'web', port: 3000 }],
        'x-author-note': 'preserved and never validated (§2:74-75)',
    },
} as const;

/** The `path` half of one `formatIssues`-shaped string. */
function pathOf(issue: string): string {
    return issue.slice(0, issue.indexOf(': '));
}

describe('kind: app — routed through the App spec validator (APW-03 T7, ACC-03-06)', () => {
    it('accepts a document the App validator accepts, x- keys and all', () => {
        const result = validateWorksConfig(APP_DOCUMENT);

        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.data?.spec).toMatchObject({
            kind: 'app',
            'x-author-note': 'preserved and never validated (§2:74-75)',
        });
    });

    /**
     * The App validator's §23 issue objects reach the Work-configuration view in
     * the same `path: message` shape `formatIssues` produces for every other
     * kind — one string per issue, errors in `errors`.
     */
    it('maps an App issue into that string shape, as an error', () => {
        const result = validateWorksConfig({
            ...APP_DOCUMENT,
            spec: {
                ...APP_DOCUMENT.spec,
                components: [{ name: 'web', role: 'web', port: 3000, replica: 2 }],
            },
        });

        expect(result.errors).toHaveLength(1);
        expect(pathOf(result.errors[0])).toBe('spec.components[0].replica');
        expect(result.errors[0]).toContain('Unknown field `replica`');
        expect(result.warnings).toEqual([]);
        expect(result.data).toBeUndefined();
    });

    /**
     * §2:76-77 — a newer `appSpecVersion` turns `unknown_field` into the warning
     * `unknown_field_newer_version`. Warnings must not become errors on the way
     * through this function, and the document stays usable.
     */
    it('maps App warnings into `warnings` and still returns the document', () => {
        const result = validateWorksConfig({
            ...APP_DOCUMENT,
            spec: { ...APP_DOCUMENT.spec, appSpecVersion: 2, futureKey: 1 },
        });

        expect(result.errors).toEqual([]);
        expect(result.warnings.map(pathOf)).toEqual(['spec.futureKey']);
        expect(result.warnings[0]).toMatch(/newer|Unknown field/i);
        expect(result.data?.spec).toMatchObject({ futureKey: 1 });
    });

    it('keeps errors and warnings apart within one document', () => {
        // A `web` component with no `port` is R1's error; a key beyond this
        // build's spec version is §2:76-77's warning. Both are in one response.
        const result = validateWorksConfig({
            version: 2,
            kind: 'app',
            spec: {
                kind: 'app',
                appSpecVersion: 2,
                source: APP_DOCUMENT.spec.source,
                build: { strategy: 'dockerfile' },
                components: [{ name: 'web', role: 'web' }],
                futureKey: 1,
            },
        });

        expect(result.errors.map(pathOf)).toEqual(['spec.components[0].port']);
        expect(result.warnings.map(pathOf)).toEqual(['spec.futureKey']);
        expect(result.data).toBeUndefined();
    });

    it('compares the root kind with `spec.kind` the App way (§1:64)', () => {
        const result = validateWorksConfig({
            version: 2,
            kind: 'website',
            spec: { ...APP_DOCUMENT.spec },
        });
        expect(result.errors.map(pathOf)).toEqual(['spec.kind']);
        expect(result.errors[0]).toContain('`website`');
        expect(result.errors[0]).toContain('`app`');
    });

    it('runs in `data-repository` mode, where `source` is required (§3:87, §4:99)', () => {
        const result = validateWorksConfig({
            version: 2,
            kind: 'app',
            spec: { kind: 'app', build: { strategy: 'none' } },
        });

        expect(result.errors.map(pathOf)).toEqual(['spec.source']);
    });

    it('never throws, whatever shape the App spec is', () => {
        for (const spec of [
            { kind: 'app' },
            { kind: 'app', components: 'nope' },
            { kind: 'app', env: [null] },
            { kind: 'app', build: { strategy: 'teleport' } },
        ]) {
            let result: ReturnType<typeof validateWorksConfig> | undefined;
            expect(() => {
                result = validateWorksConfig({ version: 2, kind: 'app', spec });
            }).not.toThrow();
            expect(result?.errors.length).toBeGreaterThan(0);
        }
    });

    /**
     * The other kinds are deliberately left exactly as they were: still the zod
     * dispatch, still `spec.`-prefixed zod paths. (The App branch is one added
     * `if`; nothing else in the function changed.)
     */
    it('leaves every other kind on the zod path it used before', () => {
        const blog = validateWorksConfig({
            kind: 'blog',
            spec: { kind: 'blog', generation: { posts_per_run: 'three' } },
        });
        expect(pathOf(blog.errors[0])).toBe('spec.generation.posts_per_run');

        const appShapedButWebsite = validateWorksConfig({
            kind: 'website',
            spec: { kind: 'website', template: 'web', future_thing: 42 },
        });
        expect(appShapedButWebsite.errors).toEqual([]);
        expect(appShapedButWebsite.data?.spec).toMatchObject({ future_thing: 42 });
    });
});
