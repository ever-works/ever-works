import type { AppSpec, AppSpecEnvEntry } from '@ever-works/contracts';
import {
    APP_SPEC_REFERENCE_MAX_DEPTH,
    APP_SPEC_ISSUE_ROOT,
    analyzeReferences,
    buildReferenceTables,
    dependencyOutputSecret,
    findTemplateCycles,
    resolveReference,
    templateResolutionDepth,
    tokenizeReference,
    tokenizeTemplate,
    type AppSpecReference,
} from '../app-spec.refs';
import { appSpecSchema } from '../app-spec.schema';

/**
 * T4 — the §21 reference grammar, its resolution, and the secrecy / phase
 * propagation over `template` edges (`tasks.md:138-145`).
 *
 * The evidence this file owes:
 *
 * 1. **Every row of `schema.md` §21's table** (`:434-443`) — the construct, when
 *    it resolves and what it reports otherwise. {@link SECTION_21_ROWS} names
 *    the rows and a completeness case fails if one of them loses its fixtures.
 * 2. `bucket.<name>` — declared, undeclared, and the kind that has no buckets.
 * 3. A three-entry `template` cycle naming all three.
 * 4. Depth 11 refused, depth 10 accepted (`APP_SPEC_REFERENCE_MAX_DEPTH`).
 * 5. `build.commitSha` under `auto` (accepted) and under `image` (refused).
 *
 * The fixtures are plain `AppSpec` objects rather than YAML: §21 is a property of
 * the parsed document, and the positioned, YAML-sourced half of the pipeline is
 * T6's (`app-spec.validate.spec.ts`). One fixture per §24 example is parsed
 * through `appSpecSchema` so the refs layer is exercised on a document the real
 * pipeline would hand it.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A whole `AppSpec` from the blocks a case cares about. */
function documentWith(partial: AppSpec): AppSpec {
    return { kind: 'app', ...partial };
}

/** One env entry. */
function env(partial: AppSpecEnvEntry): AppSpecEnvEntry {
    return partial;
}

/** The Cal.diy shape (§24.1): a web component, Postgres with `directUrl`, SMTP. */
const CALDIY: AppSpec = documentWith({
    source: { relation: 'fork', upstream: { repo: 'calcom/cal.diy', defaultBranch: 'main' } },
    build: { strategy: 'dockerfile', dockerfile: 'Dockerfile' },
    components: [{ name: 'web', role: 'web', port: 3000 }],
    dependencies: { postgres: { version: '16', directUrl: true }, smtp: { required: true } },
    env: [
        env({ name: 'DATABASE_URL', secret: true, from: 'deps.postgres.url' }),
        env({ name: 'PUBLIC_URL', from: 'domains.primary.url' }),
        env({ name: 'NEXTAUTH_URL', template: '{{domains.primary.url}}/api/auth' }),
        env({ name: 'MAIL_HOST', from: 'deps.smtp.host' }),
    ],
});

/** The analytics shape (§24.2): a prebuilt image, so no Build produces a commit. */
const IMAGE_ONLY: AppSpec = documentWith({
    build: {
        strategy: 'image',
        image: 'ghcr.io/example-org/analytics@sha256:9f2c1e0b7a4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a49',
    },
    components: [{ name: 'web', role: 'web', port: 3000 }],
    dependencies: { postgres: { version: '16' } },
});

/** The help-desk shape (§24.3): web + worker, Redis, one object-storage bucket. */
const HELPDESK: AppSpec = documentWith({
    build: { strategy: 'dockerfile' },
    components: [
        { name: 'web', role: 'web', port: 8080 },
        { name: 'worker', role: 'worker' },
    ],
    dependencies: {
        postgres: { version: '16' },
        redis: { version: '7' },
        objectStorage: { buckets: ['attachments'] },
    },
});

/** The problem codes a document produces, as `code@pointer` strings. */
function problems(spec: AppSpec): readonly string[] {
    return analyzeReferences(spec).problems.map((problem) => `${problem.code}@${problem.pointer}`);
}

/** The params of the first problem carrying `code`. */
function problemFor(spec: AppSpec, code: string): Record<string, unknown> | undefined {
    return analyzeReferences(spec).problems.find((problem) => problem.code === code)?.params as
        | Record<string, unknown>
        | undefined;
}

// ---------------------------------------------------------------------------
// §21's table, row by row
// ---------------------------------------------------------------------------

/**
 * The rows of §21's `Resolves when / Otherwise` table (`schema.md:434-443`).
 * Every row must be covered below — by a {@link ReferenceCase} or by a case in
 * {@link ROWS_COVERED_ELSEWHERE} — and the completeness case at the end of this
 * describe fails when one is dropped.
 */
const SECTION_21_ROWS = [
    'domains.primary.*',
    'deps.<kind>.<out>',
    'deps.bucket.<name>',
    'platform.smtp.*',
    'build.commitSha',
    'components.<n>.internalUrl',
    'env.<NAME>',
    'fromEnv',
    'placeholder',
] as const;

/**
 * The three rows whose fixtures cannot be a bare `resolveReference` call: an
 * `env.<NAME>` reference is only legal inside a `template` (§21:429-430), and
 * `fromEnv` and the placeholder row are properties of a whole entry rather than
 * of one tokenized reference. They are exercised by the `env references and
 * fromEnv`, `template cycles` and `reference syntax` describes below.
 */
const ROWS_COVERED_ELSEWHERE = ['env.<NAME>', 'fromEnv', 'placeholder'] as const;

/** One §21 case: the document, the reference text, and what §21 says. */
interface ReferenceCase {
    readonly row: (typeof SECTION_21_ROWS)[number];
    readonly name: string;
    readonly spec: AppSpec;
    readonly reference: string;
    readonly resolves: boolean;
    readonly secret?: boolean;
    readonly needs?: string;
}

const REFERENCE_CASES: readonly ReferenceCase[] = [
    {
        row: 'domains.primary.*',
        name: 'domains.primary.url resolves with a web component',
        spec: CALDIY,
        reference: 'domains.primary.url',
        resolves: true,
        secret: false,
    },
    {
        row: 'domains.primary.*',
        name: 'domains.primary.host resolves with a web component',
        spec: CALDIY,
        reference: 'domains.primary.host',
        resolves: true,
        secret: false,
    },
    {
        row: 'domains.primary.*',
        name: 'domains.primary.url is reference_unresolved with no web component',
        spec: documentWith({ components: [{ name: 'worker', role: 'worker' }] }),
        reference: 'domains.primary.url',
        resolves: false,
    },
    {
        row: 'deps.<kind>.<out>',
        name: 'deps.postgres.host resolves when postgres is declared',
        spec: CALDIY,
        reference: 'deps.postgres.host',
        resolves: true,
        secret: false,
    },
    {
        row: 'deps.<kind>.<out>',
        name: 'deps.postgres.url is a † output',
        spec: CALDIY,
        reference: 'deps.postgres.url',
        resolves: true,
        secret: true,
    },
    {
        row: 'deps.<kind>.<out>',
        name: 'deps.postgres.directUrl resolves only with directUrl: true',
        spec: CALDIY,
        reference: 'deps.postgres.directUrl',
        resolves: true,
        secret: true,
    },
    {
        row: 'deps.<kind>.<out>',
        name: 'deps.postgres.directUrl is unresolved without directUrl: true',
        spec: IMAGE_ONLY,
        reference: 'deps.postgres.directUrl',
        resolves: false,
        secret: true,
        needs: 'dependencies.postgres.directUrl: true',
    },
    {
        row: 'deps.<kind>.<out>',
        name: 'deps.postgres.url is unresolved when the block is absent',
        spec: documentWith({ components: [{ name: 'web', role: 'web', port: 3000 }] }),
        reference: 'deps.postgres.url',
        resolves: false,
        needs: 'dependencies.postgres',
    },
    {
        row: 'deps.<kind>.<out>',
        name: 'deps.redis.url resolves when redis is declared',
        spec: HELPDESK,
        reference: 'deps.redis.url',
        resolves: true,
        secret: true,
    },
    {
        row: 'deps.<kind>.<out>',
        name: 'deps.redis.url is unresolved when only postgres is declared',
        spec: documentWith({ dependencies: { postgres: { version: '16' } } }),
        reference: 'deps.redis.url',
        resolves: false,
        needs: 'dependencies.redis',
    },
    {
        row: 'deps.<kind>.<out>',
        name: 'deps.objectStorage.endpoint resolves when the block is declared',
        spec: HELPDESK,
        reference: 'deps.objectStorage.endpoint',
        resolves: true,
        secret: false,
    },
    {
        row: 'deps.<kind>.<out>',
        name: 'deps.objectStorage.accessKeyId is a † output',
        spec: HELPDESK,
        reference: 'deps.objectStorage.accessKeyId',
        resolves: true,
        secret: true,
    },
    {
        row: 'deps.<kind>.<out>',
        name: 'an output the kind does not publish is unresolved, not a syntax error',
        spec: HELPDESK,
        reference: 'deps.redis.uri',
        resolves: false,
        needs: 'dependencies.redis',
    },
    {
        row: 'deps.bucket.<name>',
        name: 'deps.objectStorage.bucket.attachments resolves for a declared bucket',
        spec: HELPDESK,
        reference: 'deps.objectStorage.bucket.attachments',
        resolves: true,
        secret: false,
    },
    {
        row: 'deps.bucket.<name>',
        name: 'deps.objectStorage.bucket.media is unresolved for an undeclared bucket',
        spec: HELPDESK,
        reference: 'deps.objectStorage.bucket.media',
        resolves: false,
        needs: 'dependencies.objectStorage.buckets',
    },
    {
        row: 'deps.bucket.<name>',
        name: 'a bucket output of a kind that has no buckets is unresolved',
        spec: HELPDESK,
        reference: 'deps.redis.bucket.attachments',
        resolves: false,
    },
    {
        row: 'platform.smtp.*',
        name: 'platform.smtp.host resolves when smtp is declared',
        spec: CALDIY,
        reference: 'platform.smtp.host',
        resolves: true,
        secret: false,
    },
    {
        row: 'platform.smtp.*',
        name: 'platform.smtp.password is a † output',
        spec: CALDIY,
        reference: 'platform.smtp.password',
        resolves: true,
        secret: true,
    },
    {
        row: 'platform.smtp.*',
        name: 'platform.smtp.host is unresolved when smtp is not declared',
        spec: documentWith({ dependencies: { postgres: { version: '16' } } }),
        reference: 'platform.smtp.host',
        resolves: false,
        needs: 'dependencies.smtp',
    },
    {
        row: 'build.commitSha',
        name: 'build.commitSha resolves for dockerfile',
        spec: CALDIY,
        reference: 'build.commitSha',
        resolves: true,
        secret: false,
    },
    {
        row: 'build.commitSha',
        name: 'build.commitSha resolves for auto',
        spec: documentWith({ build: { strategy: 'auto' } }),
        reference: 'build.commitSha',
        resolves: true,
    },
    {
        row: 'build.commitSha',
        name: 'build.commitSha is refused for image',
        spec: IMAGE_ONLY,
        reference: 'build.commitSha',
        resolves: false,
        needs: 'build.strategy: dockerfile or auto',
    },
    {
        row: 'build.commitSha',
        name: 'build.commitSha is refused for none',
        spec: documentWith({ build: { strategy: 'none' } }),
        reference: 'build.commitSha',
        resolves: false,
    },
    {
        row: 'components.<n>.internalUrl',
        name: 'components.web.internalUrl resolves for a web component',
        spec: HELPDESK,
        reference: 'components.web.internalUrl',
        resolves: true,
        secret: false,
    },
    {
        row: 'components.<n>.internalUrl',
        name: 'components.worker.internalUrl is unresolved for a worker',
        spec: HELPDESK,
        reference: 'components.worker.internalUrl',
        resolves: false,
        needs: 'components.worker with role web',
    },
    {
        row: 'components.<n>.internalUrl',
        name: 'components.api.internalUrl is unresolved for an unknown component',
        spec: HELPDESK,
        reference: 'components.api.internalUrl',
        resolves: false,
    },
];

describe('schema.md §21 — the reference table, row by row', () => {
    it.each(REFERENCE_CASES)('$name', (testCase) => {
        const parse = tokenizeReference(testCase.reference);
        expect(parse.ok).toBe(true);
        const resolution = resolveReference(
            parse.reference as AppSpecReference,
            buildReferenceTables(testCase.spec),
        );
        expect(resolution.resolved).toBe(testCase.resolves);
        expect(resolution.reference).toBe(testCase.reference);
        if (testCase.secret !== undefined) expect(resolution.secret).toBe(testCase.secret);
        if (testCase.needs !== undefined) expect(resolution.needs).toBe(testCase.needs);
    });

    it('covers every row of §21’s table', () => {
        const covered = [
            ...new Set([
                ...REFERENCE_CASES.map((testCase) => testCase.row),
                ...ROWS_COVERED_ELSEWHERE,
            ]),
        ].sort();
        expect(covered).toEqual([...SECTION_21_ROWS].sort());
    });

    it('every §21 row has at least one refused and one accepted case', () => {
        for (const row of SECTION_21_ROWS) {
            const cases = REFERENCE_CASES.filter((testCase) => testCase.row === row);
            if ((ROWS_COVERED_ELSEWHERE as readonly string[]).includes(row)) continue;
            expect({
                row,
                accepted: cases.some((testCase) => testCase.resolves),
                refused: cases.some((testCase) => !testCase.resolves),
            }).toEqual({ row, accepted: true, refused: true });
        }
    });
});

// ---------------------------------------------------------------------------
// The grammar's edges — what is reference_syntax (§21:443)
// ---------------------------------------------------------------------------

describe('reference syntax', () => {
    it.each([
        ['env.FOO outside a template', 'env.FOO'],
        ['a template in a from:', '{{deps.postgres.url}}'],
        ['an unknown dependency kind', 'deps.mysql.url'],
        ['an unknown domain output', 'domains.primary.port'],
        ['a non-primary domain', 'domains.web.url'],
        ['an unknown platform output', 'platform.smtp.port_'],
        ['an unknown build output', 'build.sha'],
        ['a component reference without an output', 'components.web'],
        ['an unknown component output', 'components.web.url'],
        ['an uppercase bucket name', 'deps.objectStorage.bucket.Attachments'],
        ['an empty string', ''],
        ['a bare word', 'DATABASE_URL'],
        ['a path', 'deps/postgres/url'],
    ])('%s is reference_syntax', (_name, text) => {
        expect(tokenizeReference(text).ok).toBe(false);
    });

    it('a bucket without a name is grammatical but resolves to nothing', () => {
        // `Output := Identifier | "bucket." Name` (§21:427): `bucket` alone is a
        // well-formed identifier, and objectStorage publishes no such output —
        // so this is `reference_unresolved`, and the grammar never guesses.
        const spec = documentWith({
            dependencies: { objectStorage: { buckets: ['attachments'] } },
        });
        expect(tokenizeReference('deps.objectStorage.bucket').ok).toBe(true);
        expect(
            problems(
                documentWith({
                    ...spec,
                    env: [env({ name: 'B', from: 'deps.objectStorage.bucket' })],
                }),
            ),
        ).toEqual([`reference_unresolved@${APP_SPEC_ISSUE_ROOT}/env/0/from`]);
    });

    it.each([
        ['domains.primary.url', 'domain'],
        ['deps.postgres.url', 'dep'],
        ['platform.smtp.secure', 'platform'],
        ['build.commitSha', 'build'],
        ['components.web.internalUrl', 'component'],
    ])('%s tokenizes as a %s reference', (text, kind) => {
        const parse = tokenizeReference(text);
        expect(parse.ok).toBe(true);
        expect((parse.reference as AppSpecReference).kind).toBe(kind);
    });

    it('splits a template into literals and placeholders', () => {
        const parts = tokenizeTemplate('{{ domains.primary.url }}/api/{{env.TOKEN}}');
        expect(parts.map((part) => part.kind)).toEqual(['reference', 'literal', 'reference']);
        expect(parts[1]).toEqual({ kind: 'literal', text: '/api/' });
    });

    it('reads space around a placeholder name', () => {
        const parse = tokenizeTemplate('{{   env.JWT_SIGNING_KEY   }}');
        expect(parse[0].kind).toBe('reference');
        expect((parse[0] as { reference: AppSpecReference }).reference).toEqual({
            kind: 'env',
            entry: 'JWT_SIGNING_KEY',
            text: 'env.JWT_SIGNING_KEY',
        });
    });

    it('flags an unterminated placeholder as reference_syntax', () => {
        expect(problems(documentWith({ env: [env({ name: 'A', template: '{{env.B' })] }))).toEqual([
            `reference_syntax@${APP_SPEC_ISSUE_ROOT}/env/0/template`,
        ]);
    });

    it('a malformed from: never reports pattern, only reference_syntax', () => {
        const codes = analyzeReferences(
            documentWith({ env: [env({ name: 'A', from: 'deps.postgres' })] }),
        ).problems.map((problem) => problem.code);
        expect(codes).toEqual(['reference_syntax']);
        expect(codes).not.toContain('pattern');
    });
});

// ---------------------------------------------------------------------------
// env.<NAME> and fromEnv (§21:441-442)
// ---------------------------------------------------------------------------

describe('env references and fromEnv', () => {
    it('env.<NAME> resolves when the entry exists and is not the entry itself', () => {
        const spec = documentWith({
            env: [env({ name: 'A', value: '1' }), env({ name: 'B', template: 'prefix-{{env.A}}' })],
        });
        expect(problems(spec)).toEqual([]);
    });

    it('env.<NAME> is reference_unresolved when no entry has that name', () => {
        const spec = documentWith({ env: [env({ name: 'B', template: '{{env.A}}' })] });
        expect(problems(spec)).toEqual([
            `reference_unresolved@${APP_SPEC_ISSUE_ROOT}/env/0/template`,
        ]);
    });

    it('fromEnv resolves when the entry exists with phase build or both', () => {
        const spec = documentWith({
            build: { strategy: 'dockerfile', args: [{ name: 'KEY', fromEnv: 'MIXED' }] },
            env: [env({ name: 'MIXED', phase: 'both', value: 'x' })],
        });
        expect(problems(spec)).toEqual([]);
    });

    it('fromEnv is reference_unresolved when no entry has that name', () => {
        const spec = documentWith({
            build: { strategy: 'dockerfile', args: [{ name: 'KEY', fromEnv: 'MISSING' }] },
        });
        expect(problems(spec)).toEqual([
            `reference_unresolved@${APP_SPEC_ISSUE_ROOT}/build/args/0/fromEnv`,
        ]);
    });

    it('fromEnv is phase_mismatch when the entry is runtime-only', () => {
        const spec = documentWith({
            build: { strategy: 'dockerfile', args: [{ name: 'KEY', fromEnv: 'RUNTIME_ONLY' }] },
            env: [env({ name: 'RUNTIME_ONLY', value: 'x' })],
        });
        expect(problems(spec)).toEqual([
            `phase_mismatch@${APP_SPEC_ISSUE_ROOT}/build/args/0/fromEnv`,
        ]);
    });
});

// ---------------------------------------------------------------------------
// Secrecy and phase propagation (§21:445-449)
// ---------------------------------------------------------------------------

describe('secrecy propagation', () => {
    it('a from: naming a † output requires secret: true', () => {
        const spec = documentWith({
            dependencies: { postgres: { version: '16' } },
            env: [env({ name: 'DATABASE_URL', from: 'deps.postgres.url' })],
        });
        expect(problems(spec)).toEqual([
            `secret_reference_not_secret@${APP_SPEC_ISSUE_ROOT}/env/0/secret`,
        ]);
        expect(problemFor(spec, 'secret_reference_not_secret')?.reference).toBe(
            'deps.postgres.url',
        );
    });

    it('a bucket name is not a secret, so it needs no secret: true', () => {
        const spec = documentWith({
            dependencies: { objectStorage: { buckets: ['attachments'] } },
            env: [env({ name: 'BUCKET', from: 'deps.objectStorage.bucket.attachments' })],
        });
        expect(problems(spec)).toEqual([]);
    });

    it('a template reading a secret entry requires secret: true', () => {
        const spec = documentWith({
            env: [
                env({ name: 'JWT_SIGNING_KEY', secret: true, generate: { kind: 'uuid' } }),
                env({ name: 'COMBINED', template: 'v1.{{env.JWT_SIGNING_KEY}}' }),
            ],
        });
        expect(problems(spec)).toEqual([
            `secret_reference_not_secret@${APP_SPEC_ISSUE_ROOT}/env/1/secret`,
        ]);
    });

    it('secrecy propagates transitively', () => {
        const spec = documentWith({
            dependencies: { postgres: { version: '16' } },
            env: [
                env({ name: 'A', secret: true, from: 'deps.postgres.url' }),
                env({ name: 'B', secret: true, template: '{{env.A}}' }),
                env({ name: 'C', template: '{{env.B}}' }),
            ],
        });
        expect(problems(spec)).toEqual([
            `secret_reference_not_secret@${APP_SPEC_ISSUE_ROOT}/env/2/secret`,
        ]);
        const analysis = analyzeReferences(spec);
        expect(analysis.byName.get('C')?.secret).toBe(true);
    });

    it('reports one secret_reference_not_secret per entry, never one per placeholder', () => {
        const spec = documentWith({
            env: [
                env({ name: 'A', secret: true, generate: { kind: 'uuid' } }),
                env({ name: 'B', secret: true, generate: { kind: 'uuid' } }),
                env({ name: 'C', template: '{{env.A}}-{{env.B}}' }),
            ],
        });
        expect(problems(spec)).toEqual([
            `secret_reference_not_secret@${APP_SPEC_ISSUE_ROOT}/env/2/secret`,
        ]);
    });
});

describe('phase propagation', () => {
    it('a runtime entry cannot template a build-only entry', () => {
        const spec = documentWith({
            env: [
                env({ name: 'BUILT', phase: 'build', value: 'x' }),
                env({ name: 'RUNTIME', template: '{{env.BUILT}}' }),
            ],
        });
        expect(problems(spec)).toEqual([`phase_mismatch@${APP_SPEC_ISSUE_ROOT}/env/1/template`]);
    });

    it('a build entry cannot template a runtime-only entry', () => {
        const spec = documentWith({
            env: [
                env({ name: 'RUNTIME', value: 'x' }),
                env({ name: 'BUILT', phase: 'build', template: '{{env.RUNTIME}}' }),
            ],
        });
        expect(problems(spec)).toEqual([`phase_mismatch@${APP_SPEC_ISSUE_ROOT}/env/1/template`]);
    });

    it('a both entry cannot template a runtime-only entry', () => {
        const spec = documentWith({
            env: [
                env({ name: 'RUNTIME', value: 'x' }),
                env({ name: 'MIXED', phase: 'both', template: '{{env.RUNTIME}}' }),
            ],
        });
        expect(problems(spec)).toEqual([`phase_mismatch@${APP_SPEC_ISSUE_ROOT}/env/1/template`]);
    });

    it('both reads both without complaint', () => {
        const spec = documentWith({
            env: [
                env({ name: 'MIXED', phase: 'both', value: 'x' }),
                env({ name: 'BUILT', phase: 'build', template: '{{env.MIXED}}' }),
                env({ name: 'RUNTIME', template: '{{env.MIXED}}' }),
            ],
        });
        expect(problems(spec)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Cycles (§21:448) and depth (§21:449)
// ---------------------------------------------------------------------------

describe('template cycles', () => {
    /**
     * `EnvName` is `^[A-Z_][A-Z0-9_]{0,127}$` (§0), so a ring's names are
     * `A`, `B`, … — a lowercase `{{env.a}}` is `reference_syntax`, not a cycle.
     */
    function nameAt(index: number): string {
        const letter = String.fromCharCode('A'.charCodeAt(0) + (index % 26));
        return index < 26 ? letter : `${letter}${Math.floor(index / 26)}`;
    }

    /** A ring of `count` entries, each templating the next (§21:448). */
    function ring(count: number): AppSpec {
        const entries: AppSpecEnvEntry[] = [];
        for (let index = 0; index < count; index += 1) {
            entries.push(
                env({
                    name: nameAt(index),
                    template: `{{env.${nameAt((index + 1) % count)}}}`,
                }),
            );
        }
        return documentWith({ env: entries });
    }

    it('names all three entries of a three-entry cycle', () => {
        const spec = ring(3);
        const cycles = findTemplateCycles(spec);
        expect(cycles.length).toBe(1);
        expect(cycles[0]).toEqual(['A', 'B', 'C']);

        const reported = analyzeReferences(spec).problems.filter(
            (problem) => problem.code === 'template_cycle',
        );
        expect(reported.length).toBe(1);
        expect(reported[0].pointer).toBe(`${APP_SPEC_ISSUE_ROOT}/env/0/template`);
        expect(reported[0].params.entries).toBe('A, B, C');
        expect(reported[0].params.count).toBe(3);
        expect(reported[0].entries).toEqual(['A', 'B', 'C']);
        // A cycle is reported as a cycle, never also as an unresolved reference.
        expect(problems(spec)).toEqual([`template_cycle@${APP_SPEC_ISSUE_ROOT}/env/0/template`]);
    });

    it('reports a template reading its own entry as a one-entry cycle', () => {
        const spec = documentWith({ env: [env({ name: 'LOOP', template: '{{env.LOOP}}' })] });
        expect(findTemplateCycles(spec)).toEqual([['LOOP']]);
        expect(problems(spec)).toEqual([`template_cycle@${APP_SPEC_ISSUE_ROOT}/env/0/template`]);
    });

    it('finds two independent cycles', () => {
        const spec = documentWith({
            env: [
                env({ name: 'A', template: '{{env.B}}' }),
                env({ name: 'B', template: '{{env.A}}' }),
                env({ name: 'C', template: '{{env.D}}' }),
                env({ name: 'D', template: '{{env.C}}' }),
            ],
        });
        expect(findTemplateCycles(spec)).toEqual([
            ['A', 'B'],
            ['C', 'D'],
        ]);
    });

    it('does not call a diamond a cycle', () => {
        const spec = documentWith({
            env: [
                env({ name: 'D', value: 'x' }),
                env({ name: 'B', template: '{{env.D}}' }),
                env({ name: 'C', template: '{{env.D}}' }),
                env({ name: 'A', template: '{{env.B}}{{env.C}}' }),
            ],
        });
        expect(findTemplateCycles(spec)).toEqual([]);
        expect(problems(spec)).toEqual([]);
    });

    it('reports reference_unresolved, not template_cycle, when the target is absent', () => {
        const spec = documentWith({ env: [env({ name: 'LOOP', template: '{{env.OTHER}}' })] });
        expect(findTemplateCycles(spec)).toEqual([]);
        expect(problems(spec)).toEqual([
            `reference_unresolved@${APP_SPEC_ISSUE_ROOT}/env/0/template`,
        ]);
    });
});

describe('resolution depth (§21:449, ≤ 10)', () => {
    /** A chain `E0 → E1 → … → E{count-1}`, whose last entry reads nothing. */
    function chain(count: number): AppSpec {
        const entries: AppSpecEnvEntry[] = [];
        for (let index = 0; index < count; index += 1) {
            entries.push(
                index === count - 1
                    ? env({ name: `E${index}`, value: 'x' })
                    : env({ name: `E${index}`, template: `{{env.E${index + 1}}}` }),
            );
        }
        return documentWith({ env: entries });
    }

    it(`accepts a chain of exactly ${APP_SPEC_REFERENCE_MAX_DEPTH}`, () => {
        const spec = chain(APP_SPEC_REFERENCE_MAX_DEPTH);
        expect(templateResolutionDepth(spec)).toBe(APP_SPEC_REFERENCE_MAX_DEPTH);
        expect(problems(spec)).toEqual([]);
    });

    it(`refuses depth ${APP_SPEC_REFERENCE_MAX_DEPTH + 1}`, () => {
        const spec = chain(APP_SPEC_REFERENCE_MAX_DEPTH + 1);
        const reported = analyzeReferences(spec).problems;
        expect(templateResolutionDepth(spec)).toBe(APP_SPEC_REFERENCE_MAX_DEPTH + 1);
        expect(reported.length).toBe(1);
        expect(reported[0].code).toBe('template_too_deep');
        expect(reported[0].pointer).toBe(`${APP_SPEC_ISSUE_ROOT}/env/0/template`);
        expect(reported[0].params).toEqual({
            entry: 'E0',
            depth: APP_SPEC_REFERENCE_MAX_DEPTH + 1,
            max: APP_SPEC_REFERENCE_MAX_DEPTH,
        });
    });

    it('a cycle is never also reported as too deep', () => {
        const spec = documentWith({
            env: [
                env({ name: 'A', template: '{{env.B}}' }),
                env({ name: 'B', template: '{{env.A}}' }),
            ],
        });
        const codes = analyzeReferences(spec).problems.map((problem) => problem.code);
        expect(codes).toEqual(['template_cycle']);
    });
});

// ---------------------------------------------------------------------------
// The §24 examples, through the schema the pipeline would hand this module
// ---------------------------------------------------------------------------

describe('§24 examples resolve cleanly', () => {
    it.each([
        ['§24.1 Cal.diy', CALDIY],
        ['§24.2 prebuilt image', IMAGE_ONLY],
        ['§24.3 help-desk', HELPDESK],
    ])('%s', (_name, spec) => {
        const parsed = appSpecSchema.safeParse(spec);
        expect(parsed.success ? null : parsed.error.issues).toBeNull();
        expect(problems(parsed.success ? (parsed.data as AppSpec) : spec)).toEqual([]);
    });

    it('the §11 output table is APW-07’s, not a second copy', () => {
        expect(dependencyOutputSecret('postgres', 'url')).toBe(true);
        expect(dependencyOutputSecret('postgres', 'host')).toBe(false);
        expect(dependencyOutputSecret('objectStorage', 'bucket.attachments')).toBe(false);
        expect(dependencyOutputSecret('smtp', 'password')).toBe(true);
    });
});
