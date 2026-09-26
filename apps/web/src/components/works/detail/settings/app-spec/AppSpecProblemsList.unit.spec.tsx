import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { AppSpecIssue, WorkAppSpecLinks } from '@ever-works/contracts';
import {
    APP_SPEC_PROBLEM_FILTERS,
    AppSpecProblemsList,
    filterAppSpecIssues,
    issueCodeMessageKey,
    sortAppSpecIssues,
} from './AppSpecProblemsList';

/**
 * APW-03 T17 (ACC-03-40) — the App spec problems list.
 *
 * ## What this spec proves
 *
 * FR-70's three claims, each as its own assertion: **order** (errors before
 * warnings, then by line, then by column, with a position-less issue last within
 * its severity), **content** (severity as text and icon, display path,
 * `line:column`, message, `Fix:` hint) and **filtering** (the three chips, with
 * the evaluation's own counts) — plus the link ACC-03-40 names: every row links
 * to **the evaluated commit and line**, built from `links.file` +
 * `links.lineAnchor` and never from a URL shape this app knows.
 *
 * ## Why the copy is a fixture rather than `messages/en.json`
 *
 * T18 lands this namespace in the 21 locale files. Until it does, the real
 * catalogue has no `dashboard.workDetail.settings.appSpec` leaves, and every
 * assertion would be against a rendered key path instead of the sentence a
 * member reads. The fixture is spec §6.2's copy verbatim (`spec.md:577-584`), and
 * it deliberately carries **two** `issues.<camelCode>` leaves and not a third —
 * so the third row proves plan §4.3:581's fallback: a code with no translation
 * leaf yet shows the API's own English `message`, never a raw key.
 */

/** Spec §6.2's copy for this surface, verbatim, plus two issue leaves. */
const APP_SPEC_COPY = {
    problemsTitle: 'Problems',
    filterAll: 'All ({count})',
    filterErrors: 'Errors ({count})',
    filterWarnings: 'Warnings ({count})',
    problemsTruncated: 'Showing the first 200 problems.',
    severityError: 'Error',
    severityWarning: 'Warning',
    fixPrefix: 'Fix:',
    openInRepository: 'Open in repository',
    issues: {
        unknownField: 'Unknown field `replica`. Did you mean `replicas`?',
        webComponentNeedsPort: 'Web components must declare the port they listen on.',
    },
};

const messages = {
    dashboard: { workDetail: { settings: { appSpec: APP_SPEC_COPY } } },
};

/**
 * The same bundle with **no** `issues.<camelCode>` leaves at all — the state a
 * code lands in before T18 translates it (`messages/en.json` carries the block
 * without an `issues` tree today). Held in a variable rather than inlined so the
 * extra key is not an excess-property error against the catalogue's own type.
 */
const MESSAGES_WITHOUT_ISSUE_COPY = {
    dashboard: { workDetail: { settings: { appSpec: { ...APP_SPEC_COPY, issues: {} } } } },
};

const COMMIT = '4f1c2ab999999999999999999999999999999999';
const FILE_URL = `https://github.com/acme/app/blob/${COMMIT}/.works/works.yml`;

const links: WorkAppSpecLinks = {
    file: { base: FILE_URL, commitSha: COMMIT, path: '.works/works.yml' },
    lineAnchor: '#L{line}',
};

function issue(over: Partial<AppSpecIssue> = {}): AppSpecIssue {
    return {
        code: 'unknown_field',
        severity: 'error',
        path: 'spec.components[0].replica',
        pointer: '/spec/components/0/replica',
        displayPath: 'components › web › replica',
        line: 41,
        column: 7,
        message: 'Unknown field `replica`. Did you mean `replicas`?',
        hint: 'rename it to `replicas`.',
        ...over,
    };
}

/** The §6.2 mock's own two errors, out of order on purpose. */
const REPLICA = issue();
const PORT = issue({
    code: 'web_component_needs_port',
    path: 'spec.components[0].port',
    pointer: '/spec/components/0/port',
    displayPath: 'components › web › port',
    line: 38,
    column: 5,
    message: 'Web components must declare the port they listen on.',
    hint: 'add `port: <number>` under `web`.',
});

/** A warning above both errors in the file, and one with no position at all. */
const ADVISORY = issue({
    code: 'advisory_check',
    severity: 'warning',
    displayPath: 'checks › lint',
    line: 1,
    column: 1,
    message: 'This check only advises.',
    hint: undefined,
});
const POSITIONLESS = issue({
    code: 'image_not_pinned',
    severity: 'warning',
    displayPath: 'components › web › image',
    line: undefined,
    column: undefined,
    message: 'Pin the image to a digest.',
    hint: undefined,
});

const ALL_FOUR = [REPLICA, ADVISORY, PORT, POSITIONLESS];

function renderList(over: Partial<Parameters<typeof AppSpecProblemsList>[0]> = {}) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <AppSpecProblemsList
                issues={ALL_FOUR}
                errorCount={2}
                warningCount={2}
                truncated={false}
                links={links}
                {...over}
            />
        </NextIntlClientProvider>,
    );
}

/** The rendered rows, in DOM order, as the three facts each row shows. */
function rows() {
    return screen.queryAllByTestId('app-spec-problem').map((row) => ({
        severity: row.dataset.severity ?? '',
        path: within(row).getByTestId('app-spec-problem-message').textContent ?? '',
        displayPath: within(row).getByTestId('app-spec-problem-path').textContent ?? '',
        position: within(row).queryByTestId('app-spec-problem-position')?.textContent ?? null,
        href: within(row).queryByTestId('app-spec-problem-link')?.getAttribute('href') ?? null,
    }));
}

const paths = () => rows().map((row) => row.displayPath);

describe('AppSpecProblemsList — order (FR-70)', () => {
    it('orders errors before warnings, then by line', () => {
        renderList();

        // PORT (error, line 38) → REPLICA (error, line 41) → ADVISORY (warning,
        // line 1) → POSITIONLESS (warning, no line): the warning on line 1 comes
        // *after* both errors, which is what "errors first" means.
        expect(paths()).toEqual([
            'components › web › port',
            'components › web › replica',
            'checks › lint',
            'components › web › image',
        ]);
    });

    it('sorts a position-less issue last within its severity, never first', () => {
        const sorted = sortAppSpecIssues([POSITIONLESS, ADVISORY]);

        expect(sorted.map((entry) => entry.displayPath)).toEqual([
            'checks › lint',
            'components › web › image',
        ]);
    });

    it('breaks a line tie by column, then keeps the API’s own order', () => {
        const second = issue({ displayPath: 'a › second', line: 7, column: 9 });
        const first = issue({ displayPath: 'a › first', line: 7, column: 2 });
        const sameColumn = issue({ displayPath: 'a › third', line: 7, column: 9 });

        const sorted = sortAppSpecIssues([second, first, sameColumn]);

        expect(sorted.map((entry) => entry.displayPath)).toEqual([
            'a › first',
            'a › second',
            'a › third',
        ]);
    });

    it('does not mutate the array it was given', () => {
        const input = [REPLICA, ADVISORY, PORT, POSITIONLESS];
        const before = [...input];

        sortAppSpecIssues(input);

        expect(input).toEqual(before);
    });
});

describe('AppSpecProblemsList — filtering (FR-70)', () => {
    it('offers All, Errors and Warnings with the evaluation’s own counts', () => {
        renderList();

        expect(screen.getByTestId('app-spec-problem-filter-all')).toHaveTextContent('All (4)');
        expect(screen.getByTestId('app-spec-problem-filter-errors')).toHaveTextContent(
            'Errors (2)',
        );
        expect(screen.getByTestId('app-spec-problem-filter-warnings')).toHaveTextContent(
            'Warnings (2)',
        );
    });

    it('filters to errors only, and to warnings only', () => {
        renderList();

        fireEvent.click(screen.getByTestId('app-spec-problem-filter-errors'));

        expect(paths()).toEqual(['components › web › port', 'components › web › replica']);
        expect(screen.getByTestId('app-spec-problem-filter-errors')).toHaveAttribute(
            'aria-pressed',
            'true',
        );

        fireEvent.click(screen.getByTestId('app-spec-problem-filter-warnings'));

        expect(paths()).toEqual(['checks › lint', 'components › web › image']);
    });

    it('returns to every problem through All', () => {
        renderList();

        fireEvent.click(screen.getByTestId('app-spec-problem-filter-warnings'));
        fireEvent.click(screen.getByTestId('app-spec-problem-filter-all'));

        expect(rows()).toHaveLength(4);
    });

    it('names the three filters in one place, `all` first', () => {
        expect(APP_SPEC_PROBLEM_FILTERS).toEqual(['all', 'errors', 'warnings']);
        expect(filterAppSpecIssues(ALL_FOUR, 'errors')).toHaveLength(2);
        expect(filterAppSpecIssues(ALL_FOUR, 'warnings')).toHaveLength(2);
        expect(filterAppSpecIssues(ALL_FOUR, 'all')).toHaveLength(4);
    });

    it('renders no list at all when the spec has no problems', () => {
        renderList({ issues: [], errorCount: 0, warningCount: 0 });

        expect(screen.queryByTestId('app-spec-problems')).not.toBeInTheDocument();
    });

    it('says the list was cut at the 200-issue cap', () => {
        renderList({ truncated: true });

        expect(screen.getByTestId('app-spec-problems-truncated')).toHaveTextContent(
            'Showing the first 200 problems.',
        );
    });
});

describe('AppSpecProblemsList — content and the link (FR-70, ACC-03-40)', () => {
    it('shows severity as text and icon, the display path, `line:column`, the message and the Fix hint', () => {
        renderList({ issues: [REPLICA], errorCount: 1, warningCount: 0 });

        const row = screen.getByTestId('app-spec-problem');

        expect(within(row).getByTestId('app-spec-problem-severity')).toHaveTextContent('Error');
        expect(
            within(row).getByTestId('app-spec-problem-severity').querySelector('svg'),
        ).not.toBeNull();
        expect(row).toHaveTextContent('components › web › replica');
        expect(within(row).getByTestId('app-spec-problem-position')).toHaveTextContent('41:7');
        expect(within(row).getByTestId('app-spec-problem-message')).toHaveTextContent(
            'Unknown field `replica`. Did you mean `replicas`?',
        );
        expect(within(row).getByTestId('app-spec-problem-hint')).toHaveTextContent(
            'Fix: rename it to `replicas`.',
        );
    });

    it('renders the Warning text for a warning, and no Fix line when the issue has no hint', () => {
        renderList({ issues: [ADVISORY], errorCount: 0, warningCount: 1 });

        const row = screen.getByTestId('app-spec-problem');

        expect(within(row).getByTestId('app-spec-problem-severity')).toHaveTextContent('Warning');
        expect(within(row).queryByTestId('app-spec-problem-hint')).not.toBeInTheDocument();
    });

    it('links every row to the evaluated commit and the issue’s line', () => {
        renderList();

        expect(rows().map((row) => row.href)).toEqual([
            `${FILE_URL}#L38`,
            `${FILE_URL}#L41`,
            `${FILE_URL}#L1`,
            // No line ⇒ the file at the evaluated commit, never a broken anchor.
            FILE_URL,
        ]);
        expect(screen.getAllByTestId('app-spec-problem-link')[0]).toHaveAttribute(
            'target',
            '_blank',
        );
    });

    it('links to the file when the provider offers no line anchor', () => {
        renderList({ links: { ...links, lineAnchor: null } });

        expect(rows()[0].href).toBe(FILE_URL);
    });

    it('renders no link at all when the API could not build one (empty base)', () => {
        renderList({
            links: {
                file: { base: '', commitSha: COMMIT, path: '.works/works.yml' },
                lineAnchor: '#L{line}',
            },
        });

        expect(screen.queryByTestId('app-spec-problem-link')).not.toBeInTheDocument();
    });

    it('falls back to the API’s own English message when a code has no translation leaf', () => {
        renderList({ issues: [POSITIONLESS], errorCount: 0, warningCount: 1 });

        expect(screen.getByTestId('app-spec-problem-message')).toHaveTextContent(
            'Pin the image to a digest.',
        );
    });

    it('camelCases a snake_case code into its leaf name, leaving a camelCase code alone', () => {
        expect(issueCodeMessageKey('web_component_needs_port')).toBe(
            'issues.webComponentNeedsPort',
        );
        expect(issueCodeMessageKey('unknown_field_newer_version')).toBe(
            'issues.unknownFieldNewerVersion',
        );
        expect(issueCodeMessageKey('sourceOfferMissing')).toBe('issues.sourceOfferMissing');
    });

    it('shows a translated row and an untranslated row side by side, each in its own words', () => {
        renderList({ issues: [REPLICA, POSITIONLESS], errorCount: 1, warningCount: 1 });

        const messagesShown = screen
            .getAllByTestId('app-spec-problem-message')
            .map((node) => node.textContent);

        expect(messagesShown).toEqual([
            'Unknown field `replica`. Did you mean `replicas`?',
            'Pin the image to a digest.',
        ]);

        cleanup();

        // The same two rows with the leaf *absent*: the translated row falls back
        // to the API's message too, so nothing ever renders a raw key path.
        render(
            <NextIntlClientProvider
                locale="en"
                messages={MESSAGES_WITHOUT_ISSUE_COPY}
                timeZone="UTC"
            >
                <AppSpecProblemsList
                    issues={[REPLICA]}
                    errorCount={1}
                    warningCount={0}
                    truncated={false}
                    links={links}
                />
            </NextIntlClientProvider>,
        );

        expect(screen.getByTestId('app-spec-problem-message')).toHaveTextContent(
            'Unknown field `replica`. Did you mean `replicas`?',
        );
    });
});
