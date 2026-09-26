import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
    APP_SPEC_FILE_MAX_BYTES,
    APP_SPEC_MAX_DEPTH,
    APP_SPEC_MAX_ISSUES,
    APP_SPEC_YAML_MAX_ALIASES,
    type AppSpecIssue,
} from '@ever-works/contracts';
import { APP_SPEC_SERVER_ONLY_ISSUE_CODES } from '../app-spec.issues';
import {
    APP_SPEC_ALL_RULE_LABELS,
    APP_SPEC_SERVER_ONLY_RULES,
    APP_SPEC_STRUCTURAL_RULES,
    validateAppSpecDocument,
    validateAppSpecObject,
    type AppSpecValidationResult,
    type RuleContext,
} from '../app-spec.validate';

/**
 * T6 — positioned validation and the issue builder (`tasks.md:158-192`).
 *
 * Every case the task's Test line names, and how it is produced:
 *
 * | Case | Where |
 * | ---- | ----- |
 * | `schema.md` §24.4 yields exactly its six codes and display paths, **with the rules having run** despite the structural `unknown_field` (ACC-03-01) | {@link INVALID_24_4} |
 * | S5's pair — `unknown_field` (with suggestion) + `web_component_needs_port` together | `S5` |
 * | `yaml_syntax`, `file_too_large`, the alias limit and the depth limit are the **only** inputs that suppress the rule set | `the four inputs that stop the rule set` |
 * | one invalid leaf suppresses exactly the rules that read it and no others | `a broken leaf suppresses R1 and nothing else` |
 * | unknown-key suggestion, `x-` silence, newer-version warning (ACC-03-02) | `ACC-03-02` |
 * | line/column for a present and an absent key | `positions` |
 * | a property test: random secret-shaped strings never reach an issue string (ACC-03-04) | `FR-6` |
 * | 300 KiB, 101-alias and 13-level files each report one error (ACC-03-05) | `ACC-03-05` |
 * | a 256 KiB draft validates in under 2 s (ACC-03-08) | `ACC-03-08` |
 * | `auto` with an empty `buildStrategies` reports `build_strategy_unavailable`; `image`/`none` never do (ACC-03-49) | `ACC-03-49` |
 * | every `RuleContext` field left unknown skips its rule; a default context reports no server-only issue (ACC-03-58) | `ACC-03-58` |
 * | a draft carrying `source` and `blueprint` validates in `blueprint` mode (ACC-03-52) | `ACC-03-52` |
 * | §24.1–§24.3 validate with zero errors (ACC-03-01) | `schema.md §24's three examples` |
 */

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------

/**
 * A token-shaped string for the fixtures that need one, BUILT rather than
 * written out: a literal `ghp_…` in the repository trips GitHub's secret
 * scanning, which blocked a push of a sibling spec. The rules under test read
 * the SHAPE, so a constructed string is an equivalent fixture and a better
 * citizen.
 */
const PAT_SHAPED = ['ghp', '0123456789abcdefghijklmnopqrstuvwxyz012345'].join('_');

/** A whole `.works/works.yml` from the lines of its `spec:` block. */
function documentOf(...specLines: readonly string[]): string {
    return ['version: 2', 'kind: app', 'name: fixture', 'spec:', ...specLines].join('\n') + '\n';
}

/** The 1-based position of the first occurrence of `needle` in `text`. */
function positionOf(text: string, needle: string): { line: number; column: number } {
    const index = text.indexOf(needle);
    if (index < 0) throw new Error(`positionOf: ${JSON.stringify(needle)} is not in the fixture`);
    const before = text.slice(0, index);
    return { line: before.split('\n').length, column: index - before.lastIndexOf('\n') };
}

/** The codes an issue list carries, deduplicated and sorted. */
function codesOf(result: AppSpecValidationResult): readonly string[] {
    return [...new Set(result.issues.map((issue) => issue.code))].sort();
}

/** The one issue carrying a code. Fails loudly when there is not exactly one. */
function issueWith(result: AppSpecValidationResult, code: string): AppSpecIssue {
    const matching = result.issues.filter((issue) => issue.code === code);
    expect(matching.map((issue) => issue.displayPath)).toHaveLength(1);
    return matching[0];
}

/** `spec.md` §3.1 S5's fixture: the `web` component's `port` renamed to `replica`. */
const S5 = documentOf(
    '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
    '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
    '    components:',
    '        - name: web',
    '          role: web',
    '          replica: 2',
);

/** `schema.md` §24.4, as a whole document (the snippet prints only the block). */
const INVALID_24_4 =
    [
        'version: 2',
        'kind: app',
        'spec:',
        '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
        "    build: { strategy: dockerfile, args: [{ name: PAYMENTS_SECRET_KEY, value: '<a real key pasted here>' }] }",
        '    components: [{ name: web, role: web, replica: 2 }]',
        '    env: [{ name: DATABASE_URL, from: deps.postgres.url }]',
        '    upstreamPullRequests: { requireApproval: false }',
    ].join('\n') + '\n';

/** The six codes §24.4's table lists, and the display path it prints for each. */
const INVALID_24_4_TABLE: readonly (readonly [string, string])[] = [
    ['literal_secret_in_build_args', 'build › args › PAYMENTS_SECRET_KEY › value'],
    ['unknown_field', 'components › web › replica'],
    ['web_component_needs_port', 'components › web › port'],
    ['reference_unresolved', 'env › DATABASE_URL › from'],
    ['secret_reference_not_secret', 'env › DATABASE_URL › secret'],
    ['upstream_pr_approval_required', 'upstreamPullRequests › requireApproval'],
];

/** A document whose only extension is `x-` keys, at two depths (§2:74-75). */
const EXTENSION_KEYS = documentOf(
    '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
    '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
    '    x-internal: { anything: [1, 2, 3], nested: { deeper: true } }',
    '    components:',
    '        - name: web',
    '          role: web',
    '          port: 3000',
    '          x-note: hello',
);

/** A document with one unknown key, and the two versions of the same document. */
function unknownKeyDocument(version?: number): string {
    return documentOf(
        ...(version === undefined ? [] : [`    appSpecVersion: ${version}`]),
        '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
        '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
        '    components: [{ name: web, role: web, port: 3000 }]',
        '    futureField: true',
    );
}

/** The conformance-report fixture: a `web` component with no `port`, on its own lines. */
const ABSENT_PORT = documentOf(
    '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
    '    build:',
    '        strategy: dockerfile',
    '        dockerfile: Dockerfile',
    '    components:',
    '        - name: web',
    '          role: web',
);

/** One invalid leaf — `port` with the wrong type — plus two unrelated problems. */
const BROKEN_PORT = documentOf(
    '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
    '    build: { strategy: image, image: nginx:1.27 }',
    '    components:',
    '        - name: web',
    '          role: web',
    "          port: 'not-a-number'",
    '    upstreamPullRequests: { requireApproval: false }',
);

/** An anchor plus `count` alias references, all under `x-` keys. */
function aliasDocument(count: number): string {
    const lines = [
        'version: 2',
        'kind: app',
        'spec:',
        '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
        '    x-anchor: &shared [1, 2, 3]',
    ];
    for (let index = 0; index < count; index += 1) {
        lines.push(`    x-alias-${index}: *shared`);
    }
    return lines.join('\n') + '\n';
}

/**
 * A document whose deepest nesting is exactly `depth` containers.
 *
 * Built in YAML flow style so the level count is a number in the source rather
 * than a column of indentation: `version`/`kind`/`spec` are three levels, and
 * each `{ … }` below `spec` adds one.
 */
function depthDocument(depth: number): string {
    let inner = '1';
    for (let level = depth - 3; level >= 0; level -= 1) {
        inner = `{ x-${String.fromCharCode(97 + (level % 26))}: ${inner} }`;
    }
    return (
        ['version: 2', 'kind: app', 'name: fixture', 'spec:', `    x-nest: ${inner}`].join('\n') +
        '\n'
    );
}

/** A draft of exactly `targetBytes` bytes: 200 env entries with padded values. */
function draftOfBytes(targetBytes: number): string {
    const build = (valueLength: number): string => {
        const lines = [
            'version: 2',
            'kind: app',
            'name: fixture',
            'spec:',
            '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
            '    env:',
        ];
        for (let index = 0; index < 200; index += 1) {
            lines.push(`        - { name: VAR_${index}, value: '${'a'.repeat(valueLength)}' }`);
        }
        return lines.join('\n') + '\n';
    };

    let valueLength = 1200;
    let text = build(valueLength);
    const deficit = targetBytes - Buffer.byteLength(text, 'utf8');
    if (deficit > 0) {
        valueLength += Math.floor(deficit / 200);
        text = build(valueLength);
        // Top up the last entry so the file lands on the byte exactly.
        const rest = targetBytes - Buffer.byteLength(text, 'utf8');
        if (rest > 0) {
            text = text.replace(
                `value: '${'a'.repeat(valueLength)}' }`,
                `value: '${'a'.repeat(valueLength + rest)}' }`,
            );
        }
    }
    return text;
}

// ---------------------------------------------------------------------------
// ACC-03-01: schema.md §24
// ---------------------------------------------------------------------------

describe('schema.md §24 examples', () => {
    it('§24.4 yields exactly its six codes, with the rules having run', () => {
        const result = validateAppSpecDocument(INVALID_24_4);

        // The rule set ran **despite** the structural `unknown_field` (§22:507-513).
        expect(result.rulesRan).toBe(true);
        expect(result.suppressedRules).toEqual([]);
        expect(codesOf(result)).toEqual([...INVALID_24_4_TABLE.map(([code]) => code)].sort());
        expect(result.issues).toHaveLength(6);

        for (const [code, displayPath] of INVALID_24_4_TABLE) {
            expect([code, issueWith(result, code).displayPath]).toEqual([code, displayPath]);
        }
    });

    it('§24.4 prints the messages its table prints', () => {
        const result = validateAppSpecDocument(INVALID_24_4);
        expect(issueWith(result, 'literal_secret_in_build_args').message).toBe(
            'Build arguments are stored in image layers. Reference an env entry with `fromEnv`.',
        );
        expect(issueWith(result, 'unknown_field').message).toBe(
            'Unknown field `replica`. Did you mean `replicas`?',
        );
        expect(issueWith(result, 'web_component_needs_port').message).toBe(
            'Web components must declare the port they listen on.',
        );
        expect(issueWith(result, 'reference_unresolved').message).toBe(
            '`deps.postgres.url` needs `dependencies.postgres`.',
        );
        expect(issueWith(result, 'secret_reference_not_secret').message).toBe(
            '`DATABASE_URL` reads a secret output, so it must be `secret: true`.',
        );
        expect(issueWith(result, 'upstream_pr_approval_required').message).toBe(
            "Upstream pull requests always need a person's approval.",
        );
    });

    it('§24.1, §24.2 and §24.3 validate with zero errors', () => {
        const fixtures = join(
            __dirname,
            '..',
            '..',
            '..',
            '..',
            '..',
            '..',
            'docs',
            'specs',
            'features',
            'app-works',
            'APW-03-app-spec-and-catalog',
            'schema.md',
        );
        const schema = readFileSync(fixtures, 'utf8');
        const blocks = [...schema.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]);
        // §24.1, §24.2 and §24.3 are the §24 examples that must be clean; §24.4 is
        // the *invalid* one and is asserted separately, and the envelope and
        // key-pair examples earlier in the file are not whole documents. A whole
        // document is the one that opens with the envelope's first line.
        const examples = blocks.filter(
            (block) => block.includes('components:') && block.startsWith('version: 2'),
        );
        expect(examples).toHaveLength(3);

        for (const example of examples) {
            const result = validateAppSpecDocument(example);
            expect({
                errors: result.issues.filter((issue) => issue.severity === 'error'),
                example: example.slice(0, 60),
            }).toEqual({ errors: [], example: example.slice(0, 60) });
            expect(result.status === 'valid' || result.status === 'valid_with_warnings').toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// S5
// ---------------------------------------------------------------------------

describe('S5 — a hand edit is checked on push', () => {
    it('reports unknown_field with its suggestion and web_component_needs_port together', () => {
        const result = validateAppSpecDocument(S5);

        expect(codesOf(result)).toEqual(['unknown_field', 'web_component_needs_port']);
        expect(result.issues).toHaveLength(2);
        expect(result.status).toBe('invalid');

        const unknown = issueWith(result, 'unknown_field');
        expect(unknown.severity).toBe('error');
        expect(unknown.displayPath).toBe('components › web › replica');
        expect(unknown.params).toMatchObject({ key: 'replica', suggestion: 'replicas' });
        expect(unknown.message).toContain('Did you mean `replicas`?');

        const needsPort = issueWith(result, 'web_component_needs_port');
        expect(needsPort.displayPath).toBe('components › web › port');
    });
});

// ---------------------------------------------------------------------------
// The four inputs that suppress the rule set (§22:508, FR-83)
// ---------------------------------------------------------------------------

describe('the four inputs that stop the rule set', () => {
    const fatal: readonly (readonly [string, string, string])[] = [
        ['300 KiB', 'x'.repeat(300 * 1024), 'file_too_large'],
        ['an unclosed quote', 'version: 2\nkind: app\nspec:\n    name: "unclosed\n', 'yaml_syntax'],
        ['101 aliases', aliasDocument(101), 'yaml_alias_limit'],
        ['13 levels', depthDocument(13), 'out_of_range'],
    ];

    it.each(fatal)('%s reports one error and suppresses everything', (_label, text, code) => {
        const result = validateAppSpecDocument(text);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].code).toBe(code);
        expect(result.rulesRan).toBe(false);
        expect(result.suppressedRules).toEqual(APP_SPEC_ALL_RULE_LABELS);
        // §22:513 — the issue that names it records which rules were skipped.
        expect(result.issues[0].params?.skippedRules).toBe('all');
    });

    it('accepts 99 aliases, so the alias case is the limit and not a blanket refusal', () => {
        const result = validateAppSpecDocument(aliasDocument(99));
        expect(codesOf(result)).not.toContain('yaml_alias_limit');
        expect(result.rulesRan).toBe(true);
    });

    it('accepts 12 levels, so the depth case is the limit and not a blanket refusal', () => {
        const result = validateAppSpecDocument(depthDocument(12));
        expect(codesOf(result)).not.toContain('out_of_range');
        expect(result.rulesRan).toBe(true);
    });

    /**
     * Controls: the structural problems §22:508 does **not** list. Each of these
     * keeps the rule set running — which is the whole content of "the rules run
     * whenever the document parses".
     */
    const nonFatal: readonly (readonly [string, string])[] = [
        [
            'an unknown field',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    components: [{ name: web, role: web, port: 3000 }]',
                '    totallyUnknown: 1',
            ),
        ],
        [
            'a duplicate key',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    display: { name: one }',
                '    display: { name: two }',
            ),
        ],
        [
            'a wrong type',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    display: { name: 12345 }',
            ),
        ],
        ['a kind mismatch', documentOf('    kind: website', '    source: { relation: fork }')],
        ['a missing spec block', 'version: 2\nkind: app\nname: fixture\n'],
        ['a sequence at the root', '- one\n- two\n'],
        [
            'an invalid enum',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    build: { strategy: makesomethingup }',
            ),
        ],
    ];

    it.each(nonFatal)('%s still runs the rules', (_label, text) => {
        const result = validateAppSpecDocument(text);
        expect(result.rulesRan).toBe(true);
        expect(result.suppressedRules).not.toEqual(APP_SPEC_ALL_RULE_LABELS);
        expect(result.issues.length).toBeGreaterThan(0);
    });

    it('runs the rules when one leaf is invalid, unlike a fatal problem', () => {
        const result = validateAppSpecDocument(BROKEN_PORT);
        expect(result.rulesRan).toBe(true);
        expect(codesOf(result)).toEqual(
            ['image_not_pinned', 'invalid_type', 'upstream_pr_approval_required'].sort(),
        );
    });
});

// ---------------------------------------------------------------------------
// One leaf, one report
// ---------------------------------------------------------------------------

describe('a broken leaf suppresses the rules that read it, and no others', () => {
    it('drops R1 and keeps R12 and R19', () => {
        const result = validateAppSpecDocument(BROKEN_PORT);

        // The leaf itself is reported once, structurally…
        const broken = issueWith(result, 'invalid_type');
        expect(broken.displayPath).toBe('components › web › port');
        expect(broken.params).toMatchObject({ key: 'port', expected: 'number' });

        // …R1 would have reported the very same pointer, so it is suppressed…
        expect(codesOf(result)).not.toContain('web_component_needs_port');
        expect(result.suppressedRules).toContain('R1');

        // …and the rules that read something else are untouched.
        expect(result.suppressedRules).not.toContain('R12');
        expect(result.suppressedRules).not.toContain('R19');
        expect(issueWith(result, 'upstream_pr_approval_required').displayPath).toBe(
            'upstreamPullRequests › requireApproval',
        );
        expect(issueWith(result, 'image_not_pinned').severity).toBe('warning');
    });

    it('never publishes two reports on one pointer', () => {
        // Two `build` mappings: `duplicate_key` lands on `/spec/build`, and the
        // surviving (second) block declares no `strategy`, so R2 wants to report
        // the very same pointer. §22:511-513 settles it — one leaf, one report.
        const text = documentOf(
            '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
            '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
            '    build: { dockerfile: Dockerfile }',
            '    components: [{ name: web, role: web, port: 3000 }]',
        );
        const result = validateAppSpecDocument(text);
        const pointers = result.issues.map((issue) => issue.pointer);
        expect(new Set(pointers).size).toBe(pointers.length);
        expect(codesOf(result)).toEqual(['duplicate_key']);
        expect(result.issues[0].displayPath).toBe('build');
    });

    /**
     * The two `cron` paths whose shape failure belongs to T5: the repair loop has
     * to delete the expression to reach a parse, and its value is then put back so
     * `cron_invalid` can judge it. The structural `pattern` for these two paths is
     * not published at all, so the leaf is still reported exactly once.
     */
    it('defers a four-field schedule to cron_invalid, and reports it once', () => {
        const text = documentOf(
            '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
            '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
            '    components: [{ name: web, role: web, port: 3000 }]',
            '    cron: [{ name: purge, schedule: "30 3 * *", command: [node, purge.js] }]',
            '    upstreamSync: { schedule: "0 5 *" }',
        );
        const result = validateAppSpecDocument(text);
        expect(codesOf(result)).toEqual(['cron_invalid']);
        expect(result.issues).toHaveLength(2);
        expect(result.issues.map((issue) => issue.displayPath).sort()).toEqual([
            'cron › purge › schedule',
            'upstreamSync › schedule',
        ]);
    });
});

// ---------------------------------------------------------------------------
// ACC-03-02
// ---------------------------------------------------------------------------

describe('ACC-03-02 — an unknown key, an extension key and a newer spec version', () => {
    it('reports an unknown key with a suggestion', () => {
        const result = validateAppSpecDocument(unknownKeyDocument());
        const issue = issueWith(result, 'unknown_field');
        expect(issue.severity).toBe('error');
        expect(issue.displayPath).toBe('futureField');
        expect(issue.params).toMatchObject({ key: 'futureField' });
        expect(result.status).toBe('invalid');
    });

    it('reports nothing for an x- key, at any depth', () => {
        const result = validateAppSpecDocument(EXTENSION_KEYS);
        expect(result.issues).toEqual([]);
        expect(result.status).toBe('valid');
        expect(result.spec).not.toBeNull();
    });

    it('turns the unknown-key report into a warning when appSpecVersion is newer', () => {
        const result = validateAppSpecDocument(unknownKeyDocument(2));
        expect(codesOf(result)).toEqual(['unknown_field_newer_version']);
        const issue = issueWith(result, 'unknown_field_newer_version');
        expect(issue.severity).toBe('warning');
        expect(issue.message).toContain('Unknown field `futureField`.');
        expect(result.status).toBe('valid_with_warnings');
        // Every other rule still applies (§2:77), and a warning does not stop the
        // spec from being usable (FR-20).
        expect(result.spec).not.toBeNull();
        expect(result.errorCount).toBe(0);
    });

    it('keeps the error severity when appSpecVersion is the supported one', () => {
        const result = validateAppSpecDocument(unknownKeyDocument(1));
        expect(codesOf(result)).toEqual(['unknown_field']);
        expect(result.status).toBe('invalid');
    });
});

// ---------------------------------------------------------------------------
// Positions (§23:533)
// ---------------------------------------------------------------------------

describe('line and column', () => {
    it('points at the key when the key is present', () => {
        const result = validateAppSpecDocument(INVALID_24_4);
        const unknown = issueWith(result, 'unknown_field');
        expect({ line: unknown.line, column: unknown.column }).toEqual(
            positionOf(INVALID_24_4, 'replica'),
        );
    });

    it('falls back to the nearest parent key when the key is absent', () => {
        const result = validateAppSpecDocument(ABSENT_PORT);
        const issue = issueWith(result, 'web_component_needs_port');
        expect(issue.displayPath).toBe('components › web › port');
        expect({ line: issue.line, column: issue.column }).toEqual(
            positionOf(ABSENT_PORT, 'components'),
        );
    });

    it('gives the document root a position of its own for a root-level problem', () => {
        const result = validateAppSpecDocument('- one\n- two\n');
        expect(result.issues[0].displayPath).toBe('works.yml');
        expect(result.issues[0].line).toBe(1);
        expect(result.issues[0].column).toBe(1);
    });

    it('omits line and column when the caller already held a parsed object (plan §2.2:144)', () => {
        const spec = parseYaml(ABSENT_PORT)?.spec;
        const result = validateAppSpecObject(spec);
        const issue = issueWith(result, 'web_component_needs_port');
        expect(issue.displayPath).toBe('components › web › port');
        expect(issue.line).toBeUndefined();
        expect(issue.column).toBeUndefined();

        // The whole-document form of the same call agrees, code for code.
        const asDocument = validateAppSpecObject(parseYaml(ABSENT_PORT));
        expect(codesOf(asDocument)).toEqual(codesOf(result));
        expect(asDocument.issues[0].line).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// ACC-03-04 / FR-6
// ---------------------------------------------------------------------------

describe('FR-6 — no issue string ever carries a value from the file', () => {
    /** mulberry32, seeded — the fixture is random but the test is reproducible. */
    function random(seed: number): () => number {
        let state = seed >>> 0;
        return () => {
            state = (state + 0x6d2b_79f5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
        };
    }

    const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    function secret(next: () => number, prefix: string, length: number): string {
        let out = prefix;
        for (let index = 0; index < length; index += 1) {
            out += ALNUM[Math.floor(next() * ALNUM.length)];
        }
        return out;
    }

    it('keeps build-argument, secret-entry and prompt-example values out of every field', () => {
        const next = random(0x5eed_1234);

        for (let round = 0; round < 25; round += 1) {
            const buildArg = secret(next, 'sk_live_', 24);
            const fromEnvArg = secret(next, 'ghp_', 36);
            const literalSecret = secret(next, 'glpat-', 20);
            const promptExample = secret(next, 'npm_', 36);

            const text = documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    build:',
                '        strategy: dockerfile',
                '        args:',
                `            - { name: PUBLIC_BUILD_ARG, value: '${buildArg}' }`,
                `            - { name: FROM_ENV_ARG, fromEnv: ${fromEnvArg} }`,
                '    components: [{ name: web, role: web, port: 3000 }]',
                '    env:',
                `        - { name: LITERAL_SECRET, secret: true, value: '${literalSecret}' }`,
                `        - { name: PROMPTED, secret: true, prompt: { description: asked, example: '${promptExample}' } }`,
            );

            const result = validateAppSpecDocument(text);
            expect(codesOf(result)).toEqual(
                expect.arrayContaining([
                    'literal_secret_in_build_args',
                    'literal_secret_value',
                    'prompt_example_secret',
                ]),
            );

            for (const issue of result.issues) {
                const rendered = [
                    issue.code,
                    issue.severity,
                    issue.path,
                    issue.pointer,
                    issue.displayPath,
                    issue.message,
                    issue.hint ?? '',
                    JSON.stringify(issue.params ?? {}),
                ].join('\u0000');
                for (const value of [buildArg, fromEnvArg, literalSecret, promptExample]) {
                    expect(rendered).not.toContain(value);
                }
            }

            // And the whole result, serialized, is free of them too.
            const serialized = JSON.stringify(result);
            for (const value of [buildArg, fromEnvArg, literalSecret, promptExample]) {
                expect(serialized).not.toContain(value);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// ACC-03-05 / ACC-03-08
// ---------------------------------------------------------------------------

describe('ACC-03-05 — the three size guards report one error each', () => {
    it('300 KiB reports exactly one file_too_large', () => {
        const text = 'x'.repeat(300 * 1024);
        const result = validateAppSpecDocument(text);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].code).toBe('file_too_large');
        expect(result.issues[0].params).toMatchObject({
            bytes: Buffer.byteLength(text, 'utf8'),
            maxBytes: APP_SPEC_FILE_MAX_BYTES,
        });
    });

    it('101 aliases report exactly one yaml_alias_limit', () => {
        const result = validateAppSpecDocument(aliasDocument(101));
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].code).toBe('yaml_alias_limit');
        expect(result.issues[0].params).toMatchObject({ max: APP_SPEC_YAML_MAX_ALIASES });
    });

    it('13 levels report exactly one depth failure', () => {
        const result = validateAppSpecDocument(depthDocument(13));
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].code).toBe('out_of_range');
        expect(result.issues[0].params).toMatchObject({ limit: APP_SPEC_MAX_DEPTH, depth: 13 });
    });
});

describe('ACC-03-08 — a 256 KiB draft validates in under 2 seconds', () => {
    it('returns in time, reports nothing, and stores nothing', () => {
        const text = draftOfBytes(APP_SPEC_FILE_MAX_BYTES);
        expect(Buffer.byteLength(text, 'utf8')).toBe(APP_SPEC_FILE_MAX_BYTES);

        const started = Date.now();
        const result = validateAppSpecDocument(text, { mode: 'draft' });
        const elapsed = Date.now() - started;

        expect(result.issues).toEqual([]);
        expect(result.status).toBe('valid');
        expect(elapsed).toBeLessThan(2000);
        // Nothing is stored: the validator is a pure function of its input, so a
        // second call on the same text is byte-identical.
        expect(JSON.stringify(validateAppSpecDocument(text, { mode: 'draft' }))).toBe(
            JSON.stringify(result),
        );
    });
});

// ---------------------------------------------------------------------------
// ACC-03-49 / ACC-03-58
// ---------------------------------------------------------------------------

describe('ACC-03-49 — only a strategy that needs a builder can be unavailable', () => {
    const withStrategy = (strategy: string): string =>
        documentOf(
            '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
            '    build:',
            `        strategy: ${strategy}`,
            ...(strategy === 'image' ? ['        image: nginx:1.27'] : []),
            ...(strategy === 'dockerfile' ? ['        dockerfile: Dockerfile'] : []),
            '    components: [{ name: web, role: web, port: 3000 }]',
        );

    it('reports auto with an empty buildStrategies', () => {
        const result = validateAppSpecDocument(withStrategy('auto'), {
            context: { buildStrategies: [] },
        });
        const issue = issueWith(result, 'build_strategy_unavailable');
        expect(issue.severity).toBe('warning');
        expect(issue.displayPath).toBe('build › strategy');
        expect(issue.params).toMatchObject({ strategy: 'auto' });
    });

    it('reports dockerfile with an empty buildStrategies', () => {
        const result = validateAppSpecDocument(withStrategy('dockerfile'), {
            context: { buildStrategies: [] },
        });
        expect(codesOf(result)).toContain('build_strategy_unavailable');
    });

    it('never reports image or none, which name no builder', () => {
        for (const strategy of ['image', 'none']) {
            const result = validateAppSpecDocument(withStrategy(strategy), {
                context: { buildStrategies: [] },
            });
            expect([strategy, codesOf(result).includes('build_strategy_unavailable')]).toEqual([
                strategy,
                false,
            ]);
        }
    });

    it('reports nothing when a plugin lists the strategy', () => {
        const result = validateAppSpecDocument(withStrategy('auto'), {
            context: { buildStrategies: ['dockerfile', 'auto'] },
        });
        expect(codesOf(result)).not.toContain('build_strategy_unavailable');
    });
});

describe('ACC-03-58 — an unknown context field skips its rule', () => {
    /**
     * One fixture per server-only rule that **would** report when its input is
     * known. Every one of them must stay silent with a default context.
     */
    const triggers: readonly (readonly [string, string, RuleContext])[] = [
        [
            'source_relation_mismatch',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    components: [{ name: web, role: web, port: 3000 }]',
            ),
            { recordedRelation: 'link' },
        ],
        [
            'blueprint_unknown',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    blueprint:',
                '        { id: cal-diy, version: 1.0.0, repo: ever-works/cal-diy-template, sha: 0123456789abcdef0123456789abcdef01234567 }',
            ),
            { catalogIds: ['umami'] },
        ],
        [
            'build_strategy_unavailable',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    build: { strategy: auto }',
                '    components: [{ name: web, role: web, port: 3000 }]',
            ),
            { buildStrategies: [] },
        ],
        [
            'dependency_unavailable',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    dependencies: { postgres: { version: "16" } }',
            ),
            { dependencyProviders: { postgres: false }, deployTarget: 'ever-works-apps' },
        ],
        [
            'tracked_branch_missing',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk }, branch: release }',
                '    components: [{ name: web, role: web, port: 3000 }]',
            ),
            { trackedBranchExists: false },
        ],
        [
            'extension_unavailable',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    dependencies: { postgres: { version: "16", extensions: [pgvector] } }',
            ),
            { postgresExtensions: ['pg_trgm'] },
        ],
    ];

    it.each(triggers)('%s reports when its input is known', (code, text, context) => {
        const result = validateAppSpecDocument(text, { context });
        expect(codesOf(result)).toContain(code);
    });

    it('reports no server-only issue at all with a default context', () => {
        for (const [, text, context] of triggers) {
            const bare = validateAppSpecDocument(text);
            for (const issue of bare.issues) {
                expect(APP_SPEC_SERVER_ONLY_ISSUE_CODES as readonly string[]).not.toContain(
                    issue.code,
                );
            }

            // An explicitly `null` field is unknown too, never `false` (§22:502).
            const nulled: RuleContext = {};
            for (const key of Object.keys(context)) {
                (nulled as Record<string, unknown>)[key] = null;
            }
            const withNulls = validateAppSpecDocument(text, { context: nulled });
            for (const issue of withNulls.issues) {
                expect(APP_SPEC_SERVER_ONLY_ISSUE_CODES as readonly string[]).not.toContain(
                    issue.code,
                );
            }
        }
    });

    it('reports no server-only issue for the §24.1 example either', () => {
        const spec = readFileSync(
            join(
                __dirname,
                '..',
                '..',
                '..',
                '..',
                '..',
                '..',
                'docs',
                'specs',
                'features',
                'app-works',
                'APW-03-app-spec-and-catalog',
                'schema.md',
            ),
            'utf8',
        );
        const block = [...spec.matchAll(/```yaml\n([\s\S]*?)```/g)]
            .map((match) => match[1])
            .find((candidate) => candidate.includes('CALENDSO_ENCRYPTION_KEY'));
        expect(block).toBeDefined();
        const result = validateAppSpecDocument(block);
        for (const issue of result.issues) {
            expect(APP_SPEC_SERVER_ONLY_ISSUE_CODES as readonly string[]).not.toContain(issue.code);
        }
    });

    it('registers exactly the five server-only codes of §22:483-488 as its own, plus extension_unavailable', () => {
        expect(APP_SPEC_SERVER_ONLY_RULES.map((rule) => rule.name).sort()).toEqual(
            [
                'blueprint_unknown',
                'build_strategy_unavailable',
                'dependency_unavailable',
                'extension_unavailable',
                'source_relation_mismatch',
                'tracked_branch_missing',
            ].sort(),
        );
    });

    it('registers the six structural cross-field rules of schema.md §23', () => {
        expect(APP_SPEC_STRUCTURAL_RULES.map((rule) => rule.name).sort()).toEqual(
            [
                'generated_not_secret',
                'http_job_requires_web_component',
                'prompt_example_secret',
                'public_bucket_undeclared',
                'worker_port_forbidden',
                'worker_probe_without_port',
            ].sort(),
        );
    });
});

// ---------------------------------------------------------------------------
// The seven structural cross-field codes of §23
// ---------------------------------------------------------------------------

describe('the structural cross-field codes of schema.md §23', () => {
    const cases: readonly (readonly [string, string, string])[] = [
        [
            'worker_port_forbidden',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    components: [{ name: web, role: web, port: 3000 }, { name: jobs, role: worker, port: 9000 }]',
            ),
            'components › jobs › port',
        ],
        [
            'worker_probe_without_port',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    components:',
                '        - { name: web, role: web, port: 3000 }',
                '        - { name: jobs, role: worker, probes: { readiness: { tcp: true } } }',
            ),
            'components › jobs › probes › readiness › tcp',
        ],
        [
            'http_job_requires_web_component',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    components: [{ name: web, role: web, port: 3000 }, { name: jobs, role: worker }]',
                '    jobs: [{ name: migrate, when: pre-deploy, component: jobs, http: { path: /migrate } }]',
            ),
            'jobs › migrate › component',
        ],
        [
            'public_bucket_undeclared',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    dependencies: { objectStorage: { buckets: [attachments], publicBuckets: [avatars] } }',
            ),
            'dependencies › objectStorage › publicBuckets › 0',
        ],
        [
            'generated_not_secret',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    env: [{ name: APP_SECRET, generate: { kind: hex, bytes: 32 } }]',
            ),
            'env › APP_SECRET › secret',
        ],
        [
            'prompt_example_secret',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    env:',
                `        - { name: SMTP_PASSWORD, secret: true, prompt: { description: password, example: ${PAT_SHAPED} } }`,
            ),
            'env › SMTP_PASSWORD › prompt › example',
        ],
        [
            'http_job_requires_web_component',
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    components: [{ name: jobs, role: worker }]',
                '    cron: [{ name: purge, schedule: "30 3 * * *", component: jobs, http: { path: /purge } }]',
            ),
            'cron › purge › component',
        ],
    ];

    it.each(cases)('%s is reported at %s', (code, text, displayPath) => {
        const result = validateAppSpecDocument(text);
        expect(issueWith(result, code).displayPath).toBe(displayPath);
    });

    it('accepts the same documents once the problem is gone', () => {
        const clean = documentOf(
            '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
            '    dependencies: { objectStorage: { buckets: [attachments], publicBuckets: [attachments] } }',
            '    components: [{ name: web, role: web, port: 3000 }, { name: jobs, role: worker }]',
            '    env: [{ name: APP_SECRET, secret: true, generate: { kind: hex, bytes: 32 } }]',
        );
        const result = validateAppSpecDocument(clean);
        for (const [code] of cases) {
            expect(codesOf(result)).not.toContain(code);
        }
    });
});

// ---------------------------------------------------------------------------
// ACC-03-52
// ---------------------------------------------------------------------------

describe('ACC-03-52 — a Blueprint repository draft carrying source and blueprint', () => {
    const DRAFT = documentOf(
        '    source: { relation: fork, upstream: { repo: example-org/helpdesk, defaultBranch: main } }',
        '    blueprint:',
        '        { id: cal-diy, version: 1.0.0, repo: ever-works/cal-diy-template, sha: 0123456789abcdef0123456789abcdef01234567 }',
        '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
        '    components: [{ name: web, role: web, port: 3000 }]',
    );

    it('validates with zero errors in blueprint mode', () => {
        const result = validateAppSpecDocument(DRAFT, { mode: 'blueprint' });
        expect(result.errorCount).toBe(0);
        expect(result.status).toBe('valid');
        expect(result.spec).not.toBeNull();
    });

    /**
     * The correction of 2026-09-17, pinned as a contrast case: §3:89 used to
     * forbid these two keys in `blueprint` mode with
     * `blueprint_mode_forbidden_key`, which **no** APW-13 Blueprint could satisfy
     * while catalog CI check C4 demands zero errors. The code stays in §23's list
     * (§3:89, `app-spec-issues.ts:173-176`) and is no longer emitted for them.
     */
    it('never emits blueprint_mode_forbidden_key for source and blueprint', () => {
        const result = validateAppSpecDocument(DRAFT, { mode: 'blueprint' });
        expect(codesOf(result)).not.toContain('blueprint_mode_forbidden_key');
        expect(JSON.stringify(result)).not.toContain('blueprint_mode_forbidden_key');
    });

    it('accepts the blueprint-draft spelling as an alias of blueprint mode', () => {
        const asBlueprint = validateAppSpecDocument(DRAFT, { mode: 'blueprint' });
        const asDraft = validateAppSpecDocument(DRAFT, { mode: 'blueprint-draft' });
        expect(JSON.stringify(asDraft)).toBe(JSON.stringify(asBlueprint));
        expect(asDraft.errorCount).toBe(0);
    });

    it('does not require source in blueprint mode', () => {
        const withoutSource = documentOf(
            '    blueprint:',
            '        { id: cal-diy, version: 1.0.0, repo: ever-works/cal-diy-template, sha: 0123456789abcdef0123456789abcdef01234567 }',
            '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
            '    components: [{ name: web, role: web, port: 3000 }]',
        );
        expect(codesOf(validateAppSpecDocument(withoutSource, { mode: 'blueprint' }))).toEqual([]);
        // …and does require it in data-repository mode (§4:99).
        const missing = validateAppSpecDocument(
            documentOf(
                '    build: { strategy: dockerfile, dockerfile: Dockerfile }',
                '    components: [{ name: web, role: web, port: 3000 }]',
            ),
        );
        const required = issueWith(missing, 'required');
        expect(required.displayPath).toBe('source');
        expect(required.params).toMatchObject({ key: 'source' });
    });
});

// ---------------------------------------------------------------------------
// Kind, sorting and the cap
// ---------------------------------------------------------------------------

describe('the envelope, the sort and the cap', () => {
    it('reports kind_mismatch when the two spellings disagree', () => {
        const result = validateAppSpecDocument(
            documentOf('    kind: website', '    source: { relation: fork }'),
        );
        const issue = issueWith(result, 'kind_mismatch');
        expect(issue.displayPath).toBe('kind');
        expect(issue.params).toMatchObject({ root: 'app', declared: 'website' });
    });

    it('reports kind_mismatch through the OBJECT entry point, not only the text one', () => {
        // `validateAppSpecObject` accepts the whole document as well as the bare
        // block, and it must reach the same verdict as `validateAppSpecDocument`
        // for the same document (its own doc comment says so). The root `kind`
        // is what the two spellings are compared through, so a document-form
        // caller that got `null` here would silently lose the rule.
        const result = validateAppSpecObject({
            version: 2,
            kind: 'app',
            name: 'fixture',
            spec: {
                kind: 'website',
                source: { relation: 'fork' },
                build: { strategy: 'dockerfile', dockerfile: 'Dockerfile' },
                components: [{ name: 'web', role: 'web', port: 3000 }],
            },
        });
        const issue = issueWith(result, 'kind_mismatch');
        expect(issue.displayPath).toBe('kind');
        expect(issue.params).toMatchObject({ root: 'app', declared: 'website' });
    });

    it('reports blueprint_repo_outside_org for a repository outside ever-works', () => {
        const result = validateAppSpecDocument(
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    blueprint:',
                '        { id: cal-diy, version: 1.0.0, repo: someone-else/cal-diy-template, sha: 0123456789abcdef0123456789abcdef01234567 }',
            ),
        );
        expect(codesOf(result)).toContain('blueprint_repo_outside_org');
    });

    it('sorts errors before warnings and then by line', () => {
        const result = validateAppSpecDocument(INVALID_24_4);
        const severities = result.issues.map((issue) => issue.severity);
        expect(severities).toEqual(
            [...severities].sort((a, b) => (a === b ? 0 : a === 'error' ? -1 : 1)),
        );
        const lines = result.issues.map((issue) => issue.line ?? 0);
        expect(lines).toEqual([...lines].sort((a, b) => a - b));
    });

    it('caps the list at 200 and says so (§2.5:79-80)', () => {
        // 60 unknown keys per line × enough lines to pass the cap, well inside
        // the 256 KiB size guard.
        const unknown: string[] = [];
        for (let index = 0; index < APP_SPEC_MAX_ISSUES + 50; index += 1) {
            unknown.push(`    totallyUnknown${index}: 1`);
        }
        const result = validateAppSpecDocument(
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                ...unknown,
            ),
        );
        expect(result.issues).toHaveLength(APP_SPEC_MAX_ISSUES);
        expect(result.truncated).toBe(true);
        // The counts describe the whole list, not the published slice.
        expect(result.errorCount).toBe(APP_SPEC_MAX_ISSUES + 50);
    });

    it('never throws, whatever it is handed (FR-8)', () => {
        const inputs: readonly unknown[] = [
            null,
            undefined,
            42,
            {},
            [],
            'version: 2\nkind: app\nspec: { source: { relation: fork } }',
            'spec: [1, 2, 3]',
            'spec: "a string"',
            'version: 2\nkind: app\nspec:\n  source: { relation: fork }\n  components: "not an array"',
            'version: 2\nkind: app\nspec:\n  env: [{ name: X }]\n  components: [[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]',
        ];
        for (const input of inputs) {
            expect(() => validateAppSpecDocument(input)).not.toThrow();
            expect(() => validateAppSpecObject(input)).not.toThrow();
            const result = validateAppSpecDocument(input);
            expect(Array.isArray(result.issues)).toBe(true);
        }
    });

    it('keeps working when a rule cannot read a document the repair could not fix', () => {
        // `components` is a string: no rule can read it, the repair cannot make a
        // spec of it, and the result still says which rules were skipped.
        const result = validateAppSpecDocument(
            documentOf(
                '    source: { relation: fork, upstream: { repo: example-org/helpdesk } }',
                '    components: "not an array"',
            ),
        );
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.rulesRan).toBe(true);
        expect(codesOf(result)).toContain('invalid_type');
    });
});
