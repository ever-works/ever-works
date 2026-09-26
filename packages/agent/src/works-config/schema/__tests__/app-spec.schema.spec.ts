import { parse as parseYaml } from 'yaml';
import { z } from 'zod/v4';
import {
    APP_SPEC_MAX_PROTECTED_PATHS,
    APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS,
    APP_SPEC_VERSION,
    type AppSpec,
} from '@ever-works/contracts';
import { KIND_SPEC_SCHEMAS, validateWorksConfig } from '../works-config.schema';
import {
    APP_SPEC_BLUEPRINT_MODE_ALLOWED_KEYS,
    APP_SPEC_VALIDATION_MODES,
    APP_SPEC_VERSION_MAX,
    APP_SPEC_VERSION_MIN,
    appSpecSchema,
    stripExtensionKeys,
} from '../app-spec.schema';

/**
 * T3 — the structural App spec schema (`schema.md` §5–§20, plan §2.2:123-125).
 *
 * Two halves, both of them acceptance criteria rather than decoration:
 *
 * 1. **Runtime** — the three `schema.md` §24 examples parse (ACC-03-01); one
 *    failing case per bound and per enum in §5–§20; `x-` keys (ACC-03-02) and the
 *    three §12 key-pair examples plus `build.strategy: auto` (ACC-03-49).
 * 2. **Type level** — `z.input<typeof appSpecSchema>` and the T1 contract
 *    `AppSpec` are mutually assignable and shape-identical, so the hand-written
 *    contract cannot drift from the schema (plan.md:517-518).
 *
 * Deliberately NOT asserted here, because it belongs to another task: the codes
 * the validator reports (`unknown_field`, `out_of_range`, `keypair_format_unsupported`,
 * `keypair_password_invalid`, …) — T5/T6 own those, in
 * `app-spec.rules.spec.ts` and `app-spec.validate.spec.ts`. A test in this file
 * asserts the opposite where it matters: a document with a cross-field problem
 * **parses**, so that the rule layer has something to report on.
 */

// ---------------------------------------------------------------------------
// Type level: the schema and the T1 contract cannot drift (plan.md:517-518)
// ---------------------------------------------------------------------------

/** Compile-time type identity — `true` only when `A` and `B` are the same type. */
type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails to compile unless the argument type is exactly `true`. */
type Assert<T extends true> = T;

/**
 * `AppSpec` spells its list fields `readonly T[]` (T1); zod's arrays are mutable,
 * and TypeScript refuses `readonly T[]` → `T[]`. Both sides are therefore mapped
 * through the same normalization — mutable arrays, nothing else — before they are
 * compared.
 *
 * That rewriting is the ONLY difference these assertions ignore, and it can hide
 * nothing: nothing in `app-spec.schema.ts` calls `.readonly()`, so the schema
 * cannot produce a readonly array (it would also freeze every parsed list at
 * runtime, which is a behaviour the consumers of this schema did not ask for).
 * Optionality, every other modifier and every nested shape are compared by type
 * identity below.
 */
type Normalize<T> = T extends readonly (infer U)[]
    ? Normalize<U>[]
    : T extends object
      ? { [K in keyof T]: Normalize<T[K]> }
      : T;

/** The schema's input type and the T1 contract, reduced to the same spelling. */
type SchemaShape = Normalize<z.input<typeof appSpecSchema>>;
type ContractShape = Normalize<AppSpec>;

/**
 * The assertion plan.md:517-518 names, in both directions.
 *
 * `z.input` → `AppSpec` needs no rewriting at all — a mutable list satisfies a
 * readonly one — so the first line compares the raw types. The other direction
 * goes through {@link Normalize}, because `AppSpec`'s `readonly T[]` cannot
 * satisfy zod's mutable `T[]`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _schemaAssignableToContract: AppSpec = {} as z.input<typeof appSpecSchema>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _contractAssignableToSchema: SchemaShape = {} as ContractShape;

/**
 * …and the two shapes are identical, not merely compatible.
 *
 * The pair above already catches an optionality drift — making `source` required
 * in the schema fails it with "Property 'source' is optional in type … but
 * required in type …", even though this package compiles with
 * `strictNullChecks: false`. This assertion is the stricter half: it is type
 * **identity** rather than mutual assignability, so it also refuses a pair of
 * shapes that can each absorb the other without being the same type (`unknown`
 * against `any`, a widened union, an intersection against its flattening) — the
 * quieter ways a hand-written contract and a zod chain drift apart.
 */
type _SameShape = Assert<Equal<SchemaShape, ContractShape>>;

/**
 * …and when a single field's optionality differs, the failure names it. This is
 * the readable half of {@link _SameShape}: make `source` required in the schema
 * and `ModifierMismatch` becomes `'source'`, so the compiler reports
 * `'"source"' does not satisfy the constraint 'true'` — where the pair above
 * reports the whole 19-block object type twice.
 */
type ModifierMismatch<A, B> = {
    [K in keyof A | keyof B]: K extends keyof A
        ? K extends keyof B
            ? Equal<
                  {} extends Pick<A, K> ? 'optional' : 'required',
                  {} extends Pick<B, K> ? 'optional' : 'required'
              > extends true
                ? never
                : K
            : K
        : K;
}[keyof A | keyof B];

type _NoModifierMismatch = Assert<Equal<ModifierMismatch<SchemaShape, ContractShape>, never>>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The minimal document the T1 contract allows — every optional block absent,
 * typed as `AppSpec`. `schema.md` §3:89 is why `source` may be absent at all: in
 * `blueprint` mode both `source` and `blueprint` are allowed and expected, and
 * the mode-scoped requirement is a validator rule, not a shape.
 */
const minimalContractSpec: AppSpec = { kind: 'app' };

/** The three `schema.md` §24 examples, verbatim. ACC-03-01. */
const EXAMPLE_24_1 = `
version: 2
kind: app
name: Cal.diy (community build)
spec:
    source: { relation: fork, upstream: { repo: calcom/cal.diy, defaultBranch: main }, branch: main }
    blueprint:
        {
            id: cal-diy,
            version: 1.0.0,
            repo: ever-works/cal-diy-template,
            sha: 0123456789abcdef0123456789abcdef01234567
        }
    license: { spdx: MIT, class: green, source: blueprint, notice: 'Cal.diy® is a trademark of Cal.com, Inc.' }
    display: { name: 'Cal.diy (community build)', protectedPaths: ['apps/web/public/brand/**'] }
    build:
        strategy: dockerfile
        dockerfile: Dockerfile
        target: runner
        args:
            - { name: NEXT_PUBLIC_WEBAPP_URL, value: 'http://NEXT_PUBLIC_WEBAPP_URL_PLACEHOLDER' }
            - { name: CALENDSO_ENCRYPTION_KEY, fromEnv: CALENDSO_ENCRYPTION_KEY } # R11 warning, accepted
        services:
            [
                {
                    name: postgres,
                    image: 'postgres:16',
                    port: 5432,
                    env: [{ name: POSTGRES_PASSWORD, value: build-only }]
                }
            ]
        resources: { cpu: 4, memory: 12Gi, timeoutMinutes: 60 }
    components:
        - name: web
          role: web
          command: ['/calcom/scripts/start.sh']
          port: 3000
          writableRootFilesystem: true
          probes:
              startup: { http: /api/version, periodSeconds: 10, failureThreshold: 60 }
              readiness: { http: /auth/login }
              liveness: { http: /api/version, periodSeconds: 30 }
          resources: { cpu: 500m, memory: 1Gi, memoryLimit: 3Gi }
    dependencies:
        postgres: { version: '16', directUrl: true }
        smtp: { required: true }
    env:
        - { name: NEXTAUTH_SECRET, secret: true, generate: { kind: base64, bytes: 32 } }
        - {
              name: CALENDSO_ENCRYPTION_KEY,
              secret: true,
              phase: both,
              generate: { kind: chars, length: 32, alphabet: alnum },
              validate: { length: 32 }
          }
        - { name: CRON_API_KEY, secret: true, generate: { kind: hex, bytes: 32 } }
        - { name: DATABASE_URL, secret: true, from: deps.postgres.url }
        - { name: DATABASE_DIRECT_URL, secret: true, from: deps.postgres.directUrl }
        - { name: NEXT_PUBLIC_WEBAPP_URL, from: domains.primary.url }
        - { name: NEXTAUTH_URL, template: '{{domains.primary.url}}/api/auth' }
        - { name: EMAIL_SERVER_HOST, from: deps.smtp.host }
        - { name: EMAIL_SERVER_PASSWORD, secret: true, from: deps.smtp.password }
        - {
              name: GOOGLE_API_CREDENTIALS,
              secret: true,
              prompt: { description: 'Google Calendar OAuth JSON', required: false }
          }
        - { name: CALCOM_TELEMETRY_DISABLED, value: '1' }
    jobs:
        - {
              name: migrate,
              when: pre-deploy,
              component: web,
              command: ['npx', 'prisma', 'migrate', 'deploy'],
              timeoutSeconds: 900
          }
    cron:
        - {
              name: booking-reminder,
              schedule: '*/15 * * * *',
              http: { method: POST, path: /api/cron/bookingReminder, authEnv: CRON_API_KEY, authScheme: raw }
          }
    domains:
        {
            primaryComponent: web,
            publicUrlEnv: [NEXT_PUBLIC_WEBAPP_URL, NEXTAUTH_URL],
            onChange: restart,
            needsHairpin: true
        }
    smoke:
        - { name: version, http: { path: /api/version }, expect: { status: [200] } }
        - { name: login, http: { path: /auth/login }, expect: { status: [200], bodyNotContains: ['localhost:3000'] } }
    checks:
        - { name: type-check, command: 'yarn type-check:ci --force', timeoutSeconds: 1800 }
    agents: { instructionFiles: [AGENTS.md], maxPullRequestChangedLines: 500 }
    upstreamSync: { schedule: '0 6 * * 1', mode: merge }
    upstreamPullRequests: { enabled: false, requireApproval: true }`;
const EXAMPLE_24_2 = `
version: 2
kind: app
spec:
    source: { relation: fork, upstream: { repo: example-org/analytics, defaultBranch: main } }
    build:
        {
            strategy: image,
            image: 'ghcr.io/example-org/analytics@sha256:9f2c1e0b7a4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a49'
        }
    components:
        - name: web
          role: web
          port: 3000
          probes: { startup: { http: /api/heartbeat, failureThreshold: 30 }, readiness: { http: /api/heartbeat } }
          resources: { cpu: 250m, memory: 512Mi, memoryLimit: 1Gi }
    dependencies: { postgres: { version: '16' } }
    env:
        - { name: DATABASE_URL, secret: true, from: deps.postgres.url }
        - { name: APP_SECRET, secret: true, generate: { kind: hex, bytes: 32 }, validate: { length: 64 } }
        - { name: ADMIN_PASSWORD, secret: true, generate: { kind: chars, length: 24, alphabet: alnum-symbols } }
        - { name: DISABLE_TELEMETRY, value: '1' }
    jobs:
        - name: set-admin-password
          when: first-deploy
          component: web
          http:
              {
                  method: POST,
                  path: /api/setup/admin,
                  body: { password: '{{env.ADMIN_PASSWORD}}' },
                  expect: { status: [200, 201] }
              }
    smoke:
        - { name: heartbeat, http: { path: /api/heartbeat }, expect: { status: [200], maxLatencyMs: 2000 } }`;
const EXAMPLE_24_3 = `
version: 2
kind: app
spec:
    source: { relation: private-copy, upstream: { repo: example-org/helpdesk, defaultBranch: main } }
    build: { strategy: dockerfile, dockerfile: docker/Dockerfile, context: ., resources: { memory: 6Gi } }
    components:
        - {
              name: web,
              role: web,
              command: ['node', 'dist/server.js'],
              port: 8080,
              probes: { readiness: { http: /healthz }, liveness: { http: /healthz, periodSeconds: 30 } },
              resources: { cpu: 500m, memory: 768Mi, memoryLimit: 1536Mi }
          }
        - {
              name: worker,
              role: worker,
              command: ['node', 'dist/worker.js'],
              replicas: 2,
              resources: { cpu: 250m, memory: 512Mi }
          }
    dependencies:
        postgres: { version: '16' }
        redis: { version: '7', maxmemoryPolicy: noeviction }
        objectStorage: { buckets: [attachments] }
    env:
        - { name: DATABASE_URL, secret: true, from: deps.postgres.url }
        - { name: REDIS_URL, secret: true, from: deps.redis.url }
        - { name: S3_ENDPOINT, from: deps.objectStorage.endpoint }
        - { name: S3_BUCKET, from: deps.objectStorage.bucket.attachments }
        - { name: S3_ACCESS_KEY_ID, secret: true, from: deps.objectStorage.accessKeyId }
        - { name: S3_SECRET_ACCESS_KEY, secret: true, from: deps.objectStorage.secretAccessKey }
        - { name: SESSION_SECRET, secret: true, generate: { kind: base64, bytes: 48 }, validate: { length: 64 } }
        - { name: PUBLIC_URL, from: domains.primary.url }
        - { name: SIGNUP_ENABLED, value: 'false' }
    jobs:
        - { name: migrate, when: pre-deploy, component: web, command: ['node', 'dist/migrate.js'] }
    cron:
        - { name: purge-trash, schedule: '30 3 * * *', component: worker, command: ['node', 'dist/purge.js'] }
    smoke:
        - { name: health, http: { path: /healthz }, expect: { status: [200] } }
    upstreamSync: { schedule: '0 5 * * *' }
    upstreamPullRequests: { enabled: false } # a private copy cannot open upstream pull requests (D2)`;

/**
 * One document that is valid in **every** block of §5–§20, so that each bound and
 * each enum below can be exercised by changing exactly one leaf. It is a plain
 * JSON object: these cases are about the schema, not about YAML.
 */
const validSpec = {
    kind: 'app',
    appSpecVersion: 1,
    source: {
        relation: 'fork',
        upstream: { repo: 'example-org/helpdesk', defaultBranch: 'main' },
        branch: 'main',
    },
    blueprint: {
        id: 'helpdesk',
        version: '1.2.3',
        repo: 'ever-works/helpdesk-template',
        sha: '0123456789abcdef0123456789abcdef01234567',
    },
    license: {
        spdx: 'MIT',
        class: 'green',
        source: 'blueprint',
        notice: 'Helpdesk® is a trademark of Example Org, Inc.',
        sourceOfferUrl: 'https://example.com/source',
    },
    display: { name: 'Helpdesk', protectedPaths: ['apps/web/public/brand/**'] },
    build: {
        strategy: 'dockerfile',
        dockerfile: 'docker/Dockerfile',
        context: '.',
        target: 'runner',
        args: [
            { name: 'NEXT_PUBLIC_WEBAPP_URL', value: 'https://example.com' },
            { name: 'ENCRYPTION_KEY', fromEnv: 'ENCRYPTION_KEY' },
        ],
        services: [
            {
                name: 'postgres',
                image: 'postgres:16',
                port: 5432,
                env: [{ name: 'POSTGRES_PASSWORD', value: 'build-only' }],
            },
        ],
        resources: { cpu: 2, memory: '7Gi', timeoutMinutes: 60 },
    },
    components: [
        {
            name: 'web',
            role: 'web',
            command: ['node', 'dist/server.js'],
            args: ['--port', '8080'],
            target: 'runner',
            port: 8080,
            replicas: 1,
            writableRootFilesystem: false,
            runAsUser: 1000,
            probes: {
                startup: {
                    http: '/healthz',
                    periodSeconds: 10,
                    timeoutSeconds: 5,
                    initialDelaySeconds: 0,
                    failureThreshold: 30,
                },
                readiness: { tcp: true },
                liveness: { http: '/healthz' },
            },
            resources: { cpu: '500m', memory: '512Mi', cpuLimit: '1', memoryLimit: '1Gi' },
            volumes: [{ name: 'data', path: '/var/lib/helpdesk', size: '1Gi', backup: true }],
        },
        { name: 'worker', role: 'worker', replicas: 2 },
    ],
    dependencies: {
        postgres: { version: '16', directUrl: true, extensions: ['pgcrypto'] },
        redis: { version: '7', maxmemoryPolicy: 'noeviction', persistence: false },
        objectStorage: { buckets: ['attachments'], publicBuckets: ['attachments'] },
        smtp: { required: true },
    },
    env: [
        {
            name: 'DATABASE_URL',
            secret: true,
            phase: 'runtime',
            description: 'The pooled URL',
            from: 'deps.postgres.url',
        },
        { name: 'PUBLIC_URL', from: 'domains.primary.url' },
        { name: 'PUBLIC_API_URL', template: '{{domains.primary.url}}/api' },
        {
            name: 'JWT_SIGNING_KEY',
            secret: true,
            generate: {
                kind: 'keypair',
                keypair: { type: 'ed25519', format: 'pem' },
                rotate: 'never',
            },
        },
        {
            name: 'SESSION_SECRET',
            secret: true,
            generate: { kind: 'base64', bytes: 32 },
            validate: { length: 44 },
        },
        {
            name: 'SHORT_CODE',
            secret: true,
            generate: { kind: 'chars', length: 32, alphabet: 'alnum' },
        },
        {
            name: 'GOOGLE_API_CREDENTIALS',
            secret: true,
            prompt: { description: 'OAuth JSON', required: true, example: '{}', group: 'Auth' },
        },
        { name: 'SIGNUP_ENABLED', value: 'true' },
        /**
         * The entry `build.args[1].fromEnv` names. §24.1's own `CALENDSO_ENCRYPTION_KEY`
         * does the same thing, and R11 answers it with the warning §9:175's
         * comment calls "accepted" — which is why this fixture is valid with one
         * warning rather than none. T7 routes `kind: app` through the App
         * validator, so a fixture that referenced a missing entry stopped being
         * error-free (`reference_unresolved`, R5); the entry belongs in the
         * document either way.
         */
        {
            name: 'ENCRYPTION_KEY',
            secret: true,
            phase: 'both',
            generate: { kind: 'hex', bytes: 32 },
        },
    ],
    jobs: [
        {
            name: 'migrate',
            when: 'pre-deploy',
            component: 'web',
            command: ['node', 'dist/migrate.js'],
            timeoutSeconds: 600,
            retries: 0,
        },
        {
            name: 'bootstrap-admin',
            when: 'first-deploy',
            component: 'web',
            http: {
                method: 'POST',
                path: '/api/setup/admin',
                body: { password: '{{env.SESSION_SECRET}}' },
                authEnv: 'SESSION_SECRET',
                authScheme: 'bearer',
                expect: { status: [200, 201, 204] },
            },
        },
    ],
    cron: [
        {
            name: 'purge-trash',
            schedule: '30 3 * * *',
            component: 'worker',
            command: ['node', 'dist/purge.js'],
            timeoutSeconds: 300,
            concurrency: 'forbid',
        },
    ],
    domains: {
        primaryComponent: 'web',
        publicUrlEnv: ['PUBLIC_URL'],
        onChange: 'restart',
        needsHairpin: true,
    },
    smoke: [
        {
            name: 'health',
            http: { method: 'GET', path: '/healthz' },
            component: 'web',
            expect: {
                status: [200],
                bodyContains: ['ok'],
                bodyNotContains: ['localhost'],
                maxLatencyMs: 2000,
            },
            when: 'always',
        },
    ],
    checks: [
        { name: 'type-check', command: 'pnpm type-check', required: true, timeoutSeconds: 1800 },
    ],
    agents: {
        instructionFiles: ['AGENTS.md'],
        maxPullRequestChangedLines: 500,
        maxPullRequestChangedFiles: 50,
        requireHumanMergePaths: ['docs/**'],
    },
    upstreamSync: { enabled: true, schedule: '0 6 * * 1', mode: 'merge', branch: 'main' },
    upstreamPullRequests: { enabled: true, requireApproval: true, maxOpen: 3 },
    provisioning: { autoReprovision: false },
};

type PathSegment = string | number;

/** A deep copy of `doc` with exactly one leaf replaced — JSON round-trip, since every fixture is JSON. */
function withLeaf(base: unknown, path: readonly PathSegment[], value: unknown): unknown {
    const copy = JSON.parse(JSON.stringify(base)) as Record<string, never>;
    let cursor: Record<string, never> = copy;
    const walk = path.slice(0, -1);
    for (const segment of walk) {
        const next = cursor?.[segment as never] as Record<string, never> | undefined;
        if (next === undefined) {
            // A typo in a case's path would otherwise surface as a confusing
            // "cannot set properties of undefined" inside the helper.
            throw new Error(
                `withLeaf: no parent at ${JSON.stringify(walk)} for ${JSON.stringify(path)}`,
            );
        }
        cursor = next;
    }
    cursor[path[path.length - 1] as never] = value as never;
    return copy;
}

/** Parses and fails the test with the issue list when the document is refused. */
function expectAccepted(doc: unknown): void {
    const result = appSpecSchema.safeParse(doc);
    expect(result.success ? null : result.error.issues).toBeNull();
}

/** Parses and fails the test when the document is accepted. */
function expectRefused(doc: unknown): void {
    const result = appSpecSchema.safeParse(doc);
    expect(result.success).toBe(false);
}

/** The issue codes a document produces, or an empty list when it parses. */
function issueCodes(doc: unknown): string[] {
    const result = appSpecSchema.safeParse(doc);
    return result.success ? [] : result.error.issues.map((issue) => issue.code);
}

/** Every `x-` key path inside a value, for the extension-key cases. */
function extensionKeyPaths(value: unknown, prefix: readonly string[] = []): string[][] {
    const found: string[][] = [];
    if (Array.isArray(value)) {
        value.forEach((entry, index) =>
            found.push(...extensionKeyPaths(entry, [...prefix, String(index)])),
        );
        return found;
    }
    if (typeof value !== 'object' || value === null) {
        return found;
    }
    for (const [key, entry] of Object.entries(value)) {
        if (key.startsWith('x-')) {
            found.push([...prefix, key]);
        }
        found.push(...extensionKeyPaths(entry, [...prefix, key]));
    }
    return found;
}

// ---------------------------------------------------------------------------
// schema.md §24 — the three examples (ACC-03-01)
// ---------------------------------------------------------------------------

describe('schema.md §24 examples', () => {
    /**
     * Each example is the whole `.works/works.yml`, so the spec is its `spec`
     * block. Parsing the YAML here rather than hand-transcribing the objects is
     * deliberate: the fixture is the normative text, not a copy of it.
     */
    const examples: ReadonlyArray<[string, string]> = [
        ['§24.1 single container with Postgres (Cal.diy)', EXAMPLE_24_1],
        ['§24.2 prebuilt image (analytics)', EXAMPLE_24_2],
        ['§24.3 web + worker with Redis (help-desk)', EXAMPLE_24_3],
    ];

    it.each(examples)('%s parses with zero issues', (_name, yaml) => {
        const document = parseYaml(yaml) as { spec?: unknown };
        expect(document.spec).toBeDefined();
        expectAccepted(document.spec);
    });

    it('accepts the minimal spec the T1 contract allows', () => {
        expectAccepted(minimalContractSpec);
    });
});

// ---------------------------------------------------------------------------
// Bounds (schema.md §0 notation and every "Rules" column of §5–§20)
// ---------------------------------------------------------------------------

/** One bound: the leaf to set, a value it must accept, and a value it must refuse. */
interface BoundCase {
    readonly name: string;
    readonly path: readonly PathSegment[];
    readonly accepted: unknown;
    readonly refused: unknown;
}

const BOUND_CASES: readonly BoundCase[] = [
    // §1 appSpecVersion — 1–1000, integer
    {
        name: 'appSpecVersion ≥ 1',
        path: ['appSpecVersion'],
        accepted: APP_SPEC_VERSION_MIN,
        refused: APP_SPEC_VERSION_MIN - 1,
    },
    {
        name: 'appSpecVersion ≤ 1000',
        path: ['appSpecVersion'],
        accepted: APP_SPEC_VERSION_MAX,
        refused: APP_SPEC_VERSION_MAX + 1,
    },
    { name: 'appSpecVersion is an integer', path: ['appSpecVersion'], accepted: 1, refused: 1.5 },
    // §5 source
    {
        name: 'source.branch ≤ 255 characters',
        path: ['source', 'branch'],
        accepted: 'b'.repeat(255),
        refused: 'b'.repeat(256),
    },
    {
        name: 'source.branch is not empty',
        path: ['source', 'branch'],
        accepted: 'main',
        refused: '',
    },
    {
        name: 'source.branch has no `..`',
        path: ['source', 'branch'],
        accepted: 'feat/x',
        refused: 'feat..x',
    },
    {
        name: 'source.branch has no `//`',
        path: ['source', 'branch'],
        accepted: 'feat/x',
        refused: 'feat//x',
    },
    {
        name: 'source.branch does not end in `.lock`',
        path: ['source', 'branch'],
        accepted: 'main',
        refused: 'main.lock',
    },
    {
        name: 'source.upstream.repo ≤ 100 characters after the owner',
        path: ['source', 'upstream', 'repo'],
        accepted: `owner/${'r'.repeat(100)}`,
        refused: `owner/${'r'.repeat(101)}`,
    },
    {
        name: 'source.upstream.repo owner ≤ 39 characters',
        path: ['source', 'upstream', 'repo'],
        accepted: `${'o'.repeat(39)}/repo`,
        refused: `${'o'.repeat(40)}/repo`,
    },
    {
        name: 'source.upstream.defaultBranch ≤ 255',
        path: ['source', 'upstream', 'defaultBranch'],
        accepted: 'b'.repeat(255),
        refused: 'b'.repeat(256),
    },
    // §6 blueprint
    {
        name: 'blueprint.id is a slug of ≤ 64 characters',
        path: ['blueprint', 'id'],
        accepted: 'a'.repeat(64),
        refused: 'a'.repeat(65),
    },
    {
        name: 'blueprint.version is MAJOR.MINOR.PATCH',
        path: ['blueprint', 'version'],
        accepted: '10.20.30',
        refused: '1.0',
    },
    {
        name: 'blueprint.repo is `ever-works/<slug>`',
        path: ['blueprint', 'repo'],
        accepted: 'ever-works/helpdesk',
        refused: 'example-org/helpdesk',
    },
    {
        name: 'blueprint.sha is 40 hex characters',
        path: ['blueprint', 'sha'],
        accepted: 'a'.repeat(40),
        refused: 'a'.repeat(39),
    },
    // §7 license
    {
        name: 'license.spdx ≤ 200 characters',
        path: ['license', 'spdx'],
        accepted: 's'.repeat(200),
        refused: 's'.repeat(201),
    },
    {
        name: 'license.notice ≤ 500 characters',
        path: ['license', 'notice'],
        accepted: 'n'.repeat(500),
        refused: 'n'.repeat(501),
    },
    {
        name: 'license.sourceOfferUrl ≤ 500 characters',
        path: ['license', 'sourceOfferUrl'],
        accepted: `https://e.co/${'u'.repeat(487)}`,
        refused: `https://e.co/${'u'.repeat(488)}`,
    },
    {
        name: 'license.sourceOfferUrl is https',
        path: ['license', 'sourceOfferUrl'],
        accepted: 'https://example.com/source',
        refused: 'http://example.com/source',
    },
    // §8 display
    {
        name: 'display.name ≥ 1 character',
        path: ['display', 'name'],
        accepted: 'H',
        refused: '',
    },
    {
        name: 'display.protectedPaths entries are relative globs',
        path: ['display', 'protectedPaths'],
        accepted: ['brand/**'],
        refused: ['/brand/**'],
    },
    {
        name: 'display.name ≤ 80 characters',
        path: ['display', 'name'],
        accepted: 'n'.repeat(80),
        refused: 'n'.repeat(81),
    },
    {
        name: 'display.protectedPaths ≤ 50 globs',
        path: ['display', 'protectedPaths'],
        accepted: Array.from({ length: APP_SPEC_MAX_PROTECTED_PATHS }, () => 'a/**'),
        refused: Array.from({ length: APP_SPEC_MAX_PROTECTED_PATHS + 1 }, () => 'a/**'),
    },
    {
        name: 'display.protectedPaths entries are globs of ≤ 200 characters',
        path: ['display', 'protectedPaths'],
        accepted: ['g'.repeat(200)],
        refused: ['g'.repeat(201)],
    },
    // §9 build
    {
        name: 'build.target ≤ 64 characters',
        path: ['build', 'target'],
        accepted: 't'.repeat(64),
        refused: 't'.repeat(65),
    },
    {
        name: 'build.image ≤ 512 characters',
        path: ['build', 'image'],
        accepted: 'a'.repeat(512),
        refused: 'a'.repeat(513),
    },
    {
        name: 'build.args ≤ 50 entries',
        path: ['build', 'args'],
        accepted: Array.from({ length: 50 }, () => ({ name: 'A', value: 'x' })),
        refused: Array.from({ length: 51 }, () => ({ name: 'A', value: 'x' })),
    },
    {
        name: 'build.args[].value ≤ 1000 characters',
        path: ['build', 'args'],
        accepted: [{ name: 'A', value: 'v'.repeat(1000) }],
        refused: [{ name: 'A', value: 'v'.repeat(1001) }],
    },
    {
        name: 'build.services ≤ 5 entries',
        path: ['build', 'services'],
        accepted: Array.from({ length: 5 }, () => ({ name: 'db', image: 'postgres:16' })),
        refused: Array.from({ length: 6 }, () => ({ name: 'db', image: 'postgres:16' })),
    },
    {
        name: 'build.services[].port ≥ 1',
        path: ['build', 'services'],
        accepted: [{ name: 'db', image: 'postgres:16', port: 1 }],
        refused: [{ name: 'db', image: 'postgres:16', port: 0 }],
    },
    {
        name: 'build.services[].port ≤ 65535',
        path: ['build', 'services'],
        accepted: [{ name: 'db', image: 'postgres:16', port: 65535 }],
        refused: [{ name: 'db', image: 'postgres:16', port: 65536 }],
    },
    {
        name: 'build.services[].env ≤ 20 entries',
        path: ['build', 'services'],
        accepted: [
            {
                name: 'db',
                image: 'postgres:16',
                env: Array.from({ length: 20 }, () => ({ name: 'A', value: 'x' })),
            },
        ],
        refused: [
            {
                name: 'db',
                image: 'postgres:16',
                env: Array.from({ length: 21 }, () => ({ name: 'A', value: 'x' })),
            },
        ],
    },
    {
        name: 'build.resources.cpu ≥ 1',
        path: ['build', 'resources', 'cpu'],
        accepted: 1,
        refused: 0.5,
    },
    {
        name: 'build.resources.cpu ≤ 16',
        path: ['build', 'resources', 'cpu'],
        accepted: 16,
        refused: 17,
    },
    {
        name: 'build.resources.timeoutMinutes ≥ 5',
        path: ['build', 'resources', 'timeoutMinutes'],
        accepted: 5,
        refused: 4,
    },
    {
        name: 'build.resources.timeoutMinutes ≤ 180',
        path: ['build', 'resources', 'timeoutMinutes'],
        accepted: 180,
        refused: 181,
    },
    {
        name: 'build.resources.memory has a Mi/Gi unit',
        path: ['build', 'resources', 'memory'],
        accepted: '64Gi',
        refused: '7',
    },
    // §10 components
    {
        name: 'components ≤ 10 entries',
        path: ['components'],
        accepted: [{ name: 'web', role: 'web', port: 80 }],
        refused: [
            { name: 'web', role: 'web', port: 80 },
            { name: 'w2', role: 'worker' },
            { name: 'w3', role: 'worker' },
            { name: 'w4', role: 'worker' },
            { name: 'w5', role: 'worker' },
            { name: 'w6', role: 'worker' },
            { name: 'w7', role: 'worker' },
            { name: 'w8', role: 'worker' },
            { name: 'w9', role: 'worker' },
            { name: 'w10', role: 'worker' },
            { name: 'w11', role: 'worker' },
        ],
    },
    {
        name: 'components[].command ≤ 20 items',
        path: ['components', 0, 'command'],
        accepted: Array.from({ length: 20 }, () => 'x'),
        refused: Array.from({ length: 21 }, () => 'x'),
    },
    {
        name: 'components[].command items ≤ 1000 characters',
        path: ['components', 0, 'command'],
        accepted: ['c'.repeat(1000)],
        refused: ['c'.repeat(1001)],
    },
    {
        name: 'components[].args ≤ 50 items',
        path: ['components', 0, 'args'],
        accepted: Array.from({ length: 50 }, () => 'x'),
        refused: Array.from({ length: 51 }, () => 'x'),
    },
    { name: 'components[].port ≥ 1', path: ['components', 0, 'port'], accepted: 1, refused: 0 },
    {
        name: 'components[].port ≤ 65535',
        path: ['components', 0, 'port'],
        accepted: 65535,
        refused: 65536,
    },
    {
        name: 'components[].replicas ≥ 0',
        path: ['components', 0, 'replicas'],
        accepted: 0,
        refused: -1,
    },
    {
        name: 'components[].replicas ≤ 10',
        path: ['components', 0, 'replicas'],
        accepted: 10,
        refused: 11,
    },
    {
        name: 'components[].runAsUser ≥ 1',
        path: ['components', 0, 'runAsUser'],
        accepted: 1,
        refused: 0,
    },
    {
        name: 'components[].runAsUser ≤ 4294967294',
        path: ['components', 0, 'runAsUser'],
        accepted: 4294967294,
        refused: 4294967295,
    },
    {
        name: 'probes.periodSeconds ≥ 1',
        path: ['components', 0, 'probes', 'liveness', 'periodSeconds'],
        accepted: 1,
        refused: 0,
    },
    {
        name: 'probes.periodSeconds ≤ 300',
        path: ['components', 0, 'probes', 'liveness', 'periodSeconds'],
        accepted: 300,
        refused: 301,
    },
    {
        name: 'probes.timeoutSeconds ≥ 1',
        path: ['components', 0, 'probes', 'liveness', 'timeoutSeconds'],
        accepted: 1,
        refused: 0,
    },
    {
        name: 'probes.timeoutSeconds ≤ 60',
        path: ['components', 0, 'probes', 'liveness', 'timeoutSeconds'],
        accepted: 60,
        refused: 61,
    },
    {
        name: 'probes.initialDelaySeconds ≥ 0',
        path: ['components', 0, 'probes', 'liveness', 'initialDelaySeconds'],
        accepted: 0,
        refused: -1,
    },
    {
        name: 'probes.initialDelaySeconds ≤ 600',
        path: ['components', 0, 'probes', 'liveness', 'initialDelaySeconds'],
        accepted: 600,
        refused: 601,
    },
    {
        name: 'probes.failureThreshold ≥ 1',
        path: ['components', 0, 'probes', 'liveness', 'failureThreshold'],
        accepted: 1,
        refused: 0,
    },
    {
        name: 'probes.failureThreshold ≤ 120',
        path: ['components', 0, 'probes', 'liveness', 'failureThreshold'],
        accepted: 120,
        refused: 121,
    },
    {
        name: 'probes[].http is an HttpPath',
        path: ['components', 0, 'probes', 'liveness', 'http'],
        accepted: '/healthz',
        refused: 'healthz',
    },
    {
        name: 'probes[].tcp is literally true',
        path: ['components', 0, 'probes', 'liveness', 'tcp'],
        accepted: true,
        refused: false,
    },
    {
        name: 'components[].resources.cpu is a CpuQuantity',
        path: ['components', 0, 'resources', 'cpu'],
        accepted: '250m',
        refused: 'half a core',
    },
    {
        name: 'components[].resources.cpuLimit is a CpuQuantity',
        path: ['components', 0, 'resources', 'cpuLimit'],
        accepted: '2',
        refused: '2 cores',
    },
    {
        name: 'components[].resources.memory is a MemQuantity',
        path: ['components', 0, 'resources', 'memory'],
        accepted: '512Mi',
        refused: '512M',
    },
    {
        name: 'components[].volumes ≤ 5 entries',
        path: ['components', 0, 'volumes'],
        accepted: Array.from({ length: 5 }, (_v, i) => ({
            name: `v${i}`,
            path: `/data/${i}`,
            size: '1Gi',
        })),
        refused: Array.from({ length: 6 }, (_v, i) => ({
            name: `v${i}`,
            path: `/data/${i}`,
            size: '1Gi',
        })),
    },
    {
        name: 'components[].volumes[].path is absolute',
        path: ['components', 0, 'volumes'],
        accepted: [{ name: 'data', path: '/data', size: '1Gi' }],
        refused: [{ name: 'data', path: 'data', size: '1Gi' }],
    },
    {
        name: 'components[].volumes[].path ≤ 255 characters',
        path: ['components', 0, 'volumes'],
        accepted: [{ name: 'data', path: `/${'p'.repeat(254)}`, size: '1Gi' }],
        refused: [{ name: 'data', path: `/${'p'.repeat(255)}`, size: '1Gi' }],
    },
    {
        name: 'components[].volumes[].size is a StorageQuantity',
        path: ['components', 0, 'volumes'],
        accepted: [{ name: 'data', path: '/data', size: '2Gi' }],
        refused: [{ name: 'data', path: '/data', size: '2G' }],
    },
    // §11 dependencies
    {
        name: 'postgres.extensions ≤ 10 entries',
        path: ['dependencies', 'postgres', 'extensions'],
        accepted: Array.from({ length: 10 }, (_v, i) => `ext_${i}`),
        refused: Array.from({ length: 11 }, (_v, i) => `ext_${i}`),
    },
    {
        name: 'postgres.extensions have the extension pattern',
        path: ['dependencies', 'postgres', 'extensions'],
        accepted: ['pgcrypto'],
        refused: ['pg-crypto'],
    },
    {
        name: 'objectStorage.buckets ≥ 1',
        path: ['dependencies', 'objectStorage'],
        accepted: { buckets: ['attachments'] },
        refused: { buckets: [] },
    },
    {
        name: 'objectStorage.buckets ≤ 10',
        path: ['dependencies', 'objectStorage'],
        accepted: { buckets: Array.from({ length: 10 }, (_v, i) => `b${i}`) },
        refused: { buckets: Array.from({ length: 11 }, (_v, i) => `b${i}`) },
    },
    {
        name: 'objectStorage.publicBuckets entries are Names',
        path: ['dependencies', 'objectStorage'],
        accepted: { buckets: ['attachments'], publicBuckets: ['attachments'] },
        refused: { buckets: ['attachments'], publicBuckets: ['Attachments'] },
    },
    // §12 env
    {
        name: 'env ≤ 200 entries',
        path: ['env'],
        accepted: Array.from({ length: 200 }, (_v, i) => ({ name: `V${i}`, value: 'x' })),
        refused: Array.from({ length: 201 }, (_v, i) => ({ name: `V${i}`, value: 'x' })),
    },
    {
        name: 'env[].description ≤ 300 characters',
        path: ['env', 0, 'description'],
        accepted: 'd'.repeat(300),
        refused: 'd'.repeat(301),
    },
    {
        name: 'env[].value ≤ 4096 characters',
        path: ['env', 0, 'value'],
        accepted: 'v'.repeat(4096),
        refused: 'v'.repeat(4097),
    },
    {
        name: 'env[].template ≤ 2048 characters',
        path: ['env', 0, 'template'],
        accepted: 't'.repeat(2048),
        refused: 't'.repeat(2049),
    },
    {
        name: 'env[].generate.bytes ≥ 16',
        path: ['env', 3, 'generate', 'bytes'],
        accepted: 16,
        refused: 15,
    },
    {
        name: 'env[].generate.bytes ≤ 128',
        path: ['env', 3, 'generate', 'bytes'],
        accepted: 128,
        refused: 129,
    },
    {
        name: 'env[].generate.length ≥ 16',
        path: ['env', 3, 'generate', 'length'],
        accepted: 16,
        refused: 15,
    },
    {
        name: 'env[].generate.length ≤ 256',
        path: ['env', 3, 'generate', 'length'],
        accepted: 256,
        refused: 257,
    },
    {
        name: 'env[].validate.length ≥ 1',
        path: ['env', 4, 'validate', 'length'],
        accepted: 1,
        refused: 0,
    },
    {
        name: 'env[].validate.length ≤ 65536',
        path: ['env', 4, 'validate', 'length'],
        accepted: 65536,
        refused: 65537,
    },
    {
        name: 'env[].generate.keypair.passwordEnv is an EnvName',
        path: ['env', 3, 'generate', 'keypair', 'passwordEnv'],
        accepted: 'SAML_KEY_PASSWORD',
        refused: 'saml_key_password',
    },
    {
        name: 'env[].validate.minLength ≥ 1',
        path: ['env', 4, 'validate', 'minLength'],
        accepted: 1,
        refused: 0,
    },
    {
        name: 'env[].validate.minLength ≤ 65536',
        path: ['env', 4, 'validate', 'minLength'],
        accepted: 65536,
        refused: 65537,
    },
    {
        name: 'env[].validate.maxLength ≥ 1',
        path: ['env', 4, 'validate', 'maxLength'],
        accepted: 1,
        refused: 0,
    },
    {
        name: 'env[].validate.maxLength ≤ 65536',
        path: ['env', 4, 'validate', 'maxLength'],
        accepted: 65536,
        refused: 65537,
    },
    {
        name: 'env[].validate.pattern ≤ 500 characters',
        path: ['env', 4, 'validate', 'pattern'],
        accepted: 'p'.repeat(500),
        refused: 'p'.repeat(501),
    },
    {
        name: 'env[].prompt.description ≥ 1 character',
        path: ['env', 6, 'prompt', 'description'],
        accepted: 'd',
        refused: '',
    },
    {
        name: 'env[].prompt.description ≤ 300 characters',
        path: ['env', 6, 'prompt', 'description'],
        accepted: 'd'.repeat(300),
        refused: 'd'.repeat(301),
    },
    {
        name: 'env[].prompt.example ≤ 200 characters',
        path: ['env', 6, 'prompt', 'example'],
        accepted: 'e'.repeat(200),
        refused: 'e'.repeat(201),
    },
    {
        name: 'env[].prompt.group ≤ 40 characters',
        path: ['env', 6, 'prompt', 'group'],
        accepted: 'g'.repeat(40),
        refused: 'g'.repeat(41),
    },
    // §13 jobs
    {
        name: 'jobs ≤ 10 entries',
        path: ['jobs'],
        accepted: Array.from({ length: 10 }, (_v, i) => ({
            name: `j${i}`,
            when: 'pre-deploy',
            command: ['x'],
        })),
        refused: Array.from({ length: 11 }, (_v, i) => ({
            name: `j${i}`,
            when: 'pre-deploy',
            command: ['x'],
        })),
    },
    {
        name: 'jobs[].http.expect.status has 1–10 codes',
        path: ['jobs', 1, 'http', 'expect', 'status'],
        accepted: [200],
        refused: [],
    },
    {
        name: 'jobs[].http.expect.status has at most 10 codes',
        path: ['jobs', 1, 'http', 'expect', 'status'],
        accepted: Array.from({ length: 10 }, () => 200),
        refused: Array.from({ length: 11 }, () => 200),
    },
    {
        name: 'jobs[].http.expect.status codes ≥ 100',
        path: ['jobs', 1, 'http', 'expect', 'status'],
        accepted: [100],
        refused: [99],
    },
    {
        name: 'jobs[].http.expect.status codes ≤ 599',
        path: ['jobs', 1, 'http', 'expect', 'status'],
        accepted: [599],
        refused: [600],
    },
    {
        name: 'jobs[].timeoutSeconds ≥ 10',
        path: ['jobs', 0, 'timeoutSeconds'],
        accepted: 10,
        refused: 9,
    },
    {
        name: 'jobs[].timeoutSeconds ≤ 3600',
        path: ['jobs', 0, 'timeoutSeconds'],
        accepted: 3600,
        refused: 3601,
    },
    { name: 'jobs[].retries ≥ 0', path: ['jobs', 0, 'retries'], accepted: 0, refused: -1 },
    { name: 'jobs[].retries ≤ 3', path: ['jobs', 0, 'retries'], accepted: 3, refused: 4 },
    // §14 cron
    {
        name: 'cron ≤ 20 entries',
        path: ['cron'],
        accepted: Array.from({ length: 20 }, (_v, i) => ({
            name: `c${i}`,
            schedule: '0 3 * * *',
            command: ['x'],
        })),
        refused: Array.from({ length: 21 }, (_v, i) => ({
            name: `c${i}`,
            schedule: '0 3 * * *',
            command: ['x'],
        })),
    },
    {
        name: 'cron[].schedule has exactly five fields',
        path: ['cron', 0, 'schedule'],
        accepted: '30 3 * * *',
        refused: '30 3 * *',
    },
    {
        name: 'cron[].timeoutSeconds ≥ 10',
        path: ['cron', 0, 'timeoutSeconds'],
        accepted: 10,
        refused: 9,
    },
    {
        name: 'cron[].timeoutSeconds ≤ 3600',
        path: ['cron', 0, 'timeoutSeconds'],
        accepted: 3600,
        refused: 3601,
    },
    // §15 domains
    {
        name: 'domains.publicUrlEnv ≤ 10 entries',
        path: ['domains', 'publicUrlEnv'],
        accepted: Array.from({ length: 10 }, (_v, i) => `V${i}`),
        refused: Array.from({ length: 11 }, (_v, i) => `V${i}`),
    },
    {
        name: 'domains.publicUrlEnv entries are EnvNames',
        path: ['domains', 'publicUrlEnv'],
        accepted: ['PUBLIC_URL'],
        refused: ['public_url'],
    },
    // §16 smoke
    {
        name: 'smoke ≤ 20 entries',
        path: ['smoke'],
        accepted: Array.from({ length: 20 }, (_v, i) => ({ name: `s${i}`, http: { path: '/x' } })),
        refused: Array.from({ length: 21 }, (_v, i) => ({ name: `s${i}`, http: { path: '/x' } })),
    },
    {
        name: 'smoke[].expect.status has 1–10 codes',
        path: ['smoke', 0, 'expect', 'status'],
        accepted: [200],
        refused: [],
    },
    {
        name: 'smoke[].expect.bodyContains ≤ 5 entries',
        path: ['smoke', 0, 'expect', 'bodyContains'],
        accepted: Array.from({ length: 5 }, () => 'x'),
        refused: Array.from({ length: 6 }, () => 'x'),
    },
    {
        name: 'smoke[].expect.bodyContains entries ≤ 200 characters',
        path: ['smoke', 0, 'expect', 'bodyContains'],
        accepted: ['b'.repeat(200)],
        refused: ['b'.repeat(201)],
    },
    {
        name: 'smoke[].expect.bodyNotContains ≤ 5 entries',
        path: ['smoke', 0, 'expect', 'bodyNotContains'],
        accepted: Array.from({ length: 5 }, () => 'x'),
        refused: Array.from({ length: 6 }, () => 'x'),
    },
    {
        name: 'smoke[].expect.maxLatencyMs ≥ 100',
        path: ['smoke', 0, 'expect', 'maxLatencyMs'],
        accepted: 100,
        refused: 99,
    },
    {
        name: 'smoke[].expect.maxLatencyMs ≤ 60000',
        path: ['smoke', 0, 'expect', 'maxLatencyMs'],
        accepted: 60000,
        refused: 60001,
    },
    {
        name: 'smoke[].http.path is an HttpPath',
        path: ['smoke', 0, 'http', 'path'],
        accepted: '/x',
        refused: 'x',
    },
    // §17 checks
    {
        name: 'checks ≤ 20 entries',
        path: ['checks'],
        accepted: Array.from({ length: 20 }, (_v, i) => ({ name: `k${i}`, command: 'x' })),
        refused: Array.from({ length: 21 }, (_v, i) => ({ name: `k${i}`, command: 'x' })),
    },
    {
        name: 'checks[].command ≥ 1 character',
        path: ['checks', 0, 'command'],
        accepted: 'x',
        refused: '',
    },
    {
        name: 'checks[].command ≤ 500 characters',
        path: ['checks', 0, 'command'],
        accepted: 'c'.repeat(500),
        refused: 'c'.repeat(501),
    },
    {
        name: 'checks[].command has a non-whitespace character',
        path: ['checks', 0, 'command'],
        accepted: 'x',
        refused: '   ',
    },
    {
        name: 'checks[].command has no control characters',
        path: ['checks', 0, 'command'],
        accepted: 'x',
        refused: 'x\u0007',
    },
    {
        name: 'checks[].timeoutSeconds ≥ 60',
        path: ['checks', 0, 'timeoutSeconds'],
        accepted: 60,
        refused: 59,
    },
    {
        name: 'checks[].timeoutSeconds ≤ 7200',
        path: ['checks', 0, 'timeoutSeconds'],
        accepted: 7200,
        refused: 7201,
    },
    // §18 agents
    {
        name: 'agents.instructionFiles ≤ 10 entries',
        path: ['agents', 'instructionFiles'],
        accepted: Array.from({ length: 10 }, (_v, i) => `a${i}.md`),
        refused: Array.from({ length: 11 }, (_v, i) => `a${i}.md`),
    },
    {
        name: 'agents.maxPullRequestChangedLines ≥ 50',
        path: ['agents', 'maxPullRequestChangedLines'],
        accepted: 50,
        refused: 49,
    },
    {
        name: 'agents.maxPullRequestChangedLines ≤ 5000',
        path: ['agents', 'maxPullRequestChangedLines'],
        accepted: 5000,
        refused: 5001,
    },
    {
        name: 'agents.maxPullRequestChangedFiles ≥ 1',
        path: ['agents', 'maxPullRequestChangedFiles'],
        accepted: 1,
        refused: 0,
    },
    {
        name: 'agents.maxPullRequestChangedFiles ≤ 500',
        path: ['agents', 'maxPullRequestChangedFiles'],
        accepted: 500,
        refused: 501,
    },
    {
        name: 'agents.requireHumanMergePaths ≤ 50 globs',
        path: ['agents', 'requireHumanMergePaths'],
        accepted: Array.from({ length: APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS }, () => 'docs/**'),
        refused: Array.from(
            { length: APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS + 1 },
            () => 'docs/**',
        ),
    },
    {
        name: 'agents.requireHumanMergePaths entries are globs of ≤ 200 characters',
        path: ['agents', 'requireHumanMergePaths'],
        accepted: ['g'.repeat(200)],
        refused: ['g'.repeat(201)],
    },
    // §19 upstreamSync
    {
        name: 'upstreamSync.schedule has exactly five fields',
        path: ['upstreamSync', 'schedule'],
        accepted: '0 6 * * 1',
        refused: '0 6 * *',
    },
    {
        name: 'upstreamSync.branch is a git ref',
        path: ['upstreamSync', 'branch'],
        accepted: 'main',
        refused: 'main..other',
    },
    // §20 upstreamPullRequests
    {
        name: 'upstreamPullRequests.maxOpen ≥ 1',
        path: ['upstreamPullRequests', 'maxOpen'],
        accepted: 1,
        refused: 0,
    },
    {
        name: 'upstreamPullRequests.maxOpen ≤ 10',
        path: ['upstreamPullRequests', 'maxOpen'],
        accepted: 10,
        refused: 11,
    },
];

describe('bounds (schema.md §0, §5–§20)', () => {
    it('the fixture is valid before any bound is exercised', () => {
        expectAccepted(validSpec);
    });

    it.each(BOUND_CASES.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expectAccepted(withLeaf(validSpec, entry.path, entry.accepted));
        expectRefused(withLeaf(validSpec, entry.path, entry.refused));
    });
});

// ---------------------------------------------------------------------------
// Enums — one failing case per closed vocabulary of §5–§20
// ---------------------------------------------------------------------------

/** One enum: the leaf to set, the one member it must accept and the near-miss it must refuse. */
interface EnumCase {
    readonly name: string;
    readonly path: readonly PathSegment[];
    readonly accepted: string;
    readonly refused: string;
}

const ENUM_CASES: readonly EnumCase[] = [
    { name: '§5 source.relation', path: ['source', 'relation'], accepted: 'fork', refused: 'copy' },
    {
        name: '§5 source.relation accepts `link`',
        path: ['source', 'relation'],
        accepted: 'link',
        refused: 'linked',
    },
    { name: '§7 license.class', path: ['license', 'class'], accepted: 'amber', refused: 'yellow' },
    {
        name: '§7 license.source',
        path: ['license', 'source'],
        accepted: 'detected',
        refused: 'inferred',
    },
    {
        name: '§9 build.strategy',
        path: ['build', 'strategy'],
        accepted: 'auto',
        refused: 'buildpacks',
    },
    {
        name: '§9 build.strategy has no builder name',
        path: ['build', 'strategy'],
        accepted: 'dockerfile',
        refused: 'docker',
    },
    {
        name: '§10 components[].role',
        path: ['components', 0, 'role'],
        accepted: 'worker',
        refused: 'sidecar',
    },
    {
        name: '§11 dependencies.postgres.version',
        path: ['dependencies', 'postgres', 'version'],
        accepted: '17',
        refused: '18',
    },
    {
        name: '§11 dependencies.redis.version',
        path: ['dependencies', 'redis', 'version'],
        accepted: '7',
        refused: '6',
    },
    {
        name: '§11 dependencies.redis.maxmemoryPolicy',
        path: ['dependencies', 'redis', 'maxmemoryPolicy'],
        accepted: 'allkeys-lfu',
        refused: 'lru',
    },
    { name: '§12 env[].phase', path: ['env', 0, 'phase'], accepted: 'both', refused: 'deploy' },
    {
        name: '§12 env[].generate.kind',
        path: ['env', 3, 'generate', 'kind'],
        accepted: 'uuid',
        refused: 'password',
    },
    {
        name: '§12 env[].generate.alphabet',
        path: ['env', 3, 'generate', 'alphabet'],
        accepted: 'hex-lower',
        refused: 'base32',
    },
    {
        name: '§12 env[].generate.rotate',
        path: ['env', 3, 'generate', 'rotate'],
        accepted: 'never',
        refused: 'always',
    },
    {
        name: '§12 generate.keypair.type',
        path: ['env', 3, 'generate', 'keypair', 'type'],
        accepted: 'rsa-2048',
        refused: 'ed448',
    },
    {
        name: '§12 generate.keypair.format',
        path: ['env', 3, 'generate', 'keypair', 'format'],
        accepted: 'base64url-raw',
        refused: 'der',
    },
    {
        name: '§13 jobs[].when',
        path: ['jobs', 0, 'when'],
        accepted: 'post-deploy',
        refused: 'during-deploy',
    },
    {
        name: '§13 jobs[].http.method',
        path: ['jobs', 1, 'http', 'method'],
        accepted: 'PATCH',
        refused: 'OPTIONS',
    },
    {
        name: '§13 jobs[].http.authScheme',
        path: ['jobs', 1, 'http', 'authScheme'],
        accepted: 'raw',
        refused: 'basic',
    },
    {
        name: '§14 cron[].concurrency',
        path: ['cron', 0, 'concurrency'],
        accepted: 'allow',
        refused: 'queue',
    },
    {
        name: '§15 domains.onChange',
        path: ['domains', 'onChange'],
        accepted: 'rebuild',
        refused: 'reload',
    },
    {
        name: '§16 smoke[].http.method',
        path: ['smoke', 0, 'http', 'method'],
        accepted: 'HEAD',
        refused: 'PUT',
    },
    {
        name: '§16 smoke[].when',
        path: ['smoke', 0, 'when'],
        accepted: 'first-deploy',
        refused: 'never',
    },
    {
        name: '§19 upstreamSync.mode',
        path: ['upstreamSync', 'mode'],
        accepted: 'merge',
        refused: 'rebase',
    },
    { name: '§1 spec.kind', path: ['kind'], accepted: 'app', refused: 'website' },
];

describe('enums (schema.md §5–§20)', () => {
    it.each(ENUM_CASES.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
        expectAccepted(withLeaf(validSpec, entry.path, entry.accepted));
        expectRefused(withLeaf(validSpec, entry.path, entry.refused));
    });

    it('every enum member the docs list is accepted', () => {
        const members: ReadonlyArray<readonly [readonly PathSegment[], readonly string[]]> = [
            [
                ['source', 'relation'],
                ['fork', 'private-copy', 'link'],
            ],
            [
                ['build', 'strategy'],
                ['dockerfile', 'image', 'auto', 'none'],
            ],
            [
                ['components', 0, 'role'],
                ['web', 'worker'],
            ],
            [
                ['license', 'class'],
                ['green', 'amber', 'red', 'unknown'],
            ],
            [
                ['license', 'source'],
                ['detected', 'blueprint', 'user'],
            ],
            [
                ['dependencies', 'postgres', 'version'],
                ['14', '15', '16', '17'],
            ],
            [['dependencies', 'redis', 'version'], ['7']],
            [
                ['dependencies', 'redis', 'maxmemoryPolicy'],
                ['noeviction', 'allkeys-lru', 'volatile-lru', 'allkeys-lfu', 'volatile-lfu'],
            ],
            [
                ['env', 0, 'phase'],
                ['runtime', 'build', 'both'],
            ],
            [
                ['env', 3, 'generate', 'kind'],
                ['base64', 'hex', 'chars', 'uuid', 'keypair'],
            ],
            [
                ['env', 3, 'generate', 'alphabet'],
                ['alnum', 'alnum-symbols', 'hex-lower', 'base64url'],
            ],
            [['env', 3, 'generate', 'rotate'], ['never']],
            [
                ['env', 3, 'generate', 'keypair', 'type'],
                ['ed25519', 'ec-p256', 'rsa-2048', 'rsa-4096'],
            ],
            [
                ['env', 3, 'generate', 'keypair', 'format'],
                ['pem', 'base64url-raw', 'pkcs12'],
            ],
            [
                ['jobs', 0, 'when'],
                ['pre-deploy', 'first-deploy', 'post-deploy'],
            ],
            [
                ['jobs', 1, 'http', 'method'],
                ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            ],
            [
                ['jobs', 1, 'http', 'authScheme'],
                ['bearer', 'raw'],
            ],
            [
                ['cron', 0, 'concurrency'],
                ['forbid', 'allow'],
            ],
            [
                ['domains', 'onChange'],
                ['restart', 'rebuild'],
            ],
            [
                ['smoke', 0, 'http', 'method'],
                ['GET', 'HEAD', 'POST'],
            ],
            [
                ['smoke', 0, 'when'],
                ['always', 'first-deploy'],
            ],
            [['upstreamSync', 'mode'], ['merge']],
            [['kind'], ['app']],
        ];

        for (const [path, values] of members) {
            for (const value of values) {
                expectAccepted(withLeaf(validSpec, path, value));
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Patterns (schema.md §0 notation)
// ---------------------------------------------------------------------------

describe('notation patterns (schema.md §0)', () => {
    const nameCases = [
        ['a Name of 32 characters is accepted', 'a'.repeat(31) + 'b', true],
        ['a Name of 33 characters is refused', 'a'.repeat(32) + 'b', false],
        ['a Name may not start with a dash', '-web', false],
        ['a Name may not end with a dash', 'web-', false],
        ['a Name is lowercase', 'Web', false],
    ] as const;

    it.each(nameCases)('%s', (_name, value, accepted) => {
        const doc = withLeaf(validSpec, ['components', 0, 'name'], value);
        if (accepted) {
            expectAccepted(doc);
        } else {
            expectRefused(doc);
        }
    });

    const envNameCases = [
        ['_PRIVATE is a valid EnvName', '_PRIVATE', true],
        ['A128 character EnvName is accepted', 'A'.repeat(128), true],
        ['A129 character EnvName is refused', 'A'.repeat(129), false],
        ['a lowercase EnvName is refused', 'lower', false],
    ] as const;

    it.each(envNameCases)('%s', (_name, value, accepted) => {
        const doc = withLeaf(validSpec, ['env', 0, 'name'], value);
        if (accepted) {
            expectAccepted(doc);
        } else {
            expectRefused(doc);
        }
    });

    const relPathCases = [
        ['`.` is a valid RelPath (build.context)', '.', true],
        ['a nested RelPath is accepted', 'docker/Dockerfile', true],
        ['a 255 character RelPath is accepted', 'p'.repeat(255), true],
        ['a 256 character RelPath is refused', 'p'.repeat(256), false],
        ['a leading slash is refused', '/etc/passwd', false],
        ['a backslash is refused', 'a\\b', false],
        ['a `..` segment is refused', '../../etc/passwd', false],
        ['a `.git/` prefix is refused', '.git/config', false],
        ['a nested `.git/` segment is refused', 'sub/.git/config', false],
    ] as const;

    it.each(relPathCases)('%s', (_name, value, accepted) => {
        const doc = withLeaf(validSpec, ['build', 'dockerfile'], value);
        if (accepted) {
            expectAccepted(doc);
        } else {
            expectRefused(doc);
        }
    });

    const httpPathCases = [
        ['`/` is a valid HttpPath', '/', true],
        ['a 512 character HttpPath is accepted', `/${'p'.repeat(511)}`, true],
        ['a 513 character HttpPath is refused', `/${'p'.repeat(512)}`, false],
        ['a path without a leading slash is refused', 'healthz', false],
        ['a path with whitespace is refused', '/a b', false],
    ] as const;

    it.each(httpPathCases)('%s', (_name, value, accepted) => {
        const doc = withLeaf(validSpec, ['smoke', 0, 'http', 'path'], value);
        if (accepted) {
            expectAccepted(doc);
        } else {
            expectRefused(doc);
        }
    });

    const imageRefCases = [
        ['a tag-only reference is accepted', 'postgres:16', true],
        [
            'a registry path with a port is accepted',
            'registry.example.com:5000/org/app:1.2.3',
            true,
        ],
        ['a digest-pinned reference is accepted', `ghcr.io/org/app@sha256:${'a'.repeat(64)}`, true],
        ['a 63 character digest is refused', `ghcr.io/org/app@sha256:${'a'.repeat(63)}`, false],
        ['an uppercase repository is refused', 'ghcr.io/Org/App', false],
    ] as const;

    it.each(imageRefCases)('%s', (_name, value, accepted) => {
        const doc = withLeaf(validSpec, ['build', 'image'], value);
        if (accepted) {
            expectAccepted(doc);
        } else {
            expectRefused(doc);
        }
    });

    /**
     * zod reports every unknown key of one object as a single
     * `unrecognized_keys` issue whose `path` is the **parent** and whose `keys`
     * lists the offenders — which is the shape the App validator turns into one
     * positioned `unknown_field` per key (schema.md §23, T6).
     */
    it('rejects an unknown key, naming it and where it sits (schema.md §24.4 `replica`)', () => {
        const result = appSpecSchema.safeParse(
            withLeaf(validSpec, ['components', 0], { name: 'web', role: 'web', replica: 2 }),
        );
        expect(result.success).toBe(false);
        expect(result.success ? [] : result.error.issues).toEqual([
            expect.objectContaining({
                code: 'unrecognized_keys',
                path: ['components', 0],
                keys: ['replica'],
            }),
        ]);
    });
});

// ---------------------------------------------------------------------------
// ACC-03-02 — extension keys and a newer appSpecVersion
// ---------------------------------------------------------------------------

describe('extension keys (schema.md §2:74-75, ACC-03-02)', () => {
    /** `x-` keys at four depths, exactly as §2 allows them. */
    const withExtensions = {
        ...validSpec,
        'x-note': 'kept in the file, ignored by the platform',
        build: { ...validSpec.build, 'x-build-tool': 'turbo' },
        components: [
            { ...validSpec.components[0], 'x-owner': 'web-team' },
            validSpec.components[1],
        ],
        env: [{ ...validSpec.env[0], 'x-rotation': 'manual' }, ...validSpec.env.slice(1)],
    };

    it('stripExtensionKeys removes every `x-` key at every depth', () => {
        expect(extensionKeyPaths(withExtensions).length).toBeGreaterThan(0);
        expect(extensionKeyPaths(stripExtensionKeys(withExtensions))).toEqual([]);
    });

    it('the stripped copy parses with zero issues', () => {
        expectAccepted(stripExtensionKeys(withExtensions));
    });

    it('leaves the document it was given untouched', () => {
        const before = JSON.stringify(withExtensions);
        stripExtensionKeys(withExtensions);
        expect(JSON.stringify(withExtensions)).toBe(before);
        expect(withExtensions['x-note']).toBeDefined();
        expect(withExtensions.build['x-build-tool']).toBeDefined();
    });

    it('returns a copy, not the same object', () => {
        const stripped = stripExtensionKeys(withExtensions) as Record<string, unknown>;
        expect(stripped).not.toBe(withExtensions);
        expect(stripped.display).not.toBe(withExtensions.display);
        expect((stripped.components as unknown[])[0]).not.toBe(withExtensions.components[0]);
    });

    /**
     * The strict objects do not know the `x-` exception: they report it like any
     * other unknown key. That is why the pipeline removes the extension keys from
     * a copy **before** parsing (plan §2.2:137-138) — the silence ACC-03-02 asks
     * for is the validator's, and this is the structural half of it.
     */
    it('the raw document is what the strict schema reports, before stripping', () => {
        // One issue per object that carries an extension key: the spec root,
        // `build`, `components[0]` and `env[0]` — four in this fixture.
        expect(issueCodes(withExtensions)).toEqual([
            'unrecognized_keys',
            'unrecognized_keys',
            'unrecognized_keys',
            'unrecognized_keys',
        ]);
    });

    it('keeps a `__proto__` key an ordinary key rather than reaching the prototype', () => {
        const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
        const stripped = stripExtensionKeys(hostile) as Record<string, unknown>;
        expect(Object.getPrototypeOf(stripped)).toBe(Object.prototype);
        expect(Object.prototype.hasOwnProperty.call(stripped, '__proto__')).toBe(true);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
});

describe('a newer appSpecVersion (schema.md §1:65, §2:76-77, ACC-03-02)', () => {
    it('accepts a version newer than this build understands', () => {
        const newer = withLeaf(validSpec, ['appSpecVersion'], APP_SPEC_VERSION + 1);
        expectAccepted(newer);
        expect(newer).toMatchObject({ appSpecVersion: APP_SPEC_VERSION + 1 });
        expect(APP_SPEC_VERSION + 1).toBeLessThanOrEqual(APP_SPEC_VERSION_MAX);
    });

    it('hands the declared version to the validator so it can downgrade the code', () => {
        const result = appSpecSchema.safeParse(
            withLeaf(validSpec, ['appSpecVersion'], APP_SPEC_VERSION + 1),
        );
        expect(result.success && result.data.appSpecVersion).toBe(APP_SPEC_VERSION + 1);
    });

    /**
     * The downgrade itself is T6's: the schema reports the same
     * `unrecognized_keys` issue at any version and exposes `appSpecVersion` in
     * its output, which is the whole of what the validator needs to rewrite
     * `unknown_field` into the warning `unknown_field_newer_version`.
     */
    it('reports an unknown key identically at both versions', () => {
        const unknownKey = { ...validSpec, rpelicas: 2 };
        expect(issueCodes(unknownKey)).toEqual(['unrecognized_keys']);
        expect(issueCodes({ ...unknownKey, appSpecVersion: APP_SPEC_VERSION + 1 })).toEqual([
            'unrecognized_keys',
        ]);
    });
});

// ---------------------------------------------------------------------------
// ACC-03-49 — keypair formats and `build.strategy: auto`
// ---------------------------------------------------------------------------

describe('key pair formats (schema.md §12:268-305, ACC-03-49)', () => {
    /** The `pem`, `base64url-raw` and `pkcs12` examples of §12:285-306, verbatim. */
    const keypairExamples: ReadonlyArray<[string, Record<string, unknown>]> = [
        [
            'pem — a JWT signing key (the default format)',
            {
                name: 'JWT_SIGNING_KEY',
                secret: true,
                generate: { kind: 'keypair', keypair: { type: 'ed25519' } },
            },
        ],
        [
            'base64url-raw — web-push keys with a fixed 43-character length',
            {
                name: 'VAPID_PRIVATE_KEY',
                secret: true,
                generate: {
                    kind: 'keypair',
                    keypair: { type: 'ec-p256', format: 'base64url-raw' },
                },
                validate: { length: 43, pattern: '^[A-Za-z0-9_-]{43}$' },
            },
        ],
        [
            'pkcs12 — a key protected by a separately generated password',
            {
                name: 'SAML_SIGNING_KEY',
                secret: true,
                generate: {
                    kind: 'keypair',
                    keypair: {
                        type: 'rsa-2048',
                        format: 'pkcs12',
                        passwordEnv: 'SAML_KEY_PASSWORD',
                    },
                },
            },
        ],
    ];

    it.each(keypairExamples)('%s parses', (_name, entry) => {
        expectAccepted(
            withLeaf(
                validSpec,
                ['env'],
                [
                    entry,
                    {
                        name: 'SAML_KEY_PASSWORD',
                        secret: true,
                        generate: { kind: 'chars', length: 32, alphabet: 'alnum' },
                    },
                ],
            ),
        );
    });

    /**
     * §12:303-305's two **invalid** examples must still parse.
     *
     * `rsa-4096` with `base64url-raw` is `keypair_format_unsupported` (R25) and
     * `pkcs12` without a password entry is `keypair_password_invalid` (R26) —
     * both §22 rules, so both need a document that parses. A schema refinement
     * here would refuse them and take the two codes away from the layer that owns
     * them.
     */
    it.each([
        [
            'rsa-4096 with base64url-raw parses (R25 reports it)',
            {
                name: 'BAD_RAW',
                secret: true,
                generate: {
                    kind: 'keypair',
                    keypair: { type: 'rsa-4096', format: 'base64url-raw' },
                },
            },
        ],
        [
            'pkcs12 without a password entry parses (R26 reports it)',
            {
                name: 'BAD_P12',
                secret: true,
                generate: { kind: 'keypair', keypair: { type: 'ec-p256', format: 'pkcs12' } },
            },
        ],
    ] as ReadonlyArray<[string, Record<string, unknown>]>)('%s', (_name, entry) => {
        expectAccepted(withLeaf(validSpec, ['env'], [entry]));
    });

    it('accepts `build.strategy: auto` and refuses every other strategy string', () => {
        expectAccepted(withLeaf(validSpec, ['build', 'strategy'], 'auto'));
        for (const refused of ['automatic', 'buildpacks', 'nixpacks', 'Dockerfile', '']) {
            expectRefused(withLeaf(validSpec, ['build', 'strategy'], refused));
        }
    });
});

// ---------------------------------------------------------------------------
// Validation modes (schema.md §3, corrected 2026-09-17)
// ---------------------------------------------------------------------------

describe('validation modes (schema.md §3)', () => {
    it('names exactly the two modes of the table, as it now reads', () => {
        expect(APP_SPEC_VALIDATION_MODES).toEqual(['data-repository', 'blueprint']);
    });

    it('blueprint mode allows and expects `source` and `blueprint`', () => {
        expect(APP_SPEC_BLUEPRINT_MODE_ALLOWED_KEYS).toEqual(['source', 'blueprint']);
    });

    /**
     * A Blueprint repository's own file — `source`, `blueprint` and all three of
     * the keys APW-13's Blueprints declare — is validatable with exactly the rules
     * the platform runs. Before the 2026-09-17 correction, `blueprint` mode
     * forbade the first two, which no Blueprint could satisfy.
     */
    it('parses a Blueprint repository document that declares both keys', () => {
        expectAccepted({
            kind: 'app',
            appSpecVersion: APP_SPEC_VERSION,
            source: {
                relation: 'fork',
                upstream: { repo: 'calcom/cal.diy', defaultBranch: 'main' },
                branch: 'main',
            },
            blueprint: validSpec.blueprint,
            build: validSpec.build,
            components: validSpec.components,
            license: validSpec.license,
        });
    });
});

// ---------------------------------------------------------------------------
// Registration (plan §2.2:125)
// ---------------------------------------------------------------------------

describe('registration in the works.yml envelope', () => {
    it('is the schema the envelope dispatches to for kind `app`', () => {
        expect(KIND_SPEC_SCHEMAS.app).toBe(appSpecSchema);
    });

    /**
     * T7 replaces this dispatch with `validateAppSpecObject`; either way the
     * envelope accepts an App spec for `kind: app` and reports no errors for it.
     */
    it('validates an App spec through `validateWorksConfig`', () => {
        const result = validateWorksConfig({ version: 2, kind: 'app', spec: validSpec });
        expect(result.errors).toEqual([]);
    });
});
