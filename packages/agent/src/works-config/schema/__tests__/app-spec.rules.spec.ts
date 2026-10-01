import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineCounter, isMap, isScalar, isSeq, parse as parseYaml, parseDocument } from 'yaml';
import type { AppSpec, AppSpecIssueCode, AppSpecSeverity } from '@ever-works/contracts';
import {
    APP_SPEC_RULES,
    APP_SPEC_RULE_ISSUE_CODES,
    APP_SPEC_HTTP_BODY_MAX_BYTES,
    displayPathFor,
    evaluateAppSpecRules,
    generatedLength,
    generateSamples,
    isRe2Pattern,
    nearestPosition,
    parseCpuCores,
    parseMemoryMi,
    pointerToPath,
    type AppSpecRuleContext,
    type AppSpecRuleFinding,
    type AppSpecRuleId,
    type AppSpecRulePosition,
} from '../app-spec.rules';
import { APP_SPEC_ISSUE_ROOT } from '../app-spec.refs';
import { appSpecSchema } from '../app-spec.schema';

/**
 * T5 — the §22 cross-field rules, R1–R27 (`tasks.md:147-156`).
 *
 * The evidence this file owes, and how it is produced:
 *
 * 1. **A failing and a passing fixture per rule, asserting code, severity, line
 *    and column** (ACC-03-03). {@link RULE_CASES} holds one row per (rule, code)
 *    — the completeness case proves every id of §22 and every code of every rule
 *    has both halves. `line`/`column` are checked against
 *    {@link positionOf}, which finds the key by **plain text search** in the
 *    fixture, so the assertion is independent of the pointer map it checks.
 * 2. **R19 is an error in `blueprint` mode for a verified entry.**
 * 3. **The §12 invalid examples report exactly `keypair_format_unsupported` and
 *    `keypair_password_invalid`** (ACC-03-49).
 * 4. **A default context reports no context-dependent issue at all** — §22:502.
 *
 * Fixtures are whole `.works/works.yml` documents and every one of them is
 * parsed through `appSpecSchema` first ({@link evaluate}), so a rule test can
 * never pass because its fixture was structurally refusable. The one exception
 * is R22, whose property the `RelPath` pattern of `app-spec.schema.ts` (T3)
 * already enforces structurally: it is evaluated with `schema: false` and the
 * reason is stated at its row.
 */

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

/** A whole `.works/works.yml` from the lines of its `spec:` block. */
function fixture(...body: readonly string[]): string {
    return ['version: 2', 'kind: app', 'name: fixture', 'spec:', ...body].join('\n');
}

/** The 1-based position of the first occurrence of `needle` in `yaml`. */
function positionOf(yaml: string, needle: string): AppSpecRulePosition {
    const index = yaml.indexOf(needle);
    if (index < 0) throw new Error(`positionOf: ${JSON.stringify(needle)} is not in the fixture`);
    const before = yaml.slice(0, index);
    return { line: before.split('\n').length, column: index - before.lastIndexOf('\n') };
}

/** The pointer → position map T6 builds from its `LineCounter`. */
function positionsFor(yaml: string): (pointer: string) => AppSpecRulePosition | null {
    const counter = new LineCounter();
    const document = parseDocument(yaml, { lineCounter: counter });
    const map = new Map<string, AppSpecRulePosition>();

    const walk = (node: unknown, pointer: string): void => {
        if (isMap(node)) {
            for (const item of node.items) {
                if (!isScalar(item.key)) continue;
                const child = `${pointer}/${String(item.key.value)}`;
                const range = item.key.range;
                if (range !== undefined && range !== null) {
                    const position = counter.linePos(range[0]);
                    map.set(child, { line: position.line, column: position.col });
                }
                walk(item.value, child);
            }
            return;
        }
        if (isSeq(node)) {
            node.items.forEach((item, index) => walk(item, `${pointer}/${index}`));
        }
    };

    walk(document.contents, '');
    return (pointer) => map.get(pointer) ?? null;
}

interface EvaluateOptions {
    readonly context?: AppSpecRuleContext;
    /** `false` skips the structural parse — only R22's fixture needs that. */
    readonly schema?: boolean;
}

/** Parse a fixture, then run §22 over it with real YAML positions. */
function evaluate(yaml: string, options: EvaluateOptions = {}): readonly AppSpecRuleFinding[] {
    const spec = parseYaml(yaml)?.spec as AppSpec;
    if (options.schema !== false) {
        const parsed = appSpecSchema.safeParse(spec);
        if (!parsed.success) {
            throw new Error(
                `fixture is not structurally valid: ${JSON.stringify(parsed.error.issues)}`,
            );
        }
    }
    return evaluateAppSpecRules(spec, {
        ...(options.context ?? {}),
        positions: positionsFor(yaml),
    });
}

/** The codes a finding list carries, deduplicated and sorted. */
function codesOf(findings: readonly AppSpecRuleFinding[]): readonly string[] {
    return [...new Set(findings.map((finding) => finding.code))].sort();
}

/** The findings carrying one code. */
function withCode(
    findings: readonly AppSpecRuleFinding[],
    code: AppSpecIssueCode,
): readonly AppSpecRuleFinding[] {
    return findings.filter((finding) => finding.code === code);
}

/** The position a finding reports, as `line:column`. */
function at(finding: AppSpecRuleFinding): string {
    return `${finding.line}:${finding.column}`;
}

// ---------------------------------------------------------------------------
// The case table: one failing and one passing fixture per (rule, code)
// ---------------------------------------------------------------------------

interface RuleCase {
    readonly id: AppSpecRuleId;
    readonly name: string;
    readonly code: AppSpecIssueCode;
    readonly severity: AppSpecSeverity;
    /** A unique snippet of the failing fixture whose start is the expected position. */
    readonly at: string;
    readonly failing: string;
    readonly passing: string;
    readonly context?: AppSpecRuleContext;
    /** Codes the failing fixture legitimately reports *besides* {@link code}. */
    readonly alsoCodes?: readonly AppSpecIssueCode[];
    /** Codes the passing fixture legitimately reports. */
    readonly passingCodes?: readonly AppSpecIssueCode[];
    /** `false` when T3's structural layer already refuses the fixture (R22). */
    readonly schema?: boolean;
}

const WEB_COMPONENT = '        - { name: web, role: web, port: 3000 }';
const POSTGRES = "    dependencies: { postgres: { version: '16' } }";

/** A `template` chain of `count` entries, `E0 → E1 → …` — R5's depth case. */
function chain(count: number): string {
    const lines: string[] = ['    env:'];
    for (let index = 0; index < count; index += 1) {
        lines.push(
            index === count - 1
                ? `        - { name: E${index}, value: x }`
                : `        - { name: E${index}, template: '{{env.E${index + 1}}}' }`,
        );
    }
    return fixture(...lines);
}

const RULE_CASES: readonly RuleCase[] = [
    // -- R1 ------------------------------------------------------------------
    {
        id: 'R1',
        name: 'a web component without a port',
        code: 'web_component_needs_port',
        severity: 'error',
        at: 'components:',
        failing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            '        - { name: web, role: web }',
        ),
        passing: fixture('    build: { strategy: dockerfile }', '    components:', WEB_COMPONENT),
    },

    // -- R2 ------------------------------------------------------------------
    {
        id: 'R2',
        name: 'a build strategy with no components',
        code: 'strategy_requires_components',
        severity: 'error',
        at: 'strategy: dockerfile',
        failing: fixture('    build: { strategy: dockerfile }'),
        passing: fixture('    build: { strategy: dockerfile }', '    components:', WEB_COMPONENT),
    },
    {
        id: 'R2',
        name: 'components with no build strategy',
        code: 'components_require_strategy',
        severity: 'error',
        at: 'build: {}',
        failing: fixture('    build: {}', '    components:', WEB_COMPONENT),
        passing: fixture('    build: { strategy: dockerfile }', '    components:', WEB_COMPONENT),
    },

    // -- R3 ------------------------------------------------------------------
    {
        id: 'R3',
        name: 'domains.primaryComponent naming a worker',
        code: 'primary_component_invalid',
        severity: 'error',
        at: 'primaryComponent: worker',
        failing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            WEB_COMPONENT,
            '        - { name: worker, role: worker }',
            '    domains: { primaryComponent: worker }',
        ),
        passing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            WEB_COMPONENT,
            '        - { name: worker, role: worker }',
            '    domains: { primaryComponent: web }',
        ),
    },

    // -- R4 ------------------------------------------------------------------
    {
        id: 'R4',
        name: 'two components with the same name',
        code: 'duplicate_name',
        severity: 'error',
        at: 'name: web, role: worker',
        failing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            WEB_COMPONENT,
            '        - { name: web, role: worker }',
        ),
        passing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            WEB_COMPONENT,
            '        - { name: worker, role: worker }',
        ),
    },
    {
        id: 'R4',
        name: 'an env entry declaring the implicit <NAME>_PUBLIC of a key pair',
        code: 'duplicate_name',
        severity: 'error',
        at: 'name: VAPID_PRIVATE_KEY_PUBLIC',
        failing: fixture(
            '    env:',
            '        - { name: VAPID_PRIVATE_KEY, secret: true, generate: { kind: keypair, keypair: { type: ec-p256, format: base64url-raw } } }',
            "        - { name: VAPID_PRIVATE_KEY_PUBLIC, value: 'x' }",
        ),
        passing: fixture(
            '    env:',
            '        - { name: VAPID_PRIVATE_KEY, secret: true, generate: { kind: keypair, keypair: { type: ec-p256, format: base64url-raw } } }',
            "        - { name: VAPID_PUBLIC_KEY, value: 'x' }",
        ),
    },

    // -- R5 ------------------------------------------------------------------
    {
        id: 'R5',
        name: 'a from: naming an undeclared dependency',
        code: 'reference_unresolved',
        severity: 'error',
        at: 'from: deps.postgres.url',
        failing: fixture(
            '    env:',
            '        - { name: DATABASE_URL, secret: true, from: deps.postgres.url }',
        ),
        passing: fixture(
            POSTGRES,
            '    env:',
            '        - { name: DATABASE_URL, secret: true, from: deps.postgres.url }',
        ),
    },
    {
        id: 'R5',
        name: 'a malformed reference is reference_syntax, never pattern',
        code: 'reference_syntax',
        severity: 'error',
        at: "from: '{{deps.postgres.url}}'",
        failing: fixture(
            POSTGRES,
            '    env:',
            "        - { name: DATABASE_URL, secret: true, from: '{{deps.postgres.url}}' }",
        ),
        passing: fixture(
            POSTGRES,
            '    env:',
            '        - { name: DATABASE_URL, secret: true, from: deps.postgres.url }',
        ),
    },
    {
        id: 'R5',
        name: 'two template entries naming each other',
        code: 'template_cycle',
        severity: 'error',
        at: "template: '{{env.CYCLE_B}}'",
        failing: fixture(
            '    env:',
            "        - { name: CYCLE_A, template: '{{env.CYCLE_B}}' }",
            "        - { name: CYCLE_B, template: '{{env.CYCLE_A}}' }",
        ),
        passing: fixture(
            '    env:',
            "        - { name: CYCLE_B, value: 'x' }",
            "        - { name: CYCLE_A, template: '{{env.CYCLE_B}}' }",
        ),
    },
    {
        id: 'R5',
        name: 'a template chain deeper than 10',
        code: 'template_too_deep',
        severity: 'error',
        at: "template: '{{env.E1}}'",
        failing: chain(11),
        passing: chain(10),
    },

    // -- R6 ------------------------------------------------------------------
    {
        id: 'R6',
        name: 'a from: naming a secret output without secret: true',
        code: 'secret_reference_not_secret',
        severity: 'error',
        at: 'env:',
        failing: fixture(
            POSTGRES,
            '    env:',
            '        - { name: DATABASE_URL, from: deps.postgres.url }',
        ),
        passing: fixture(
            POSTGRES,
            '    env:',
            '        - { name: DATABASE_URL, secret: true, from: deps.postgres.url }',
        ),
    },
    {
        id: 'R6',
        name: 'a runtime entry templating a build-only entry',
        code: 'phase_mismatch',
        severity: 'error',
        at: "template: '{{env.BUILT}}'",
        failing: fixture(
            '    env:',
            "        - { name: BUILT, phase: build, value: 'x' }",
            "        - { name: RUNTIME, template: '{{env.BUILT}}' }",
        ),
        passing: fixture(
            '    env:',
            "        - { name: BUILT, phase: both, value: 'x' }",
            "        - { name: RUNTIME, template: '{{env.BUILT}}' }",
        ),
    },

    // -- R7 ------------------------------------------------------------------
    {
        id: 'R7',
        name: 'an env entry with no value source',
        code: 'env_source_count',
        severity: 'error',
        // The problem is the entry's set of sources, so the pointer is the entry
        // itself and §23:533's fallback lands on the nearest key that exists.
        at: 'env:',
        failing: fixture('    env:', '        - { name: EMPTY }'),
        passing: fixture('    env:', "        - { name: EMPTY, value: 'x' }"),
    },

    // -- R8 ------------------------------------------------------------------
    {
        id: 'R8',
        name: 'a secret entry carrying a literal value',
        code: 'literal_secret_value',
        severity: 'error',
        at: 'value: hunter2',
        failing: fixture('    env:', '        - { name: TOKEN, secret: true, value: hunter2 }'),
        passing: fixture(
            '    env:',
            '        - { name: TOKEN, secret: true, generate: { kind: uuid } }',
        ),
    },

    // -- R9 ------------------------------------------------------------------
    {
        id: 'R9',
        name: 'validate.length disagreeing with the generated length',
        code: 'generate_validate_conflict',
        severity: 'error',
        at: 'length: 43',
        failing: fixture(
            '    env:',
            '        - { name: APP_SECRET, secret: true, generate: { kind: hex, bytes: 32 }, validate: { length: 43 } }',
        ),
        passing: fixture(
            '    env:',
            '        - { name: APP_SECRET, secret: true, generate: { kind: hex, bytes: 32 }, validate: { length: 64 } }',
        ),
    },

    // -- R10 -----------------------------------------------------------------
    {
        id: 'R10',
        name: 'a build argument whose name promises a secret',
        code: 'literal_secret_in_build_args',
        severity: 'error',
        at: "value: '<a real key pasted here>'",
        failing: fixture(
            "    build: { strategy: dockerfile, args: [{ name: PAYMENTS_SECRET_KEY, value: '<a real key pasted here>' }] }",
            '    components:',
            WEB_COMPONENT,
        ),
        passing: fixture(
            "    build: { strategy: dockerfile, args: [{ name: LOG_LEVEL, value: 'info' }] }",
            '    components:',
            WEB_COMPONENT,
        ),
    },

    // -- R11 -----------------------------------------------------------------
    {
        id: 'R11',
        name: 'a build argument baked from a secret env entry',
        code: 'secret_build_arg',
        severity: 'warning',
        at: 'fromEnv: JWT_SIGNING_KEY',
        failing: fixture(
            '    build: { strategy: dockerfile, args: [{ name: KEY, fromEnv: JWT_SIGNING_KEY }] }',
            '    components:',
            WEB_COMPONENT,
            '    env:',
            '        - { name: JWT_SIGNING_KEY, secret: true, phase: both, generate: { kind: uuid } }',
        ),
        passing: fixture(
            '    build: { strategy: dockerfile, args: [{ name: KEY, fromEnv: JWT_SIGNING_KEY }] }',
            '    components:',
            WEB_COMPONENT,
            '    env:',
            "        - { name: JWT_SIGNING_KEY, phase: both, value: 'x' }",
        ),
    },

    // -- R12 -----------------------------------------------------------------
    {
        id: 'R12',
        name: 'upstreamPullRequests.requireApproval: false',
        code: 'upstream_pr_approval_required',
        severity: 'error',
        at: 'requireApproval: false',
        failing: fixture(
            '    source: { relation: fork, upstream: { repo: calcom/cal.diy } }',
            '    upstreamPullRequests: { enabled: false, requireApproval: false }',
        ),
        passing: fixture(
            '    source: { relation: fork, upstream: { repo: calcom/cal.diy } }',
            '    upstreamPullRequests: { enabled: false, requireApproval: true }',
        ),
    },

    // -- R13 -----------------------------------------------------------------
    {
        id: 'R13',
        name: 'source.relation: link with an upstream',
        code: 'upstream_forbidden_for_link',
        severity: 'error',
        at: 'upstream: { repo: calcom/cal.diy }',
        failing: fixture('    source: { relation: link, upstream: { repo: calcom/cal.diy } }'),
        passing: fixture('    source: { relation: link }'),
    },
    {
        id: 'R13',
        name: 'upstreamSync on a linked repository',
        code: 'upstream_sync_requires_upstream',
        severity: 'error',
        at: 'upstreamSync:',
        failing: fixture(
            '    source: { relation: link }',
            "    upstreamSync: { schedule: '0 6 * * 1' }",
        ),
        passing: fixture('    source: { relation: link }'),
    },
    {
        id: 'R13',
        name: 'upstream pull requests on a private copy',
        code: 'upstream_prs_require_fork',
        severity: 'error',
        at: 'enabled: true',
        failing: fixture(
            '    source: { relation: private-copy, upstream: { repo: example-org/helpdesk } }',
            '    upstreamPullRequests: { enabled: true }',
        ),
        passing: fixture(
            '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
            '    upstreamPullRequests: { enabled: true }',
        ),
    },

    // -- R14 -----------------------------------------------------------------
    {
        id: 'R14',
        name: 'a job naming a component that does not exist',
        code: 'component_ref_unknown',
        severity: 'error',
        at: 'component: api',
        failing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            WEB_COMPONENT,
            '    jobs:',
            "        - { name: migrate, when: pre-deploy, component: api, command: ['x'] }",
        ),
        passing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            WEB_COMPONENT,
            '    jobs:',
            "        - { name: migrate, when: pre-deploy, component: web, command: ['x'] }",
        ),
    },

    // -- R15 -----------------------------------------------------------------
    {
        id: 'R15',
        name: 'http.authEnv naming an entry that is not secret',
        code: 'auth_env_not_secret',
        severity: 'error',
        at: 'authEnv: PUBLIC_TOKEN',
        failing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            WEB_COMPONENT,
            '    env:',
            "        - { name: PUBLIC_TOKEN, value: 'x' }",
            '    jobs:',
            '        - { name: setup, when: first-deploy, component: web, http: { path: /setup, authEnv: PUBLIC_TOKEN } }',
        ),
        passing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            WEB_COMPONENT,
            '    env:',
            '        - { name: PUBLIC_TOKEN, secret: true, generate: { kind: uuid } }',
            '    jobs:',
            '        - { name: setup, when: first-deploy, component: web, http: { path: /setup, authEnv: PUBLIC_TOKEN } }',
        ),
    },

    // -- R16 -----------------------------------------------------------------
    {
        id: 'R16',
        name: 'domains.publicUrlEnv naming an entry that does not exist',
        code: 'reference_unresolved',
        severity: 'error',
        at: 'publicUrlEnv: [MISSING_URL]',
        failing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            WEB_COMPONENT,
            '    domains: { publicUrlEnv: [MISSING_URL] }',
        ),
        passing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            WEB_COMPONENT,
            '    env:',
            "        - { name: PUBLIC_URL, value: 'x' }",
            '    domains: { publicUrlEnv: [PUBLIC_URL] }',
        ),
    },

    // -- R17 -----------------------------------------------------------------
    {
        id: 'R17',
        name: 'cpuLimit below the cpu request',
        code: 'limit_below_request',
        severity: 'error',
        at: 'cpuLimit: 250m',
        failing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            '        - { name: web, role: web, port: 3000, resources: { cpu: 500m, cpuLimit: 250m, memory: 512Mi, memoryLimit: 1Gi } }',
        ),
        passing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            "        - { name: web, role: web, port: 3000, resources: { cpu: 500m, cpuLimit: '1', memory: 512Mi, memoryLimit: 1Gi } }",
        ),
    },
    {
        id: 'R17',
        name: 'memoryLimit below the memory request',
        code: 'limit_below_request',
        severity: 'error',
        at: 'memoryLimit: 512Mi',
        failing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            "        - { name: web, role: web, port: 3000, resources: { cpu: 500m, cpuLimit: '1', memory: 1Gi, memoryLimit: 512Mi } }",
        ),
        passing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            "        - { name: web, role: web, port: 3000, resources: { cpu: 500m, cpuLimit: '1', memory: 512Mi, memoryLimit: 1Gi } }",
        ),
    },

    // -- R18 -----------------------------------------------------------------
    {
        id: 'R18',
        name: 'a volume on a component with more than one replica',
        code: 'volume_replicas',
        severity: 'error',
        at: 'replicas: 2',
        failing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            '        - { name: web, role: web, port: 3000, replicas: 2, volumes: [{ name: data, path: /data, size: 1Gi }] }',
        ),
        passing: fixture(
            '    build: { strategy: dockerfile }',
            '    components:',
            '        - { name: web, role: web, port: 3000, replicas: 1, volumes: [{ name: data, path: /data, size: 1Gi }] }',
        ),
    },

    // -- R19 -----------------------------------------------------------------
    {
        id: 'R19',
        name: 'a tag-only prebuilt image',
        code: 'image_not_pinned',
        severity: 'warning',
        at: "image: 'ghcr.io/example/app:1.2.3'",
        failing: fixture(
            "    build: { strategy: image, image: 'ghcr.io/example/app:1.2.3' }",
            '    components:',
            WEB_COMPONENT,
        ),
        passing: fixture(
            "    build: { strategy: image, image: 'ghcr.io/example/app@sha256:9f2c1e0b7a4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7c6b5a49' }",
            '    components:',
            WEB_COMPONENT,
        ),
    },

    // -- R20 -----------------------------------------------------------------
    {
        id: 'R20',
        name: 'an advisory check',
        code: 'advisory_check',
        severity: 'warning',
        at: 'required: false',
        failing: fixture(
            '    checks:',
            "        - { name: lint, command: 'pnpm lint', required: false }",
        ),
        passing: fixture(
            '    checks:',
            "        - { name: lint, command: 'pnpm lint', required: true }",
        ),
    },

    // -- R21 -----------------------------------------------------------------
    {
        id: 'R21',
        name: 'an upstream sync schedule that fires more than hourly',
        code: 'schedule_too_frequent',
        severity: 'error',
        at: "schedule: '*/15 * * * *'",
        failing: fixture(
            '    source: { relation: fork, upstream: { repo: calcom/cal.diy } }',
            "    upstreamSync: { schedule: '*/15 * * * *' }",
        ),
        passing: fixture(
            '    source: { relation: fork, upstream: { repo: calcom/cal.diy } }',
            "    upstreamSync: { schedule: '0 6 * * 1' }",
        ),
    },

    // -- R22 -----------------------------------------------------------------
    {
        id: 'R22',
        name: 'a build context outside the repository',
        code: 'path_outside_repository',
        severity: 'error',
        at: 'context: ../outside',
        // T3's `RelPath` pattern already refuses this structurally, which is why
        // the pipeline reports `pattern` and T6 removes the leaf before the rules
        // run (schema.md:511-513). The rule is the second guard, and it is
        // exercised directly here.
        schema: false,
        failing: fixture(
            '    build: { strategy: dockerfile, context: ../outside }',
            '    components:',
            WEB_COMPONENT,
        ),
        passing: fixture(
            '    build: { strategy: dockerfile, context: . }',
            '    components:',
            WEB_COMPONENT,
        ),
    },
    {
        id: 'R22',
        name: 'an absolute protected path',
        code: 'path_outside_repository',
        severity: 'error',
        at: 'protectedPaths: [/etc/passwd]',
        schema: false,
        failing: fixture('    display: { protectedPaths: [/etc/passwd] }'),
        passing: fixture("    display: { protectedPaths: ['apps/web/**'] }"),
    },

    // -- R23 -----------------------------------------------------------------
    {
        id: 'R23',
        name: 'an env entry using the reserved EVER_WORKS_ prefix',
        code: 'reserved_env_name',
        severity: 'error',
        at: 'name: EVER_WORKS_APP_URL',
        failing: fixture('    env:', "        - { name: EVER_WORKS_APP_URL, value: 'x' }"),
        passing: fixture('    env:', "        - { name: APP_URL, value: 'x' }"),
    },

    // -- R24 -----------------------------------------------------------------
    {
        id: 'R24',
        name: 'a declared green class the registry disagrees with',
        code: 'license_declared_mismatch',
        severity: 'warning',
        at: 'class: green',
        context: {
            licenseClassFor: (spdx: string) => (spdx === 'AGPL-3.0-only' ? 'amber' : 'green'),
        },
        failing: fixture("    license: { spdx: AGPL-3.0-only, class: green, source: 'detected' }"),
        passing: fixture("    license: { spdx: MIT, class: green, source: 'detected' }"),
    },

    // -- R25 -----------------------------------------------------------------
    {
        id: 'R25',
        name: 'base64url-raw on an RSA key pair',
        code: 'keypair_format_unsupported',
        severity: 'error',
        at: 'format: base64url-raw',
        failing: fixture(
            '    env:',
            '        - { name: BAD_RAW, secret: true, generate: { kind: keypair, keypair: { type: rsa-4096, format: base64url-raw } } }',
        ),
        passing: fixture(
            '    env:',
            '        - { name: GOOD_RAW, secret: true, generate: { kind: keypair, keypair: { type: ed25519, format: base64url-raw } } }',
        ),
    },

    // -- R26 -----------------------------------------------------------------
    {
        id: 'R26',
        name: 'pkcs12 without a password entry',
        code: 'keypair_password_invalid',
        severity: 'error',
        at: 'keypair: { type: ec-p256, format: pkcs12 }',
        failing: fixture(
            '    env:',
            '        - { name: BAD_P12, secret: true, generate: { kind: keypair, keypair: { type: ec-p256, format: pkcs12 } } }',
        ),
        passing: fixture(
            '    env:',
            '        - { name: SAML_KEY_PASSWORD, secret: true, generate: { kind: chars, length: 32, alphabet: alnum } }',
            '        - { name: SAML_SIGNING_KEY, secret: true, generate: { kind: keypair, keypair: { type: rsa-2048, format: pkcs12, passwordEnv: SAML_KEY_PASSWORD } } }',
        ),
    },

    // -- R27 -----------------------------------------------------------------
    {
        id: 'R27',
        name: 'a private copy with no source offer URL',
        code: 'sourceOfferMissing',
        severity: 'error',
        at: 'license: { spdx: MIT, class: green, source: user }',
        context: { recordedRelation: 'private-copy' },
        failing: fixture(
            '    source: { relation: private-copy, upstream: { repo: example-org/helpdesk } }',
            '    license: { spdx: MIT, class: green, source: user }',
        ),
        passing: fixture(
            '    source: { relation: private-copy, upstream: { repo: example-org/helpdesk } }',
            "    license: { spdx: MIT, class: green, source: user, sourceOfferUrl: 'https://example.com/src' }",
        ),
    },
];

// ---------------------------------------------------------------------------
// The table, run
// ---------------------------------------------------------------------------

describe('schema.md §22 — a failing and a passing fixture per rule', () => {
    it.each(RULE_CASES)('$id — $name', (testCase) => {
        const failing = evaluate(testCase.failing, {
            context: testCase.context,
            schema: testCase.schema,
        });
        const found = withCode(failing, testCase.code);

        // Exactly one finding for the code, and no unrelated code beside it.
        expect(found.length).toBe(1);
        expect(found[0].severity).toBe(testCase.severity);
        expect(codesOf(failing)).toEqual([testCase.code, ...(testCase.alsoCodes ?? [])].sort());
        expect(found[0].pointer.startsWith(`${APP_SPEC_ISSUE_ROOT}/`)).toBe(true);
        expect(found[0].path.startsWith('spec.')).toBe(true);
        expect(found[0].displayPath).not.toBe('');

        // …and it points at the key the author must touch, in the real text.
        expect(at(found[0])).toBe(
            `${positionOf(testCase.failing, testCase.at).line}:${positionOf(testCase.failing, testCase.at).column}`,
        );

        // The passing fixture reports nothing of this code (and nothing else,
        // unless the row says so).
        const passing = evaluate(testCase.passing, {
            context: testCase.context,
            schema: testCase.schema,
        });
        expect(withCode(passing, testCase.code)).toEqual([]);
        expect(codesOf(passing)).toEqual([...(testCase.passingCodes ?? [])].sort());
    });

    it('covers every rule id of §22', () => {
        const covered = [...new Set(RULE_CASES.map((testCase) => testCase.id))].sort(
            (left, right) => Number(left.slice(1)) - Number(right.slice(1)),
        );
        const expected = APP_SPEC_RULES.map((rule) => rule.id);
        expect(covered).toEqual(expected);
        expect(expected.length).toBe(27);
    });

    it('covers every code of every rule', () => {
        for (const rule of APP_SPEC_RULES) {
            const covered = new Set(
                RULE_CASES.filter((testCase) => testCase.id === rule.id).map(
                    (testCase) => testCase.code,
                ),
            );
            expect({ id: rule.id, codes: [...covered].sort() }).toEqual({
                id: rule.id,
                codes: [...rule.codes].sort(),
            });
        }
    });

    it('every code the rules report belongs to the rule that reported it', () => {
        const declared = new Map(APP_SPEC_RULES.map((rule) => [rule.id, rule.codes]));
        for (const testCase of RULE_CASES) {
            const failing = evaluate(testCase.failing, {
                context: testCase.context,
                schema: testCase.schema,
            });
            const rule = APP_SPEC_RULES.find((entry) => entry.id === testCase.id);
            const own = rule?.evaluate(
                parseYaml(testCase.failing).spec as AppSpec,
                testCase.context ?? {},
            );
            for (const finding of own ?? []) {
                expect(declared.get(testCase.id)).toContain(finding.code);
            }
            expect(declared.get(testCase.id)).toContain(testCase.code);
            expect(failing.length).toBeGreaterThan(0);
        }
    });

    it('reports every code in APP_SPEC_RULE_ISSUE_CODES for a rule fixture', () => {
        const reported = new Set<string>();
        for (const testCase of RULE_CASES) {
            for (const finding of evaluate(testCase.failing, {
                context: testCase.context,
                schema: testCase.schema,
            })) {
                reported.add(finding.code);
            }
        }
        for (const code of APP_SPEC_RULE_ISSUE_CODES) {
            if (code === 'cron_invalid' || code === 'pattern_unsupported') continue; // companion checks
            if (code === 'out_of_range') continue; // companion check
            expect({ code, covered: reported.has(code) }).toEqual({ code, covered: true });
        }
    });
});

// ---------------------------------------------------------------------------
// R19 in blueprint mode (§22:473), the §12 invalid examples (ACC-03-49)
// ---------------------------------------------------------------------------

describe('R19 — severity depends on where it runs', () => {
    const tagOnly = fixture(
        "    build: { strategy: image, image: 'ghcr.io/example/app:1.2.3' }",
        '    components:',
        WEB_COMPONENT,
    );

    it('is a warning in data-repository mode', () => {
        const findings = withCode(
            evaluate(tagOnly, { context: { mode: 'data-repository' } }),
            'image_not_pinned',
        );
        expect(findings.length).toBe(1);
        expect(findings[0].severity).toBe('warning');
    });

    it('is an error in blueprint mode for a verified entry', () => {
        const findings = withCode(
            evaluate(tagOnly, { context: { mode: 'blueprint', entryVerified: true } }),
            'image_not_pinned',
        );
        expect(findings.length).toBe(1);
        expect(findings[0].severity).toBe('error');
        expect(findings[0].displayPath).toBe('build › image');
    });

    it('stays a warning in blueprint mode for an unverified entry', () => {
        const findings = withCode(
            evaluate(tagOnly, { context: { mode: 'blueprint', entryVerified: false } }),
            'image_not_pinned',
        );
        expect(findings.length).toBe(1);
        expect(findings[0].severity).toBe('warning');
    });
});

describe('schema.md §12 — the key-pair examples (ACC-03-49)', () => {
    /**
     * The `env` block of §12:285-306, verbatim in shape: four valid entries and
     * the two invalid ones §12 names — `BAD_RAW` (`keypair_format_unsupported`)
     * and `BAD_P12` (`keypair_password_invalid`).
     */
    const SECTION_12_ENV = fixture(
        '    env:',
        '        - { name: JWT_SIGNING_KEY, secret: true, generate: { kind: keypair, keypair: { type: ed25519 } } }',
        "        - { name: VAPID_PRIVATE_KEY, secret: true, generate: { kind: keypair, keypair: { type: ec-p256, format: base64url-raw } }, validate: { length: 43, pattern: '^[A-Za-z0-9_-]{43}$' } }",
        '        - { name: SAML_KEY_PASSWORD, secret: true, generate: { kind: chars, length: 32, alphabet: alnum } }',
        '        - { name: SAML_SIGNING_KEY, secret: true, generate: { kind: keypair, keypair: { type: rsa-2048, format: pkcs12, passwordEnv: SAML_KEY_PASSWORD } } }',
        '        - { name: BAD_RAW, secret: true, generate: { kind: keypair, keypair: { type: rsa-4096, format: base64url-raw } } }',
        '        - { name: BAD_P12, secret: true, generate: { kind: keypair, keypair: { type: ec-p256, format: pkcs12 } } }',
    );

    it('reports exactly keypair_format_unsupported and keypair_password_invalid', () => {
        expect(codesOf(evaluate(SECTION_12_ENV))).toEqual([
            'keypair_format_unsupported',
            'keypair_password_invalid',
        ]);
    });

    it('names the two offending entries and no others', () => {
        const findings = evaluate(SECTION_12_ENV);
        expect(findings.map((finding) => finding.params?.entry).sort()).toEqual([
            'BAD_P12',
            'BAD_RAW',
        ]);
        expect(findings.every((finding) => finding.severity === 'error')).toBe(true);
    });

    it('accepts the four valid entries on their own', () => {
        const valid = fixture(
            '    env:',
            '        - { name: JWT_SIGNING_KEY, secret: true, generate: { kind: keypair, keypair: { type: ed25519 } } }',
            "        - { name: VAPID_PRIVATE_KEY, secret: true, generate: { kind: keypair, keypair: { type: ec-p256, format: base64url-raw } }, validate: { length: 43, pattern: '^[A-Za-z0-9_-]{43}$' } }",
            '        - { name: SAML_KEY_PASSWORD, secret: true, generate: { kind: chars, length: 32, alphabet: alnum } }',
            '        - { name: SAML_SIGNING_KEY, secret: true, generate: { kind: keypair, keypair: { type: rsa-2048, format: pkcs12, passwordEnv: SAML_KEY_PASSWORD } } }',
        );
        expect(evaluate(valid)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// §24.4 — the invalid file, and the rules that must still run on it
// ---------------------------------------------------------------------------

describe('schema.md §24.4 — the rule half of the six codes', () => {
    /** §24.4:741-748, verbatim. `unknown_field` is T6's structural half. */
    const SECTION_24_4 = fixture(
        '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
        "    build: { strategy: dockerfile, args: [{ name: PAYMENTS_SECRET_KEY, value: '<a real key pasted here>' }] }",
        '    components: [{ name: web, role: web, replica: 2 }]',
        '    env: [{ name: DATABASE_URL, from: deps.postgres.url }]',
        '    upstreamPullRequests: { requireApproval: false }',
    );

    it('reports the five rule codes beside the structural unknown_field', () => {
        // `replica` is not a component key, so the structural half is T6's; the
        // rule half is computed over the document as it parses.
        const findings = evaluate(SECTION_24_4, { schema: false });
        expect(codesOf(findings)).toEqual([
            'literal_secret_in_build_args',
            'reference_unresolved',
            'secret_reference_not_secret',
            'upstream_pr_approval_required',
            'web_component_needs_port',
        ]);
    });

    it('prints §24.4’s display paths', () => {
        const findings = evaluate(SECTION_24_4, { schema: false });
        const byCode = new Map(findings.map((finding) => [finding.code, finding.displayPath]));
        expect(byCode.get('literal_secret_in_build_args')).toBe(
            'build › args › PAYMENTS_SECRET_KEY › value',
        );
        expect(byCode.get('web_component_needs_port')).toBe('components › web › port');
        expect(byCode.get('reference_unresolved')).toBe('env › DATABASE_URL › from');
        expect(byCode.get('secret_reference_not_secret')).toBe('env › DATABASE_URL › secret');
        expect(byCode.get('upstream_pr_approval_required')).toBe(
            'upstreamPullRequests › requireApproval',
        );
    });

    it('prints §24.4’s paths, spelled as §23 spells them', () => {
        const findings = evaluate(SECTION_24_4, { schema: false });
        const paths = findings.map((finding) => finding.path).sort();
        expect(paths).toEqual([
            'spec.build.args[0].value',
            'spec.components[0].port',
            'spec.env[0].from',
            'spec.env[0].secret',
            'spec.upstreamPullRequests.requireApproval',
        ]);
    });

    it('never echoes a build argument value', () => {
        const findings = evaluate(SECTION_24_4, { schema: false });
        expect(JSON.stringify(findings)).not.toContain('a real key pasted here');
    });
});

// ---------------------------------------------------------------------------
// §24.1–§24.3 — the program's own examples, read from the normative file
// ---------------------------------------------------------------------------

/**
 * The three valid examples of `schema.md` §24, extracted from the spec text
 * itself rather than transcribed. A rule that fires on the program's running
 * example is a false positive by definition, and a hand-copied fixture would
 * hide exactly that drift.
 */
function section24Examples(): readonly { readonly name: string; readonly yaml: string }[] {
    const path = join(
        // `packages/agent/src/works-config/schema/__tests__` → the repository root.
        __dirname,
        '../../../../../../docs/specs/features/app-works/APW-03-app-spec-and-catalog/schema.md',
    );
    const text = readFileSync(path, 'utf8');
    const headings = [...text.matchAll(/^### 24\.([123]) (.+)$/gm)];
    return headings.flatMap((heading, index) => {
        const start = (heading.index ?? 0) + heading[0].length;
        const end =
            index + 1 < headings.length ? (headings[index + 1].index ?? text.length) : text.length;
        const fenced = /```yaml\n([\s\S]*?)```/.exec(text.slice(start, end));
        return fenced === null ? [] : [{ name: `§24.${heading[1]}`, yaml: fenced[1] }];
    });
}

describe('schema.md §24.1–§24.3 — the valid examples', () => {
    const examples = section24Examples();

    it('reads all three from schema.md', () => {
        expect(examples.map((example) => example.name)).toEqual(['§24.1', '§24.2', '§24.3']);
    });

    it('§24.1 reports only its documented R11 warning', () => {
        // schema.md:565 — "`{ name: CALENDSO_ENCRYPTION_KEY, fromEnv: … }` # R11 warning, accepted".
        const findings = evaluate(examples[0].yaml);
        expect(codesOf(findings)).toEqual(['secret_build_arg']);
        expect(findings[0].severity).toBe('warning');
        expect(findings[0].displayPath).toBe('build › args › CALENDSO_ENCRYPTION_KEY › fromEnv');
    });

    it.each([
        ['§24.2', 1],
        ['§24.3', 2],
    ] as const)('%s reports nothing at all', (_name, index) => {
        expect(evaluate(examples[index].yaml)).toEqual([]);
    });

    it('every example parses structurally, as T3 asserts', () => {
        for (const example of examples) {
            const parsed = appSpecSchema.safeParse(parseYaml(example.yaml).spec);
            expect({ name: example.name, ok: parsed.success }).toEqual({
                name: example.name,
                ok: true,
            });
        }
    });
});

// ---------------------------------------------------------------------------
// Context (§22:490-505): a null field skips its rule
// ---------------------------------------------------------------------------

describe('a context field left null skips its rule', () => {
    const SERVER_ONLY = [
        'source_relation_mismatch',
        'blueprint_unknown',
        'build_strategy_unavailable',
        'dependency_unavailable',
        'tracked_branch_missing',
    ];

    /** §24.3 — a private copy with no licence block, which R27 would report. */
    const PRIVATE_COPY = fixture(
        '    source: { relation: private-copy, upstream: { repo: example-org/helpdesk } }',
        '    build: { strategy: dockerfile }',
        '    components:',
        '        - { name: web, role: web, port: 8080 }',
    );

    it('a default context reports nothing at all', () => {
        expect(evaluate(fixture('    source: { relation: fork }'))).toEqual([]);
    });

    it('every server-only code is absent with a default context', () => {
        const findings = evaluate(PRIVATE_COPY);
        for (const code of SERVER_ONLY) {
            expect({ code, reported: codesOf(findings).includes(code) }).toEqual({
                code,
                reported: false,
            });
        }
        expect(findings).toEqual([]);
    });

    it('R24 is skipped when no licence registry is supplied', () => {
        const license = fixture(
            "    license: { spdx: AGPL-3.0-only, class: green, source: 'detected' }",
        );
        expect(withCode(evaluate(license), 'license_declared_mismatch')).toEqual([]);
        expect(
            withCode(
                evaluate(license, {
                    context: { licenseClassFor: () => 'amber' },
                }),
                'license_declared_mismatch',
            ).length,
        ).toBe(1);
    });

    it('R24 is skipped when the registry does not know the expression', () => {
        const license = fixture("    license: { spdx: 'LicenseRef-custom', class: green }");
        expect(
            withCode(
                evaluate(license, { context: { licenseClassFor: () => null } }),
                'license_declared_mismatch',
            ),
        ).toEqual([]);
    });

    it('R27 fires for a private copy, and is skipped when nothing is known', () => {
        const license = fixture(
            '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
            '    license: { spdx: MIT, class: green }',
        );
        // A fork with no visibility reading: unknown, so the rule is skipped —
        // a fork of a public repository is public.
        expect(withCode(evaluate(license), 'sourceOfferMissing')).toEqual([]);
        // …and a known `fork` relation does not make it private either: the
        // relation says how the Work was created, not who can read it.
        expect(
            withCode(
                evaluate(license, { context: { recordedRelation: 'fork' } }),
                'sourceOfferMissing',
            ),
        ).toEqual([]);
        // …and with the repository known private it fires.
        expect(
            withCode(
                evaluate(license, { context: { workRepositoryPublic: false } }),
                'sourceOfferMissing',
            ).length,
        ).toBe(1);
        // A public repository satisfies the condition by being public.
        expect(
            withCode(
                evaluate(license, { context: { workRepositoryPublic: true } }),
                'sourceOfferMissing',
            ),
        ).toEqual([]);
    });

    it('the §24 examples report only what §24 documents', () => {
        const calDiy = fixture(
            '    source: { relation: fork, upstream: { repo: calcom/cal.diy } }',
            '    build: { strategy: dockerfile, args: [{ name: CALENDSO_ENCRYPTION_KEY, fromEnv: CALENDSO_ENCRYPTION_KEY }] }',
            '    components:',
            WEB_COMPONENT,
            '    env:',
            '        - { name: CALENDSO_ENCRYPTION_KEY, secret: true, phase: both, generate: { kind: chars, length: 32, alphabet: alnum }, validate: { length: 32 } }',
            "    upstreamSync: { schedule: '0 6 * * 1' }",
        );
        const findings = evaluate(calDiy);
        expect(codesOf(findings)).toEqual(['secret_build_arg']);
        expect(findings[0].severity).toBe('warning');
    });

    it('a private copy is not reported by R27 when it carries a source offer', () => {
        const findings = evaluate(
            fixture(
                '    source: { relation: private-copy, upstream: { repo: example-org/helpdesk } }',
                "    license: { spdx: MIT, class: green, sourceOfferUrl: 'https://example.com/src' }",
            ),
            { context: { recordedRelation: 'private-copy' } },
        );
        expect(findings).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The companion checks — the §23 codes that belong to no R-number
// ---------------------------------------------------------------------------

describe('companion checks', () => {
    it('an unparsable cron expression is cron_invalid', () => {
        const findings = evaluate(
            fixture(
                '    cron:',
                "        - { name: nightly, schedule: '99 99 * * *', command: ['x'] }",
            ),
        );
        expect(codesOf(findings)).toEqual(['cron_invalid']);
        expect(findings[0].displayPath).toBe('cron › nightly › schedule');
    });

    it('an unparsable upstream sync schedule is cron_invalid', () => {
        const findings = evaluate(
            fixture(
                '    source: { relation: fork, upstream: { repo: calcom/cal.diy } }',
                "    upstreamSync: { schedule: '0 6 * * 8' }",
            ),
        );
        expect(codesOf(findings)).toEqual(['cron_invalid']);
        expect(findings[0].displayPath).toBe('upstreamSync › schedule');
    });

    it('a five-field schedule that fires at most hourly is accepted (R21 boundary)', () => {
        const findings = evaluate(
            fixture(
                '    source: { relation: fork, upstream: { repo: calcom/cal.diy } }',
                "    upstreamSync: { schedule: '0 * * * *' }",
            ),
        );
        expect(findings).toEqual([]);
    });

    it('a RE2-unsupported pattern is pattern_unsupported', () => {
        const unsupported = evaluate(
            fixture(
                '    env:',
                "        - { name: APP_SECRET, secret: true, generate: { kind: hex, bytes: 32 }, validate: { pattern: '^(a)\\1$' } }",
            ),
        );
        expect(codesOf(unsupported)).toEqual(['pattern_unsupported']);
        expect(unsupported[0].displayPath).toBe('env › APP_SECRET › validate › pattern');
    });

    it('isRe2Pattern separates RE2 syntax from ECMAScript extensions', () => {
        expect(isRe2Pattern('^[A-Za-z0-9_-]{43}$')).toBe(true);
        expect(isRe2Pattern('(?<name>a)')).toBe(true); // a named group is RE2 syntax
        expect(isRe2Pattern('(?:a)')).toBe(true);
        expect(isRe2Pattern('(a)\\1')).toBe(false); // back-reference
        expect(isRe2Pattern('(?=a)')).toBe(false); // look-ahead
        expect(isRe2Pattern('(?<!a)')).toBe(false); // look-behind
        expect(isRe2Pattern('(?>a)')).toBe(false); // atomic group
        expect(isRe2Pattern('a*+')).toBe(false); // possessive quantifier
        expect(isRe2Pattern('a{2,3}+')).toBe(false);
        expect(isRe2Pattern('(')).toBe(false); // not a pattern at all
    });

    it('a cpu quantity outside 10m–64000m or 0.01–64 cores is out_of_range', () => {
        const cases: readonly (readonly [string, boolean])[] = [
            ['250m', true],
            ['10m', true],
            ['64000m', true],
            ['5m', false],
            ['65000m', false],
            ['0.01', true],
            ['64', true],
            ['0.005', false],
            ['65', false],
        ];
        for (const [value, accepted] of cases) {
            // Quoted: a `CpuQuantity` is a string in the document, and YAML would
            // otherwise read `64` as a number.
            const findings = evaluate(
                fixture(
                    '    build: { strategy: dockerfile }',
                    '    components:',
                    `        - { name: web, role: web, port: 3000, resources: { cpu: '${value}' } }`,
                ),
            );
            expect({ value, codes: codesOf(findings) }).toEqual({
                value,
                codes: accepted ? [] : ['out_of_range'],
            });
        }
    });

    it('a memory quantity outside 64Mi–256Gi is out_of_range', () => {
        const failing = evaluate(
            fixture(
                '    build: { strategy: dockerfile }',
                '    components:',
                '        - { name: web, role: web, port: 3000, resources: { memory: 32Mi } }',
            ),
        );
        expect(codesOf(failing)).toEqual(['out_of_range']);
        expect(failing[0].displayPath).toBe('components › web › resources › memory');
        expect(
            codesOf(
                evaluate(
                    fixture(
                        '    build: { strategy: dockerfile }',
                        '    components:',
                        '        - { name: web, role: web, port: 3000, resources: { memory: 256Gi } }',
                    ),
                ),
            ),
        ).toEqual([]);
    });

    it('a volume size outside 100Mi–500Gi is out_of_range', () => {
        expect(
            codesOf(
                evaluate(
                    fixture(
                        '    build: { strategy: dockerfile }',
                        '    components:',
                        '        - { name: web, role: web, port: 3000, volumes: [{ name: data, path: /data, size: 50Gi }] }',
                    ),
                ),
            ),
        ).toEqual([]);
        const failing = evaluate(
            fixture(
                '    build: { strategy: dockerfile }',
                '    components:',
                '        - { name: web, role: web, port: 3000, volumes: [{ name: data, path: /data, size: 600Gi }] }',
            ),
        );
        expect(codesOf(failing)).toEqual(['out_of_range']);
        expect(failing[0].displayPath).toBe('components › web › volumes › data › size');
    });

    it('a build memory outside 1Gi–64Gi is out_of_range', () => {
        const failing = evaluate(
            fixture(
                '    build: { strategy: dockerfile, resources: { memory: 128Mi } }',
                '    components:',
                WEB_COMPONENT,
            ),
        );
        expect(codesOf(failing)).toEqual(['out_of_range']);
        expect(failing[0].displayPath).toBe('build › resources › memory');
        expect(
            codesOf(
                evaluate(
                    fixture(
                        '    build: { strategy: dockerfile, resources: { memory: 64Gi } }',
                        '    components:',
                        WEB_COMPONENT,
                    ),
                ),
            ),
        ).toEqual([]);
    });

    it('an http body over 16 KiB is out_of_range', () => {
        const body = 'x'.repeat(APP_SPEC_HTTP_BODY_MAX_BYTES);
        const failing = evaluate(
            fixture(
                '    build: { strategy: dockerfile }',
                '    components:',
                WEB_COMPONENT,
                '    jobs:',
                `        - { name: send, when: post-deploy, component: web, http: { path: /hook, body: '${body}' } }`,
            ),
        );
        expect(codesOf(failing)).toEqual(['out_of_range']);
        expect(failing[0].displayPath).toBe('jobs › send › http › body');
        expect(
            codesOf(
                evaluate(
                    fixture(
                        '    build: { strategy: dockerfile }',
                        '    components:',
                        WEB_COMPONENT,
                        '    jobs:',
                        "        - { name: send, when: post-deploy, component: web, http: { path: /hook, body: 'small' } }",
                    ),
                ),
            ),
        ).toEqual([]);
    });

    it('parseCpuCores and parseMemoryMi read the §0 notations', () => {
        expect(parseCpuCores('250m')).toBe(0.25);
        expect(parseCpuCores('2')).toBe(2);
        expect(parseCpuCores('not-a-quantity')).toBeNull();
        expect(parseMemoryMi('512Mi')).toBe(512);
        expect(parseMemoryMi('2Gi')).toBe(2048);
        expect(parseMemoryMi('2GiB')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// The pieces the findings are built from
// ---------------------------------------------------------------------------

describe('positions and paths (§23:532-533)', () => {
    it('pointerToPath spells indexes as §23 does', () => {
        expect(pointerToPath('/spec/components/0/port')).toBe('spec.components[0].port');
        expect(pointerToPath('/spec/env/12/secret')).toBe('spec.env[12].secret');
        expect(pointerToPath('/spec/build/image')).toBe('spec.build.image');
    });

    it('displayPathFor uses names where they exist', () => {
        const spec = parseYaml(
            fixture(
                '    build: { strategy: dockerfile, args: [{ name: PAYMENTS_SECRET_KEY, value: 1 }] }',
                '    components:',
                WEB_COMPONENT,
            ),
        ).spec as AppSpec;
        expect(displayPathFor(spec, '/spec/build/args/0/value')).toBe(
            'build › args › PAYMENTS_SECRET_KEY › value',
        );
        expect(displayPathFor(spec, '/spec/components/0/port')).toBe('components › web › port');
        expect(displayPathFor(spec, '/spec/upstreamPullRequests/requireApproval')).toBe(
            'upstreamPullRequests › requireApproval',
        );
        expect(displayPathFor(spec, '/spec/domains/publicUrlEnv/0')).toBe(
            'domains › publicUrlEnv › 0',
        );
    });

    it('nearestPosition falls back to the nearest present ancestor', () => {
        const lookup = (pointer: string) =>
            pointer === '/spec/components' ? { line: 7, column: 5 } : null;
        expect(nearestPosition('/spec/components/0/port', lookup)).toEqual({ line: 7, column: 5 });
        expect(nearestPosition('/spec/components/0/port', null)).toBeNull();
        expect(nearestPosition('/spec/components/0/port', undefined)).toBeNull();
        expect(nearestPosition('/spec/components/0/port', () => null)).toBeNull();
    });

    it('positions are absent when the caller has no map', () => {
        const spec = parseYaml(fixture('    build: { strategy: dockerfile }')).spec as AppSpec;
        const findings = evaluateAppSpecRules(spec, {});
        expect(findings.length).toBe(1);
        expect(findings[0].line).toBeUndefined();
        expect(findings[0].column).toBeUndefined();
    });

    it('points a present key at the key itself, not at its value', () => {
        const yaml = fixture(
            '    source: { relation: fork, upstream: { repo: calcom/cal.diy } }',
            "    upstreamSync: { schedule: '*/5 * * * *' }",
        );
        const finding = withCode(evaluate(yaml), 'schedule_too_frequent')[0];
        expect(at(finding)).toBe(
            at({ ...finding, ...positionOf(yaml, "schedule: '*/5 * * * *'") }),
        );
    });
});

describe('no leaf is reported twice (§22:511-513)', () => {
    const documents: readonly string[] = [
        fixture(
            '    source: { relation: link, upstream: { repo: calcom/cal.diy } }',
            "    build: { strategy: image, image: 'postgres:16', args: [{ name: PAYMENTS_SECRET_KEY, value: 'AKIAIOSFODNN7EXAMPLE' }] }",
            '    components:',
            '        - { name: web, role: web }',
            '    env:',
            '        - { name: DATABASE_URL, from: deps.postgres.url }',
            '        - { name: EMPTY }',
            "        - { name: EVER_WORKS_X, value: 'x' }",
            '        - { name: BAD_P12, secret: true, generate: { kind: keypair, keypair: { type: ec-p256, format: pkcs12 } } }',
            '    upstreamPullRequests: { requireApproval: false }',
        ),
    ];

    it.each(documents)('reports each (code, pointer) once', (yaml) => {
        const findings = evaluate(yaml, { schema: false });
        const keys = findings.map((finding) => `${finding.code}@${finding.pointer}`);
        expect(new Set(keys).size).toBe(keys.length);
        expect(findings.length).toBeGreaterThan(4);
    });

    it('sorts nothing but never returns the same finding twice', () => {
        const findings = evaluate(documents[0], { schema: false });
        const again = evaluate(documents[0], { schema: false });
        expect(again).toEqual(findings);
    });
});

describe('the §0/§12 numeric tables', () => {
    it('generatedLength follows §12:308-311', () => {
        expect(generatedLength({ kind: 'hex', bytes: 32 })).toBe(64);
        expect(generatedLength({ kind: 'hex' })).toBe(64);
        expect(generatedLength({ kind: 'base64', bytes: 32 })).toBe(44);
        expect(generatedLength({ kind: 'base64', bytes: 48 })).toBe(64);
        expect(generatedLength({ kind: 'chars', length: 24 })).toBe(24);
        expect(generatedLength({ kind: 'chars' })).toBe(32);
        expect(generatedLength({ kind: 'uuid' })).toBe(36);
        expect(generatedLength({ kind: 'keypair', keypair: { format: 'base64url-raw' } })).toBe(43);
        expect(generatedLength({ kind: 'keypair', keypair: { format: 'pem' } })).toBeNull();
        expect(generatedLength({ kind: 'keypair' })).toBeNull();
        expect(generatedLength(undefined)).toBeNull();
    });

    it('a base64url-raw key pair samples 43 base64url characters', () => {
        const samples = generateSamples({
            name: 'VAPID_PRIVATE_KEY',
            generate: { kind: 'keypair', keypair: { type: 'ec-p256', format: 'base64url-raw' } },
        });
        expect(samples.length).toBe(3);
        for (const sample of samples) {
            expect(sample.length).toBe(43);
            expect(/^[A-Za-z0-9_-]{43}$/.test(sample)).toBe(true);
        }
    });

    it('samples are deterministic but differ per entry', () => {
        const entry = {
            name: 'APP_SECRET',
            generate: { kind: 'chars' as const, length: 32 },
        };
        expect(generateSamples(entry)).toEqual(generateSamples(entry));
        expect(generateSamples(entry)).not.toEqual(
            generateSamples({ ...entry, name: 'OTHER_SECRET' }),
        );
    });

    it('samples a hex, base64, chars and uuid generator at its declared length', () => {
        const lengths = [
            [{ kind: 'hex', bytes: 16 } as const, 32],
            [{ kind: 'base64', bytes: 16 } as const, 24],
            [{ kind: 'chars', length: 20, alphabet: 'hex-lower' } as const, 20],
            [{ kind: 'uuid' } as const, 36],
        ] as const;
        for (const [generate, expected] of lengths) {
            const samples = generateSamples({ name: 'APP_SECRET', generate });
            expect(samples.length).toBe(3);
            for (const sample of samples) expect(sample.length).toBe(expected);
        }
    });

    it('a pem key pair has no length and therefore no samples', () => {
        expect(
            generateSamples({
                name: 'JWT_SIGNING_KEY',
                generate: { kind: 'keypair', keypair: { type: 'ed25519', format: 'pem' } },
            }),
        ).toEqual([]);
    });
});
