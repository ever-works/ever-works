/**
 * The App spec **cross-field rules** — `schema.md` §22 (R1–R27), plus the four
 * §23 codes that read the parsed document and belong to no numbered rule
 * (`out_of_range` for the §0 quantity ranges and the §13/§16 body ceiling,
 * `cron_invalid`, `pattern_unsupported`).
 *
 * Owning epic: **APW-03** (task T5). Plan: `plan.md` §2.2:126-129 —
 * "`app-spec.rules.ts` _(new)_ — pure functions, one per rule R1–R26, each
 * `(spec: AppSpec, ctx: RuleContext) => AppSpecIssue[]`".
 *
 * ## Why the rules are not schema refinements
 *
 * `app-spec.schema.ts` (T3) carries **no** `.refine()`: `z.toJSONSchema()`
 * silently drops refinements, so a rule expressed there would make the published
 * JSON Schema (T8) weaker than the runtime — an editor would accept what the
 * platform refuses. Every cross-field rule therefore lives here, as a pure
 * function over a document that already **parsed**.
 *
 * ## A rule whose input is unknown is skipped, never guessed
 *
 * §22:502 — "**A field left `null` (unknown) skips its rule** — nothing is
 * reported for state the platform could not read." {@link AppSpecRuleContext}
 * carries the seven fields of §22:490-500 and every one of them is optional, so
 * `evaluateAppSpecRules(spec)` with no context reports **no** catalog-, plugin-,
 * relation- or branch-dependent problem. That is what keeps a valid App spec
 * from showing "valid, with warnings" before APW-05 and APW-07 exist.
 *
 * The five **server-only** codes of §22:483-488 (`source_relation_mismatch`,
 * `blueprint_unknown`, `build_strategy_unavailable`, `dependency_unavailable`,
 * `tracked_branch_missing`) are deliberately **not** implemented here: T6 owns
 * them, and the context fields they read are declared below so that both halves
 * agree on one shape.
 *
 * ## What a rule returns
 *
 * A rule returns {@link AppSpecRuleFinding}s — everything §23:517-529 puts on an
 * issue except `message` and `hint`, which T6's `describeIssue(code, params)`
 * composes (plan §2.2:153-155). `pointer`, `path` and `displayPath` are all
 * derived here, from the document, with §23:532's rule ("`displayPath` uses
 * component/job/env **names** where they exist" — so `build › args ›
 * PAYMENTS_SECRET_KEY › value`, exactly as §24.4 prints it).
 *
 * `line`/`column` are filled in from {@link AppSpecRuleContext.positions} when
 * the caller supplies a lookup, with §23:533's fallback to the **nearest parent
 * key** when the key itself is absent ({@link nearestPosition}). A caller that
 * validated an already-parsed object supplies none, and the two fields stay
 * absent (plan §2.2:144).
 */

import {
    APP_ENV_ALPHABETS,
    APP_ENV_KEYPAIR_RAW_TYPES,
    APP_ENV_RESERVED_PREFIX,
    APP_ENV_UUID_LENGTH,
    appEnvPublicHalfName,
    type AppSpec,
    type AppSpecBuildArg,
    type AppSpecComponent,
    type AppSpecEnvEntry,
    type AppSpecEnvGenerate,
    type AppSpecIssueCode,
    type AppSpecSeverity,
    type AppSpecSourceRelation,
    type AppSpecValidationMode,
    type AppDependencyKind,
    type LicenseClass,
} from '@ever-works/contracts';
import { parseCron } from '../../missions/cron-matcher';
import { computeNextCronFire } from '../../schedules/cadence';
import { scanForSecrets } from '../../utils/secret-scan';
import { APP_SPEC_BYTE_QUANTITY_PATTERN, APP_SPEC_CPU_QUANTITY_PATTERN } from './app-spec.schema';
import {
    APP_SPEC_ISSUE_ROOT,
    analyzeReferences,
    dependencyOutputSecret,
    envEntryDeclaredSecret,
    resolveReference,
    tokenizeReference,
    tokenizeTemplate,
    type AppSpecReference,
    type AppSpecReferenceAnalysis,
} from './app-spec.refs';

// ---------------------------------------------------------------------------
// The shape a rule returns
// ---------------------------------------------------------------------------

/** A 1-based YAML position (§23:533). */
export interface AppSpecRulePosition {
    readonly line: number;
    readonly column: number;
}

/**
 * Maps a §23 pointer to its position in the source document, or `null`.
 *
 * T6 owns the map (its `LineCounter` pointer map); this module only asks. The
 * pointer handed in is the issue pointer itself — `/spec/components/0/port` —
 * so a caller keys its map by the same spelling §23:517-529 prints.
 */
export type AppSpecRulePositionLookup = (pointer: string) => AppSpecRulePosition | null;

/**
 * One rule finding: an {@link AppSpecIssue} without `message`/`hint`.
 *
 * `path` uses array indexes and `displayPath` uses names (§23:532); T6 turns
 * this into the published issue by adding the two English strings from
 * `describeIssue(code, params)`.
 */
export interface AppSpecRuleFinding {
    readonly code: AppSpecIssueCode;
    readonly severity: AppSpecSeverity;
    /** `spec.components[0].port`. */
    readonly path: string;
    /** `/spec/components/0/port`. */
    readonly pointer: string;
    /** `components › web › port`. */
    readonly displayPath: string;
    /** 1-based; present only when the caller supplied `positions`. */
    readonly line?: number;
    /** 1-based; present together with {@link AppSpecRuleFinding.line}. */
    readonly column?: number;
    /** Names and scalar facts only — never a value of a secret entry (FR-6). */
    readonly params?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * The dependency-provider facts `dependency_unavailable` (T6's server-only rule)
 * reads: which kinds the providers for the Work's deploy target support.
 *
 * `null` — the whole map, or the entry for one target — means "unknown", which
 * skips the rule rather than reporting it (§22:499, §22:502).
 */
export type AppSpecDependencyProviders =
    | Readonly<Record<string, Readonly<Record<string, boolean>>>>
    | Readonly<Record<string, boolean>>;

/**
 * Everything a rule may read that is not the document itself — §22:490-500's
 * table, plus the three inputs the table has no field for and that other tasks
 * must supply explicitly.
 *
 * | Field | §22's own table | Filled by |
 * | ----- | --------------- | --------- |
 * | `recordedRelation`, `catalogIds`, `catalogUnavailable`, `buildStrategies`, `dependencyProviders`, `trackedBranchExists` | §22:490-500 | T7/T12, as §22:495-500 names them |
 * | `mode`, `entryVerified` | — (§3:84-89) | the validator call; R19 needs both |
 * | `licenseClassFor` | — (§7:146) | the licence registry; R24 skips without it |
 * | `workRepositoryPublic` | — (§7:154) | the Work's repository facts; R27 skips without it |
 * | `positions` | — (§23:533) | T6's pointer map |
 */
export interface AppSpecRuleContext {
    /** `data-repository` · `blueprint` · `draft` (§3:84-89). R19 escalates in `blueprint`. */
    readonly mode?: AppSpecValidationMode;
    /** The Blueprint catalog entry's `verified` flag (catalog.md §3.2). R19 needs it. */
    readonly entryVerified?: boolean | null;
    /** The Work's `sourceRepository.type` (§5:128-129, §22:495). */
    readonly recordedRelation?: AppSpecSourceRelation | null;
    /** The catalog's Blueprint ids, or `null` when it is unreachable (§22:496). */
    readonly catalogIds?: readonly string[] | null;
    /** Suppresses `blueprint_unknown` instead of reporting it (§22:497). */
    readonly catalogUnavailable?: boolean;
    /** `IBuildPlugin.supportedStrategies` over the enabled plugins, or `null` (§22:498). */
    readonly buildStrategies?: readonly string[] | null;
    /** Providers by kind for the Work's deploy target, or `null` (§22:499). */
    readonly dependencyProviders?: AppSpecDependencyProviders | null;
    /** Whether the tracked branch could be read, or `null` (§22:500). */
    readonly trackedBranchExists?: boolean | null;
    /**
     * The class the licence registry computes for an SPDX expression, or `null`
     * when it cannot say.
     *
     * R24 needs it (§22:478: "`license.class: green` declared while
     * `license.spdx` maps to another class **in the registry**"). With no
     * resolver the rule is **skipped**: guessing a class would either invent a
     * warning or hide one.
     */
    readonly licenseClassFor?: ((spdx: string) => LicenseClass | null) | null;
    /**
     * Is the Work Repository public? `null`/absent means unknown (§22:502) and
     * skips R27 unless the relation is `private-copy`, which is private by
     * definition.
     *
     * §22's context table has no visibility field, and `recordedRelation` cannot
     * stand in for one: a `fork` of a public repository is public, so R27's
     * "private fork" half needs this input — see {@link rule27SourceOffer}.
     */
    readonly workRepositoryPublic?: boolean | null;
    /** The source document's pointer → position map (T6, §23:533). */
    readonly positions?: AppSpecRulePositionLookup | null;
}

/** One rule of §22, as a definition the evaluator and the tests iterate. */
export interface AppSpecRuleDefinition {
    /** `R1` … `R27`, §22:455-481. */
    readonly id: AppSpecRuleId;
    /** Every code this rule may report, in the order §22's row prints them. */
    readonly codes: readonly AppSpecIssueCode[];
    /** The rule itself: pure, never throws, one problem per real problem. */
    readonly evaluate: (spec: AppSpec, ctx: AppSpecRuleContext) => readonly AppSpecRuleFinding[];
}

/** One `check*` companion: a §23 code that is not one of §22's numbered rules. */
export interface AppSpecDocumentCheck {
    readonly name: string;
    readonly codes: readonly AppSpecIssueCode[];
    readonly evaluate: (spec: AppSpec, ctx: AppSpecRuleContext) => readonly AppSpecRuleFinding[];
}

/** The rule ids of §22:455-481. */
export type AppSpecRuleId =
    | 'R1'
    | 'R2'
    | 'R3'
    | 'R4'
    | 'R5'
    | 'R6'
    | 'R7'
    | 'R8'
    | 'R9'
    | 'R10'
    | 'R11'
    | 'R12'
    | 'R13'
    | 'R14'
    | 'R15'
    | 'R16'
    | 'R17'
    | 'R18'
    | 'R19'
    | 'R20'
    | 'R21'
    | 'R22'
    | 'R23'
    | 'R24'
    | 'R25'
    | 'R26'
    | 'R27';

// ---------------------------------------------------------------------------
// Pointers, paths and positions (§23:517-536)
// ---------------------------------------------------------------------------

/** `/spec/components/0/port` → `spec.components[0].port` (§23:532). */
export function pointerToPath(pointer: string): string {
    let path = '';
    for (const segment of pointer.split('/')) {
        if (segment.length === 0) continue;
        if (/^\d+$/.test(segment)) {
            path += `[${segment}]`;
            continue;
        }
        path += path.length === 0 ? segment : `.${segment}`;
    }
    return path;
}

/** The `name` of an array element, when it has one (§23:532 "uses … names where they exist"). */
function elementLabel(value: unknown): string | null {
    if (typeof value !== 'object' || value === null) return null;
    const name = (value as { name?: unknown }).name;
    return typeof name === 'string' && name.length > 0 ? name : null;
}

/**
 * `/spec/env/1/from` → `env › DATABASE_URL › from` (§23:532, §24.4's table).
 *
 * Array indexes are replaced by the element's `name` whenever it has one, which
 * covers components, env, jobs, cron, smoke, checks, volumes, `build.args` and
 * `build.services` — §24.4's `build › args › PAYMENTS_SECRET_KEY › value` is
 * exactly this rule.
 */
export function displayPathFor(spec: AppSpec, pointer: string): string {
    const segments = pointer.split('/').filter((segment) => segment.length > 0);
    if (segments[0] === 'spec') segments.shift();

    const display: string[] = [];
    let cursor: unknown = spec;
    for (const segment of segments) {
        if (Array.isArray(cursor) && /^\d+$/.test(segment)) {
            const element = cursor[Number(segment)];
            display.push(elementLabel(element) ?? segment);
            cursor = element;
            continue;
        }
        display.push(segment);
        cursor =
            typeof cursor === 'object' && cursor !== null
                ? (cursor as Record<string, unknown>)[segment]
                : undefined;
    }
    return display.join(' › ');
}

/**
 * The position of `pointer`, or of its **nearest present ancestor**.
 *
 * §23:533 — "`line`/`column` are 1-based and point at the key when present, else
 * at the nearest parent key". A rule reports a key the author has to add
 * (`components › web › port` with no `port`), so the fallback is the normal case,
 * not an edge case.
 */
export function nearestPosition(
    pointer: string,
    lookup?: AppSpecRulePositionLookup | null,
): AppSpecRulePosition | null {
    if (typeof lookup !== 'function') return null;
    let candidate = pointer;
    while (candidate.length > 0) {
        const position = lookup(candidate);
        if (position) return position;
        const cut = candidate.lastIndexOf('/');
        if (cut <= 0) return null;
        candidate = candidate.slice(0, cut);
    }
    return null;
}

// ---------------------------------------------------------------------------
// Small pure helpers the rules share
// ---------------------------------------------------------------------------

/** The env entries of a document, in document order. */
function envEntriesOf(spec: AppSpec): readonly AppSpecEnvEntry[] {
    return spec.env ?? [];
}

/** The components of a document, in document order. */
function componentsOf(spec: AppSpec): readonly AppSpecComponent[] {
    return spec.components ?? [];
}

/** Env entries by name — first declaration wins, as resolution does. */
function envByName(spec: AppSpec): ReadonlyMap<string, AppSpecEnvEntry> {
    const byName = new Map<string, AppSpecEnvEntry>();
    for (const entry of envEntriesOf(spec)) {
        if (entry?.name === undefined || entry?.name === null) continue;
        if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }
    return byName;
}

/** `250m` → 0.25 cores, `2` → 2 cores, anything else → `null`. */
export function parseCpuCores(value: string | undefined | null): number | null {
    if (typeof value !== 'string' || !APP_SPEC_CPU_QUANTITY_PATTERN.test(value)) return null;
    return value.endsWith('m') ? Number.parseInt(value.slice(0, -1), 10) / 1000 : Number(value);
}

/** `512Mi` → 512 (MiB), `2Gi` → 2048, anything else → `null`. */
export function parseMemoryMi(value: string | undefined | null): number | null {
    if (typeof value !== 'string' || !APP_SPEC_BYTE_QUANTITY_PATTERN.test(value)) return null;
    const amount = Number.parseInt(value.slice(0, -2), 10);
    return value.endsWith('Gi') ? amount * 1024 : amount;
}

/**
 * §0's `CpuQuantity` range — `10m`–`64000m`, or `0.01`–`64` cores.
 *
 * The schema checks the **shape** (`250m` | `2` | `0.5`) and cannot express the
 * range as one JSON Schema `pattern` honestly, which is why the range is
 * reported here as `out_of_range`.
 */
export const APP_SPEC_CPU_RANGE = {
    minMillicores: 10,
    maxMillicores: 64_000,
    minCores: 0.01,
    maxCores: 64,
} as const;

/** §0's `MemQuantity` range — `64Mi`–`256Gi`, in MiB. */
export const APP_SPEC_MEMORY_RANGE = { minMi: 64, maxMi: 256 * 1024 } as const;

/** §0's `StorageQuantity` range — `100Mi`–`500Gi`, in MiB. */
export const APP_SPEC_STORAGE_RANGE = { minMi: 100, maxMi: 500 * 1024 } as const;

/** §9:178's build-runner memory range — `1Gi`–`64Gi`, in MiB. */
export const APP_SPEC_BUILD_MEMORY_RANGE = { minMi: 1024, maxMi: 64 * 1024 } as const;

/** §13:325 / §16:363 — a serialized `http.body` is at most 16 KiB. */
export const APP_SPEC_HTTP_BODY_MAX_BYTES = 16_384;

/** Is a §0 `CpuQuantity` inside its range? `null` when the shape is wrong. */
export function cpuQuantityInRange(value: string | undefined | null): boolean | null {
    if (typeof value !== 'string' || !APP_SPEC_CPU_QUANTITY_PATTERN.test(value)) return null;
    if (value.endsWith('m')) {
        const millicores = Number.parseInt(value.slice(0, -1), 10);
        return (
            millicores >= APP_SPEC_CPU_RANGE.minMillicores &&
            millicores <= APP_SPEC_CPU_RANGE.maxMillicores
        );
    }
    const cores = Number(value);
    return cores >= APP_SPEC_CPU_RANGE.minCores && cores <= APP_SPEC_CPU_RANGE.maxCores;
}

/** Is a byte quantity inside `[minMi, maxMi]`? `null` when the shape is wrong. */
export function byteQuantityInRange(
    value: string | undefined | null,
    range: { readonly minMi: number; readonly maxMi: number },
): boolean | null {
    const mi = parseMemoryMi(value);
    if (mi === null) return null;
    return mi >= range.minMi && mi <= range.maxMi;
}

/** §12:308-311 — the generated length, or `null` when the generator has none. */
export function generatedLength(generate: AppSpecEnvGenerate | undefined | null): number | null {
    if (generate === undefined || generate === null) return null;
    switch (generate.kind) {
        case 'hex':
            return 2 * (generate.bytes ?? 32);
        case 'base64':
            return 4 * Math.ceil((generate.bytes ?? 32) / 3);
        case 'chars':
            return generate.length ?? 32;
        case 'uuid':
            return APP_ENV_UUID_LENGTH;
        case 'keypair':
            return (generate.keypair?.format ?? 'pem') === 'base64url-raw' ? 43 : null;
        default:
            return null;
    }
}

/** The fixed seed R9's three samples are drawn from — §22:463 "from a fixed seed". */
export const APP_SPEC_SAMPLE_SEED = 0x5eed_1234;

/** FNV-1a over the entry name, so two entries never sample the same values. */
function seedFor(name: string): number {
    let hash = 0x811c_9dc5;
    for (let index = 0; index < name.length; index += 1) {
        hash ^= name.charCodeAt(index);
        hash = Math.imul(hash, 0x0100_0193) >>> 0;
    }
    return (hash ^ APP_SPEC_SAMPLE_SEED) >>> 0;
}

/** mulberry32 — a tiny deterministic PRNG, so R9's samples are reproducible. */
function randomFor(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b_79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** `bytes` random bytes, base64 (padding included) or base64url (padding stripped). */
function base64Of(random: () => number, bytes: number, urlSafe: boolean): string {
    const alphabet = urlSafe ? BASE64URL_ALPHABET : BASE64_ALPHABET;
    let out = '';
    let buffer = 0;
    let bits = 0;
    for (let index = 0; index < bytes; index += 1) {
        buffer = (buffer << 8) | Math.floor(random() * 256);
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            out += alphabet[(buffer >> bits) & 0x3f];
        }
    }
    if (bits > 0) out += alphabet[(buffer << (6 - bits)) & 0x3f];
    if (urlSafe) return out;
    while (out.length % 4 !== 0) out += '=';
    return out;
}

/** A v4-shaped UUID from the deterministic PRNG (§12:308 — `uuid` = 36). */
function uuidOf(random: () => number): string {
    const hex = '0123456789abcdef';
    let out = '';
    for (let index = 0; index < 36; index += 1) {
        if (index === 8 || index === 13 || index === 18 || index === 23) {
            out += '-';
            continue;
        }
        if (index === 14) {
            out += '4';
            continue;
        }
        if (index === 19) {
            out += hex[8 + Math.floor(random() * 4)];
            continue;
        }
        out += hex[Math.floor(random() * 16)];
    }
    return out;
}

/** `length` characters from a named §12 alphabet. */
function charsOf(random: () => number, length: number, alphabet: string): string {
    let out = '';
    for (let index = 0; index < length; index += 1) {
        out += alphabet[Math.floor(random() * alphabet.length)];
    }
    return out;
}

/**
 * `count` sample values the generator of `entry` produces — R9's third check.
 *
 * Only a generator with a **fixed** length is sampled: `validate.pattern` can
 * only be judged against values that exist, and a `pem`/`pkcs12` key pair has no
 * fixed length at all (§12:310). A `base64url-raw` key pair samples exactly 43
 * characters, which is what makes §12:294's `^[A-Za-z0-9_-]{43}$` checkable.
 */
export function generateSamples(entry: AppSpecEnvEntry, count: number = 3): readonly string[] {
    const generate = entry.generate;
    const length = generatedLength(generate);
    if (generate === undefined || generate === null || length === null) return [];

    const random = randomFor(seedFor(entry.name ?? ''));
    const samples: string[] = [];
    for (let index = 0; index < count; index += 1) {
        switch (generate.kind) {
            case 'hex':
                samples.push(charsOf(random, length, '0123456789abcdef'));
                break;
            case 'base64':
                samples.push(base64Of(random, generate.bytes ?? 32, false));
                break;
            case 'chars':
                samples.push(
                    charsOf(random, length, APP_ENV_ALPHABETS[generate.alphabet ?? 'alnum']),
                );
                break;
            case 'uuid':
                samples.push(uuidOf(random));
                break;
            case 'keypair':
                // The only fixed-length key pair format: 32 raw bytes, base64url.
                samples.push(base64Of(random, 32, true));
                break;
            default:
                break;
        }
    }
    return samples;
}

/**
 * Is this `validate.pattern` expressible in **RE2**? (§12:254 — "RE2 syntax (no
 * back-references or look-around: `pattern_unsupported`)")
 *
 * RE2 has no back-references, no look-around, no atomic groups and no possessive
 * quantifiers; a pattern using one of them is accepted by an ECMAScript editor
 * and refused by the resolver, so it is `pattern_unsupported` here rather than a
 * runtime surprise later. Named capture groups (`(?<name>…)`) ARE RE2 syntax and
 * pass.
 */
export function isRe2Pattern(pattern: string): boolean {
    if (typeof pattern !== 'string') return false;
    try {
        new RegExp(pattern);
    } catch {
        return false;
    }

    for (let index = 0; index < pattern.length; index += 1) {
        const char = pattern[index];
        if (char === '\\') {
            const next = pattern[index + 1];
            // `\1` … `\9` are back-references; `\k<name>` is a named one.
            if (next !== undefined && /[1-9]/.test(next)) return false;
            if (next === 'k' || next === 'g') return false;
            index += 1;
            continue;
        }
        if (char === '(' && pattern[index + 1] === '?') {
            const kind = pattern[index + 2];
            if (kind === '=' || kind === '!') return false; // look-ahead
            if (kind === '<' && (pattern[index + 3] === '=' || pattern[index + 3] === '!')) {
                return false; // look-behind — `(?<name>…)` is a named group and stays legal
            }
            if (kind === '>') return false; // atomic group
            continue;
        }
        if (
            (char === '*' || char === '+' || char === '?' || char === '}') &&
            pattern[index + 1] === '+'
        ) {
            return false; // possessive quantifier
        }
    }
    return true;
}

/** The §12 marker names R10 looks for in a build argument's name. */
export const APP_SPEC_SECRET_ARG_NAME_MARKERS = [
    'SECRET',
    'TOKEN',
    'PASSWORD',
    'PASSWD',
    'PRIVATE',
    'CREDENTIAL',
    'APIKEY',
    'API_KEY',
] as const;

/** `/spec/...` with a numeric-safe join, so no rule builds a pointer by hand. */
function ptr(...segments: readonly (string | number)[]): string {
    return `${APP_SPEC_ISSUE_ROOT}/${segments.join('/')}`;
}

// ---------------------------------------------------------------------------
// R1 – R27 (schema.md §22:455-481)
// ---------------------------------------------------------------------------

/** R1 — a `web` component declares `port` (§10:199). */
export function rule1WebComponentNeedsPort(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    componentsOf(spec).forEach((component, index) => {
        if (component.role !== 'web') return;
        if (component.port !== undefined && component.port !== null) return;
        findings.push(
            issue(
                spec,
                ctx,
                'web_component_needs_port',
                'error',
                ptr('components', index, 'port'),
                {
                    component: component.name,
                },
            ),
        );
    });
    return findings;
}

/** R2 — a strategy that builds needs components, and components need a strategy (§9:170, §10:190). */
export function rule2StrategyAndComponents(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const components = componentsOf(spec);
    const strategy = spec.build?.strategy;

    if (components.length > 0 && (strategy === undefined || strategy === null)) {
        findings.push(
            issue(spec, ctx, 'components_require_strategy', 'error', ptr('build'), {
                components: components.length,
            }),
        );
    }
    if (
        strategy !== undefined &&
        strategy !== null &&
        strategy !== 'none' &&
        components.length === 0
    ) {
        findings.push(
            issue(spec, ctx, 'strategy_requires_components', 'error', ptr('build', 'strategy'), {
                strategy,
            }),
        );
    }
    return findings;
}

/** R3 — `domains.primaryComponent` names a `web` component; required with 2+ web components (§15:349). */
export function rule3PrimaryComponent(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const components = componentsOf(spec);
    const webComponents = components.filter((component) => component.role === 'web');
    const declared = spec.domains?.primaryComponent;

    if (declared !== undefined && declared !== null) {
        const target = components.find((component) => component.name === declared);
        if (target === undefined || target.role !== 'web') {
            findings.push(
                issue(
                    spec,
                    ctx,
                    'primary_component_invalid',
                    'error',
                    ptr('domains', 'primaryComponent'),
                    {
                        component: declared,
                        webComponents: webComponents.map((component) => component.name).join(', '),
                    },
                ),
            );
        }
        return findings;
    }

    if (webComponents.length >= 2) {
        findings.push(
            issue(
                spec,
                ctx,
                'primary_component_invalid',
                'error',
                ptr('domains', 'primaryComponent'),
                {
                    webComponents: webComponents.map((component) => component.name).join(', '),
                    reason: 'required with two or more web components',
                },
            ),
        );
    }
    return findings;
}

/**
 * R4 — names are unique within `components`, `jobs`, `cron`, `smoke`, `checks`,
 * and `env` names are unique **counting the implicit `<NAME>_PUBLIC` of each
 * key-pair entry** (§12:265, §12:310-311).
 */
export function rule4DuplicateNames(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];

    const blocks: readonly (readonly [string, readonly { name?: string }[]])[] = [
        ['components', componentsOf(spec)],
        ['jobs', spec.jobs ?? []],
        ['cron', spec.cron ?? []],
        ['smoke', spec.smoke ?? []],
        ['checks', spec.checks ?? []],
    ];
    for (const [block, entries] of blocks) {
        const seen = new Set<string>();
        entries.forEach((entry, index) => {
            const name = entry?.name;
            if (typeof name !== 'string' || name.length === 0) return;
            if (seen.has(name)) {
                findings.push(
                    issue(spec, ctx, 'duplicate_name', 'error', ptr(block, index, 'name'), {
                        name,
                        block,
                    }),
                );
                return;
            }
            seen.add(name);
        });
    }

    // `env`, with each key-pair entry's derived `<NAME>_PUBLIC` counted as a name
    // of its own: a document may not declare it (§12:311, "an entry may not
    // declare `<NAME>_PUBLIC` for a keypair entry `<NAME>`").
    const owner = new Map<string, string>();
    envEntriesOf(spec).forEach((entry, index) => {
        const name = entry?.name;
        if (typeof name !== 'string' || name.length === 0) return;
        const generated =
            entry.generate?.kind === 'keypair' ? appEnvPublicHalfName(name) : undefined;
        const names: readonly { readonly name: string; readonly generated: boolean }[] = [
            { name, generated: false },
            ...(generated === undefined ? [] : [{ name: generated, generated: true }]),
        ];
        for (const candidate of names) {
            const declaredBy = owner.get(candidate.name);
            if (declaredBy !== undefined) {
                findings.push(
                    issue(spec, ctx, 'duplicate_name', 'error', ptr('env', index, 'name'), {
                        name: candidate.name,
                        block: 'env',
                        entry: name,
                        generated: candidate.generated,
                        declaredBy,
                    }),
                );
                continue;
            }
            owner.set(candidate.name, name);
        }
    });

    return findings;
}

/** The §21 codes R5 reports — it resolves every `from:` / `template:` / `fromEnv:` (§22:459). */
const R5_CODES = [
    'reference_syntax',
    'reference_unresolved',
    'template_cycle',
    'template_too_deep',
] as const;

/** R5 — every `from:` / `template:` / `fromEnv:` resolves (§21). */
export function rule5References(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    return referenceFindings(spec, ctx, R5_CODES);
}

/** The §21 codes R6 reports — secrecy and phase propagation (§21:445-448). */
const R6_CODES = ['secret_reference_not_secret', 'phase_mismatch'] as const;

/** R6 — secrecy and phase propagate through `from:`/`template:`/`fromEnv:`. */
export function rule6SecrecyAndPhase(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    return referenceFindings(spec, ctx, R6_CODES);
}

/** Map the §21 analysis onto findings for the codes one rule owns. */
function referenceFindings(
    spec: AppSpec,
    ctx: AppSpecRuleContext,
    codes: readonly string[],
): readonly AppSpecRuleFinding[] {
    const analysis: AppSpecReferenceAnalysis = analyzeReferences(spec);
    const findings: AppSpecRuleFinding[] = [];
    for (const problem of analysis.problems) {
        if (!codes.includes(problem.code)) continue;
        findings.push(
            issue(
                spec,
                ctx,
                problem.code as AppSpecIssueCode,
                'error',
                problem.pointer,
                problem.params,
            ),
        );
    }
    return findings;
}

/** R7 — each `env` entry has exactly one value source (§12:241-242). */
export function rule7EnvSourceCount(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const sources = ['value', 'from', 'template', 'generate', 'prompt'] as const;
    envEntriesOf(spec).forEach((entry, index) => {
        const present = sources.filter(
            (source) => entry[source] !== undefined && entry[source] !== null,
        );
        if (present.length === 1) return;
        findings.push(
            issue(spec, ctx, 'env_source_count', 'error', ptr('env', index), {
                entry: entry.name,
                count: present.length,
                sources: present.length === 0 ? 'none' : present.join(', '),
            }),
        );
    });
    return findings;
}

/** R8 — a `secret: true` entry has no `value` (§12:250). The value is never echoed. */
export function rule8LiteralSecretValue(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    envEntriesOf(spec).forEach((entry, index) => {
        if (entry.secret !== true) return;
        if (entry.value === undefined || entry.value === null) return;
        findings.push(
            issue(spec, ctx, 'literal_secret_value', 'error', ptr('env', index, 'value'), {
                entry: entry.name,
            }),
        );
    });
    return findings;
}

/** R9 — `generate` and `validate` agree (§12:254, §12:308-311). */
export function rule9GenerateValidate(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];

    envEntriesOf(spec).forEach((entry, index) => {
        const validate = entry.validate;
        const generate = entry.generate;
        if (validate === undefined || validate === null) return;
        if (generate === undefined || generate === null) return; // nothing generated to agree with

        const fixed = generatedLength(generate);
        if (validate.length !== undefined && validate.length !== null) {
            if (fixed === null) {
                findings.push(
                    issue(
                        spec,
                        ctx,
                        'generate_validate_conflict',
                        'error',
                        ptr('env', index, 'validate', 'length'),
                        {
                            entry: entry.name,
                            length: validate.length,
                            generated: 'none',
                        },
                    ),
                );
            } else if (validate.length !== fixed) {
                findings.push(
                    issue(
                        spec,
                        ctx,
                        'generate_validate_conflict',
                        'error',
                        ptr('env', index, 'validate', 'length'),
                        {
                            entry: entry.name,
                            length: validate.length,
                            generated: fixed,
                        },
                    ),
                );
            }
        }

        if (fixed !== null && validate.minLength !== undefined && fixed < validate.minLength) {
            findings.push(
                issue(
                    spec,
                    ctx,
                    'generate_validate_conflict',
                    'error',
                    ptr('env', index, 'validate', 'minLength'),
                    {
                        entry: entry.name,
                        minLength: validate.minLength,
                        generated: fixed,
                    },
                ),
            );
        }
        if (fixed !== null && validate.maxLength !== undefined && fixed > validate.maxLength) {
            findings.push(
                issue(
                    spec,
                    ctx,
                    'generate_validate_conflict',
                    'error',
                    ptr('env', index, 'validate', 'maxLength'),
                    {
                        entry: entry.name,
                        maxLength: validate.maxLength,
                        generated: fixed,
                    },
                ),
            );
        }
        if (
            validate.minLength !== undefined &&
            validate.maxLength !== undefined &&
            validate.minLength > validate.maxLength
        ) {
            // §12:254's "min ≤ max": no generated length can satisfy both bounds.
            findings.push(
                issue(
                    spec,
                    ctx,
                    'generate_validate_conflict',
                    'error',
                    ptr('env', index, 'validate', 'minLength'),
                    {
                        entry: entry.name,
                        minLength: validate.minLength,
                        maxLength: validate.maxLength,
                    },
                ),
            );
        }

        const pattern = validate.pattern;
        if (typeof pattern !== 'string' || pattern.length === 0) return;
        if (!isRe2Pattern(pattern)) return; // `pattern_unsupported` reports it; do not judge samples with it
        const samples = generateSamples(entry, 3);
        if (samples.length === 0) return;
        const regex = new RegExp(pattern);
        if (samples.every((sample) => regex.test(sample))) return;
        findings.push(
            issue(
                spec,
                ctx,
                'generate_validate_conflict',
                'error',
                ptr('env', index, 'validate', 'pattern'),
                {
                    entry: entry.name,
                    samples: samples.length,
                },
            ),
        );
    });

    return findings;
}

/** R10 — `build.args[].value` contains no secret (§9:175, §22:464). */
export function rule10LiteralSecretInBuildArgs(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    (spec.build?.args ?? []).forEach((arg: AppSpecBuildArg, index) => {
        if (typeof arg?.value !== 'string') return;
        const upperName = (arg.name ?? '').toUpperCase();
        const named = APP_SPEC_SECRET_ARG_NAME_MARKERS.some((marker) => upperName.includes(marker));
        const scanned = scanForSecrets(arg.value).length > 0;
        if (!scanned && !(named && arg.value.length > 0)) return;
        findings.push(
            issue(
                spec,
                ctx,
                'literal_secret_in_build_args',
                'error',
                ptr('build', 'args', index, 'value'),
                {
                    argument: arg.name,
                    // A name-only fact: the value itself is never echoed (§23:534).
                    detected: scanned ? 'scanner' : 'name',
                },
            ),
        );
    });
    return findings;
}

/** R11 — `build.args[].fromEnv` naming a `secret: true` entry bakes it into image layers (§9:175). */
export function rule11SecretBuildArg(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const byName = envByName(spec);
    (spec.build?.args ?? []).forEach((arg: AppSpecBuildArg, index) => {
        if (typeof arg?.fromEnv !== 'string') return;
        const entry = byName.get(arg.fromEnv);
        if (entry === undefined || !envEntryDeclaredSecret(entry)) return;
        findings.push(
            issue(
                spec,
                ctx,
                'secret_build_arg',
                'warning',
                ptr('build', 'args', index, 'fromEnv'),
                {
                    argument: arg.name,
                    entry: arg.fromEnv,
                },
            ),
        );
    });
    return findings;
}

/** R12 — `upstreamPullRequests.requireApproval` is `true` (§20:407). */
export function rule12UpstreamPrApproval(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const block = spec.upstreamPullRequests;
    if (block === undefined || block === null) return [];
    if (block.requireApproval === undefined || block.requireApproval === null) return [];
    if (block.requireApproval === true) return [];
    return [
        issue(
            spec,
            ctx,
            'upstream_pr_approval_required',
            'error',
            ptr('upstreamPullRequests', 'requireApproval'),
            {
                declared: String(block.requireApproval),
            },
        ),
    ];
}

/** R13 — `link` has no upstream and no Upstream sync; PRs need a fork (§5:124, §19:393, §20:406). */
export function rule13UpstreamForbiddenForLink(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const relation = spec.source?.relation;

    if (relation === 'link') {
        if (spec.source?.upstream !== undefined && spec.source?.upstream !== null) {
            findings.push(
                issue(
                    spec,
                    ctx,
                    'upstream_forbidden_for_link',
                    'error',
                    ptr('source', 'upstream'),
                    {
                        relation,
                    },
                ),
            );
        }
        if (spec.upstreamSync !== undefined && spec.upstreamSync !== null) {
            findings.push(
                issue(spec, ctx, 'upstream_sync_requires_upstream', 'error', ptr('upstreamSync'), {
                    relation,
                }),
            );
        }
    }

    if (
        spec.upstreamPullRequests?.enabled === true &&
        relation !== undefined &&
        relation !== null &&
        relation !== 'fork'
    ) {
        findings.push(
            issue(
                spec,
                ctx,
                'upstream_prs_require_fork',
                'error',
                ptr('upstreamPullRequests', 'enabled'),
                {
                    relation,
                },
            ),
        );
    }

    return findings;
}

/** R14 — `jobs[].component`, `cron[].component`, `smoke[].component` name existing components (§13:321, §16:364). */
export function rule14ComponentRefUnknown(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const components = componentsOf(spec);
    const byName = new Map(components.map((component) => [component.name, component]));

    (spec.jobs ?? []).forEach((job, index) => {
        if (typeof job?.component !== 'string') return;
        if (byName.has(job.component)) return;
        findings.push(
            issue(spec, ctx, 'component_ref_unknown', 'error', ptr('jobs', index, 'component'), {
                job: job.name,
                component: job.component,
            }),
        );
    });

    (spec.cron ?? []).forEach((entry, index) => {
        if (typeof entry?.component !== 'string') return;
        if (byName.has(entry.component)) return;
        findings.push(
            issue(spec, ctx, 'component_ref_unknown', 'error', ptr('cron', index, 'component'), {
                cron: entry.name,
                component: entry.component,
            }),
        );
    });

    (spec.smoke ?? []).forEach((entry, index) => {
        if (typeof entry?.component !== 'string') return;
        const target = byName.get(entry.component);
        if (target !== undefined && target.role === 'web') return;
        findings.push(
            issue(spec, ctx, 'component_ref_unknown', 'error', ptr('smoke', index, 'component'), {
                smoke: entry.name,
                component: entry.component,
                reason:
                    target === undefined ? 'unknown component' : 'smoke targets a web component',
            }),
        );
    });

    return findings;
}

/** R15 — `http.authEnv` names a `secret: true` entry (§13:326, §14:341). */
export function rule15AuthEnvNotSecret(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const byName = envByName(spec);

    const check = (
        authEnv: string | undefined | null,
        pointer: string,
        owner: Readonly<Record<string, string | number | boolean>>,
    ): void => {
        if (typeof authEnv !== 'string' || authEnv.length === 0) return;
        const entry = byName.get(authEnv);
        if (entry !== undefined && envEntryDeclaredSecret(entry)) return;
        findings.push(
            issue(spec, ctx, 'auth_env_not_secret', 'error', pointer, {
                ...owner,
                entry: authEnv,
                reason: entry === undefined ? 'no such entry' : 'not secret',
            }),
        );
    };

    (spec.jobs ?? []).forEach((job, index) => {
        check(job?.http?.authEnv, ptr('jobs', index, 'http', 'authEnv'), { job: job?.name ?? '' });
    });
    (spec.cron ?? []).forEach((entry, index) => {
        check(entry?.http?.authEnv, ptr('cron', index, 'http', 'authEnv'), {
            cron: entry?.name ?? '',
        });
    });

    return findings;
}

/** R16 — `domains.publicUrlEnv[]` names existing `env` entries (§15:350). */
export function rule16PublicUrlEnv(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const byName = envByName(spec);
    (spec.domains?.publicUrlEnv ?? []).forEach((name, index) => {
        if (typeof name !== 'string' || byName.has(name)) return;
        findings.push(
            issue(
                spec,
                ctx,
                'reference_unresolved',
                'error',
                ptr('domains', 'publicUrlEnv', index),
                {
                    entry: name,
                    needs: `env.${name}`,
                },
            ),
        );
    });
    return findings;
}

/** R17 — `memoryLimit ≥ memory`, `cpuLimit ≥ cpu` (§10:206-207). */
export function rule17LimitBelowRequest(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    componentsOf(spec).forEach((component, index) => {
        const resources = component.resources;
        if (resources === undefined || resources === null) return;

        const cpu = parseCpuCores(resources.cpu);
        const cpuLimit = parseCpuCores(resources.cpuLimit);
        if (cpu !== null && cpuLimit !== null && cpuLimit < cpu) {
            findings.push(
                issue(
                    spec,
                    ctx,
                    'limit_below_request',
                    'error',
                    ptr('components', index, 'resources', 'cpuLimit'),
                    {
                        component: component.name,
                        cpu: String(resources.cpu),
                        cpuLimit: String(resources.cpuLimit),
                    },
                ),
            );
        }

        const memory = parseMemoryMi(resources.memory);
        const memoryLimit = parseMemoryMi(resources.memoryLimit);
        if (memory !== null && memoryLimit !== null && memoryLimit < memory) {
            findings.push(
                issue(
                    spec,
                    ctx,
                    'limit_below_request',
                    'error',
                    ptr('components', index, 'resources', 'memoryLimit'),
                    {
                        component: component.name,
                        memory: String(resources.memory),
                        memoryLimit: String(resources.memoryLimit),
                    },
                ),
            );
        }
    });
    return findings;
}

/** R18 — a component with `volumes` and `replicas > 1` cannot attach them (§10:200, §10:208). */
export function rule18VolumeReplicas(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    componentsOf(spec).forEach((component, index) => {
        const volumes = component.volumes ?? [];
        if (volumes.length === 0) return;
        const replicas = component.replicas ?? 1;
        if (replicas <= 1) return;
        findings.push(
            issue(spec, ctx, 'volume_replicas', 'error', ptr('components', index, 'replicas'), {
                component: component.name,
                replicas,
                volumes: volumes.length,
            }),
        );
    });
    return findings;
}

/** R19 — `build.strategy: image` with a tag-only reference (§9:174). */
export function rule19ImageNotPinned(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    if (spec.build?.strategy !== 'image') return [];
    const image = spec.build?.image;
    if (typeof image !== 'string' || image.length === 0) return [];
    if (/@sha256:[0-9a-f]{64}$/.test(image)) return [];
    // §22:473 — a warning, and an **error** in `blueprint` mode for `verified`
    // entries: a verified Blueprint pins what it ships.
    const severity: AppSpecSeverity =
        ctx.mode === 'blueprint' && ctx.entryVerified === true ? 'error' : 'warning';
    return [issue(spec, ctx, 'image_not_pinned', severity, ptr('build', 'image'), { image })];
}

/** R20 — `checks[].required: false` verifies nothing (§17:379). */
export function rule20AdvisoryCheck(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    (spec.checks ?? []).forEach((check, index) => {
        if (check?.required !== false) return;
        findings.push(
            issue(spec, ctx, 'advisory_check', 'warning', ptr('checks', index, 'required'), {
                check: check.name,
            }),
        );
    });
    return findings;
}

/** The instant R21's two fires are measured from — fixed, so the rule is pure. */
export const APP_SPEC_SCHEDULE_REFERENCE_INSTANT = '2026-01-05T00:00:00.000Z';

/** The shortest gap `upstreamSync.schedule` may have between fires — 60 minutes (§19:398). */
export const APP_SPEC_SCHEDULE_MIN_GAP_MINUTES = 60;

/** R21 — `upstreamSync.schedule` fires at most once per 60 minutes (§19:398). */
export function rule21ScheduleTooFrequent(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const schedule = spec.upstreamSync?.schedule;
    if (typeof schedule !== 'string' || schedule.length === 0) return [];
    if (!cronParses(schedule)) return []; // `cron_invalid` reports an unparsable schedule

    const from = new Date(APP_SPEC_SCHEDULE_REFERENCE_INSTANT);
    const first = computeNextCronFire(schedule, from);
    if (first === null) return []; // fires too rarely to measure — never guessed
    const second = computeNextCronFire(schedule, new Date(first));
    if (second === null) return [];

    const minutes = (Date.parse(second) - Date.parse(first)) / 60_000;
    if (minutes >= APP_SPEC_SCHEDULE_MIN_GAP_MINUTES) return [];
    return [
        issue(spec, ctx, 'schedule_too_frequent', 'error', ptr('upstreamSync', 'schedule'), {
            schedule,
            minutes,
        }),
    ];
}

/** A path that leaves the repository: absolute, backslashed, `..` or under `.git/` (§0 `RelPath`). */
function pathOutsideRepository(value: string): boolean {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (value.startsWith('/') || value.startsWith('~')) return true;
    if (value.includes('\\')) return true;
    const segments = value.split('/');
    return segments.includes('..') || segments.includes('.git');
}

/** R22 — `display.protectedPaths` and every `RelPath` stay inside the repository (§8:164, §18:386). */
export function rule22PathOutsideRepository(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const paths: readonly (readonly [string, string | undefined])[] = [
        ...(spec.display?.protectedPaths ?? []).map(
            (value, index) => [ptr('display', 'protectedPaths', index), value] as const,
        ),
        ...(spec.agents?.instructionFiles ?? []).map(
            (value, index) => [ptr('agents', 'instructionFiles', index), value] as const,
        ),
        ...(spec.agents?.requireHumanMergePaths ?? []).map(
            (value, index) => [ptr('agents', 'requireHumanMergePaths', index), value] as const,
        ),
        [ptr('build', 'dockerfile'), spec.build?.dockerfile] as const,
        [ptr('build', 'context'), spec.build?.context] as const,
    ];

    for (const [pointer, value] of paths) {
        if (typeof value !== 'string' || !pathOutsideRepository(value)) continue;
        findings.push(
            issue(spec, ctx, 'path_outside_repository', 'error', pointer, { path: value }),
        );
    }
    return findings;
}

/** R23 — no `env` entry is named `EVER_WORKS_*` (§12:246). */
export function rule23ReservedEnvName(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    envEntriesOf(spec).forEach((entry, index) => {
        if (typeof entry?.name !== 'string') return;
        if (!entry.name.startsWith(APP_ENV_RESERVED_PREFIX)) return;
        findings.push(
            issue(spec, ctx, 'reserved_env_name', 'error', ptr('env', index, 'name'), {
                entry: entry.name,
                prefix: APP_ENV_RESERVED_PREFIX,
            }),
        );
    });
    return findings;
}

/** R24 — a declared `green` class the registry does not agree with (§7:146-157, §22:478). */
export function rule24LicenseDeclaredMismatch(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const license = spec.license;
    if (license === undefined || license === null) return [];
    if (license.class !== 'green') return [];
    const spdx = license.spdx;
    if (typeof spdx !== 'string' || spdx.length === 0) return [];
    const resolver = ctx.licenseClassFor;
    // No registry ⇒ unknown ⇒ the rule is skipped, never guessed (§22:502).
    if (typeof resolver !== 'function') return [];
    const registryClass = resolver(spdx);
    if (registryClass === null || registryClass === undefined || registryClass === 'green')
        return [];
    return [
        issue(spec, ctx, 'license_declared_mismatch', 'warning', ptr('license', 'class'), {
            spdx,
            declared: 'green',
            registry: registryClass,
        }),
    ];
}

/** R25 — `base64url-raw` is used only with `ed25519` or `ec-p256` (§12:273, R-11). */
export function rule25KeypairFormatUnsupported(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    envEntriesOf(spec).forEach((entry, index) => {
        const generate = entry?.generate;
        if (generate?.kind !== 'keypair') return;
        const type = generate.keypair?.type ?? 'ed25519';
        const format = generate.keypair?.format ?? 'pem';
        if (format !== 'base64url-raw') return;
        if ((APP_ENV_KEYPAIR_RAW_TYPES as readonly string[]).includes(type)) return;
        findings.push(
            issue(
                spec,
                ctx,
                'keypair_format_unsupported',
                'error',
                ptr('env', index, 'generate', 'keypair', 'format'),
                {
                    entry: entry.name,
                    type,
                    format,
                    supportedBy: APP_ENV_KEYPAIR_RAW_TYPES.join(', '),
                },
            ),
        );
    });
    return findings;
}

/** The generators a `pkcs12` password may come from — §12:274, R-11. */
export const APP_SPEC_KEYPAIR_PASSWORD_KINDS = ['base64', 'hex', 'chars'] as const;

/** R26 — `keypair.passwordEnv` is present exactly with `pkcs12`, and names a generated secret (§12:274). */
export function rule26KeypairPasswordInvalid(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const byName = envByName(spec);

    envEntriesOf(spec).forEach((entry, index) => {
        const generate = entry?.generate;
        if (generate?.kind !== 'keypair') return;
        const format = generate.keypair?.format ?? 'pem';
        const passwordEnv = generate.keypair?.passwordEnv;
        const pointer = ptr('env', index, 'generate', 'keypair', 'passwordEnv');
        const hasPassword = typeof passwordEnv === 'string' && passwordEnv.length > 0;

        if (format === 'pkcs12' && !hasPassword) {
            findings.push(
                issue(spec, ctx, 'keypair_password_invalid', 'error', pointer, {
                    entry: entry.name,
                    format,
                    reason: 'required with pkcs12',
                }),
            );
            return;
        }
        if (format !== 'pkcs12' && hasPassword) {
            findings.push(
                issue(spec, ctx, 'keypair_password_invalid', 'error', pointer, {
                    entry: entry.name,
                    format,
                    passwordEnv: passwordEnv as string,
                    reason: 'forbidden outside pkcs12',
                }),
            );
            return;
        }
        if (format !== 'pkcs12') return;

        const target = byName.get(passwordEnv as string);
        if (target === undefined) {
            findings.push(
                issue(spec, ctx, 'keypair_password_invalid', 'error', pointer, {
                    entry: entry.name,
                    format,
                    passwordEnv: passwordEnv as string,
                    reason: 'no such entry',
                }),
            );
            return;
        }
        if (!envEntryDeclaredSecret(target)) {
            findings.push(
                issue(spec, ctx, 'keypair_password_invalid', 'error', pointer, {
                    entry: entry.name,
                    format,
                    passwordEnv: passwordEnv as string,
                    reason: 'not secret',
                }),
            );
            return;
        }
        const kind = target.generate?.kind;
        if (
            kind === undefined ||
            !(APP_SPEC_KEYPAIR_PASSWORD_KINDS as readonly string[]).includes(kind)
        ) {
            findings.push(
                issue(spec, ctx, 'keypair_password_invalid', 'error', pointer, {
                    entry: entry.name,
                    format,
                    passwordEnv: passwordEnv as string,
                    reason: `not generated with ${APP_SPEC_KEYPAIR_PASSWORD_KINDS.join(', ')}`,
                }),
            );
        }
    });

    return findings;
}

/**
 * R27 — `license.sourceOfferUrl` is required whenever the Work Repository is not
 * public (§22:481, added 2026-09-17 for ACC-03-36).
 *
 * The rule reads two context facts, and **skips** when neither decides it:
 *
 * - `workRepositoryPublic: false` — the repository facts say private, so the
 *   requirement applies (this is the "private fork" half).
 * - `recordedRelation: 'private-copy'` — a private copy is private by
 *   definition, so the requirement applies even with no visibility reading.
 *
 * `recordedRelation: 'fork'` alone is deliberately **not** enough: a fork of a
 * public repository is public, and calling it `sourceOfferMissing` would refuse a
 * valid spec. §22:490-500's context table has no visibility field, which is why
 * this one is declared on {@link AppSpecRuleContext} — see the report that
 * accompanies T5.
 */
export function rule27SourceOffer(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const declaredPublic = ctx.workRepositoryPublic ?? null;
    let knownPrivate = false;
    if (declaredPublic === false) knownPrivate = true;
    else if (declaredPublic === null && ctx.recordedRelation === 'private-copy')
        knownPrivate = true;
    if (!knownPrivate) return [];

    const sourceOfferUrl = spec.license?.sourceOfferUrl;
    if (typeof sourceOfferUrl === 'string' && sourceOfferUrl.length > 0) return [];
    return [
        issue(spec, ctx, 'sourceOfferMissing', 'error', ptr('license', 'sourceOfferUrl'), {
            relation: ctx.recordedRelation ?? 'unknown',
        }),
    ];
}

// ---------------------------------------------------------------------------
// The four §23 codes that read the parsed document and belong to no R-number
// ---------------------------------------------------------------------------

/** Does a five-field expression parse? `computeNextCronFire` returns `null` for one that does not. */
function cronParses(expression: string): boolean {
    try {
        parseCron(expression);
        return true;
    } catch {
        return false;
    }
}

/** §14:339 and §19:398 — an unparsable `Cron` is `cron_invalid`. */
export function checkCronExpressions(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    (spec.cron ?? []).forEach((entry, index) => {
        if (typeof entry?.schedule !== 'string') return;
        if (cronParses(entry.schedule)) return;
        findings.push(
            issue(spec, ctx, 'cron_invalid', 'error', ptr('cron', index, 'schedule'), {
                cron: entry.name,
                schedule: entry.schedule,
            }),
        );
    });
    if (
        typeof spec.upstreamSync?.schedule === 'string' &&
        !cronParses(spec.upstreamSync.schedule)
    ) {
        findings.push(
            issue(spec, ctx, 'cron_invalid', 'error', ptr('upstreamSync', 'schedule'), {
                schedule: spec.upstreamSync.schedule,
            }),
        );
    }
    return findings;
}

/** §12:254 — an RE2-unsupported `validate.pattern` is `pattern_unsupported`. */
export function checkValidatePatterns(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    envEntriesOf(spec).forEach((entry, index) => {
        const pattern = entry?.validate?.pattern;
        if (typeof pattern !== 'string' || pattern.length === 0) return;
        if (isRe2Pattern(pattern)) return;
        findings.push(
            issue(
                spec,
                ctx,
                'pattern_unsupported',
                'error',
                ptr('env', index, 'validate', 'pattern'),
                {
                    entry: entry.name,
                },
            ),
        );
    });
    return findings;
}

/**
 * §0's quantity ranges and §9's build memory — `out_of_range`.
 *
 * `appSpecSchema` checks the **shape** of a `CpuQuantity`/`MemQuantity`
 * (`250m` | `2` | `0.5`, `<int>Mi|Gi`) because that is what a JSON Schema
 * `pattern` can express; the ranges (10m–64000m / 0.01–64 cores, `64Mi`–`256Gi`,
 * `100Mi`–`500Gi`, build memory `1Gi`–`64Gi`) are values, so they are reported
 * here (§0:27-29, §9:178).
 */
export function checkQuantityRanges(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];

    componentsOf(spec).forEach((component, index) => {
        const resources = component.resources;
        if (resources !== undefined && resources !== null) {
            for (const key of ['cpu', 'cpuLimit'] as const) {
                const value = resources[key];
                if (cpuQuantityInRange(value) !== false) continue;
                findings.push(
                    issue(
                        spec,
                        ctx,
                        'out_of_range',
                        'error',
                        ptr('components', index, 'resources', key),
                        {
                            component: component.name,
                            field: key,
                            value: String(value),
                        },
                    ),
                );
            }
            for (const key of ['memory', 'memoryLimit'] as const) {
                const value = resources[key];
                if (byteQuantityInRange(value, APP_SPEC_MEMORY_RANGE) !== false) continue;
                findings.push(
                    issue(
                        spec,
                        ctx,
                        'out_of_range',
                        'error',
                        ptr('components', index, 'resources', key),
                        {
                            component: component.name,
                            field: key,
                            value: String(value),
                        },
                    ),
                );
            }
        }

        (component.volumes ?? []).forEach((volume, volumeIndex) => {
            if (byteQuantityInRange(volume?.size, APP_SPEC_STORAGE_RANGE) !== false) return;
            findings.push(
                issue(
                    spec,
                    ctx,
                    'out_of_range',
                    'error',
                    ptr('components', index, 'volumes', volumeIndex, 'size'),
                    {
                        component: component.name,
                        volume: volume?.name ?? '',
                        value: String(volume?.size),
                    },
                ),
            );
        });
    });

    const buildMemory = spec.build?.resources?.memory;
    if (byteQuantityInRange(buildMemory, APP_SPEC_BUILD_MEMORY_RANGE) === false) {
        findings.push(
            issue(spec, ctx, 'out_of_range', 'error', ptr('build', 'resources', 'memory'), {
                field: 'memory',
                value: String(buildMemory),
            }),
        );
    }

    return findings;
}

/** §13:325 / §16:363 — a serialized `http.body` is at most 16 KiB. */
export function checkHttpBodySize(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const check = (
        body: unknown,
        pointer: string,
        owner: Readonly<Record<string, string>>,
    ): void => {
        if (body === undefined || body === null) return;
        let serialized: string;
        try {
            serialized = JSON.stringify(body) ?? '';
        } catch {
            return; // not serializable — not this check's problem
        }
        const bytes = Buffer.byteLength(serialized, 'utf8');
        if (bytes <= APP_SPEC_HTTP_BODY_MAX_BYTES) return;
        findings.push(
            issue(spec, ctx, 'out_of_range', 'error', pointer, {
                ...owner,
                bytes,
                maxBytes: APP_SPEC_HTTP_BODY_MAX_BYTES,
            }),
        );
    };

    (spec.jobs ?? []).forEach((job, index) => {
        check(job?.http?.body, ptr('jobs', index, 'http', 'body'), { job: job?.name ?? '' });
    });
    (spec.cron ?? []).forEach((entry, index) => {
        check(entry?.http?.body, ptr('cron', index, 'http', 'body'), { cron: entry?.name ?? '' });
    });
    (spec.smoke ?? []).forEach((entry, index) => {
        check(entry?.http?.body, ptr('smoke', index, 'http', 'body'), { smoke: entry?.name ?? '' });
    });

    return findings;
}

// ---------------------------------------------------------------------------
// The registry of rules and the evaluator
// ---------------------------------------------------------------------------

/** §22:455-481, in rule order. Every rule is a pure function of `(spec, ctx)`. */
export const APP_SPEC_RULES: readonly AppSpecRuleDefinition[] = [
    { id: 'R1', codes: ['web_component_needs_port'], evaluate: rule1WebComponentNeedsPort },
    {
        id: 'R2',
        codes: ['strategy_requires_components', 'components_require_strategy'],
        evaluate: rule2StrategyAndComponents,
    },
    { id: 'R3', codes: ['primary_component_invalid'], evaluate: rule3PrimaryComponent },
    { id: 'R4', codes: ['duplicate_name'], evaluate: rule4DuplicateNames },
    {
        id: 'R5',
        codes: ['reference_unresolved', 'reference_syntax', 'template_cycle', 'template_too_deep'],
        evaluate: rule5References,
    },
    {
        id: 'R6',
        codes: ['secret_reference_not_secret', 'phase_mismatch'],
        evaluate: rule6SecrecyAndPhase,
    },
    { id: 'R7', codes: ['env_source_count'], evaluate: rule7EnvSourceCount },
    { id: 'R8', codes: ['literal_secret_value'], evaluate: rule8LiteralSecretValue },
    { id: 'R9', codes: ['generate_validate_conflict'], evaluate: rule9GenerateValidate },
    {
        id: 'R10',
        codes: ['literal_secret_in_build_args'],
        evaluate: rule10LiteralSecretInBuildArgs,
    },
    { id: 'R11', codes: ['secret_build_arg'], evaluate: rule11SecretBuildArg },
    { id: 'R12', codes: ['upstream_pr_approval_required'], evaluate: rule12UpstreamPrApproval },
    {
        id: 'R13',
        codes: [
            'upstream_forbidden_for_link',
            'upstream_sync_requires_upstream',
            'upstream_prs_require_fork',
        ],
        evaluate: rule13UpstreamForbiddenForLink,
    },
    { id: 'R14', codes: ['component_ref_unknown'], evaluate: rule14ComponentRefUnknown },
    { id: 'R15', codes: ['auth_env_not_secret'], evaluate: rule15AuthEnvNotSecret },
    { id: 'R16', codes: ['reference_unresolved'], evaluate: rule16PublicUrlEnv },
    { id: 'R17', codes: ['limit_below_request'], evaluate: rule17LimitBelowRequest },
    { id: 'R18', codes: ['volume_replicas'], evaluate: rule18VolumeReplicas },
    { id: 'R19', codes: ['image_not_pinned'], evaluate: rule19ImageNotPinned },
    { id: 'R20', codes: ['advisory_check'], evaluate: rule20AdvisoryCheck },
    { id: 'R21', codes: ['schedule_too_frequent'], evaluate: rule21ScheduleTooFrequent },
    { id: 'R22', codes: ['path_outside_repository'], evaluate: rule22PathOutsideRepository },
    { id: 'R23', codes: ['reserved_env_name'], evaluate: rule23ReservedEnvName },
    { id: 'R24', codes: ['license_declared_mismatch'], evaluate: rule24LicenseDeclaredMismatch },
    { id: 'R25', codes: ['keypair_format_unsupported'], evaluate: rule25KeypairFormatUnsupported },
    { id: 'R26', codes: ['keypair_password_invalid'], evaluate: rule26KeypairPasswordInvalid },
    { id: 'R27', codes: ['sourceOfferMissing'], evaluate: rule27SourceOffer },
];

/**
 * The §23 codes that read the parsed document but are **not** one of §22's
 * numbered rules. T6 runs these beside {@link APP_SPEC_RULES} and must not also
 * emit them from its structural layer, or one leaf would be reported twice
 * (§22:511-513).
 */
export const APP_SPEC_DOCUMENT_CHECKS: readonly AppSpecDocumentCheck[] = [
    { name: 'quantity-ranges', codes: ['out_of_range'], evaluate: checkQuantityRanges },
    { name: 'http-body-size', codes: ['out_of_range'], evaluate: checkHttpBodySize },
    { name: 'cron-expressions', codes: ['cron_invalid'], evaluate: checkCronExpressions },
    { name: 'validate-patterns', codes: ['pattern_unsupported'], evaluate: checkValidatePatterns },
];

/** Every code this module can report. */
export const APP_SPEC_RULE_ISSUE_CODES: readonly AppSpecIssueCode[] = [
    ...new Set([
        ...APP_SPEC_RULES.flatMap((rule) => rule.codes),
        ...APP_SPEC_DOCUMENT_CHECKS.flatMap((check) => check.codes),
    ]),
];

/**
 * Run every rule of §22 and the four document checks, in a stable order: R1 →
 * R27, then the companions, each rule reporting in document order.
 *
 * The caller runs this **whenever the document parses** (§22:507-513) and
 * suppresses the whole set only for `yaml_syntax`, `file_too_large`,
 * `yaml_alias_limit` and the depth limit — all four T6's.
 */
export function evaluateAppSpecRules(
    spec: AppSpec,
    ctx: AppSpecRuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    for (const rule of APP_SPEC_RULES) findings.push(...rule.evaluate(spec, ctx));
    for (const check of APP_SPEC_DOCUMENT_CHECKS) findings.push(...check.evaluate(spec, ctx));
    return findings;
}

// ---------------------------------------------------------------------------
// Building one finding
// ---------------------------------------------------------------------------

/** One issue, with the position of its key or of the nearest key that exists. */
function issue(
    spec: AppSpec,
    ctx: AppSpecRuleContext,
    code: AppSpecIssueCode,
    severity: AppSpecSeverity,
    pointer: string,
    params?: Readonly<Record<string, string | number | boolean>>,
): AppSpecRuleFinding {
    const position = nearestPosition(pointer, ctx.positions);
    return {
        code,
        severity,
        pointer,
        path: pointerToPath(pointer),
        displayPath: displayPathFor(spec, pointer),
        ...(position === null ? {} : { line: position.line, column: position.column }),
        ...(params === undefined ? {} : { params }),
    };
}

// ---------------------------------------------------------------------------
// Re-exports the rules share with the refs layer, so callers import one module
// ---------------------------------------------------------------------------

export {
    APP_SPEC_ISSUE_ROOT,
    dependencyOutputSecret,
    resolveReference,
    tokenizeReference,
    tokenizeTemplate,
};
export type { AppSpecReference };
