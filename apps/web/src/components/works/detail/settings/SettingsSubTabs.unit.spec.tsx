import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { WORK_KINDS } from '@ever-works/contracts';

/**
 * APW-03 T16 (ACC-03-39) — the Settings sub-tab strip.
 *
 * Two claims, and nothing else:
 *
 *  1. A **fourth** tab, App spec, is present for an App Work and absent for
 *     every other kind — `website` explicitly (ACC-03-39), the rest of
 *     `WORK_KINDS` by enumeration, plus an unrecognised kind the server could
 *     ship without a web deploy (the union is deliberately open).
 *  2. The **three existing tabs render unchanged** for every kind, and exactly
 *     one tab is active at a time — General's `isActive` excludes
 *     `/settings/app-spec` just as it already excluded `/settings/members` and
 *     `/settings/budgets-usage`.
 *
 * What decides the fourth tab is the Work's `kind`, read from
 * `useWorkDetail()` — the same source `WorkTabs` reads for its Upstream tab.
 * The mocks below hand the component a Work whose kind each case sets, and a
 * pathname, so both claims are exercised through the real component.
 */

const state = vi.hoisted(() => ({
    kind: 'website' as string | undefined,
    pathname: '/works/w1/settings',
    canManageMembers: true,
}));

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@/i18n/navigation', () => ({
    usePathname: () => state.pathname,
}));
vi.mock('next/link', () => ({
    default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
        <a href={typeof href === 'string' ? href : ''} {...rest}>
            {children}
        </a>
    ),
}));
// Every role-based gate is opened by default, so the only thing deciding the
// fourth tab's visibility in these specs is the Work's kind.
vi.mock('../WorkDetailContext', () => ({
    useWorkDetail: () => ({ work: { id: 'w1', name: 'Platform', kind: state.kind } }),
    useWorkPermissions: () => ({ canManageMembers: state.canManageMembers }),
}));

import { SettingsSubTabs } from './SettingsSubTabs';

const T = 'dashboard.workDetail.settings.tabs';

const HREF = {
    general: '/works/w1/settings',
    members: '/works/w1/settings/members',
    budgets: '/works/w1/settings/budgets-usage',
    appSpec: '/works/w1/settings/app-spec',
} as const;

const LABEL = {
    general: `${T}.general`,
    members: `${T}.members`,
    budgets: `${T}.budgets`,
    appSpec: `${T}.appSpec`,
} as const;

/** The three tabs that existed before APW-03 T16, in their rendered order. */
const EXISTING_TABS = [
    { label: LABEL.general, href: HREF.general },
    { label: LABEL.members, href: HREF.members },
    { label: LABEL.budgets, href: HREF.budgets },
];

type TabRow = { label: string; href: string; active: boolean };

/** The rendered tab strip, in DOM order, read through the component's own markup. */
function tabRows(): TabRow[] {
    const nav = screen.getByRole('navigation', { name: `${T}.navigationLabel` });
    return within(nav)
        .getAllByRole('link')
        .map((link) => ({
            label: link.textContent ?? '',
            href: link.getAttribute('href') ?? '',
            active: link.getAttribute('data-active') === 'true',
        }));
}

function renderTabs(overrides: {
    kind?: string | undefined;
    pathname?: string;
    canManageMembers?: boolean;
}): TabRow[] {
    state.kind = 'kind' in overrides ? overrides.kind : 'website';
    state.pathname = overrides.pathname ?? '/works/w1/settings';
    state.canManageMembers = overrides.canManageMembers ?? true;

    render(<SettingsSubTabs workId="w1" />);

    return tabRows();
}

const labels = (rows: TabRow[]) => rows.map((row) => row.label);
const activeLabels = (rows: TabRow[]) => rows.filter((row) => row.active).map((row) => row.label);

/** Every kind the vocabulary knows, minus `app` — `app` is asserted on its own. */
const OTHER_KINDS = WORK_KINDS.filter((kind) => kind !== 'app');

describe('SettingsSubTabs — the App spec tab (ACC-03-39)', () => {
    it('offers the App spec tab for an App Work, linking to the App spec route', () => {
        const rows = renderTabs({ kind: 'app' });

        expect(rows).toEqual([
            ...EXISTING_TABS.map((tab) => ({ ...tab, active: tab.label === LABEL.general })),
            { label: LABEL.appSpec, href: HREF.appSpec, active: false },
        ]);
    });

    it('withholds it for a website Work', () => {
        const rows = renderTabs({ kind: 'website' });

        expect(labels(rows)).toEqual([LABEL.general, LABEL.members, LABEL.budgets]);
        expect(screen.queryByText(LABEL.appSpec)).not.toBeInTheDocument();
    });

    it.each<[string]>(OTHER_KINDS.map((kind) => [kind]))(
        'withholds it for kind %s, rendering exactly the three existing tabs',
        (kind) => {
            const rows = renderTabs({ kind });

            expect(rows).toEqual(
                EXISTING_TABS.map((tab) => ({ ...tab, active: tab.label === LABEL.general })),
            );
        },
    );

    it('withholds it for an unrecognised kind the server could ship without a web deploy', () => {
        const rows = renderTabs({ kind: 'some-future-kind' });

        expect(labels(rows)).toEqual([LABEL.general, LABEL.members, LABEL.budgets]);
    });

    it('withholds it when the Work carries no kind at all', () => {
        // `Work.kind` is an OPTIONAL string in the web's own read model
        // (`lib/api/work.ts:104`), so `undefined` is a real input and must
        // render the three tabs rather than throw.
        const rows = renderTabs({ kind: undefined });

        expect(labels(rows)).toEqual([LABEL.general, LABEL.members, LABEL.budgets]);
    });
});

describe('SettingsSubTabs — the three existing tabs are unchanged', () => {
    it.each<[string]>(WORK_KINDS.map((kind) => [kind]))(
        'renders General, Members and Budgets with their own hrefs for kind %s',
        (kind) => {
            const rows = renderTabs({ kind });

            for (const existing of EXISTING_TABS) {
                const row = rows.find((candidate) => candidate.label === existing.label);

                expect(row, `${existing.label} must be rendered for kind ${kind}`).toBeDefined();
                expect(row?.href).toBe(existing.href);
            }
        },
    );

    it('still withholds the Members tab when the caller cannot manage members', () => {
        const rows = renderTabs({ kind: 'app', canManageMembers: false });

        expect(labels(rows)).toEqual([LABEL.general, LABEL.budgets, LABEL.appSpec]);
    });
});

describe('SettingsSubTabs — exactly one tab is active at a time', () => {
    it.each([
        ['/works/w1/settings', LABEL.general],
        ['/works/w1/settings/', LABEL.general],
        ['/works/w1/settings/members', LABEL.members],
        ['/works/w1/settings/budgets-usage', LABEL.budgets],
        ['/works/w1/settings/app-spec', LABEL.appSpec],
    ])('lights up only %s → %s', (pathname, expected) => {
        const rows = renderTabs({ kind: 'app', pathname });

        expect(activeLabels(rows)).toEqual([expected]);
    });

    it('does not also light up General on the App spec path', () => {
        const rows = renderTabs({ kind: 'app', pathname: '/works/w1/settings/app-spec' });
        const general = rows.find((row) => row.label === LABEL.general);
        const appSpec = rows.find((row) => row.label === LABEL.appSpec);

        expect(general?.active).toBe(false);
        expect(appSpec?.active).toBe(true);
    });

    it('leaves General inactive on the App spec path for a kind that gets no App spec tab', () => {
        // Belt to the braces above: the exclusion must hold independently of
        // the fourth tab existing, which is what keeps it correct on a Work
        // whose kind the fourth tab is withheld for.
        const rows = renderTabs({ kind: 'website', pathname: '/works/w1/settings/app-spec' });

        expect(activeLabels(rows)).toEqual([]);
    });
});
