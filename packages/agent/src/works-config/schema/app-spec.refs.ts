/**
 * The App spec **reference grammar, resolution and propagation** — `schema.md`
 * §21, as a hand-written tokenizer plus a resolver and graph analysis.
 *
 * Owning epic: **APW-03** (task T4). Plan: `plan.md` §2.2:126-129 —
 * "`app-spec.refs.ts` _(new)_ holds the reference grammar (`schema.md` §21) as a
 * hand-written tokenizer, the resolver, the secrecy/phase propagation and a
 * Tarjan cycle check over `template` edges."
 *
 * ## Why this module exists at all
 *
 * `app-spec.schema.ts` (T3) types `env[].from` and `env[].template` as plain
 * strings **on purpose**: the grammar of §21 is not a structural bound any JSON
 * Schema `pattern` could carry honestly (a `from` reference is resolved against
 * the *rest* of the document, not against its own shape), and zod refinements
 * are dropped by `z.toJSONSchema()`. So a malformed reference is
 * `reference_syntax` from this module and never `pattern` from the schema, and a
 * well-formed reference that names something the document does not declare is
 * `reference_unresolved` (§21:434-443).
 *
 * ## The grammar (schema.md §21:420-432, verbatim)
 *
 * ```
 * Reference    := DomainRef | DepRef | PlatformRef | BuildRef | ComponentRef
 * DomainRef    := "domains.primary." ( "url" | "host" )
 * BuildRef     := "build.commitSha"
 * ComponentRef := "components." Name ".internalUrl"
 * DepRef       := "deps." DepKind "." Output
 * DepKind      := "postgres" | "redis" | "objectStorage" | "smtp"
 * Output       := Identifier | "bucket." Name          ; bucket.<name> for objectStorage only
 * PlatformRef  := "platform.smtp." ( "host" | "port" | "user" | "password" | "from" | "secure" )
 * Template     := { Literal | "{{" Space* ( Reference | EnvRef ) Space* "}}" }
 * EnvRef       := "env." EnvName
 * FromEnv      := EnvName                              ; build.args[].fromEnv only
 * ```
 *
 * `EnvRef` is deliberately **not** a `Reference`: `from:` takes a `Reference`,
 * so `from: env.FOO` is `reference_syntax`, while `{{env.FOO}}` inside a
 * `template:` is not. {@link tokenizeReference} and
 * {@link tokenizeTemplatePlaceholder} are that distinction.
 *
 * ## The dependency output table is APW-07's, not a second copy
 *
 * §11:229-237 prints the outputs a `from:` may reference and says the normative
 * list is APW-07's `APP_DEPENDENCY_OUTPUTS`; that constant has shipped
 * (`packages/contracts/src/apps/app-dependencies.ts:126-131`), so it is imported
 * and never re-declared here. The `directUrl` (only with
 * `postgres.directUrl: true`) and `bucket.<name>` (one per declared bucket)
 * qualifications are the two the §11 table adds to it, and they are resolved
 * against the document by {@link buildReferenceTables}.
 *
 * ## Pointers are rooted at `/spec`
 *
 * Every pointer this module returns is a §23 issue pointer — `/spec/env/0/from`
 * — not a path inside the `spec` object (§23:517-529). `path` and `displayPath`
 * are the rule layer's (`app-spec.rules.ts`).
 */

import {
    APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX,
    APP_DEPENDENCY_KINDS,
    APP_DEPENDENCY_OUTPUTS,
    APP_ENV_TEMPLATE_MAX_DEPTH,
    appEnvPublicHalfName,
    type AppDependencyKind,
    type AppSpec,
    type AppSpecBuildStrategy,
    type AppSpecComponent,
    type AppSpecEnvEntry,
    type AppSpecEnvPhase,
} from '@ever-works/contracts';
import { APP_SPEC_ENV_NAME_PATTERN, APP_SPEC_NAME_PATTERN } from './app-spec.schema';

// ---------------------------------------------------------------------------
// Grammar constants (schema.md §21)
// ---------------------------------------------------------------------------

/** The root every §23 pointer carries (§23:517-529) — `/spec/components/0/port`. */
export const APP_SPEC_ISSUE_ROOT = '/spec';

/**
 * The deepest `template` chain the platform resolves — **10** (§21:449
 * "Resolution depth ≤ 10 (`template_too_deep`)").
 *
 * Read from APW-07's `APP_ENV_TEMPLATE_MAX_DEPTH`
 * (`packages/contracts/src/apps/app-env.ts:169`, "Template nesting depth,
 * re-checked at resolution"), because the same bound is enforced again when
 * APW-07 resolves the value: one number, declared once.
 */
export const APP_SPEC_REFERENCE_MAX_DEPTH = APP_ENV_TEMPLATE_MAX_DEPTH;

/** The two outputs of `domains.primary` (§21:422). */
export const APP_SPEC_DOMAIN_OUTPUTS = ['url', 'host'] as const;

/** The six outputs of `platform.smtp` (§21:428). */
export const APP_SPEC_PLATFORM_SMTP_OUTPUTS = [
    'host',
    'port',
    'user',
    'password',
    'from',
    'secure',
] as const;

/** The single output of `components.<n>` (§21:424). */
export const APP_SPEC_COMPONENT_OUTPUT = 'internalUrl' as const;

/** The single output of `build` (§21:423). */
export const APP_SPEC_BUILD_OUTPUT = 'commitSha' as const;

/**
 * The strategies for which `build.commitSha` resolves — `dockerfile` and `auto`
 * (§21:439: "`build.strategy` is `dockerfile` or `auto` (a Build produces the
 * image)"). `image` deploys a prebuilt image and `none` builds nothing, so for
 * those two the reference is `reference_unresolved`.
 */
export const APP_SPEC_BUILD_COMMIT_SHA_STRATEGIES: readonly AppSpecBuildStrategy[] = [
    'dockerfile',
    'auto',
];

/**
 * `Identifier` in the `Output` production (§21:427) — an output name such as
 * `url`, `accessKeyId` or `secretAccessKey`.
 *
 * A well-formed identifier the dependency does not publish is
 * `reference_unresolved`, never `reference_syntax`: the grammar cannot know
 * which outputs exist (§11's table is the authority).
 */
export const APP_SPEC_OUTPUT_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

// ---------------------------------------------------------------------------
// The parsed reference
// ---------------------------------------------------------------------------

/** Where a reference lives, which decides what it may name (§21:420-432). */
export type AppSpecReferenceSource = 'from' | 'template' | 'fromEnv' | 'publicUrlEnv';

/** A resolved-or-not `domains.primary` reference (§21:422, §15:345-352). */
export interface AppSpecDomainReference {
    readonly kind: 'domain';
    readonly output: (typeof APP_SPEC_DOMAIN_OUTPUTS)[number];
    /** The reference exactly as written, trimmed. */
    readonly text: string;
}

/** A `deps.<kind>.<output>` reference (§21:425-427). */
export interface AppSpecDepReference {
    readonly kind: 'dep';
    readonly dependency: AppDependencyKind;
    /** `url`, `accessKeyId`, `bucket.attachments`, … */
    readonly output: string;
    /** Set when `output` is `bucket.<name>` — the bucket name. */
    readonly bucket?: string;
    readonly text: string;
}

/** A `platform.smtp.<out>` reference (§21:428). */
export interface AppSpecPlatformReference {
    readonly kind: 'platform';
    readonly output: (typeof APP_SPEC_PLATFORM_SMTP_OUTPUTS)[number];
    readonly text: string;
}

/** A `build.commitSha` reference (§21:423). */
export interface AppSpecBuildReference {
    readonly kind: 'build';
    readonly output: typeof APP_SPEC_BUILD_OUTPUT;
    readonly text: string;
}

/** A `components.<n>.internalUrl` reference (§21:424). */
export interface AppSpecComponentReference {
    readonly kind: 'component';
    readonly component: string;
    readonly output: typeof APP_SPEC_COMPONENT_OUTPUT;
    readonly text: string;
}

/** An `env.<NAME>` reference — legal inside a `template` only (§21:430). */
export interface AppSpecEnvReference {
    readonly kind: 'env';
    readonly entry: string;
    readonly text: string;
}

/** Every reference the grammar produces. */
export type AppSpecReference =
    | AppSpecDomainReference
    | AppSpecDepReference
    | AppSpecPlatformReference
    | AppSpecBuildReference
    | AppSpecComponentReference
    | AppSpecEnvReference;

/** A tokenizer result: the parsed reference, or `reference_syntax` (§21:443). */
export interface AppSpecReferenceParse {
    readonly ok: boolean;
    /** The parsed reference; present when {@link AppSpecReferenceParse.ok}. */
    readonly reference?: AppSpecReference;
    /** The offending text; present when the parse failed. */
    readonly text: string;
}

/** One piece of a `template` (§21:429). */
export interface AppSpecTemplateLiteralPart {
    readonly kind: 'literal';
    readonly text: string;
}

/** A `{{ … }}` placeholder that parses. */
export interface AppSpecTemplateReferencePart {
    readonly kind: 'reference';
    readonly reference: AppSpecReference;
    /** The placeholder exactly as it appeared, braces included. */
    readonly placeholder: string;
}

/** A `{{ … }}` placeholder that does not match the grammar — `reference_syntax`. */
export interface AppSpecTemplateSyntaxPart {
    readonly kind: 'syntax';
    readonly text: string;
    readonly placeholder: string;
}

/** One tokenized piece of a `template`. */
export type AppSpecTemplatePart =
    | AppSpecTemplateLiteralPart
    | AppSpecTemplateReferencePart
    | AppSpecTemplateSyntaxPart;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/** A tokenizer failure — `reference_syntax`, and never `pattern` (§21:443). */
function syntaxError(text: string): AppSpecReferenceParse {
    return { ok: false, text };
}

/** A tokenizer success. */
function parsed(reference: AppSpecReference): AppSpecReferenceParse {
    return { ok: true, reference, text: reference.text };
}

/**
 * Tokenize a bare `Reference` (§21:421-428) — what `env[].from` carries.
 *
 * `env.<NAME>` is refused here (it is an `EnvRef`, legal inside a `template`
 * only — §21:429-430); {@link tokenizeTemplatePlaceholder} is the entry point
 * that allows it. Blank input is `reference_syntax`: `from` is either absent or
 * a reference, and an empty string is neither.
 */
export function tokenizeReference(text: string): AppSpecReferenceParse {
    const value = typeof text === 'string' ? text.trim() : '';
    if (value.length === 0) return syntaxError(String(text ?? ''));

    if (value === `build.${APP_SPEC_BUILD_OUTPUT}`) {
        return parsed({ kind: 'build', output: APP_SPEC_BUILD_OUTPUT, text: value });
    }

    if (value.startsWith('domains.')) {
        const segments = value.split('.');
        if (
            segments.length === 3 &&
            segments[1] === 'primary' &&
            (APP_SPEC_DOMAIN_OUTPUTS as readonly string[]).includes(segments[2])
        ) {
            return parsed({
                kind: 'domain',
                output: segments[2] as AppSpecDomainReference['output'],
                text: value,
            });
        }
        return syntaxError(value);
    }

    if (value.startsWith('platform.')) {
        const segments = value.split('.');
        if (
            segments.length === 3 &&
            segments[1] === 'smtp' &&
            (APP_SPEC_PLATFORM_SMTP_OUTPUTS as readonly string[]).includes(segments[2])
        ) {
            return parsed({
                kind: 'platform',
                output: segments[2] as AppSpecPlatformReference['output'],
                text: value,
            });
        }
        return syntaxError(value);
    }

    if (value.startsWith('components.')) {
        const segments = value.split('.');
        if (
            segments.length === 3 &&
            APP_SPEC_NAME_PATTERN.test(segments[1]) &&
            segments[2] === APP_SPEC_COMPONENT_OUTPUT
        ) {
            return parsed({
                kind: 'component',
                component: segments[1],
                output: APP_SPEC_COMPONENT_OUTPUT,
                text: value,
            });
        }
        return syntaxError(value);
    }

    if (value.startsWith('deps.')) {
        const segments = value.split('.');
        const dependency = segments[1] as AppDependencyKind;
        if (!(APP_DEPENDENCY_KINDS as readonly string[]).includes(segments[1])) {
            return syntaxError(value);
        }
        if (segments.length === 3 && APP_SPEC_OUTPUT_IDENTIFIER_PATTERN.test(segments[2])) {
            return parsed({ kind: 'dep', dependency, output: segments[2], text: value });
        }
        if (
            segments.length === 4 &&
            segments[2] === APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX.replace(/\.$/, '') &&
            APP_SPEC_NAME_PATTERN.test(segments[3])
        ) {
            return parsed({
                kind: 'dep',
                dependency,
                output: `${APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX}${segments[3]}`,
                bucket: segments[3],
                text: value,
            });
        }
        return syntaxError(value);
    }

    return syntaxError(value);
}

/**
 * Tokenize a `{{ … }}` placeholder's inner text — a `Reference` **or** an
 * `EnvRef` (§21:429).
 */
export function tokenizeTemplatePlaceholder(text: string): AppSpecReferenceParse {
    const value = typeof text === 'string' ? text.trim() : '';
    if (value.startsWith('env.')) {
        const entry = value.slice('env.'.length);
        if (!APP_SPEC_ENV_NAME_PATTERN.test(entry)) return syntaxError(value);
        return parsed({ kind: 'env', entry, text: value });
    }
    return tokenizeReference(value);
}

/**
 * Tokenize a whole `template` (§21:429) into literals and placeholders.
 *
 * An unterminated `{{` makes the remainder of the string one `syntax` part: the
 * placeholder is malformed and the text after it cannot be trusted to be a
 * literal either.
 */
export function tokenizeTemplate(text: string): readonly AppSpecTemplatePart[] {
    const parts: AppSpecTemplatePart[] = [];
    const source = typeof text === 'string' ? text : '';

    let index = 0;
    while (index < source.length) {
        const open = source.indexOf('{{', index);
        if (open < 0) {
            parts.push({ kind: 'literal', text: source.slice(index) });
            break;
        }
        if (open > index) {
            parts.push({ kind: 'literal', text: source.slice(index, open) });
        }
        const close = source.indexOf('}}', open + 2);
        if (close < 0) {
            parts.push({
                kind: 'syntax',
                text: source.slice(open),
                placeholder: source.slice(open),
            });
            break;
        }
        const placeholder = source.slice(open, close + 2);
        const inner = source.slice(open + 2, close);
        const parse = tokenizeTemplatePlaceholder(inner);
        if (parse.ok) {
            parts.push({ kind: 'reference', reference: parse.reference, placeholder });
        } else {
            parts.push({ kind: 'syntax', text: inner.trim(), placeholder });
        }
        index = close + 2;
    }

    return parts;
}

/**
 * Every `{{ … }}` placeholder inside a string, braces included — the helper
 * APW-06 uses for `http.body` string leaves (§13:325: "String leaves may
 * contain `{{…}}` placeholders").
 *
 * The rule set does **not** report unresolved placeholders inside a body: R5
 * resolves `from:`, `template:` and `fromEnv:` (§22:459), and a body is none of
 * the three. The helper exists so that consumer can resolve them with exactly
 * the same grammar instead of a second scanner.
 */
export function templatePlaceholders(text: string): readonly string[] {
    return tokenizeTemplate(text)
        .filter((part) => part.kind === 'reference')
        .map((part) => (part as AppSpecTemplateReferencePart).placeholder);
}

// ---------------------------------------------------------------------------
// Resolution tables
// ---------------------------------------------------------------------------

/** What the rest of a document makes resolvable — built once per evaluation. */
export interface AppSpecReferenceTables {
    /** Component names, in document order (§10:190). */
    readonly componentNames: readonly string[];
    /** Components by name, for the `web` and `internalUrl` checks. */
    readonly components: ReadonlyMap<string, AppSpecComponent>;
    /** Env entries by name (§12:241). */
    readonly env: ReadonlyMap<string, AppSpecEnvEntry>;
    /** The dependency kinds `dependencies` declares (§11:215-227). */
    readonly dependencies: ReadonlySet<AppDependencyKind>;
    /** The object-storage buckets `objectStorage.buckets` declares (§11:225). */
    readonly buckets: ReadonlySet<string>;
    /** `dependencies.postgres.directUrl` — which gates the `directUrl` output (§11:220). */
    readonly postgresDirectUrl: boolean;
    /** `build.strategy`, or `null` when the block is absent (§9:170). */
    readonly buildStrategy: AppSpecBuildStrategy | null;
    /** True when at least one `web` component exists (§21:436). */
    readonly hasWebComponent: boolean;
    /** The `web` component names, in document order. */
    readonly webComponents: readonly string[];
    /** `domains.primaryComponent`, or the single `web` component when it is absent (§15:349). */
    readonly primaryComponent: string | null;
    /** Derived `<NAME>_PUBLIC` name → the key-pair entry that produces it (§12:265, R4). */
    readonly publicHalves: ReadonlyMap<string, string>;
}

/** `domains.primaryComponent` when declared, else the only `web` component (§15:349). */
function primaryWebComponent(spec: AppSpec, webComponents: readonly string[]): string | null {
    const declared = spec.domains?.primaryComponent;
    if (declared !== undefined && declared !== null) return declared;
    return webComponents.length === 1 ? webComponents[0] : null;
}

/**
 * The derived `<NAME>_PUBLIC` names a document declares (§12:265: "Public half
 * exposed as `<NAME>_PUBLIC` only"; §12:310-311: an entry may not declare
 * `<NAME>_PUBLIC` for a key-pair entry `<NAME>`).
 */
export function appSpecPublicHalves(
    spec: AppSpec,
): readonly { readonly name: string; readonly entry: string; readonly index: number }[] {
    const halves: { name: string; entry: string; index: number }[] = [];
    const entries = spec.env ?? [];
    entries.forEach((entry, index) => {
        if (entry.name === undefined || entry.name === null) return;
        if (entry.generate?.kind !== 'keypair') return;
        halves.push({ name: appEnvPublicHalfName(entry.name), entry: entry.name, index });
    });
    return halves;
}

/** Build the resolution tables of one document (§9, §10, §11, §12, §15). */
export function buildReferenceTables(spec: AppSpec): AppSpecReferenceTables {
    const componentNames: string[] = [];
    const components = new Map<string, AppSpecComponent>();
    const webComponents: string[] = [];
    for (const component of spec.components ?? []) {
        if (component?.name === undefined || component?.name === null) continue;
        componentNames.push(component.name);
        components.set(component.name, component);
        if (component.role === 'web') webComponents.push(component.name);
    }

    const env = new Map<string, AppSpecEnvEntry>();
    for (const entry of spec.env ?? []) {
        if (entry?.name === undefined || entry?.name === null) continue;
        // First declaration wins: a duplicate is R4's report, and resolution
        // must stay deterministic while it is being reported.
        if (!env.has(entry.name)) env.set(entry.name, entry);
    }

    const dependencies = new Set<AppDependencyKind>();
    const declared = spec.dependencies;
    if (declared) {
        for (const kind of APP_DEPENDENCY_KINDS) {
            if (declared[kind] !== undefined && declared[kind] !== null) dependencies.add(kind);
        }
    }

    const buckets = new Set<string>();
    for (const bucket of declared?.objectStorage?.buckets ?? []) {
        if (typeof bucket === 'string') buckets.add(bucket);
    }

    const publicHalves = new Map<string, string>();
    for (const half of appSpecPublicHalves(spec)) {
        if (!publicHalves.has(half.name)) publicHalves.set(half.name, half.entry);
    }

    return {
        componentNames,
        components,
        env,
        dependencies,
        buckets,
        postgresDirectUrl: declared?.postgres?.directUrl === true,
        buildStrategy: spec.build?.strategy ?? null,
        hasWebComponent: webComponents.length > 0,
        webComponents,
        primaryComponent: primaryWebComponent(spec, webComponents),
        publicHalves,
    };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The name of a reference's output, for messages and params. */
export function referenceOutputName(reference: AppSpecReference): string {
    switch (reference.kind) {
        case 'domain':
            return `domains.primary.${reference.output}`;
        case 'dep':
            return `deps.${reference.dependency}.${reference.output}`;
        case 'platform':
            return `platform.smtp.${reference.output}`;
        case 'build':
            return `build.${reference.output}`;
        case 'component':
            return `components.${reference.component}.${reference.output}`;
        case 'env':
        default:
            return `env.${reference.entry}`;
    }
}

/** What a reference resolved to — or why it did not (§21:434-443). */
export interface AppSpecReferenceResolution {
    readonly resolved: boolean;
    /** True when the reference names a † output (§11:232-237, §21:445-446). */
    readonly secret: boolean;
    /** The reference's own name — `deps.postgres.url`. */
    readonly reference: string;
    /** What the document would have to declare — `dependencies.postgres`. */
    readonly needs?: string;
    /** For `deps.` references only: the kind, so consumers key by it. */
    readonly dependency?: AppDependencyKind;
}

/**
 * Is a † output? Read from APW-07's table (§11:232-237), which §11:229-230
 * names as the normative list.
 *
 * `bucket.<name>` is never secret (§11:236 — the bucket *name* is not a
 * credential; `accessKeyId` and `secretAccessKey` beside it are). An output
 * name the table does not know is reported as `reference_unresolved` and is not
 * *also* called secret: one problem per reference.
 */
export function dependencyOutputSecret(kind: AppDependencyKind, output: string): boolean {
    if (output.startsWith(APP_DEPENDENCY_BUCKET_OUTPUT_PREFIX)) return false;
    const flags: Record<string, boolean> = APP_DEPENDENCY_OUTPUTS[kind];
    return flags[output] ?? false;
}

/**
 * Does this `deps.<kind>.<output>` reference name an output the kind publishes
 * **and** the document declares? (§11:217-237)
 *
 * `null` means "not an output of this kind at all" — a different failure from
 * "the output exists but this document does not declare it", because the two
 * produce different `needs` text.
 */
export function dependencyOutputAvailable(
    reference: AppSpecDepReference,
    tables: AppSpecReferenceTables,
): boolean | null {
    const outputs: Record<string, boolean> = APP_DEPENDENCY_OUTPUTS[reference.dependency];
    if (reference.bucket !== undefined) {
        if (reference.dependency !== 'objectStorage') return null;
        return tables.buckets.has(reference.bucket);
    }
    if (!(reference.output in outputs)) return null;
    if (reference.dependency === 'postgres' && reference.output === 'directUrl') {
        return tables.postgresDirectUrl;
    }
    return true;
}

/** Resolve one reference against the tables (§21:434-443). */
export function resolveReference(
    reference: AppSpecReference,
    tables: AppSpecReferenceTables,
): AppSpecReferenceResolution {
    const text = referenceOutputName(reference);

    switch (reference.kind) {
        case 'domain': {
            if (!tables.hasWebComponent) {
                return {
                    resolved: false,
                    secret: false,
                    reference: text,
                    needs: 'a web component',
                };
            }
            return { resolved: true, secret: false, reference: text };
        }
        case 'platform': {
            // §21:438 — `platform.smtp.*` resolves when `dependencies.smtp` is declared.
            if (!tables.dependencies.has('smtp')) {
                return {
                    resolved: false,
                    secret: reference.output === 'password',
                    reference: text,
                    needs: 'dependencies.smtp',
                };
            }
            return { resolved: true, secret: reference.output === 'password', reference: text };
        }
        case 'build': {
            const strategy = tables.buildStrategy;
            const resolves =
                strategy !== null &&
                (APP_SPEC_BUILD_COMMIT_SHA_STRATEGIES as readonly string[]).includes(strategy);
            if (!resolves) {
                return {
                    resolved: false,
                    secret: false,
                    reference: text,
                    needs: 'build.strategy: dockerfile or auto',
                };
            }
            return { resolved: true, secret: false, reference: text };
        }
        case 'component': {
            const component = tables.components.get(reference.component);
            // §21:440 — a component named `<n>` exists **and is `web`**.
            if (component === undefined || component.role !== 'web') {
                return {
                    resolved: false,
                    secret: false,
                    reference: text,
                    needs: `components.${reference.component} with role web`,
                };
            }
            return { resolved: true, secret: false, reference: text };
        }
        case 'dep': {
            const secret = dependencyOutputSecret(reference.dependency, reference.output);
            const output = dependencyOutputAvailable(reference, tables);
            if (output === null) {
                return {
                    resolved: false,
                    secret,
                    reference: text,
                    needs: `dependencies.${reference.dependency}`,
                    dependency: reference.dependency,
                };
            }
            if (!tables.dependencies.has(reference.dependency)) {
                return {
                    resolved: false,
                    secret,
                    reference: text,
                    needs: `dependencies.${reference.dependency}`,
                    dependency: reference.dependency,
                };
            }
            if (reference.bucket !== undefined && !tables.buckets.has(reference.bucket)) {
                return {
                    resolved: false,
                    secret,
                    reference: text,
                    needs: 'dependencies.objectStorage.buckets',
                    dependency: reference.dependency,
                };
            }
            if (reference.dependency === 'postgres' && reference.output === 'directUrl') {
                if (tables.postgresDirectUrl) {
                    return {
                        resolved: true,
                        secret,
                        reference: text,
                        dependency: reference.dependency,
                    };
                }
                return {
                    resolved: false,
                    secret,
                    reference: text,
                    needs: 'dependencies.postgres.directUrl: true',
                    dependency: reference.dependency,
                };
            }
            return { resolved: true, secret, reference: text, dependency: reference.dependency };
        }
        case 'env':
        default: {
            if (!tables.env.has(reference.entry)) {
                return {
                    resolved: false,
                    secret: false,
                    reference: text,
                    needs: `env.${reference.entry}`,
                };
            }
            return { resolved: true, secret: false, reference: text };
        }
    }
}

// ---------------------------------------------------------------------------
// Secrecy and phase propagation (§21:445-449)
// ---------------------------------------------------------------------------

/** An entry's declared phase, defaulted — `runtime` when absent (§12:248). */
export function envPhaseOf(entry: AppSpecEnvEntry): AppSpecEnvPhase {
    return entry.phase ?? 'runtime';
}

/**
 * Can an entry at `reader` phase read a value at `source` phase? (§21:447-448)
 *
 * A `runtime` entry cannot template a `build`-only entry and vice versa;
 * `both` needs the value on both sides, so it also demands `both` (or better)
 * from what it reads.
 */
export function envPhasesCompatible(reader: AppSpecEnvPhase, source: AppSpecEnvPhase): boolean {
    const readerNeedsRuntime = reader === 'runtime' || reader === 'both';
    const readerNeedsBuild = reader === 'build' || reader === 'both';
    const sourceHasRuntime = source === 'runtime' || source === 'both';
    const sourceHasBuild = source === 'build' || source === 'both';
    return (!readerNeedsRuntime || sourceHasRuntime) && (!readerNeedsBuild || sourceHasBuild);
}

/**
 * Is this entry secret *by its own declaration*?
 *
 * `generate` implies `secret: true` (§12:253) — `secret: false` beside a
 * `generate` block is the structural error `generated_not_secret`, and until
 * that is fixed the entry is still a generated value.
 */
export function envEntryDeclaredSecret(entry: AppSpecEnvEntry): boolean {
    return entry.secret === true || (entry.generate !== undefined && entry.generate !== null);
}

// ---------------------------------------------------------------------------
// The analysis: problems, cycles, depth
// ---------------------------------------------------------------------------

/** The §21 codes this module can produce. */
export const APP_SPEC_REFERENCE_PROBLEM_CODES = [
    'reference_syntax',
    'reference_unresolved',
    'secret_reference_not_secret',
    'phase_mismatch',
    'template_cycle',
    'template_too_deep',
] as const;

/** Union derived from {@link APP_SPEC_REFERENCE_PROBLEM_CODES}. */
export type AppSpecReferenceProblemCode = (typeof APP_SPEC_REFERENCE_PROBLEM_CODES)[number];

/** One §21 problem, located by its §23 pointer. */
export interface AppSpecReferenceProblem {
    readonly code: AppSpecReferenceProblemCode;
    /** `/spec/env/0/from` — rooted at `/spec` (§23:517-529). */
    readonly pointer: string;
    /** Names and scalar facts only (plan §2.2:153-155). */
    readonly params: Readonly<Record<string, string | number | boolean>>;
    /** The entries a `template_cycle` names, in document order. */
    readonly entries?: readonly string[];
}

/** One env entry, after propagation. */
export interface AppSpecEntryAnalysis {
    readonly index: number;
    readonly name: string;
    readonly phase: AppSpecEnvPhase;
    /** Declared by this entry itself (`secret: true`, or a `generate` block). */
    readonly declaredSecret: boolean;
    /** Declared **or** propagated from what it reads (§21:445-446). */
    readonly secret: boolean;
    /** The env entries its `template` reads, in document order, deduplicated. */
    readonly reads: readonly string[];
    /** 1 for an entry that reads nothing; `1 + max(depth of what it reads)` otherwise. */
    readonly depth: number;
    /** The longest chain it depends on, ending with itself — `['a', 'b']`. */
    readonly chain: readonly string[];
}

/** The whole-document §21 result. */
export interface AppSpecReferenceAnalysis {
    readonly tables: AppSpecReferenceTables;
    readonly entries: readonly AppSpecEntryAnalysis[];
    readonly byName: ReadonlyMap<string, AppSpecEntryAnalysis>;
    /** Every cycle among `template` edges, each naming all of its members (§21:448). */
    readonly cycles: readonly (readonly string[])[];
    /** Problems in document order: entry by entry, `from` before `template`. */
    readonly problems: readonly AppSpecReferenceProblem[];
}

/** `pointer` for one env entry's key. */
function envPointer(index: number, key?: string): string {
    return `${APP_SPEC_ISSUE_ROOT}/env/${index}${key === undefined ? '' : `/${key}`}`;
}

/** The env entry names a `template` reads, in document order. */
function templateReads(entry: AppSpecEnvEntry): readonly string[] {
    if (typeof entry.template !== 'string') return [];
    const names: string[] = [];
    for (const part of tokenizeTemplate(entry.template)) {
        if (part.kind !== 'reference') continue;
        const reference = (part as AppSpecTemplateReferencePart).reference;
        if (reference.kind !== 'env') continue;
        if (!names.includes(reference.entry)) names.push(reference.entry);
    }
    return names;
}

/**
 * Tarjan's strongly connected components over the `template` edges (§21:448 —
 * "Cycles among `template` entries are error `template_cycle` naming every entry
 * in the cycle").
 *
 * A component of one node counts only when that node has an edge to itself: a
 * `template` that reads its own entry is the smallest cycle there is, and §21's
 * table spells it out ("an `env` entry named `<NAME>` exists **and is not the
 * entry itself**").
 *
 * Members come back in document order so the report is stable.
 */
export function findTemplateCycles(spec: AppSpec): readonly (readonly string[])[] {
    const entries = spec.env ?? [];
    const names: string[] = [];
    const indexByName = new Map<string, number>();
    entries.forEach((entry, index) => {
        if (entry?.name === undefined || entry?.name === null) return;
        if (!indexByName.has(entry.name)) {
            indexByName.set(entry.name, index);
            names.push(entry.name);
        }
    });

    const edges = new Map<string, readonly string[]>();
    for (const entry of entries) {
        if (entry?.name === undefined || entry?.name === null) continue;
        edges.set(
            entry.name,
            templateReads(entry).filter((read) => indexByName.has(read)),
        );
    }

    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];
    let counter = 0;

    const strongConnect = (name: string): void => {
        index.set(name, counter);
        low.set(name, counter);
        counter += 1;
        stack.push(name);
        onStack.add(name);

        for (const next of edges.get(name) ?? []) {
            if (!index.has(next)) {
                strongConnect(next);
                low.set(name, Math.min(low.get(name) as number, low.get(next) as number));
            } else if (onStack.has(next)) {
                low.set(name, Math.min(low.get(name) as number, index.get(next) as number));
            }
        }

        if (low.get(name) === index.get(name)) {
            const component: string[] = [];
            let member = stack.pop() as string;
            while (member !== name) {
                onStack.delete(member);
                component.push(member);
                member = stack.pop() as string;
            }
            onStack.delete(member);
            component.push(member);
            components.push(component);
        }
    };

    for (const name of names) {
        if (!index.has(name)) strongConnect(name);
    }

    const cycles: string[][] = [];
    for (const component of components) {
        const selfEdge =
            component.length === 1 && (edges.get(component[0]) ?? []).includes(component[0]);
        if (component.length > 1 || selfEdge) {
            cycles.push(
                component
                    .slice()
                    .sort(
                        (left, right) =>
                            (indexByName.get(left) as number) - (indexByName.get(right) as number),
                    ),
            );
        }
    }

    return cycles;
}

/** The deepest `template` chain in a document, 1 when nothing templates anything. */
export function templateResolutionDepth(spec: AppSpec): number {
    const analysis = analyzeReferences(spec);
    return analysis.entries.reduce((deepest, entry) => Math.max(deepest, entry.depth), 1);
}

/**
 * Everything §21 says about one document: what resolves, what is secret, what
 * phase a value exists in, which `template` entries cycle, and how deep the
 * chains run.
 *
 * Deterministic by construction: entries are walked in document order, and a
 * problem is emitted at most once per (entry, code) for the entry-level codes
 * (`secret_reference_not_secret`, `phase_mismatch`) so a single pointer is never
 * reported twice (§22:511-513).
 */
export function analyzeReferences(
    spec: AppSpec,
    tables: AppSpecReferenceTables = buildReferenceTables(spec),
): AppSpecReferenceAnalysis {
    const envEntries = spec.env ?? [];
    const problems: AppSpecReferenceProblem[] = [];
    const cycles = findTemplateCycles(spec);
    const inCycle = new Set<string>();
    for (const cycle of cycles) for (const name of cycle) inCycle.add(name);

    // --- per-entry propagation -------------------------------------------------
    const readsByName = new Map<string, readonly string[]>();
    const phaseByName = new Map<string, AppSpecEnvPhase>();
    const declaredSecretByName = new Map<string, boolean>();
    const indexByName = new Map<string, number>();
    const seen = new Set<string>();

    envEntries.forEach((entry, index) => {
        if (entry?.name === undefined || entry?.name === null) return;
        if (seen.has(entry.name)) return;
        seen.add(entry.name);
        indexByName.set(entry.name, index);
        readsByName.set(entry.name, templateReads(entry));
        phaseByName.set(entry.name, envPhaseOf(entry));
        declaredSecretByName.set(entry.name, envEntryDeclaredSecret(entry));
    });

    // Secrecy propagates (§21:445-446) and a template cycle must not hang the
    // fixpoint: iterate at most once per entry.
    const secretByName = new Map<string, boolean>();
    for (const [name, declared] of declaredSecretByName) secretByName.set(name, declared);
    for (let pass = 0; pass < seen.size; pass += 1) {
        let changed = false;
        for (const [name, reads] of readsByName) {
            if (secretByName.get(name) === true) continue;
            const propagated = reads.some((read) => secretByName.get(read) === true);
            if (propagated) {
                secretByName.set(name, true);
                changed = true;
            }
        }
        if (!changed) break;
    }

    // Depth, over the acyclic remainder: a cycle member is an opaque leaf, so a
    // cycle reports as `template_cycle` and never as `template_too_deep` too.
    const depthCache = new Map<string, readonly string[]>();
    const chainOf = (name: string, visiting: Set<string>): readonly string[] => {
        const cached = depthCache.get(name);
        if (cached !== undefined) return cached;
        if (inCycle.has(name) || visiting.has(name)) return [name];
        visiting.add(name);
        let longest: readonly string[] = [];
        for (const read of readsByName.get(name) ?? []) {
            const chain = chainOf(read, visiting);
            if (chain.length > longest.length) longest = chain;
        }
        visiting.delete(name);
        const chain = [...longest, name];
        depthCache.set(name, chain);
        return chain;
    };

    // --- the problems, in document order --------------------------------------
    envEntries.forEach((entry, index) => {
        if (entry?.name === undefined || entry?.name === null) return;

        const secretSources: string[] = [];
        let firstSecret: string | null = null;
        let firstPhase: string | null = null;

        // `from:` — a bare Reference (§12:251).
        if (typeof entry.from === 'string') {
            const parse = tokenizeReference(entry.from);
            if (!parse.ok) {
                problems.push({
                    code: 'reference_syntax',
                    pointer: envPointer(index, 'from'),
                    params: { entry: entry.name, reference: parse.text },
                });
            } else {
                const reference = parse.reference as AppSpecReference;
                const resolution = resolveReference(reference, tables);
                if (!resolution.resolved) {
                    problems.push({
                        code: 'reference_unresolved',
                        pointer: envPointer(index, 'from'),
                        params: {
                            entry: entry.name,
                            reference: resolution.reference,
                            ...(resolution.needs === undefined ? {} : { needs: resolution.needs }),
                        },
                    });
                }
                if (resolution.secret) {
                    secretSources.push(resolution.reference);
                    if (firstSecret === null) firstSecret = resolution.reference;
                }
            }
        }

        // `template:` — literals and `{{ … }}` placeholders (§12:252).
        if (typeof entry.template === 'string') {
            for (const part of tokenizeTemplate(entry.template)) {
                if (part.kind === 'syntax') {
                    problems.push({
                        code: 'reference_syntax',
                        pointer: envPointer(index, 'template'),
                        params: {
                            entry: entry.name,
                            reference: (part as AppSpecTemplateSyntaxPart).text,
                        },
                    });
                    continue;
                }
                if (part.kind !== 'reference') continue;
                const reference = (part as AppSpecTemplateReferencePart).reference;

                if (reference.kind === 'env') {
                    const source = tables.env.get(reference.entry);
                    if (source === undefined) {
                        problems.push({
                            code: 'reference_unresolved',
                            pointer: envPointer(index, 'template'),
                            params: { entry: entry.name, reference: `env.${reference.entry}` },
                        });
                        continue;
                    }
                    // §21:441 — an entry cannot read itself.
                    if (reference.entry === entry.name) {
                        continue; // reported as the one-entry cycle below
                    }
                    if (secretByName.get(reference.entry) === true) {
                        secretSources.push(`env.${reference.entry}`);
                        if (firstSecret === null) firstSecret = `env.${reference.entry}`;
                    }
                    if (
                        firstPhase === null &&
                        !envPhasesCompatible(
                            envPhaseOf(entry),
                            phaseByName.get(reference.entry) as AppSpecEnvPhase,
                        )
                    ) {
                        firstPhase = `env.${reference.entry}`;
                    }
                    continue;
                }

                const resolution = resolveReference(reference, tables);
                if (!resolution.resolved) {
                    problems.push({
                        code: 'reference_unresolved',
                        pointer: envPointer(index, 'template'),
                        params: {
                            entry: entry.name,
                            reference: resolution.reference,
                            ...(resolution.needs === undefined ? {} : { needs: resolution.needs }),
                        },
                    });
                }
                if (resolution.secret) {
                    secretSources.push(resolution.reference);
                    if (firstSecret === null) firstSecret = resolution.reference;
                }
            }
        }

        // §21:445-446 — an entry that reads a secret must itself be secret.
        if (firstSecret !== null && entry.secret !== true) {
            problems.push({
                code: 'secret_reference_not_secret',
                pointer: envPointer(index, 'secret'),
                params: { entry: entry.name, reference: firstSecret },
            });
        }

        // §21:447-448 — phase propagates.
        if (firstPhase !== null) {
            problems.push({
                code: 'phase_mismatch',
                pointer: envPointer(index, 'template'),
                params: { entry: entry.name, reference: firstPhase },
            });
        }
    });

    // `build.args[].fromEnv` (§21:431, §21:442).
    (spec.build?.args ?? []).forEach((arg, index) => {
        if (typeof arg?.fromEnv !== 'string') return;
        const pointer = `${APP_SPEC_ISSUE_ROOT}/build/args/${index}/fromEnv`;
        const source = tables.env.get(arg.fromEnv);
        if (source === undefined) {
            problems.push({
                code: 'reference_unresolved',
                pointer,
                params: { argument: arg.name, reference: arg.fromEnv },
            });
            return;
        }
        const phase = phaseByName.get(arg.fromEnv) ?? envPhaseOf(source);
        if (phase === 'runtime') {
            problems.push({
                code: 'phase_mismatch',
                pointer,
                params: { argument: arg.name, reference: arg.fromEnv },
            });
        }
    });

    // Cycles, then depth (§21:448-449).
    for (const cycle of cycles) {
        const first = cycle[0];
        problems.push({
            code: 'template_cycle',
            pointer: envPointer(indexByName.get(first) as number, 'template'),
            params: { entries: cycle.join(', '), count: cycle.length, entry: first },
            entries: cycle,
        });
    }

    const entries: AppSpecEntryAnalysis[] = [];
    const byName = new Map<string, AppSpecEntryAnalysis>();
    envEntries.forEach((entry, index) => {
        if (entry?.name === undefined || entry?.name === null) return;
        const chain = inCycle.has(entry.name) ? [entry.name] : chainOf(entry.name, new Set());
        const analysis: AppSpecEntryAnalysis = {
            index,
            name: entry.name,
            phase: envPhaseOf(entry),
            declaredSecret: declaredSecretByName.get(entry.name) === true,
            secret: secretByName.get(entry.name) === true,
            reads: readsByName.get(entry.name) ?? [],
            depth: chain.length,
            chain,
        };
        entries.push(analysis);
        byName.set(entry.name, analysis);
    });

    for (const analysis of entries) {
        if (analysis.depth <= APP_SPEC_REFERENCE_MAX_DEPTH) continue;
        problems.push({
            code: 'template_too_deep',
            pointer: envPointer(analysis.index, 'template'),
            params: {
                entry: analysis.name,
                depth: analysis.depth,
                max: APP_SPEC_REFERENCE_MAX_DEPTH,
            },
        });
    }

    return { tables, entries, byName, cycles, problems };
}
