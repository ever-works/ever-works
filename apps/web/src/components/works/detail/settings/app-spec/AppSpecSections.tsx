'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { APP_SPEC_BLOCK_DEFAULTS, type AppSpec, type AppSpecEnvEntry } from '@ever-works/contracts';

/**
 * APW-03 T17 — the App spec sections (FR-68, `spec.md:384-385`; FR-69,
 * `spec.md:386-387`; plan §5.2, `plan.md:620`; spec §6.2's section strip,
 * `spec.md:589`).
 *
 * ## What it renders
 *
 * One collapsible section per block FR-68 names, in the order §6.2's strip
 * writes them: **Source, Blueprint, License, Build, Components, Dependencies,
 * Env, Jobs, Cron, Domains, Smoke tests, Checks, Agents and Upstream**, with the
 * declared count of the list-shaped ones (`Components (1)`, `Env (11)`) and the
 * default marker of the fields that have a literal default. Sections with
 * nothing declared are not rendered at all — a spec that declares only `build`
 * and `components` should not put twelve empty headings on the page.
 *
 * The **License** section is the spec's own declared `license` block. The
 * detected licence, its class, eligibility and the attestation are the
 * `AppLicenseCard` below/above it, which is T45's slot on this page, and this
 * component deliberately does not duplicate them.
 *
 * ## The `default` marker comes from the contract's own map
 *
 * Plan §5.2:620 fixes the source: `APP_SPEC_BLOCK_DEFAULTS` in
 * `packages/contracts/src/apps/app-spec.types.ts:1009` — the documented literal
 * default of every App-spec field that has one, keyed by path. A leaf whose value
 * **equals** its documented default is marked `default`, because the file did not
 * have to write it (schema.md §0: defaults are documented and never written
 * back). Relative defaults stay out of that map and therefore stay unmarked —
 * never guessed here.
 *
 * ## Env is the one section with its own shape (FR-69)
 *
 * Env lists **names, the secret flag, the phase and the source kind only**, and
 * a non-secret literal value truncated at {@link ENV_LITERAL_VALUE_MAX}
 * characters. The six source-kind labels are §6.2's own six (`Generated once`,
 * `From {reference}`, `Template`, `Asked at setup`, `Fixed value`, `Secret`), and
 * `envSecret` is the flag chip rather than a sixth source: a `secret: true`
 * entry still says how its value arrives.
 */

/** The 14 sections of FR-68, in the order §6.2's strip shows them. */
export const APP_SPEC_SECTION_KEYS = [
    'source',
    'blueprint',
    'license',
    'build',
    'components',
    'dependencies',
    'env',
    'jobs',
    'cron',
    'domains',
    'smoke',
    'checks',
    'agents',
    'upstream',
] as const;

export type AppSpecSectionKey = (typeof APP_SPEC_SECTION_KEYS)[number];

/** The translator this component reads with (see the renderer maps below). */
type AppSpecTranslator = ReturnType<
    typeof useTranslations<'dashboard.workDetail.settings.appSpec'>
>;

/**
 * The section headings' message keys.
 *
 * **Gap, named rather than silenced:** plan §8 (`plan.md:746-772`) allocates
 * `status*`, `problems*`, `severity*`, `fixPrefix`, `defaultMarker`, the `env*`
 * kind labels and `issues.<camelCode>` — and **no leaf for the fourteen section
 * headings FR-68 requires**. They are read here as `sections.<key>` so that
 * FR-74 (every string translatable) is satisfied the moment T18 lands them; T18's
 * message spec, which asserts every key the P1 components read exists in every
 * locale, is the check that will surface them. See this task's report.
 */
export const APP_SPEC_SECTION_LABEL_KEYS = {
    source: 'sections.source',
    blueprint: 'sections.blueprint',
    license: 'sections.license',
    build: 'sections.build',
    components: 'sections.components',
    dependencies: 'sections.dependencies',
    env: 'sections.env',
    jobs: 'sections.jobs',
    cron: 'sections.cron',
    domains: 'sections.domains',
    smoke: 'sections.smoke',
    checks: 'sections.checks',
    agents: 'sections.agents',
    upstream: 'sections.upstream',
} as const satisfies Record<AppSpecSectionKey, string>;

/**
 * How much of a non-secret literal `env[].value` is shown (FR-69: "non-secret
 * literal values MUST be truncated at 80 characters").
 */
export const ENV_LITERAL_VALUE_MAX = 80;

/** FR-69's truncation, with an ellipsis so a cut value never reads as complete. */
export function truncateEnvValue(value: string): string {
    return value.length <= ENV_LITERAL_VALUE_MAX
        ? value
        : `${value.slice(0, ENV_LITERAL_VALUE_MAX)}…`;
}

/** The five value sources of an `env[]` entry (schema.md §12:239-311, exactly one). */
export type AppSpecEnvSourceKind = 'generate' | 'from' | 'template' | 'prompt' | 'value';

/** §6.2's six labels, the five sources plus the secret flag. */
export const ENV_SOURCE_KIND_KEYS = {
    generate: 'envGenerated',
    from: 'envFrom',
    template: 'envTemplate',
    prompt: 'envPrompt',
    value: 'envValue',
} as const satisfies Record<AppSpecEnvSourceKind, string>;

/**
 * The same five labels, rendered.
 *
 * A renderer map for the reason `AppSpecStatusBanner`'s own map records:
 * `apps/web/src/global.ts:4-9` types every key against `messages/en.json`, and a
 * dynamically indexed key widens to `string` — which the type gate rejects. Each
 * entry calls `t` with the literal leaf, and only `envFrom` carries the
 * `{reference}` its sentence declares.
 */
const ENV_SOURCE_KIND_LABELS = {
    generate: (t) => t(ENV_SOURCE_KIND_KEYS.generate),
    from: (t, entry) => t(ENV_SOURCE_KIND_KEYS.from, { reference: entry.from ?? '' }),
    template: (t) => t(ENV_SOURCE_KIND_KEYS.template),
    prompt: (t) => t(ENV_SOURCE_KIND_KEYS.prompt),
    value: (t) => t(ENV_SOURCE_KIND_KEYS.value),
} satisfies Record<AppSpecEnvSourceKind, (t: AppSpecTranslator, entry: AppSpecEnvEntry) => string>;

/**
 * Which source an `env[]` entry declares, or `null` when it declares none (which
 * the validator reports as `env_source_count`, so it is a real input to render).
 * The order is the contract's own list of the five mutually exclusive fields
 * (`app-spec.types.ts:700-718`); an entry can only ever match one.
 */
export function envEntrySourceKind(entry: AppSpecEnvEntry): AppSpecEnvSourceKind | null {
    if (entry.generate) return 'generate';
    if (entry.from) return 'from';
    if (entry.template) return 'template';
    if (entry.prompt) return 'prompt';
    if (typeof entry.value === 'string') return 'value';
    return null;
}

/**
 * Whether one leaf equals its documented default — `true` ⇒ the row is marked
 * `default`. The path is normalised to the map's own notation first
 * (`components[0].replicas` → `components[].replicas`).
 */
export function isAppSpecDefault(path: string, value: unknown): boolean {
    const normalised = path.replace(/\[\d+\]/g, '[]');
    if (!Object.prototype.hasOwnProperty.call(APP_SPEC_BLOCK_DEFAULTS, normalised)) {
        return false;
    }

    const documented = APP_SPEC_BLOCK_DEFAULTS[normalised];
    if (Array.isArray(documented)) {
        return Array.isArray(value) && JSON.stringify(documented) === JSON.stringify(value);
    }

    return documented === value;
}

/** One rendered leaf of a section. */
export interface AppSpecSectionRow {
    /** `components[0].replicas` — the path the default map is keyed by. */
    path: string;
    /** What the row is called: the key, or a named entry's own `name`. */
    label: string;
    /** A scalar, or JSON for the structured values a section may hold. */
    value: string;
    /** `true` when the value equals its documented default. */
    isDefault: boolean;
}

/** How deep the flattener walks before it prints a subtree as JSON. */
const MAX_ROW_DEPTH = 4;

function scalarText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value === null) return 'null';
    return JSON.stringify(value) ?? String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLeaf(value: unknown): boolean {
    return !Array.isArray(value) && !isPlainObject(value);
}

/**
 * A block → the rows the section renders, depth-first, with array indexes in the
 * path (`components[0].replicas`) and an entry's own `name` as its label where it
 * has one, so a row reads `web` rather than `components[0]`.
 */
export function appSpecSectionRows(value: unknown, path = '', depth = 0): AppSpecSectionRow[] {
    if (depth >= MAX_ROW_DEPTH || isLeaf(value)) {
        return [
            {
                path,
                label: path,
                value: scalarText(value),
                isDefault: isAppSpecDefault(path, value),
            },
        ];
    }

    const rows: AppSpecSectionRow[] = [];

    if (Array.isArray(value)) {
        value.forEach((entry, index) => {
            const childPath = `${path}[${index}]`;
            if (isLeaf(entry)) {
                rows.push({
                    path: childPath,
                    label: childPath,
                    value: scalarText(entry),
                    isDefault: isAppSpecDefault(childPath, entry),
                });
                return;
            }

            const named =
                isPlainObject(entry) && typeof entry.name === 'string' ? entry.name : null;
            rows.push({
                path: childPath,
                label: named ? `${childPath} · ${named}` : childPath,
                value: '',
                isDefault: false,
            });
            rows.push(...appSpecSectionRows(entry, childPath, depth + 1));
        });

        return rows;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childPath = path ? `${path}.${key}` : key;
        if (isLeaf(child)) {
            rows.push({
                path: childPath,
                label: childPath,
                value: scalarText(child),
                isDefault: isAppSpecDefault(childPath, child),
            });
            continue;
        }

        rows.push(...appSpecSectionRows(child, childPath, depth + 1));
    }

    return rows;
}

/** The block behind one section — `upstream` is the one section of two blocks. */
export function appSpecSectionValue(spec: AppSpec, key: AppSpecSectionKey): unknown {
    if (key === 'upstream') {
        const upstream = {
            ...(spec.upstreamSync ? { upstreamSync: spec.upstreamSync } : {}),
            ...(spec.upstreamPullRequests
                ? { upstreamPullRequests: spec.upstreamPullRequests }
                : {}),
        };
        return Object.keys(upstream).length > 0 ? upstream : undefined;
    }

    return (spec as Record<string, unknown>)[key];
}

/** Nothing declared ⇒ no section (see this module's header). */
function isEmptyBlock(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (isPlainObject(value)) return Object.keys(value).length === 0;
    return false;
}

/** §6.2 shows a count for the list-shaped sections and for Dependencies. */
export function appSpecSectionCount(key: AppSpecSectionKey, value: unknown): number | null {
    if (Array.isArray(value)) {
        return value.length;
    }
    if (key === 'dependencies' && isPlainObject(value)) {
        return Object.keys(value).length;
    }
    return null;
}

export interface AppSpecSectionsProps {
    /** `state.effectiveSpec` — the last zero-error evaluation's spec (FR-20). */
    spec: AppSpec | null;
}

export function AppSpecSections({ spec }: AppSpecSectionsProps) {
    const t = useTranslations('dashboard.workDetail.settings.appSpec');
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});

    const sections = useMemo(() => {
        if (!spec) {
            return [];
        }

        return APP_SPEC_SECTION_KEYS.map((key) => {
            const value = appSpecSectionValue(spec, key);
            return { key, value };
        }).filter((section) => !isEmptyBlock(section.value));
    }, [spec]);

    if (!spec || sections.length === 0) {
        return null;
    }

    const toggle = (key: AppSpecSectionKey) => {
        setExpanded((current) => ({ ...current, [key]: !current[key] }));
    };

    return (
        <section data-testid="app-spec-sections" className="space-y-2">
            {sections.map(({ key, value }) => {
                const isOpen = expanded[key] === true;
                const count = appSpecSectionCount(key, value);
                // Collapsed sections flatten nothing: the rows are only built for
                // the section a member has opened, and Env renders its own shape.
                const rows = isOpen && key !== 'env' ? appSpecSectionRows(value, '') : [];

                return (
                    <div
                        key={key}
                        data-testid={`app-spec-section-${key}`}
                        className="rounded-md border border-card-border dark:border-border-secondary-dark"
                    >
                        <button
                            type="button"
                            data-testid={`app-spec-section-toggle-${key}`}
                            aria-expanded={isOpen}
                            onClick={() => toggle(key)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-text hover:bg-surface-hover dark:text-text-dark dark:hover:bg-surface-hover-dark"
                        >
                            {isOpen ? (
                                <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0" />
                            ) : (
                                <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0" />
                            )}
                            <span>{t(APP_SPEC_SECTION_LABEL_KEYS[key])}</span>
                            {count !== null && (
                                <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                    ({count})
                                </span>
                            )}
                        </button>

                        {isOpen && key === 'env' && (
                            <ul data-testid="app-spec-env-list" className="space-y-1 px-3 pb-3">
                                {(value as readonly AppSpecEnvEntry[]).map((entry) => {
                                    const sourceKind = envEntrySourceKind(entry);
                                    const showsLiteral =
                                        sourceKind === 'value' &&
                                        entry.secret !== true &&
                                        typeof entry.value === 'string';

                                    return (
                                        <li
                                            key={entry.name}
                                            data-testid="app-spec-env-entry"
                                            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
                                        >
                                            <span className="font-mono text-text dark:text-text-dark">
                                                {entry.name}
                                            </span>
                                            {sourceKind && (
                                                <span className="text-text-secondary dark:text-text-secondary-dark">
                                                    {ENV_SOURCE_KIND_LABELS[sourceKind](t, entry)}
                                                </span>
                                            )}
                                            {entry.secret === true && (
                                                <span
                                                    data-testid="app-spec-env-secret"
                                                    className="rounded border border-card-border px-1 dark:border-border-secondary-dark"
                                                >
                                                    {t('envSecret')}
                                                </span>
                                            )}
                                            <span className="font-mono text-text-muted dark:text-text-muted-dark">
                                                {entry.phase ?? 'runtime'}
                                            </span>
                                            {showsLiteral && (
                                                <span className="font-mono text-text-secondary dark:text-text-secondary-dark">
                                                    {truncateEnvValue(entry.value as string)}
                                                </span>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}

                        {isOpen && key !== 'env' && (
                            <dl data-testid="app-spec-section-rows" className="space-y-1 px-3 pb-3">
                                {rows.map((row) => (
                                    <div
                                        key={row.path}
                                        data-testid="app-spec-section-row"
                                        data-default={row.isDefault}
                                        className="flex flex-wrap items-baseline gap-x-3 text-xs"
                                    >
                                        <dt className="font-mono text-text-secondary dark:text-text-secondary-dark">
                                            {row.label}
                                        </dt>
                                        {row.value !== '' && (
                                            <dd className="font-mono text-text dark:text-text-dark">
                                                {row.value}
                                            </dd>
                                        )}
                                        {row.isDefault && (
                                            <dd
                                                data-testid="app-spec-default-marker"
                                                className="rounded border border-card-border px-1 text-text-muted dark:border-border-secondary-dark dark:text-text-muted-dark"
                                            >
                                                {t('defaultMarker')}
                                            </dd>
                                        )}
                                    </div>
                                ))}
                            </dl>
                        )}
                    </div>
                );
            })}
        </section>
    );
}
