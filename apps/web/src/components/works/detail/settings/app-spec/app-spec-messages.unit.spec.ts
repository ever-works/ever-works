import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTranslator } from 'next-intl';
import { APP_SPEC_ISSUE_CODES } from '@ever-works/contracts';
import { issueCodeMessageKey } from './AppSpecProblemsList';
import { APP_SPEC_BANNER_TITLE_KEYS } from './AppSpecStatusBanner';
import { APP_SPEC_SECTION_LABEL_KEYS, ENV_SOURCE_KIND_KEYS } from './AppSpecSections';

/**
 * APW-03 T18 — the App spec message catalogue guard (ACC-03-43, plan §10.4:895).
 *
 * ## What this pins, and why it is a spec rather than a review
 *
 * ACC-03-43 is "every string on these surfaces resolves through translation in
 * all locales". Four things have to hold for that to be true, and each one is a
 * separate assertion here:
 *
 * 1. **The key set is the components' own.** Every key the four P1 components
 *    read exists in **all 21** locale files. The set is not retyped: the banner's
 *    title leafs, the section headings and the env source labels are imported
 *    from the components themselves, the `issues.<camelCode>` leafs are built
 *    from the contract's `APP_SPEC_ISSUE_CODES` with the component's own
 *    {@link issueCodeMessageKey}, and the keys the components pass to `t` as
 *    literals are **read out of their source** — so a component that starts
 *    reading a new leaf turns this spec red instead of shipping a raw key path.
 * 2. **The leaf names are the convention plan §8:741 fixes** — camelCase, no
 *    literal `.` in a leaf.
 * 3. **Every message parses and interpolates.** T17's `AppSpecProblemsList` reads
 *    `issues.<camelCode>` dynamically and `AppSpecStatusBanner` renders ICU
 *    plurals, so a bad brace or a dropped `{count}` is a UI fault in a locale
 *    nobody on the team reads. Every leaf goes through a real
 *    `createTranslator` round trip with values derived from its own placeholders,
 *    and its placeholder signature must equal `en`'s.
 * 4. **One `issues.<camelCode>` leaf per `APP_SPEC_ISSUE_CODES` entry**, and no
 *    extra ones — the list is append-only (schema.md §23:536) and a code that
 *    reaches the page without copy falls back to the API's English sentence.
 *
 * ## Why the round trip also asserts on the rendered sentence
 *
 * The Meetings spec next door fails only on `INVALID_MESSAGE`, because a
 * missing *value* is a caller concern there. Here it is not: the caller is
 * `AppSpecProblemsList`, which passes exactly `issue.params`, and the API omits
 * a parameter whenever the API's own message omits its clause (`unknown_field`
 * carries `suggestion` only when a defined key is within edit distance 2 — see
 * `app-spec.validate.ts:1010`). So every `issues.*` leaf is written to
 * interpolate **only the parameters the API always sends**, and the extra
 * assertion below is what holds that line: a message whose placeholders are not
 * all supplied renders its own raw template — `Unknown field {key}.` — which
 * next-intl does **silently**, with no error at all (verified against the
 * installed version: it formats what it can and returns the template).
 */

// Vitest's root is `apps/web` (see vitest.config.ts), so the bundle
// directory resolves off the cwd rather than import.meta.url — which is
// not a file: URL under the Vite transform.
const MESSAGES_DIR = resolve(process.cwd(), 'messages');

/** The namespace the App spec tab renders from (plan §8:746-772). */
const NAMESPACE = 'dashboard.workDetail.settings.appSpec';

/**
 * The same namespace as a path into a locale file's `dashboard` tree — what
 * {@link readNamespace} reads with. `createTranslator` wants the dotted
 * {@link NAMESPACE}; the file walk wants the path below it.
 */
const NAMESPACE_PATH = 'workDetail.settings.appSpec';

/** The fourth settings tab's own leaf, read by `SettingsSubTabs` (T16). */
const TABS_KEY = 'dashboard.workDetail.settings.tabs.appSpec';

/** {@link TABS_KEY}, as a path into a locale file's `dashboard` tree. */
const TABS_PATH = 'workDetail.settings.tabs.appSpec';

/** Where the four P1 components live — the keys below are read out of them. */
const COMPONENT_DIR = resolve(process.cwd(), 'src/components/works/detail/settings/app-spec');

/**
 * The files whose literal `t('…')` calls this spec reads. The `.unit.spec.tsx`
 * siblings are deliberately excluded: they render with fixtures, not with the
 * catalogue.
 */
const COMPONENT_FILES = [
    'AppSpecStatusBanner.tsx',
    'AppSpecProblemsList.tsx',
    'AppSpecSections.tsx',
    'AppSpecPageClient.tsx',
] as const;

/**
 * The keys the P1 components name as literals in `t('…')`.
 *
 * The scan below asserts this list is *exactly* what the sources contain, so it
 * is a pinned copy of the components rather than a second source of truth.
 */
const INLINE_KEYS = [
    'statusInvalidRunning',
    'statusInvalidNothing',
    'statusMissingBody',
    'statusUnreadableBody',
    'statusMeta',
    'recheck',
    'recheckBusy',
    'browseBlueprints',
    'runProvisioner',
    'problemsTitle',
    'problemsTruncated',
    'severityError',
    'severityWarning',
    'fixPrefix',
    'openInRepository',
    'defaultMarker',
    'envSecret',
] as const;

/**
 * The one key the problems list reads through a local map rather than a literal
 * (`AppSpecProblemsList.tsx:161-165`), so the source scan cannot see it.
 */
const FILTER_KEYS = ['filterAll', 'filterErrors', 'filterWarnings'] as const;

/** The keys the components read through their exported maps. */
const MAPPED_KEYS = [
    ...Object.values(APP_SPEC_BANNER_TITLE_KEYS),
    ...Object.values(APP_SPEC_SECTION_LABEL_KEYS),
    ...Object.values(ENV_SOURCE_KIND_KEYS),
] as const;

/** One `issues.<camelCode>` leaf per append-only contract code (plan §8:770). */
const ISSUE_KEYS = APP_SPEC_ISSUE_CODES.map((code) => issueCodeMessageKey(code));

/**
 * The parameters the validator puts on **every** finding of a code, so a leaf
 * may interpolate them and only them.
 *
 * The component hands `issue.params` straight to `t`, and ICU has no
 * optional-argument form — a placeholder whose value is missing renders as its
 * own raw text (`Unknown field {key}.`) with no error at all. So a code whose
 * findings carry a parameter on *some* paths only (`suggestion` on
 * `unknown_field`, `root`/`declared` on `kind_mismatch`, `job`/`cron` on
 * `http_job_requires_web_component`, `target` on `dependency_unavailable`, …)
 * must not appear here, and its leaf must be written without that parameter.
 *
 * This is a **snapshot** of the emission sites in
 * `packages/agent/src/works-config/schema/{app-spec.rules.ts,app-spec.validate.ts,app-spec.refs.ts}`
 * — the one place these names are decided — kept here because `apps/web` does
 * not depend on `packages/agent`. A code that gains or loses a parameter there
 * needs this table updated in the same change.
 */
const ISSUE_ALWAYS_PARAMS: Partial<Record<(typeof APP_SPEC_ISSUE_CODES)[number], string>> = {
    yaml_syntax: 'skippedRules',
    file_too_large: 'bytes maxBytes skippedRules',
    yaml_alias_limit: 'max skippedRules',
    duplicate_key: 'key',
    required: 'key',
    invalid_type: 'expected',
    invalid_enum: 'key allowed',
    pattern: 'key',
    unknown_field: 'key',
    unknown_field_newer_version: 'key appSpecVersion supported',
    pattern_unsupported: 'entry',
    prompt_example_secret: 'entry',
    generated_not_secret: 'entry',
    worker_port_forbidden: 'component port',
    worker_probe_without_port: 'component probe',
    public_bucket_undeclared: 'bucket',
    extension_unavailable: 'extension',
    cron_invalid: 'schedule',
    reference_syntax: 'entry reference',
    template_cycle: 'entries count entry',
    template_too_deep: 'entry depth max',
    web_component_needs_port: 'component',
    strategy_requires_components: 'strategy',
    components_require_strategy: 'components',
    primary_component_invalid: 'webComponents',
    duplicate_name: 'name block',
    secret_reference_not_secret: 'entry reference',
    phase_mismatch: 'reference',
    env_source_count: 'entry count sources',
    literal_secret_value: 'entry',
    generate_validate_conflict: 'entry',
    literal_secret_in_build_args: 'argument detected',
    secret_build_arg: 'argument entry',
    upstream_pr_approval_required: 'declared',
    upstream_forbidden_for_link: 'relation',
    upstream_sync_requires_upstream: 'relation',
    upstream_prs_require_fork: 'relation',
    component_ref_unknown: 'component',
    auth_env_not_secret: 'entry reason',
    limit_below_request: 'component',
    volume_replicas: 'component replicas volumes',
    image_not_pinned: 'image',
    advisory_check: 'check',
    schedule_too_frequent: 'schedule minutes',
    path_outside_repository: 'path',
    reserved_env_name: 'entry prefix',
    license_declared_mismatch: 'spdx declared registry',
    keypair_format_unsupported: 'entry type format supportedBy',
    keypair_password_invalid: 'entry format reason',
    sourceOfferMissing: 'relation',
    source_relation_mismatch: 'recorded declared',
    blueprint_unknown: 'id',
    build_strategy_unavailable: 'strategy',
    dependency_unavailable: 'kind',
};

/** Every key of `NAMESPACE` the P1 surfaces read. */
const NAMESPACE_KEYS = [
    ...new Set([...INLINE_KEYS, ...FILTER_KEYS, ...MAPPED_KEYS, ...ISSUE_KEYS]),
].sort();

type Tree = { [key: string]: string | Tree };

function leafKeys(node: Tree, prefix = ''): string[] {
    return Object.entries(node).flatMap(([key, value]) =>
        typeof value === 'string' ? [prefix + key] : leafKeys(value, `${prefix}${key}.`),
    );
}

/** The four components' own `t('…')` literals, in source order. */
function scannedInlineKeys(): string[] {
    const keys = new Set<string>();

    for (const file of COMPONENT_FILES) {
        const source = readFileSync(join(COMPONENT_DIR, file), 'utf8');
        for (const match of source.matchAll(/\bt\(\s*'([^']+)'\s*[,)]/g)) {
            keys.add(match[1]);
        }
    }

    return [...keys].sort();
}

/** `a.b.c` → the leaf, or `undefined` when any segment is missing. */
function readPath(tree: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((node, segment) => {
        if (typeof node !== 'object' || node === null) {
            return undefined;
        }
        return (node as Record<string, unknown>)[segment];
    }, tree);
}

/** One leaf of the App spec namespace, read out of a parsed locale file. */
function readNamespace(messages: { dashboard: Record<string, Tree> }, path: string): unknown {
    return readPath(messages.dashboard, `${NAMESPACE_PATH}.${path}`);
}

/**
 * A message's placeholder signature, e.g. `['plural:count']` or `['var:sha']`.
 *
 * The format type is part of the signature, so `{count}` and
 * `{count, plural, …}` are different messages — the same rule the repo's own
 * translation script validates with (`apps/web/scripts/translate-messages.mjs`).
 */
function signatures(message: string): string[] {
    const found: string[] = [];

    for (const match of message.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*([A-Za-z]+))?/g)) {
        found.push(`${match[2] ?? 'var'}:${match[1]}`);
    }

    return found.sort();
}

/**
 * Values for every placeholder a message declares — a number where ICU needs
 * one, a neutral word otherwise. Derived from the message so a leaf that
 * interpolates `{branch}` is exercised even though nothing tells this spec what
 * a branch is.
 */
function valuesFor(message: string): Record<string, string | number> {
    const values: Record<string, string | number> = {};

    for (const match of message.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*([A-Za-z]+))?/g)) {
        const [, name, format] = match;
        values[name] = format === 'plural' || format === 'selectordinal' ? 2 : 'value';
    }

    return values;
}

const locales = readdirSync(MESSAGES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace('.json', ''))
    .sort();

function readMessages(locale: string): { dashboard: Record<string, Tree> } {
    return JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8')) as {
        dashboard: Record<string, Tree>;
    };
}

describe('App spec messages — the P1 catalogue', () => {
    it('covers every locale bundled in the app', () => {
        // A guard on the guard: if locales stop being discovered, everything
        // below would vacuously pass.
        expect(locales.length).toBeGreaterThanOrEqual(21);
        expect(locales).toContain('en');
    });

    it('reads exactly the keys the four P1 components read', () => {
        // The scan is what keeps this spec honest: a component that starts
        // reading a leaf this spec does not know about fails here, before the
        // locale assertions below could pass vacuously.
        expect(scannedInlineKeys()).toEqual([...INLINE_KEYS].sort());
    });

    it('names one issues leaf per APP_SPEC_ISSUE_CODES entry, and no others', () => {
        expect(APP_SPEC_ISSUE_CODES.length).toBeGreaterThan(0);
        expect(ISSUE_KEYS).toHaveLength(APP_SPEC_ISSUE_CODES.length);
        expect(new Set(ISSUE_KEYS).size).toBe(APP_SPEC_ISSUE_CODES.length);

        const en = readMessages('en');
        const enIssues = readNamespace(en, 'issues') as Tree;
        expect(enIssues, 'en.json has no appSpec.issues tree').toBeTruthy();
        expect(Object.keys(enIssues).sort()).toEqual(
            APP_SPEC_ISSUE_CODES.map((code) =>
                issueCodeMessageKey(code).replace('issues.', ''),
            ).sort(),
        );
    });

    it('writes every issues leaf with parameters the validator always sends', () => {
        // The claim the leaves depend on (see ISSUE_ALWAYS_PARAMS above): the
        // component passes `issue.params` verbatim, so a leaf that interpolates
        // a parameter a finding may omit renders its own raw text.
        const en = readMessages('en');
        const offenders: string[] = [];

        for (const code of APP_SPEC_ISSUE_CODES) {
            const key = issueCodeMessageKey(code);
            const message = readNamespace(en, key) as string;
            if (typeof message !== 'string') {
                offenders.push(`${key}: no leaf in en.json`);
                continue;
            }

            const allowed = (ISSUE_ALWAYS_PARAMS[code] ?? '').split(' ').filter(Boolean);

            for (const signature of new Set(signatures(message))) {
                const name = signature.split(':')[1];
                if (!allowed.includes(name)) {
                    offenders.push(
                        `${key} interpolates {${name}}, which a ${code} finding may omit`,
                    );
                }
            }
        }

        expect(offenders, 'an issues leaf can render a raw {placeholder}').toEqual([]);
    });

    for (const locale of locales) {
        it(`${locale} — every key the App spec surfaces read exists`, () => {
            const messages = readMessages(locale);
            const missing = NAMESPACE_KEYS.filter(
                (key) => typeof readNamespace(messages, key) !== 'string',
            );

            expect(missing, `${locale} is missing ${NAMESPACE} keys`).toEqual([]);
            expect(
                typeof readPath(messages.dashboard, TABS_PATH),
                `${locale} is missing ${TABS_KEY}`,
            ).toBe('string');
        });

        it(`${locale} — every App spec leaf is camelCase with no dot`, () => {
            const messages = readMessages(locale);
            const appSpec = readPath(messages.dashboard, NAMESPACE_PATH) as Tree;
            const bad = leafKeys(appSpec)
                .map((path) => path.split('.').at(-1) as string)
                .filter((leaf) => !/^[a-z][A-Za-z0-9]*$/.test(leaf));

            expect(bad, `${locale} has leaf names outside plan §8's convention`).toEqual([]);
        });

        it(`${locale} — every App spec message survives a createTranslator round trip`, () => {
            const messages = readMessages(locale);
            const en = readMessages('en');
            const invalid: string[] = [];
            const raw: string[] = [];
            const signatureDrift: string[] = [];

            for (const key of NAMESPACE_KEYS) {
                const full = `${NAMESPACE}.${key}`;
                const message = readNamespace(messages, key) as string;
                const enMessage = readNamespace(en, key) as string;

                if (signatures(message).join(',') !== signatures(enMessage).join(',')) {
                    signatureDrift.push(
                        `${full}: expected [${signatures(enMessage).join(',')}] received [${signatures(message).join(',')}]`,
                    );
                }

                const t = createTranslator({
                    locale,
                    messages,
                    namespace: NAMESPACE,
                    onError: (error) => {
                        const text = String(error?.message ?? error);
                        if (text.includes('INVALID_MESSAGE')) {
                            invalid.push(`${full}: ${text}`);
                        }
                    },
                });

                // next-intl types `t` against the literal key union; this spec
                // walks keys discovered at runtime.
                const rendered = (
                    t as unknown as (k: string, v?: Record<string, unknown>) => string
                )(key, valuesFor(enMessage));

                if (message.includes('{') && rendered === message) {
                    // The raw template came back: at least one placeholder had
                    // no value, so the member would read `{key}` on screen.
                    raw.push(`${full}: ${rendered}`);
                }
            }

            expect(invalid, `${locale} has invalid ICU messages`).toEqual([]);
            expect(raw, `${locale} rendered a raw template (a value was not supplied)`).toEqual([]);
            expect(signatureDrift, `${locale} drifted from en's placeholders`).toEqual([]);
        });
    }
});
