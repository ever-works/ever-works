'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircle, AlertTriangle, ExternalLink } from 'lucide-react';
import {
    buildAppSpecLineLink,
    type AppSpecIssue,
    type AppSpecSeverity,
    type WorkAppSpecLinks,
} from '@ever-works/contracts';

/**
 * APW-03 T17 — the App spec problems list (spec §6.2, `spec.md:577-584`;
 * FR-70, `spec.md:388-390`; plan §5.2, `plan.md:619`).
 *
 * ## The three claims FR-70 makes, and where each one lives
 *
 * 1. **Order** — errors before warnings, then by line. {@link sortAppSpecIssues}
 *    is the whole rule as a pure function: severity first, then `line`, then
 *    `column`, then the API's own order. An issue with no `line` (the caller
 *    validated an already-parsed object, so there are no YAML positions —
 *    `app-spec-issues.ts:136-138`) sorts **last within its severity** rather
 *    than first, because "no position" is not "line zero".
 * 2. **Content** — severity as **text and icon**, the display path,
 *    `line:column`, the message, the hint and **Open in repository** at the
 *    evaluated commit and line. Nothing here is conveyed by colour alone (FR-74).
 * 3. **Filtering** — by severity, with the counts the state row carries
 *    (`errorCount` / `warningCount`, which are the evaluation's own totals and
 *    may exceed the 200 issues the cap returns — hence the `truncated` note).
 *
 * ## The link is data, never a URL shape
 *
 * The href is `buildAppSpecLineLink(links, issue.line)`
 * (`packages/contracts/src/apps/work-app-spec.dto.ts:88-97`): the provider's own
 * file URL plus the provider's own `lineAnchor` hint — the web app never
 * assembles a provider URL (plan §4.3:578-580). An anchor-less provider, an
 * issue with no line, or an empty `base` (the API could not reach a provider)
 * all degrade to the file URL or to no link at all rather than to a broken one.
 *
 * ## The message is translated when a translation exists
 *
 * Plan §4.3:581-582: `issues[].message` and `hint` are the **English
 * fallbacks**, and the web renders
 * `dashboard.workDetail.settings.appSpec.issues.<camelCode>` when that key
 * exists. {@link issueCodeMessageKey} is the one place the code is camelCased,
 * and `t.has` is the check — so a code whose leaf T18 has not landed yet shows
 * the API's own sentence instead of a raw key path.
 */

/** Which severities the list shows (spec §6.2's three filter chips). */
export type AppSpecProblemFilter = 'all' | 'errors' | 'warnings';

/** The three filters in strip order; the `all` member is the default. */
export const APP_SPEC_PROBLEM_FILTERS = ['all', 'errors', 'warnings'] as const;

/** Errors first (FR-70). */
const SEVERITY_RANK = { error: 0, warning: 1 } as const satisfies Record<AppSpecSeverity, number>;

/**
 * `web_component_needs_port` → `issues.webComponentNeedsPort` (plan §8:770).
 *
 * The snake-to-camel conversion is deliberately the only transformation:
 * `sourceOfferMissing` is already camelCase in `APP_SPEC_ISSUE_CODES`
 * (`app-spec-issues.ts:21-24`) and passes through unchanged.
 */
export function issueCodeMessageKey(code: string): string {
    return `issues.${code.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())}`;
}

/** A position that sorts last: "no line" is not "line zero". */
function lineOf(issue: AppSpecIssue): number {
    return typeof issue.line === 'number' ? issue.line : Number.POSITIVE_INFINITY;
}

function columnOf(issue: AppSpecIssue): number {
    return typeof issue.column === 'number' ? issue.column : Number.POSITIVE_INFINITY;
}

/**
 * FR-70's order: errors before warnings, then by line, then by column, then the
 * API's own order. A stable sort would already keep the last tiebreak; the
 * explicit index makes it a property of this function rather than of the engine.
 */
export function sortAppSpecIssues(issues: readonly AppSpecIssue[]): AppSpecIssue[] {
    return issues
        .map((issue, index) => ({ issue, index }))
        .sort((a, b) => {
            const severity = SEVERITY_RANK[a.issue.severity] - SEVERITY_RANK[b.issue.severity];
            if (severity !== 0) {
                return severity;
            }

            const line = lineOf(a.issue) - lineOf(b.issue);
            if (line !== 0) {
                return line;
            }

            const column = columnOf(a.issue) - columnOf(b.issue);
            if (column !== 0) {
                return column;
            }

            return a.index - b.index;
        })
        .map((entry) => entry.issue);
}

/** The rows one filter shows, in FR-70's order. */
export function filterAppSpecIssues(
    issues: readonly AppSpecIssue[],
    filter: AppSpecProblemFilter,
): AppSpecIssue[] {
    const sorted = sortAppSpecIssues(issues);

    if (filter === 'all') {
        return sorted;
    }

    const wanted: AppSpecSeverity = filter === 'errors' ? 'error' : 'warning';
    return sorted.filter((issue) => issue.severity === wanted);
}

export interface AppSpecProblemsListProps {
    /** `state.issues ?? []` — the head evaluation's problems. */
    issues: readonly AppSpecIssue[];
    /** The evaluation's own error total (not necessarily `issues.length`). */
    errorCount: number;
    /** The evaluation's own warning total. */
    warningCount: number;
    /** `true` when the 200-issue cap cut the list (plan §8:765). */
    truncated: boolean;
    /** `state.links` — the file link and the provider's line anchor. */
    links: WorkAppSpecLinks;
}

export function AppSpecProblemsList({
    issues,
    errorCount,
    warningCount,
    truncated,
    links,
}: AppSpecProblemsListProps) {
    const t = useTranslations('dashboard.workDetail.settings.appSpec');
    const [filter, setFilter] = useState<AppSpecProblemFilter>('all');

    const visible = useMemo(() => filterAppSpecIssues(issues, filter), [issues, filter]);

    // A spec with no problems has no list: the banner is the whole answer, and
    // §6.2 gives no empty-state copy for this surface.
    if (issues.length === 0) {
        return null;
    }

    const counts: Record<AppSpecProblemFilter, number> = {
        all: errorCount + warningCount,
        errors: errorCount,
        warnings: warningCount,
    };

    const filterLabelKeys = {
        all: 'filterAll',
        errors: 'filterErrors',
        warnings: 'filterWarnings',
    } as const satisfies Record<AppSpecProblemFilter, string>;

    /**
     * One `issues.<camelCode>` leaf, read by name.
     *
     * `APP_SPEC_ISSUE_CODES` is append-only and a code can reach this page before
     * its copy does (plan §4.3:581-582: the API's `message` is the fallback the
     * web uses "when the key exists"), so the leaf **cannot** be a literal here —
     * it is built from the issue's own code at runtime. `apps/web/src/global.ts`
     * types every key against `messages/en.json`, so a runtime-built key widens
     * to `string`; the narrowing below is the price of that dynamic key, and
     * `t.has` keeps it a real check rather than a silent key path.
     */
    const issueCopy = t as unknown as {
        has: (key: string) => boolean;
        (key: string, values?: Record<string, string | number | boolean>): string;
    };

    return (
        <section data-testid="app-spec-problems" className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark">
                    {t('problemsTitle')}
                </h2>
                <div className="flex flex-wrap items-center gap-2" role="group">
                    {APP_SPEC_PROBLEM_FILTERS.map((candidate) => (
                        <button
                            key={candidate}
                            type="button"
                            data-testid={`app-spec-problem-filter-${candidate}`}
                            aria-pressed={filter === candidate}
                            onClick={() => setFilter(candidate)}
                            className={`rounded-md border px-2 py-1 text-xs font-medium ${
                                filter === candidate
                                    ? 'border-primary text-primary dark:border-gray-100 dark:text-gray-100'
                                    : 'border-card-border text-text-secondary dark:border-border-secondary-dark dark:text-text-secondary-dark'
                            }`}
                        >
                            {t(filterLabelKeys[candidate], { count: counts[candidate] })}
                        </button>
                    ))}
                </div>
            </div>

            {truncated && (
                <p
                    data-testid="app-spec-problems-truncated"
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                >
                    {t('problemsTruncated')}
                </p>
            )}

            <ul className="space-y-2">
                {visible.map((issue, index) => {
                    // An empty `base` means the API could not reach a provider
                    // for this Work, and the controller's own note says the row
                    // then "links to nothing rather than to a broken URL"
                    // (`work-app-spec.controller.ts:516-519`). It has to be
                    // decided **here**: `buildAppSpecLineLink` returns ``base``
                    // plus the anchor, so with an empty base it answers a bare
                    // `#L41` — a same-page fragment, not a link to a file.
                    const href = links.file.base ? buildAppSpecLineLink(links, issue.line) : '';
                    const messageKey = issueCodeMessageKey(issue.code);
                    const message = issueCopy.has(messageKey)
                        ? issueCopy(messageKey, issue.params ? { ...issue.params } : undefined)
                        : issue.message;
                    const position =
                        typeof issue.line === 'number'
                            ? `${issue.line}:${issue.column ?? 1}`
                            : null;
                    const isError = issue.severity === 'error';
                    const SeverityIcon = isError ? AlertCircle : AlertTriangle;

                    return (
                        <li
                            // An issue has no id of its own; the pointer plus its
                            // index is stable within one answer and unique across
                            // duplicates of the same pointer.
                            key={`${issue.pointer}:${index}`}
                            data-testid="app-spec-problem"
                            data-severity={issue.severity}
                            className="rounded-md border border-card-border px-3 py-2 dark:border-border-secondary-dark"
                        >
                            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                                <span
                                    data-testid="app-spec-problem-severity"
                                    className={`inline-flex items-center gap-1 font-semibold ${
                                        isError
                                            ? 'text-red-600 dark:text-red-400'
                                            : 'text-amber-600 dark:text-amber-400'
                                    }`}
                                >
                                    <SeverityIcon aria-hidden="true" className="h-3.5 w-3.5" />
                                    {isError ? t('severityError') : t('severityWarning')}
                                </span>
                                <span
                                    data-testid="app-spec-problem-path"
                                    className="font-mono text-text dark:text-text-dark"
                                >
                                    {issue.displayPath}
                                </span>
                                {position && (
                                    <span
                                        data-testid="app-spec-problem-position"
                                        className="font-mono text-text-muted dark:text-text-muted-dark"
                                    >
                                        {position}
                                    </span>
                                )}
                            </div>

                            <p
                                data-testid="app-spec-problem-message"
                                className="mt-1 text-sm text-text dark:text-text-dark"
                            >
                                {message}
                            </p>

                            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                                {issue.hint ? (
                                    <p
                                        data-testid="app-spec-problem-hint"
                                        className="text-xs text-text-secondary dark:text-text-secondary-dark"
                                    >
                                        {t('fixPrefix')} {issue.hint}
                                    </p>
                                ) : (
                                    <span />
                                )}

                                {href && (
                                    <a
                                        data-testid="app-spec-problem-link"
                                        href={href}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline dark:text-gray-100"
                                    >
                                        {t('openInRepository')}
                                        <ExternalLink aria-hidden="true" className="h-3 w-3" />
                                    </a>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
