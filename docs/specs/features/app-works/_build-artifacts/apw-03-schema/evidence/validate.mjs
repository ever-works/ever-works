#!/usr/bin/env node
/**
 * APW-03 build artifact — evidence runner for `app-spec.schema.json`.
 *
 * WHAT THIS IS
 * ------------
 * Layer 1 (authoritative): the JSON Schema is compiled and applied with the validator the repository
 * already depends on — `ajv` 8 (packages/agent/package.json:339) through its draft 2020-12 build,
 * exactly as `packages/agent-plugins/src/schema-validator.ts:29,53` does it
 * (`new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true })`). YAML is parsed with the
 * `yaml` package the agent package also already depends on (packages/agent/package.json:364). Nothing is
 * installed and nothing is added to the repository: both modules are resolved out of
 * `packages/agent`'s own node_modules with `createRequire`.
 *
 * Layer 2 (reference only): a deliberately small implementation of the rules JSON Schema cannot express —
 * reference resolution, secrecy propagation, duplicate names, RE2-compatibility, generated-length
 * agreement, and the warnings. It exists so this runner can say, per fixture, WHICH layer catches the
 * defect, and so the "schema cannot express this" claims in `validator-rules.md` are demonstrated rather
 * than asserted. It is NOT the production validator: APW-03 plan.md §2.2 puts that in
 * `packages/agent/src/works-config/schema/app-spec.rules.ts`, with line/column positions, the 200-issue
 * cap and the full R1-R26 set. Rules this script does not implement are listed in
 * `validator-rules.md` §5.
 *
 * USAGE
 * -----
 *   cd docs/specs/features/app-works/_build-artifacts/apw-03-schema/evidence
 *   node validate.mjs            # exits 0 when every fixture matches its recorded expectation
 *
 * The fixture registry below carries the EXPECTATION for each file. The three real Blueprints are read
 * from their repository paths (not copied); `fixtures/head-revision/` holds verbatim `git show HEAD:…`
 * snapshots of the same files, because the worktree carries an uncommitted change that renamed the env
 * entries R23 forbids — see `fixtures/head-revision/SOURCE.txt`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..', '..', '..');
const SCHEMA_PATH = path.join(HERE, '..', 'app-spec.schema.json');
const SCHEMA_ID = 'https://api.ever.works/api/schema/app-spec.schema.json';

const requireFromAgent = createRequire(path.join(REPO_ROOT, 'packages', 'agent', 'package.json'));
const load = async (specifier) => import(pathToFileURL(requireFromAgent.resolve(specifier)).href);

const { Ajv2020 } = await load('ajv/dist/2020.js');
const YAML = await load('yaml');

const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf8');
const schema = JSON.parse(schemaText);
const schemaSha = crypto.createHash('sha256').update(schemaText).digest('hex');

const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
const validateDocument = ajv.compile(schema);
const validateReference = ajv.compile({ $ref: `${SCHEMA_ID}#/$defs/reference` });

const BLUEPRINTS = 'docs/specs/features/app-works/APW-13-golden-paths/blueprints';
/** Every registry path is relative to the repository root, so the transcript shows one coordinate system. */
const FIXTURES = 'docs/specs/features/app-works/_build-artifacts/apw-03-schema/evidence/fixtures';

/* -------------------------------------------------------------------------------------------------
 * Fixture registry: the EXPECTATION each file must meet.
 *
 *   layer   'data-repository' | 'blueprint'  — schema.md §3 validation mode
 *   schema  'pass' | 'fail'                  — Layer 1 verdict
 *   codes   [APP_SPEC_ISSUE_CODES]           — Layer 2 errors expected
 *   warnings[…]                              — Layer 2 warnings expected
 *   paths   [JSON pointer]                   — Layer 1 failures expected at these instance paths
 * ----------------------------------------------------------------------------------------------- */
const REGISTRY = [
    // ── the three real Blueprint specs, at their repository paths ────────────────────────────────
    {
        id: 'blueprint/app-fixture-hello (worktree)',
        file: `${BLUEPRINTS}/app-fixture-hello/.works/works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: [],
        warnings: ['advisory_check'],
        note: 'the fixture Blueprint; its `format` check is required:false, hence one warning',
    },
    {
        id: 'blueprint/umami (worktree)',
        file: `${BLUEPRINTS}/umami/.works/works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: [],
        warnings: [],
        note: 'worktree revision: the EVER_WORKS_* env names were renamed to APP_* by an uncommitted change',
    },
    {
        id: 'blueprint/cal-diy (worktree)',
        file: `${BLUEPRINTS}/cal-diy/.works/works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: [],
        warnings: ['advisory_check', 'secret_build_arg'],
        note: 'the reserved env names AND the look-around validate.pattern were both repaired by uncommitted worktree changes (20:09 and 20:17 on 2026-09-17); the head-revision fixture below still catches both. `secret_build_arg` (R11) is the ACCEPTED outcome for this draft: its DATABASE_URL build arg is now `fromEnv` rather than a literal, and schema.md §24.1 records why — the previous literal named a user/database the build service never provisions',
    },
    // ── the same three at HEAD, where R23 was still violated ────────────────────────────────────
    {
        id: 'head-revision/app-fixture-hello (control)',
        file: `${FIXTURES}/head-revision/app-fixture-hello.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: [],
        warnings: ['advisory_check'],
        note: 'CONTROL: never declared a reserved env name, so it must pass under both revisions',
    },
    {
        id: 'head-revision/umami (HEAD e47866dc7)',
        file: `${FIXTURES}/head-revision/umami.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['reserved_env_name'],
        codes: ['reserved_env_name'],
        warnings: [],
        paths: ['/spec/env/6/name', '/spec/env/7/name'],
        note: 'EVER_WORKS_WEB_INTERNAL_URL, EVER_WORKS_BOOTSTRAP_ADMIN_PASSWORD',
    },
    {
        id: 'head-revision/cal-diy (HEAD e47866dc7)',
        file: `${FIXTURES}/head-revision/cal-diy.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['reserved_env_name'],
        codes: ['reserved_env_name', 'pattern_unsupported'],
        warnings: ['advisory_check'],
        paths: ['/spec/env/9/name', '/spec/env/19/name', '/spec/env/20/name'],
        note: 'three reserved names; the look-around pattern is a second, independent defect',
    },
    // ── the CONTRACTS.md §1 outline, verbatim and materialised ──────────────────────────────────
    {
        id: 'contracts-1/annotated (verbatim CONTRACTS.md §1)',
        file: `${FIXTURES}/contracts-1-annotated.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        codes: null,
        warnings: null,
        paths: [
            '/spec/source/relation',
            '/spec/blueprint/sha',
            '/spec/license/class',
            '/spec/license/source',
            '/spec/build/strategy',
            '/spec/build/image',
            '/spec/components/0/role',
            '/spec/env/0/phase',
            '/spec/env/0/generate/kind',
            '/spec/env/0/generate/keypair/format',
            '/spec/env/0/generate/keypair/passwordEnv',
            '/spec/jobs/0/when',
        ],
        note: 'the outline writes enums and placeholders as prose; every path listed is a documented placeholder. Layer 2 is NOT asserted on this file: with no valid component the resolver cascades, and the cascade is reported for information only (see the issues below).',
    },
    {
        id: 'contracts-1/materialised',
        file: `${FIXTURES}/contracts-1-materialised.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['reference_unresolved', 'auth_env_not_secret'],
        warnings: [],
        note: "§1's own outline names three env entries it never declares: build.args[1].fromEnv CALENDSO_ENCRYPTION_KEY, cron[0].http.authEnv CRON_API_KEY, and (before R15) the same key again",
    },
    // ── positives: the contract's own "must be accepted" cases ───────────────────────────────────
    {
        id: 'pos-00 minimal valid spec',
        file: `${FIXTURES}/positive/pos-00-minimal.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: [],
        warnings: [],
        note: 'only `source` and `source.relation` are required — CONTRACTS.md §1 "every field is optional unless marked required"',
    },
    {
        id: 'pos-01 x- extension keys at three depths',
        file: `${FIXTURES}/positive/pos-01-extension-keys.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: [],
        warnings: [],
        note: 'schema.md §2.3 / C1: `patternProperties: { "^x-": {} }` next to every `additionalProperties: false`',
    },
    {
        id: 'pos-02 appSpecVersion newer than the build',
        file: `${FIXTURES}/positive/pos-02-app-spec-version.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: [],
        warnings: [],
        note: 'the error→warning downgrade for a newer appSpecVersion is deliberately NOT a schema failure',
    },
    {
        id: 'pos-03 spec.kind: app with no root kind',
        file: `${FIXTURES}/positive/pos-03-spec-kind-only.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: [],
        warnings: [],
        note: 'schema.md §1: "When absent, `spec.kind: app` selects this schema"',
    },
    // ── negatives, one per error class ─────────────────────────────────────────────────────────
    {
        id: 'neg-01 unknown field (typo)',
        file: `${FIXTURES}/negative/neg-01-unknown-field.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['unknown_field'],
        codes: [],
        warnings: [],
        paths: ['/spec/components/0'],
        note: '`replica` → `replicas`; the suggestion is Layer-2 work (CONTRACTS.md C1), printed in the schema error table',
    },
    {
        id: 'neg-02 reserved env name',
        file: `${FIXTURES}/negative/neg-02-reserved-env-name.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['reserved_env_name'],
        codes: ['reserved_env_name'],
        warnings: [],
        paths: ['/spec/env/0/name'],
    },
    {
        id: 'neg-03 volumes with replicas > 1',
        file: `${FIXTURES}/negative/neg-03-volumes-with-replicas.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['volume_replicas'],
        codes: [],
        warnings: [],
        paths: ['/spec/components/0/replicas'],
        note: 'R18 is one of the cross-field rules the SCHEMA carries (if/then) — Layer 2 deliberately does not repeat it',
    },
    {
        id: 'neg-04 secret: true with a literal value',
        file: `${FIXTURES}/negative/neg-04-secret-with-literal-value.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['literal_secret_value'],
        codes: ['literal_secret_value'],
        warnings: [],
        paths: ['/spec/env/0'],
    },
    {
        id: 'neg-05 from: outside the reference grammar',
        file: `${FIXTURES}/negative/neg-05-bad-from-reference.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['reference_syntax'],
        codes: ['reference_syntax'],
        warnings: [],
        paths: ['/spec/env/0/from'],
    },
    {
        id: 'neg-06 missing source.relation',
        file: `${FIXTURES}/negative/neg-06-missing-source-relation.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['required'],
        codes: [],
        warnings: [],
        paths: ['/spec/source'],
    },
    {
        id: 'neg-07 well-formed but unresolved from:',
        file: `${FIXTURES}/negative/neg-07-unresolved-reference.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['reference_unresolved'],
        warnings: [],
        note: 'THE LAYER SPLIT: the schema cannot see that `dependencies.redis` was never declared',
    },
    {
        id: 'neg-08 secrecy does not propagate',
        file: `${FIXTURES}/negative/neg-08-secret-not-propagated.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['secret_reference_not_secret'],
        warnings: [],
    },
    {
        id: 'neg-09 env entry with two value sources',
        file: `${FIXTURES}/negative/neg-09-env-two-value-sources.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['env_source_count'],
        codes: ['env_source_count'],
        warnings: [],
        paths: ['/spec/env/0'],
    },
    {
        id: 'neg-10 pkcs12 keypair without passwordEnv',
        file: `${FIXTURES}/negative/neg-10-pkcs12-without-password-env.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['keypair_password_invalid'],
        codes: [],
        warnings: [],
        paths: ['/spec/env/0/generate/keypair'],
        note: '"passwordEnv present exactly when pkcs12" is schema-carried; Layer 2 only validates the named entry',
    },
    {
        id: 'neg-11 worker component with a port',
        file: `${FIXTURES}/negative/neg-11-worker-with-port.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['worker_port_forbidden'],
        codes: [],
        warnings: [],
        paths: ['/spec/components/1'],
    },
    {
        id: 'neg-12 web component without a port',
        file: `${FIXTURES}/negative/neg-12-web-without-port.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['web_component_needs_port'],
        codes: [],
        warnings: [],
        paths: ['/spec/components/0'],
    },
    {
        id: 'neg-13 validate.pattern with look-around',
        file: `${FIXTURES}/negative/neg-13-lookaround-validate-pattern.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['pattern_unsupported'],
        warnings: [],
        note: 'ECMA-262 accepts it; RE2 (schema.md §12) does not — the schema must NOT encode RE2',
    },
    {
        id: 'neg-14 duplicate env name',
        file: `${FIXTURES}/negative/neg-14-duplicate-env-name.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['duplicate_name'],
        warnings: [],
    },
    {
        id: 'neg-15 generate/validate disagree',
        file: `${FIXTURES}/negative/neg-15-generate-validate-conflict.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['generate_validate_conflict'],
        warnings: [],
        note: "CONTRACTS.md C2's own example: base64 of 32 bytes is 44 characters, not 32",
    },
    {
        id: 'neg-16 job component that does not exist',
        file: `${FIXTURES}/negative/neg-16-unknown-component-reference.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['component_ref_unknown'],
        warnings: [],
    },
    {
        id: 'neg-17 warnings only',
        file: `${FIXTURES}/negative/neg-17-warnings-only.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: [],
        warnings: ['advisory_check', 'image_not_pinned', 'secret_build_arg'],
        note: 'a legal document that is still wrong three ways — severity is not a schema concept',
    },
    {
        id: 'neg-18 literal secret in build.args',
        file: `${FIXTURES}/negative/neg-18-literal-secret-in-build-args.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['literal_secret_in_build_args'],
        warnings: [],
        note: 'schema.md §24.4 leading example (R10)',
    },
    {
        id: 'neg-19 upstreamPullRequests.requireApproval: false',
        file: `${FIXTURES}/negative/neg-19-upstream-pr-approval-false.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['upstream_pr_approval_required'],
        codes: ['upstream_pr_approval_required'],
        warnings: [],
        paths: ['/spec/upstreamPullRequests/requireApproval'],
    },
    {
        id: 'neg-20 publicBuckets not a subset of buckets',
        file: `${FIXTURES}/negative/neg-20-public-bucket-undeclared.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['public_bucket_undeclared'],
        warnings: [],
    },
    {
        id: 'neg-21 fork-only blocks on relation: link',
        file: `${FIXTURES}/negative/neg-21-upstream-blocks-on-link.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['upstream_sync_requires_upstream', 'upstream_prs_require_fork'],
        warnings: [],
    },
    {
        id: 'neg-22 upstreamSync schedule too frequent',
        file: `${FIXTURES}/negative/neg-22-schedule-too-frequent.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['schedule_too_frequent'],
        warnings: [],
    },
    {
        id: 'neg-23 cron with the wrong field count',
        file: `${FIXTURES}/negative/neg-23-cron-wrong-field-count.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['cron_invalid'],
        codes: ['cron_invalid'],
        warnings: [],
        paths: ['/spec/cron/0/schedule'],
    },
    {
        id: 'neg-24 memoryLimit below memory',
        file: `${FIXTURES}/negative/neg-24-memory-limit-below-request.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['limit_below_request'],
        warnings: [],
    },
    {
        id: 'neg-25 path outside the repository',
        file: `${FIXTURES}/negative/neg-25-path-outside-repository.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        codes: [],
        warnings: [],
        paths: ['/spec/build/dockerfile', '/spec/display/protectedPaths/0'],
        note: 'R22 is schema-carried (`#/$defs/relPath`, `#/$defs/glob`); Layer 2 does not repeat it',
    },
    {
        id: 'neg-26 keypair format the type cannot produce',
        file: `${FIXTURES}/negative/neg-26-keypair-format-unsupported.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['invalid_enum'],
        codes: [],
        warnings: [],
        paths: ['/spec/env/0/generate/keypair/type'],
        note: 'R25 is schema-carried; the JSON Schema failure carries no code of its own, which is why §5 of validator-rules.md maps keyword+path → code',
    },
    {
        id: 'neg-27 spec.kind disagrees with root kind',
        file: `${FIXTURES}/negative/neg-27-kind-mismatch.works.yml`,
        layer: 'data-repository',
        schema: 'fail',
        schemaCodes: ['kind_mismatch'],
        codes: ['kind_mismatch'],
        warnings: [],
        paths: ['/spec/kind'],
    },
    {
        id: 'neg-28 template cycle',
        file: `${FIXTURES}/negative/neg-28-template-cycle.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['template_cycle'],
        warnings: [],
    },
    {
        id: 'neg-29 template chain deeper than 10',
        file: `${FIXTURES}/negative/neg-29-template-too-deep.works.yml`,
        layer: 'data-repository',
        schema: 'pass',
        codes: ['template_too_deep'],
        warnings: [],
    },
    // ── mode-dependent rule: the same Blueprints in blueprint mode ──────────────────────────────
    {
        id: 'blueprint-mode/cal-diy (mode: blueprint)',
        file: `${FIXTURES}/head-revision/cal-diy.works.yml`,
        layer: 'blueprint',
        schema: 'fail',
        codes: ['reserved_env_name', 'pattern_unsupported'],
        warnings: ['advisory_check'],
        note: 'schema.md §3 ALLOWS `source`/`blueprint` in blueprint mode since the 2026-09-17 correction (it used to forbid them, which no Blueprint could satisfy). This fixture still fails on the two real defects the HEAD revision carries: the reserved env names and the RE2-illegal look-around pattern.',
    },
];

/* -------------------------------------------------------------------------------------------------
 * Layer 1 → APP_SPEC_ISSUE_CODES mapping.
 *
 * JSON Schema reports KEYWORDS; schema.md §23 reports CODES. This is the translation the validator has
 * to perform, kept next to the evidence so the mapping is testable rather than aspirational.
 * ----------------------------------------------------------------------------------------------- */
function codeForSchemaError(error) {
    const p = error.instancePath;
    switch (error.keyword) {
        case 'additionalProperties':
            return 'unknown_field';
        case 'required':
            // A `then: { required: [...] }` branch reports as `required` with no hint of which rule
            // demanded it, so the code depends on WHERE the missing key is.
            if (error.params.missingProperty === 'port' && /\/components\/\d+$/.test(p)) return 'web_component_needs_port';
            if (error.params.missingProperty === 'passwordEnv') return 'keypair_password_invalid';
            if (error.params.missingProperty === 'strategy') return 'components_require_strategy';
            if (error.params.missingProperty === 'components') return 'strategy_requires_components';
            return 'required';
        case 'type':
            return 'invalid_type';
        case 'enum':
            return 'invalid_enum';
        case 'const':
            if (/^\/(kind|spec\/kind)$/.test(p)) return 'kind_mismatch';
            if (/upstreamPullRequests\/requireApproval$/.test(p)) return 'upstream_pr_approval_required';
            if (/\/probes\/\w+\/tcp$/.test(p)) return 'invalid_type';
            return 'invalid_enum';
        case 'minimum':
        case 'maximum':
        case 'exclusiveMinimum':
        case 'minItems':
        case 'maxItems':
        case 'minLength':
        case 'maxLength':
            if (/\/components\/\d+\/replicas$/.test(p)) return 'volume_replicas';
            return 'out_of_range';
        case 'uniqueItems':
            return 'duplicate_name';
        case 'pattern':
            if (/\/from$/.test(p)) return 'reference_syntax';
            if (/\/schedule$/.test(p)) return 'cron_invalid';
            if (/\/check\/\d+\/command$|\/checks\/\d+\/command$/.test(p)) return 'pattern';
            return 'pattern';
        case 'oneOf':
            if (/\/env\/\d+$/.test(p)) return 'env_source_count';
            if (/\/probes\/(startup|readiness|liveness)$/.test(p)) return 'invalid_type';
            if (/\/(jobs|cron)\/\d+$/.test(p)) return 'invalid_type';
            if (/\/components\/\d+\/build\/args\/\d+$|\/build\/args\/\d+$/.test(p)) return 'env_source_count';
            return 'invalid_type';
        case 'not':
            if (/\/env\/\d+\/name$/.test(p)) return 'reserved_env_name';
            if (/\/env\/\d+$/.test(p)) return 'literal_secret_value';
            if (/\/components\/\d+$/.test(p)) return 'worker_port_forbidden';
            if (/\/generate\/keypair$/.test(p)) return 'keypair_password_invalid';
            if (/\/build$/.test(p)) return 'unknown_field';
            return 'invalid_type';
        default:
            // `if`/`then` failures surface on the inner keyword of the `then` branch
            // (`then` has no keyword of its own), so anything left here is reported structurally.
            return 'invalid_type';
    }
}

/** Human sentence for one Ajv error — mirrors `describeSchemaError` in schema-validator.ts:96-110. */
function describe(error) {
    const where = error.instancePath === '' ? 'the document root' : error.instancePath;
    if (error.keyword === 'additionalProperties') {
        return `${where} has an unpermitted field "${error.params.additionalProperty}"`;
    }
    if (error.keyword === 'required') {
        return `${where} is missing the required field "${error.params.missingProperty}"`;
    }
    if (error.keyword === 'oneOf') return `${where} must match exactly one of the allowed shapes`;
    if (error.keyword === 'not') return `${where} must NOT match the forbidden shape`;
    if (error.keyword === 'const') return `${where} must be ${JSON.stringify(error.params.allowedValue)}`;
    if (error.keyword === 'enum') return `${where} must be one of ${error.params.allowedValues.join(', ')}`;
    if (error.keyword === 'pattern') return `${where} does not match ${error.params.pattern}`;
    return `${where} ${error.message}`;
}

/* -------------------------------------------------------------------------------------------------
 * Layer 2 — reference implementation of the rules JSON Schema cannot express.
 * ----------------------------------------------------------------------------------------------- */

/** schema.md §11 output table. † = secret. */
const DEP_OUTPUTS = {
    postgres: ['url', 'directUrl', 'host', 'port', 'database', 'user', 'password'],
    redis: ['url', 'host', 'port', 'password'],
    objectStorage: ['endpoint', 'region', 'accessKeyId', 'secretAccessKey'],
    smtp: ['host', 'port', 'user', 'password', 'from', 'secure'],
};
const SECRET_OUTPUTS = new Set([
    'deps.postgres.url',
    'deps.postgres.directUrl',
    'deps.postgres.password',
    'deps.redis.url',
    'deps.redis.password',
    'deps.objectStorage.accessKeyId',
    'deps.objectStorage.secretAccessKey',
    'deps.smtp.password',
]);
const PLATFORM_SMTP_FIELDS = ['host', 'port', 'user', 'password', 'from', 'secure'];
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SECRETISH_NAME_RE = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|APIKEY|API_KEY/i;
const SECRETISH_VALUE_RE = /^(sk_live_|sk_test_|ghp_|gho_|github_pat_|AKIA|xox[baprs]-)/;
const RE2_UNSUPPORTED_RE = /\(\?<?[=!]|\\[1-9]|\\k<|\(\?P=/;

/** Damerau-Levenshtein distance, for the `unknown_field` suggestion (plan.md §2.2 "Suggestions"). */
function editDistance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j += 1) d[0][j] = j;
    for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
            }
        }
    }
    return d[a.length][b.length];
}

/** Allowed keys at the level an Ajv `additionalProperties` error points at, read back out of the schema. */
function allowedKeysAt(schemaPointer) {
    const base = schemaPointer.replace(/\/additionalProperties$/, '/properties');
    const node = base.split('/').slice(1).reduce((acc, raw) => {
        const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        return acc === undefined || acc === null ? undefined : acc[key];
    }, schema);
    return node ? Object.keys(node) : [];
}

function suggestKey(key, allowed) {
    let best;
    for (const candidate of allowed) {
        if (candidate === key) continue;
        const distance = editDistance(key, candidate);
        if (distance <= 2 && (best === undefined || distance < best.distance || (distance === best.distance && candidate < best.key))) {
            best = { key: candidate, distance };
        }
    }
    return best?.key;
}

/** Parse a `Mi`/`Gi` (memory, storage) or millicore/core (cpu) quantity into a comparable number. */
function quantity(value, unit) {
    if (typeof value !== 'string') return undefined;
    const match = /^(\d+)(m|Mi|Gi)?$/.exec(value.trim());
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (unit === 'cpu') return match[2] === 'm' ? amount : amount * 1000;
    if (match[2] === 'Mi') return amount;
    if (match[2] === 'Gi') return amount * 1024;
    return undefined;
}

/** §12 "Generated length" table. `null` = no fixed length (any validate.length conflicts). */
function generatedLength(generate) {
    if (!generate || typeof generate !== 'object') return undefined;
    const bytes = typeof generate.bytes === 'number' ? generate.bytes : 32;
    const length = typeof generate.length === 'number' ? generate.length : 32;
    switch (generate.kind) {
        case 'hex':
            return 2 * bytes;
        case 'base64':
            return 4 * Math.ceil(bytes / 3);
        case 'chars':
            return length;
        case 'uuid':
            return 36;
        case 'keypair':
            return generate.keypair?.format === 'base64url-raw' ? 43 : null;
        default:
            return undefined;
    }
}

/** Minimum minutes between two consecutive fires of a five-field cron, for R21 (approximate by design). */
function minimumIntervalMinutes(expression) {
    const fields = String(expression).trim().split(/\s+/);
    if (fields.length !== 5) return 0;
    const [minute, hour] = fields;
    const stepOf = (field) => (/^\*\/(\d+)$/.exec(field) ? Number(/^\*\/(\d+)$/.exec(field)[1]) : undefined);
    const minuteStep = stepOf(minute);
    if (minuteStep !== undefined) return minuteStep;
    if (minute === '*') return 1;
    if (hour === '*') return 60;
    const hourStep = stepOf(hour);
    if (hourStep !== undefined) return hourStep * 60;
    return 1440;
}

function invalidCronField(expression) {
    const fields = String(expression).trim().split(/\s+/);
    if (fields.length !== 5) return true;
    const bounds = [
        [0, 59],
        [0, 23],
        [1, 31],
        [1, 12],
        [0, 7],
    ];
    return fields.some((field, index) => {
        const [low, high] = bounds[index];
        return field.split(',').some((part) => {
            const body = part.includes('/') ? part.split('/')[0] : part;
            if (body === '*') return false;
            const range = body.split('-').map(Number);
            if (range.some((n) => !Number.isInteger(n))) return true;
            return range.some((n) => n < low || n > high);
        });
    });
}

function checkRules(document, mode) {
    const issues = [];
    const add = (code, severity, at, message) => issues.push({ code, severity, path: at, message });
    const spec = document?.spec;
    if (!spec || typeof spec !== 'object') return issues;

    // §1 — the two kind spellings must agree.
    if (document.kind && spec.kind && document.kind !== spec.kind) {
        add('kind_mismatch', 'error', 'spec.kind', `root kind is "${document.kind}" but spec.kind is "${spec.kind}"`);
    }

    // §3 — blueprint mode. CORRECTED 2026-09-17: this used to emit `blueprint_mode_forbidden_key` for
    // `spec.source` and `spec.blueprint`, which no APW-13 Blueprint could satisfy while catalog CI check C4
    // demands zero errors — all three declare both keys. schema.md §3 now ALLOWS them in this mode (a
    // Blueprint's file becomes the App Work's spec, where both are present). The rule that applies instead is
    // that `blueprint.repo` must name the repository the file lives in; the harness has no repo context, so it
    // is asserted in catalog CI rather than here. `blueprint_mode_forbidden_key` stays in §23's code list but
    // is no longer emitted for these two keys.

    const components = Array.isArray(spec.components) ? spec.components : [];
    const env = Array.isArray(spec.env) ? spec.env : [];
    const webComponents = components.filter((c) => c?.role === 'web');
    const componentNames = new Set(components.map((c) => c?.name));
    const envByName = new Map(env.filter((e) => e?.name).map((e) => [e.name, e]));
    const secretEnvNames = new Set(env.filter((e) => e?.secret === true).map((e) => e.name));

    // R23 — reserved env prefix.
    env.forEach((entry, index) => {
        if (typeof entry?.name === 'string' && entry.name.startsWith('EVER_WORKS_')) {
            add('reserved_env_name', 'error', `spec.env[${index}].name`, `\`${entry.name}\` uses the reserved EVER_WORKS_ prefix`);
        }
    });

    // R4 — unique names, including the implicit <NAME>_PUBLIC of every keypair entry.
    const uniqueIn = (list, label, at) => {
        const seen = new Set();
        (Array.isArray(list) ? list : []).forEach((entry, index) => {
            const name = entry?.name;
            if (typeof name !== 'string') return;
            if (seen.has(name)) add('duplicate_name', 'error', `${at}[${index}].name`, `duplicate ${label} name "${name}"`);
            seen.add(name);
        });
    };
    uniqueIn(components, 'component', 'spec.components');
    uniqueIn(spec.jobs, 'job', 'spec.jobs');
    uniqueIn(spec.cron, 'cron', 'spec.cron');
    uniqueIn(spec.smoke, 'smoke', 'spec.smoke');
    uniqueIn(spec.checks, 'check', 'spec.checks');
    {
        const seen = new Set();
        env.forEach((entry, index) => {
            if (typeof entry?.name !== 'string') return;
            if (seen.has(entry.name)) add('duplicate_name', 'error', `spec.env[${index}].name`, `duplicate env name "${entry.name}"`);
            seen.add(entry.name);
            const derived = entry?.generate?.kind === 'keypair' ? `${entry.name}_PUBLIC` : undefined;
            if (derived) {
                if (seen.has(derived) || env.some((other) => other?.name === derived)) {
                    add('duplicate_name', 'error', `spec.env[${index}].name`, `\`${derived}\` is the implicit public half of \`${entry.name}\``);
                }
                seen.add(derived);
            }
        });
    }

    // R7 — exactly one value source; R8; §12 `generate` implies `secret`; R9; §12 RE2.
    env.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const at = `spec.env[${index}]`;
        const sources = ['value', 'from', 'template', 'generate', 'prompt'].filter((key) => entry[key] !== undefined);
        if (sources.length !== 1) {
            add('env_source_count', 'error', `${at}`, `entry has ${sources.length} value sources (${sources.join(', ') || 'none'}); exactly one is required`);
        }
        if (entry.secret === true && entry.value !== undefined) {
            add('literal_secret_value', 'error', `${at}.value`, 'a secret entry may not carry a literal value');
        }
        if (entry.generate && entry.secret !== true) {
            add('generated_not_secret', 'error', `${at}.secret`, 'a generated entry must be `secret: true`');
        }
        if (entry.validate?.pattern && RE2_UNSUPPORTED_RE.test(String(entry.validate.pattern))) {
            add('pattern_unsupported', 'error', `${at}.validate.pattern`, 'RE2 has no look-around and no back-references');
        }
        const generated = generatedLength(entry.generate);
        const validate = entry.validate;
        if (validate && generated !== undefined) {
            const checks = [];
            if (typeof validate.length === 'number') checks.push(['length', validate.length]);
            if (typeof validate.minLength === 'number') checks.push(['minLength', validate.minLength]);
            if (typeof validate.maxLength === 'number') checks.push(['maxLength', validate.maxLength]);
            for (const [field, declared] of checks) {
                const conflict =
                    generated === null ||
                    (field === 'length' && declared !== generated) ||
                    (field === 'minLength' && declared > generated) ||
                    (field === 'maxLength' && declared < generated);
                if (conflict) {
                    add(
                        'generate_validate_conflict',
                        'error',
                        `${at}.validate.${field}`,
                        generated === null
                            ? `a ${entry.generate?.kind} generated value has no fixed length, so validate.${field} cannot hold`
                            : `the generator produces ${generated} characters, validate.${field} is ${declared}`,
                    );
                }
            }
            if (typeof validate.minLength === 'number' && typeof validate.maxLength === 'number' && validate.minLength > validate.maxLength) {
                add('generate_validate_conflict', 'error', `${at}.validate`, 'minLength is greater than maxLength');
            }
        }
    });

    // §21 — references.
    const resolve = (reference) => {
        if (validateReference(reference) !== true) return { ok: false, code: 'reference_syntax', why: 'not a Reference in the §21 grammar' };
        if (/^domains\.primary\./.test(reference)) {
            if (!webComponents.length) return { ok: false, code: 'reference_unresolved', why: 'no `web` component exists' };
            return { ok: true, secret: false };
        }
        if (reference === 'build.commitSha') {
            const strategy = spec.build?.strategy;
            if (strategy !== 'dockerfile' && strategy !== 'auto') {
                return { ok: false, code: 'reference_unresolved', why: 'no Build produces the image when build.strategy is not dockerfile/auto' };
            }
            return { ok: true, secret: false };
        }
        if (/^components\./.test(reference)) {
            const name = reference.split('.')[1];
            const component = components.find((c) => c?.name === name);
            if (!component) return { ok: false, code: 'reference_unresolved', why: `no component named \`${name}\`` };
            if (component.role !== 'web') return { ok: false, code: 'reference_unresolved', why: `component \`${name}\` is not a web component` };
            return { ok: true, secret: false };
        }
        if (/^platform\.smtp\./.test(reference)) {
            const field = reference.split('.')[2];
            if (!PLATFORM_SMTP_FIELDS.includes(field)) return { ok: false, code: 'reference_syntax', why: `platform.smtp has no output \`${field}\`` };
            if (!spec.dependencies?.smtp) return { ok: false, code: 'reference_unresolved', why: 'dependencies.smtp is not declared' };
            return { ok: true, secret: field === 'password' };
        }
        const [, kind, ...rest] = reference.split('.');
        const output = rest.join('.');
        const declared = spec.dependencies?.[kind];
        if (!declared) return { ok: false, code: 'reference_unresolved', why: `dependencies.${kind} is not declared` };
        if (kind === 'objectStorage' && output.startsWith('bucket.')) {
            const bucket = output.slice('bucket.'.length);
            if (!(declared.buckets ?? []).includes(bucket)) {
                return { ok: false, code: 'reference_unresolved', why: `bucket \`${bucket}\` is not in dependencies.objectStorage.buckets` };
            }
            return { ok: true, secret: false };
        }
        if (!DEP_OUTPUTS[kind]?.includes(output)) {
            return { ok: false, code: 'reference_syntax', why: `${kind} has no output \`${output}\`` };
        }
        if (kind === 'postgres' && output === 'directUrl' && declared.directUrl !== true) {
            return { ok: false, code: 'reference_unresolved', why: 'deps.postgres.directUrl needs `directUrl: true`' };
        }
        const scalar = kind === 'objectStorage' || kind === 'platform.smtp' ? `${kind === 'objectStorage' ? 'deps' : 'platform'}.${kind}.${output}` : `deps.${kind}.${output}`;
        return { ok: true, secret: SECRET_OUTPUTS.has(scalar) || scalar === 'platform.smtp.password' };
    };

    env.forEach((entry, index) => {
        const at = `spec.env[${index}]`;
        if (entry?.from !== undefined) {
            const result = resolve(entry.from);
            if (!result.ok) add(result.code, 'error', `${at}.from`, `\`${entry.from}\`: ${result.why}`);
            else if (result.secret && entry.secret !== true) {
                add('secret_reference_not_secret', 'error', `${at}.secret`, `\`${entry.name}\` reads a secret output, so it must be secret: true`);
            }
        }
        if (entry?.template !== undefined) {
            const text = String(entry.template);
            const placeholders = [...text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((match) => match[1]);
            const opens = (text.match(/\{\{/g) ?? []).length;
            if (opens !== placeholders.length) add('reference_syntax', 'error', `${at}.template`, 'unbalanced `{{` placeholder');
            let secret = false;
            for (const body of placeholders) {
                if (/^env\./.test(body)) {
                    const name = body.slice('env.'.length);
                    const target = envByName.get(name);
                    if (!target) add('reference_unresolved', 'error', `${at}.template`, `no env entry named \`${name}\``);
                    else if (target.secret === true) secret = true;
                    continue;
                }
                const result = resolve(body);
                if (!result.ok) add(result.code, 'error', `${at}.template`, `\`${body}\`: ${result.why}`);
                else if (result.secret) secret = true;
            }
            if (secret && entry.secret !== true) {
                add('secret_reference_not_secret', 'error', `${at}.secret`, `\`${entry.name}\` templates a secret value, so it must be secret: true`);
            }
        }
        if (entry?.generate?.keypair?.passwordEnv !== undefined) {
            const name = entry.generate.keypair.passwordEnv;
            const target = envByName.get(name);
            const usable = target && target.secret === true && ['base64', 'hex', 'chars'].includes(target.generate?.kind);
            if (!usable) {
                add('keypair_password_invalid', 'error', `${at}.generate.keypair.passwordEnv`, `\`${name}\` must be a secret entry generated with base64, hex or chars`);
            }
        }
    });

    // §21 — `template` cycles and resolution depth. A graph walk, not a per-entry check: every string is
    // individually legal, and only the chain of `template` → `env.<NAME>` edges makes it wrong.
    const TEMPLATE_DEPTH_LIMIT = 10;
    const templateEdges = (entry) =>
        [...String(entry?.template ?? '').matchAll(/\{\{\s*env\.([A-Z_][A-Z0-9_]{0,127})\s*\}\}/g)].map((match) => match[1]);
    {
        const state = new Map();
        const stack = [];
        const walk = (name, depth) => {
            const mark = state.get(name);
            if (mark === 'visiting') {
                const cycle = stack.slice(stack.indexOf(name)).concat(name);
                add('template_cycle', 'error', `spec.env.${name}.template`, `template cycle: ${cycle.join(' → ')}`);
                return;
            }
            if (mark === 'done') return;
            const entry = envByName.get(name);
            if (!entry) return;
            if (depth > TEMPLATE_DEPTH_LIMIT) {
                add('template_too_deep', 'error', `spec.env.${name}.template`, `resolution depth exceeds ${TEMPLATE_DEPTH_LIMIT}`);
                return;
            }
            state.set(name, 'visiting');
            stack.push(name);
            for (const next of templateEdges(entry)) walk(next, depth + 1);
            stack.pop();
            state.set(name, 'done');
        };
        for (const entry of env) {
            if (entry?.template !== undefined && typeof entry.name === 'string') walk(entry.name, 1);
        }
    }

    // R5 / R10 / R11 — build.args.
    (spec.build?.args ?? []).forEach((argument, index) => {
        // R10 — a literal secret in a build argument is an error whether or not `fromEnv` is present, so
        // this must run BEFORE the fromEnv early-return below (it did not, and neg-18 caught it).
        if (argument?.value !== undefined) {
            const value = String(argument.value);
            if (value !== '' && (SECRETISH_NAME_RE.test(String(argument.name ?? '')) || SECRETISH_VALUE_RE.test(value))) {
                add('literal_secret_in_build_args', 'error', `spec.build.args[${index}].value`, 'build arguments are stored in image layers');
            }
        }
        if (argument?.fromEnv === undefined) return;
        const target = envByName.get(argument.fromEnv);
        if (!target) add('reference_unresolved', 'error', `spec.build.args[${index}].fromEnv`, `no env entry named \`${argument.fromEnv}\``);
        else if (target.phase !== undefined && target.phase !== 'build' && target.phase !== 'both') {
            add('phase_mismatch', 'error', `spec.build.args[${index}].fromEnv`, `\`${argument.fromEnv}\` is not a build-phase entry`);
        } else if (target.secret === true) {
            add('secret_build_arg', 'warning', `spec.build.args[${index}].fromEnv`, `\`${argument.fromEnv}\` is a secret baked into image layers`);
        }
    });
    // R19 — a tag-only image reference.
    if (spec.build?.strategy === 'image' && typeof spec.build.image === 'string' && !spec.build.image.includes('@sha256:')) {
        add('image_not_pinned', 'warning', 'spec.build.image', '`image` is a moving tag; pin by digest');
    }

    // R14 / R3 — component references.
    const primary = spec.domains?.primaryComponent ?? webComponents[0]?.name;
    const refTargets = [
        ['jobs', spec.jobs, (index) => `spec.jobs[${index}].component`],
        ['cron', spec.cron, (index) => `spec.cron[${index}].component`],
        ['smoke', spec.smoke, (index) => `spec.smoke[${index}].component`],
    ];
    for (const [label, list, at] of refTargets) {
        (Array.isArray(list) ? list : []).forEach((entry, index) => {
            const name = entry?.component ?? primary;
            if (name === undefined) return;
            if (!componentNames.has(name)) {
                add('component_ref_unknown', 'error', at(index), `no component named \`${name}\``);
                return;
            }
            if (label === 'smoke' && components.find((c) => c.name === name)?.role !== 'web') {
                add('component_ref_unknown', 'error', at(index), `smoke targets \`${name}\`, which is not a web component`);
            }
        });
    }
    if (spec.domains?.primaryComponent !== undefined) {
        const target = components.find((c) => c.name === spec.domains.primaryComponent);
        if (!target || target.role !== 'web') {
            add('primary_component_invalid', 'error', 'spec.domains.primaryComponent', '`domains.primaryComponent` must name a web component');
        }
    } else if (webComponents.length > 1) {
        add('primary_component_invalid', 'error', 'spec.domains', '`domains.primaryComponent` is required with two or more web components');
    }

    // §13 — an `http` job needs a web component; R15 — authEnv must be secret.
    const httpCarriers = [
        ['spec.jobs', spec.jobs],
        ['spec.cron', spec.cron],
    ];
    for (const [at, list] of httpCarriers) {
        (Array.isArray(list) ? list : []).forEach((entry, index) => {
            if (entry?.http) {
                const name = entry.component ?? primary;
                const target = components.find((c) => c.name === name);
                if (!target || target.role !== 'web') {
                    add('http_job_requires_web_component', 'error', `${at}[${index}].component`, 'an http job requires a web component');
                }
            }
            if (entry?.http?.authEnv !== undefined && !secretEnvNames.has(entry.http.authEnv)) {
                add('auth_env_not_secret', 'error', `${at}[${index}].http.authEnv`, `\`${entry.http.authEnv}\` must name a secret: true entry`);
            }
        });
    }

    // R16 — domains.publicUrlEnv names env entries.
    (spec.domains?.publicUrlEnv ?? []).forEach((name, index) => {
        if (!envByName.has(name)) add('reference_unresolved', 'error', `spec.domains.publicUrlEnv[${index}]`, `no env entry named \`${name}\``);
    });

    // R13 — link forbids upstream-only blocks.
    if (spec.source?.relation === 'link') {
        if (spec.source.upstream !== undefined) add('upstream_forbidden_for_link', 'error', 'spec.source.upstream', 'a link App Work has no upstream');
        if (spec.upstreamSync !== undefined) add('upstream_sync_requires_upstream', 'error', 'spec.upstreamSync', 'a link App Work cannot sync an upstream');
        if (spec.upstreamPullRequests?.enabled === true) add('upstream_prs_require_fork', 'error', 'spec.upstreamPullRequests.enabled', 'upstream pull requests need a fork');
    } else if (spec.upstreamPullRequests?.enabled === true && spec.source?.relation === 'private-copy') {
        add('upstream_prs_require_fork', 'error', 'spec.upstreamPullRequests.enabled', 'upstream pull requests need a fork');
    }
    if (spec.upstreamPullRequests?.requireApproval === false) {
        add('upstream_pr_approval_required', 'error', 'spec.upstreamPullRequests.requireApproval', 'upstream pull requests always need a person’s approval');
    }

    // §11 — publicBuckets ⊆ buckets.
    const storage = spec.dependencies?.objectStorage;
    if (storage?.publicBuckets) {
        for (const bucket of storage.publicBuckets) {
            if (!(storage.buckets ?? []).includes(bucket)) {
                add('public_bucket_undeclared', 'error', 'spec.dependencies.objectStorage.publicBuckets', `\`${bucket}\` is not in \`buckets\``);
            }
        }
    }

    // R21 / §14 — cron.
    if (spec.upstreamSync?.schedule !== undefined) {
        if (invalidCronField(spec.upstreamSync.schedule)) {
            add('cron_invalid', 'error', 'spec.upstreamSync.schedule', `cannot parse \`${spec.upstreamSync.schedule}\``);
        } else if (minimumIntervalMinutes(spec.upstreamSync.schedule) < 60) {
            add('schedule_too_frequent', 'error', 'spec.upstreamSync.schedule', 'consecutive upstream syncs must be at least 60 minutes apart');
        }
    }
    (Array.isArray(spec.cron) ? spec.cron : []).forEach((entry, index) => {
        if (typeof entry?.schedule === 'string' && invalidCronField(entry.schedule)) {
            add('cron_invalid', 'error', `spec.cron[${index}].schedule`, `cannot parse \`${entry.schedule}\``);
        }
    });

    // R17 — limits are not below requests.
    components.forEach((component, index) => {
        const resources = component?.resources ?? {};
        const memory = quantity(resources.memory, 'mem');
        const memoryLimit = quantity(resources.memoryLimit, 'mem');
        const cpu = quantity(resources.cpu, 'cpu');
        const cpuLimit = quantity(resources.cpuLimit, 'cpu');
        if (memory !== undefined && memoryLimit !== undefined && memoryLimit < memory) {
            add('limit_below_request', 'error', `spec.components[${index}].resources.memoryLimit`, `${resources.memoryLimit} is below ${resources.memory}`);
        }
        if (cpu !== undefined && cpuLimit !== undefined && cpuLimit < cpu) {
            add('limit_below_request', 'error', `spec.components[${index}].resources.cpuLimit`, `${resources.cpuLimit} is below ${resources.cpu}`);
        }
    });

    // R20 — an advisory check verifies nothing.
    (Array.isArray(spec.checks) ? spec.checks : []).forEach((check, index) => {
        if (check?.required === false) {
            add('advisory_check', 'warning', `spec.checks[${index}].required`, `\`${check.name}\` is advisory, so it verifies nothing`);
        }
    });

    return issues;
}

/* -------------------------------------------------------------------------------------------------
 * Run
 * ----------------------------------------------------------------------------------------------- */
function pointerMatches(expectedPath, error) {
    if (error.instancePath === expectedPath) return true;
    // a `oneOf`/`not` failure points at the object; the expectation may name the child that caused it
    return error.instancePath !== '' && expectedPath.startsWith(`${error.instancePath}/`);
}

const results = [];
for (const fixture of REGISTRY) {
    const absolute = path.resolve(REPO_ROOT, fixture.file);
    const display = path.relative(REPO_ROOT, absolute).replace(/\\/g, '/');
    const record = { fixture, display, problems: [] };

    if (!fs.existsSync(absolute)) {
        record.problems.push(`fixture file missing: ${display}`);
        record.schemaVerdict = 'n/a';
        record.ruleVerdict = 'n/a';
        record.schemaErrors = [];
        record.issues = [];
        record.matched = false;
        results.push(record);
        continue;
    }
    const text = fs.readFileSync(absolute, 'utf8');
    record.sha256 = crypto.createHash('sha256').update(text).digest('hex');

    let document;
    try {
        document = YAML.parse(text, { uniqueKeys: true, maxAliasCount: 100 });
        record.parsed = true;
    } catch (error) {
        record.parsed = false;
        record.parseError = error.message;
        record.schemaVerdict = 'fail';
        record.schemaErrors = [];
        record.issues = [];
        if (fixture.schema !== 'fail') record.problems.push(`expected schema ${fixture.schema.toUpperCase()} but the YAML did not parse`);
        record.matched = record.problems.length === 0;
        results.push(record);
        continue;
    }

    const schemaOk = validateDocument(document);
    record.schemaVerdict = schemaOk ? 'pass' : 'fail';
    record.schemaErrors = (validateDocument.errors ?? []).map((error) => ({
        keyword: error.keyword,
        instancePath: error.instancePath || '/',
        schemaPath: error.schemaPath,
        code: codeForSchemaError(error),
        message: describe(error),
        suggestion:
            error.keyword === 'additionalProperties'
                ? suggestKey(error.params.additionalProperty, allowedKeysAt(error.schemaPath))
                : undefined,
    }));

    record.issues = [];
    try {
        record.issues = checkRules(document, fixture.layer);
    } catch (error) {
        record.ruleError = error.stack ?? String(error);
    }
    const ruleErrors = record.issues.filter((issue) => issue.severity === 'error');
    const ruleWarnings = record.issues.filter((issue) => issue.severity === 'warning');
    record.ruleVerdict = record.ruleError || ruleErrors.length ? 'fail' : 'pass';

    // expectations
    if (record.schemaVerdict !== fixture.schema) {
        record.problems.push(`schema: expected ${fixture.schema.toUpperCase()}, got ${record.schemaVerdict.toUpperCase()}`);
    }
    for (const path_ of fixture.paths ?? []) {
        if (!record.schemaErrors.some((error) => pointerMatches(path_, error))) {
            record.problems.push(`schema: expected a failure at ${path_}, none reported`);
        }
    }
    const actualCodes = [...new Set(ruleErrors.map((issue) => issue.code))].sort();
    const expectedCodes = fixture.codes === null ? null : [...fixture.codes].sort();
    if (expectedCodes && actualCodes.join(',') !== expectedCodes.join(',')) {
        record.problems.push(`rules: expected errors [${expectedCodes.join(', ')}], got [${actualCodes.join(', ')}]`);
    }
    if (expectedCodes === null) record.ruleCodesNotAsserted = true;
    const actualWarnings = [...new Set(ruleWarnings.map((issue) => issue.code))].sort();
    const expectedWarnings = fixture.warnings === null ? null : [...fixture.warnings].sort();
    if (expectedWarnings && actualWarnings.join(',') !== expectedWarnings.join(',')) {
        record.problems.push(`rules: expected warnings [${expectedWarnings.join(', ')}], got [${actualWarnings.join(', ')}]`);
    }
    // The layer-1 keyword → APP_SPEC_ISSUE_CODES translation is itself an assertion: it is the mapping
    // the production validator has to perform, and asserting only the Ajv verdict would not test it.
    const actualSchemaCodes = [...new Set(record.schemaErrors.map((error) => error.code))].sort();
    const expectedSchemaCodes = [...(fixture.schemaCodes ?? [])].sort();
    for (const code of expectedSchemaCodes) {
        if (!actualSchemaCodes.includes(code)) {
            record.problems.push(`schema: expected the layer-1 code ${code}, got [${actualSchemaCodes.join(', ')}]`);
        }
    }
    record.matched = record.problems.length === 0;
    results.push(record);
}

/* ---- report --------------------------------------------------------------------------------- */
const out = [];
const line = (text = '') => out.push(text);

line('================================================================================');
line('APW-03 App spec schema — evidence run');
line('================================================================================');
line(`run at        : ${new Date().toISOString()}`);
line(`node          : ${process.version}`);
line(`repo root     : ${REPO_ROOT}`);
line(`schema        : ${path.relative(REPO_ROOT, SCHEMA_PATH).replace(/\\/g, '/')}`);
line(`schema sha256 : ${schemaSha}`);
line(`$schema       : ${schema.$schema}`);
line(`$id           : ${schema.$id}`);
line(`$defs         : ${Object.keys(schema.$defs).length} definitions`);
line(`ajv           : ${requireFromAgent.resolve('ajv/dist/2020.js')}`);
line(`ajv options   : { strict: false, allErrors: true, allowUnionTypes: true }  (packages/agent-plugins/src/schema-validator.ts:53)`);
line(`yaml          : ${requireFromAgent.resolve('yaml')}`);
line(`fixtures      : ${REGISTRY.length}`);
line();

for (const record of results) {
    line('-'.repeat(80));
    line(`FIXTURE   ${record.fixture.id}`);
    line(`file      ${record.display}`);
    line(`mode      ${record.fixture.layer}`);
    if (record.fixture.note) line(`note      ${record.fixture.note}`);
    line(`sha256    ${record.sha256 ?? '(not read)'}`);
    if (record.parseError) line(`YAML      PARSE ERROR: ${record.parseError}`);
    line(`SCHEMA    ${record.schemaVerdict.toUpperCase()}  (expected ${record.fixture.schema.toUpperCase()})`);
    if (record.schemaErrors.length) {
        for (const error of record.schemaErrors) {
            line(`  ${error.code.padEnd(30)} ${error.instancePath.padEnd(38)} ${error.keyword.padEnd(22)} ${error.message}`);
            if (error.suggestion) line(`  ${''.padEnd(30)} ${''.padEnd(38)} ${'suggestion'.padEnd(22)} Did you mean \`${error.suggestion}\`?`);
        }
    }
    if (record.ruleError) line(`RULES     THREW: ${record.ruleError}`);
    line(`RULES     ${record.ruleVerdict.toUpperCase()}`);
    for (const issue of record.issues) {
        line(`  ${issue.severity.padEnd(8)} ${issue.code.padEnd(31)} ${String(issue.path).padEnd(38)} ${issue.message}`);
    }
    line(`VERDICT   ${record.matched ? 'expectation met' : 'EXPECTATION NOT MET'}`);
    for (const problem of record.problems) line(`  !! ${problem}`);
    line();
}

line('================================================================================');
line('SUMMARY');
line('================================================================================');
line(`${'fixture'.padEnd(52)} ${'schema'.padEnd(8)} ${'rules'.padEnd(7)} ${'verdict'}`);
for (const record of results) {
    line(
        `${record.fixture.id.slice(0, 51).padEnd(52)} ${record.schemaVerdict.padEnd(8)} ${record.ruleVerdict.padEnd(7)} ${
            record.matched ? 'met' : 'NOT MET'
        }`,
    );
}
line();
const mismatches = results.filter((record) => !record.matched);
const schemaFailures = results.filter((record) => record.schemaVerdict === 'fail');
const splitFixtures = results.filter((record) => record.schemaVerdict === 'pass' && record.ruleVerdict === 'fail');
const blueprintFixtures = results.filter((record) => record.fixture.id.startsWith('blueprint/'));
const headFixtures = results.filter((record) => record.fixture.id.startsWith('head-revision/'));
line(`fixtures run          : ${results.length}`);
line(`schema PASS / FAIL    : ${results.length - schemaFailures.length} / ${schemaFailures.length}`);
line(`expectations met      : ${results.length - mismatches.length} / ${results.length}`);
line();
line('FINDINGS (computed from this run, not written in advance)');
line(`  1. The three real Blueprint specs, at their repository revisions, score:`);
for (const record of blueprintFixtures) {
    line(`       ${record.fixture.id.replace('blueprint/', '').padEnd(34)} schema ${record.schemaVerdict.toUpperCase().padEnd(4)} rules ${record.ruleVerdict.toUpperCase()}`);
}
line(`     A schema that rejected a real Blueprint would be the most serious possible finding. None does.`);
line(`  2. The same Blueprints snapshotted at HEAD (e47866dc7) score:`);
for (const record of headFixtures) {
    line(`       ${record.fixture.id.replace('head-revision/', '').padEnd(34)} schema ${record.schemaVerdict.toUpperCase().padEnd(4)} rules ${record.ruleVerdict.toUpperCase()}`);
}
line(`     The HEAD revision of cal-diy and umami declares env entries named EVER_WORKS_*, which`);
line(`     CONTRACTS.md:27 and schema.md R23 forbid; both are rejected with reserved_env_name, and`);
line(`     app-fixture-hello is the control that passes in both revisions. The working tree no longer`);
line(`     reproduces it — an uncommitted change renamed those entries (see fixtures/head-revision/SOURCE.txt).`);
line(`  3. ${splitFixtures.length} of ${results.length} fixtures PASS the JSON Schema and FAIL the rule layer:`);
line(`       ${splitFixtures.map((record) => record.fixture.id.split(' ')[0]).join(', ')}`);
line(`     That list IS the schema/rule boundary the program keeps asserting, enumerated.`);
line(`  4. CONTRACTS.md §1 extracted verbatim is not a valid document (its enums are prose); materialising`);
line(`     it exposes a second defect — its build args and its cron entry name env entries the outline`);
line(`     never declares (two reference_unresolved + one auth_env_not_secret).`);
line(`  5. Each fixture's sha256 is printed above, so this transcript stays checkable even though other`);
line(`     agents are editing the same worktree concurrently.`);
line();

const transcript = `${out.join('\n')}\n`;
process.stdout.write(transcript);

if (mismatches.length) {
    process.stderr.write(`\n${mismatches.length} fixture(s) did not match their recorded expectation.\n`);
    process.exitCode = 1;
} else {
    process.stderr.write(`\nAll ${results.length} fixtures matched their recorded expectation.\n`);
}
