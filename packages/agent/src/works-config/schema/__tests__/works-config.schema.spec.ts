import * as yaml from 'yaml';
import {
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
            ['company', { kind: 'company', departments: [{ name: 'Engineering' }] }],
        ])('accepts a %s spec', (kind, spec) => {
            const result = validateWorksConfig({ version: 2, kind, spec });
            expect(result.errors).toEqual([]);
            expect(result.data?.spec).toMatchObject({ kind });
        });

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
