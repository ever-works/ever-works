import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import type { PlaybookSummary } from '@ever-works/contracts';
import messages from '../../../messages/en.json';
import type { CatalogIndexData } from './catalog-data';

const refresh = vi.fn();

vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    useRouter: () => ({ refresh, push: vi.fn() }),
}));

vi.mock('@/app/actions/workflows', () => ({
    runWorkflowAction: vi.fn(),
    reactivateWorkflowAction: vi.fn(),
}));

import { CATALOG_SEARCH_DEBOUNCE_MS, CatalogShell } from './CatalogShell';

function playbook(slug: string, extra: Partial<PlaybookSummary> = {}): PlaybookSummary {
    return {
        slug,
        title: `Title ${slug}`,
        outcome: 'Outcome.',
        summary: 'Summary.',
        category: 'reporting',
        version: '1.0.0',
        icon: 'report',
        triggerKind: 'schedule',
        triggerDescription: 'Mondays',
        costBand: 'low',
        estimatedTokensPerRun: { min: 1, max: 2 },
        tags: [],
        stepTitles: [],
        requiredCapabilities: [],
        readiness: 'ready',
        missingRequired: [],
        ...extra,
    };
}

function data(overrides: Partial<CatalogIndexData> = {}): CatalogIndexData {
    return {
        playbooks: {
            items: [
                playbook('needs-search', {
                    title: 'Market watch',
                    category: 'research',
                    readiness: 'needs_connection',
                    missingRequired: ['search'],
                }),
                playbook('weekly-report', { title: 'Weekly report', category: 'reporting' }),
                playbook('inbox-triage', {
                    title: 'Inbox triage',
                    category: 'inbox',
                    tags: ['weekly'],
                }),
            ],
            total: 3,
            error: false,
        },
        skills: {
            items: [
                {
                    slug: 'weekly-rollup',
                    title: 'Weekly rollup',
                    description: 'Rolls up.',
                    tags: [],
                    installed: true,
                },
                {
                    slug: 'cite-it',
                    title: 'Cite it',
                    description: 'Cites.',
                    tags: [],
                    installed: false,
                },
            ],
            total: 34,
            error: false,
        },
        workflows: {
            items: [
                {
                    id: 'wf-1',
                    name: 'Item enrichment walk',
                    description: '',
                    status: 'active',
                    nodeCount: 6,
                    runCount: 12,
                    lastRunAt: null,
                },
            ],
            total: 1,
            error: false,
        },
        taskTemplates: {
            items: [
                {
                    id: 'tt-1',
                    name: 'Release checklist',
                    description: '',
                    labels: [],
                    stepCount: 7,
                    needApprovalCount: 2,
                },
            ],
            total: 1,
            error: false,
        },
        startingPoints: {
            items: [
                { kind: 'work', count: 9 },
                { kind: 'website', count: 6 },
                { kind: 'mission', count: 4 },
            ],
            total: 3,
            error: false,
        },
        ...overrides,
    };
}

function renderShell(value: CatalogIndexData = data()) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <CatalogShell data={value} />
        </NextIntlClientProvider>,
    );
}

function section(id: string) {
    return screen.getByTestId(`catalog-section-${id}`);
}

function playbookSlugs() {
    return within(section('playbooks'))
        .queryAllByTestId('playbook-card')
        .map((card) => card.getAttribute('data-slug'));
}

async function search(text: string) {
    fireEvent.change(screen.getByLabelText('Search the catalog'), { target: { value: text } });
    await act(async () => {
        vi.advanceTimersByTime(CATALOG_SEARCH_DEBOUNCE_MS);
    });
}

describe('CatalogShell', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        refresh.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders the five sections in their fixed order', () => {
        renderShell();
        const headings = screen
            .getAllByRole('heading', { level: 2 })
            .map((heading) => heading.textContent);
        expect(headings).toEqual([
            'Playbooks',
            'Skills',
            'Workflows',
            'Task templates',
            'Starting points',
        ]);
    });

    it('shows ready playbooks first, and each section’s true total on See all', () => {
        renderShell();
        expect(playbookSlugs()).toEqual(['weekly-report', 'inbox-triage', 'needs-search']);
        expect(
            within(section('skills')).getByRole('link', { name: 'See all (34)' }),
        ).toHaveAttribute('href', '/agents/skills');
        expect(within(section('skills')).getByText('Installed')).toBeInTheDocument();
        expect(screen.getByText('2 of 3 work with what you already have.')).toBeInTheDocument();
    });

    it('focuses search on "/" but not while typing in a field', () => {
        renderShell();
        const input = screen.getByLabelText('Search the catalog');
        fireEvent.keyDown(document.body, { key: '/' });
        expect(input).toHaveFocus();

        const other = document.createElement('input');
        document.body.appendChild(other);
        other.focus();
        fireEvent.keyDown(other, { key: '/' });
        expect(other).toHaveFocus();
        other.remove();
    });

    it('waits 250 ms and at least 2 characters before narrowing', async () => {
        renderShell();
        fireEvent.change(screen.getByLabelText('Search the catalog'), {
            target: { value: 'weekly' },
        });
        expect(playbookSlugs()).toHaveLength(3);
        await act(async () => {
            vi.advanceTimersByTime(CATALOG_SEARCH_DEBOUNCE_MS - 1);
        });
        expect(playbookSlugs()).toHaveLength(3);
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(playbookSlugs()).toEqual(['weekly-report', 'inbox-triage']);

        await search('w');
        expect(playbookSlugs()).toHaveLength(3);
        expect(screen.getByText('Type at least 2 characters to search.')).toBeInTheDocument();
    });

    it('narrows every section at once, ranks title above tag, and shows per-section counts', async () => {
        renderShell();
        await search('weekly');
        expect(playbookSlugs()).toEqual(['weekly-report', 'inbox-triage']);
        const counts = screen
            .getAllByTestId('catalog-section-count')
            .map((node) => node.textContent);
        expect(counts).toEqual(['2 results', '1 result', '0 results', '0 results', '0 results']);
        expect(within(section('skills')).getByText('Weekly rollup')).toBeInTheDocument();
        expect(
            within(section('workflows')).getByText('No matches in this section.'),
        ).toBeInTheDocument();
    });

    it('shows the no-results copy with a Clear control that restores everything', async () => {
        renderShell();
        await search('zzz');
        expect(screen.getByTestId('catalog-no-results')).toHaveTextContent(
            'Nothing matches "zzz". Try a shorter word, or clear the search.',
        );
        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(screen.queryByTestId('catalog-no-results')).not.toBeInTheDocument();
        expect(playbookSlugs()).toHaveLength(3);
    });

    it('clears and blurs the search on Escape', async () => {
        renderShell();
        const input = screen.getByLabelText('Search the catalog');
        input.focus();
        await search('zzz');
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(input).toHaveValue('');
        expect(input).not.toHaveFocus();
    });

    it('combines category chips (any-of) with readiness chips (intersect)', () => {
        renderShell();
        const categories = screen.getByRole('group', { name: 'Filter playbooks by category' });
        const readiness = screen.getByRole('group', { name: 'Filter playbooks by readiness' });

        fireEvent.click(within(categories).getByRole('button', { name: 'Research' }));
        fireEvent.click(within(categories).getByRole('button', { name: 'Inbox' }));
        expect(playbookSlugs()).toEqual(['inbox-triage', 'needs-search']);

        fireEvent.click(within(readiness).getByRole('button', { name: 'Ready now' }));
        expect(playbookSlugs()).toEqual(['inbox-triage']);
        expect(within(readiness).getByRole('button', { name: 'Ready now' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );

        fireEvent.click(within(categories).getByRole('button', { name: 'All' }));
        expect(playbookSlugs()).toEqual(['weekly-report', 'inbox-triage']);
    });

    it('renders a failed section’s own error state and leaves the others intact', () => {
        renderShell(data({ skills: { items: [], total: 0, error: true } }));
        const skills = section('skills');
        expect(within(skills).getByRole('alert')).toHaveTextContent('This section did not load.');
        fireEvent.click(within(skills).getByRole('button', { name: 'Try again' }));
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(playbookSlugs()).toHaveLength(3);
        expect(within(section('workflows')).getByText('Item enrichment walk')).toBeInTheDocument();
    });

    it('keeps an empty section on the page with its empty state', () => {
        renderShell(data({ workflows: { items: [], total: 0, error: false } }));
        expect(
            within(section('workflows')).getByText(
                'No saved workflows. A workflow is a graph of steps you save once and re-run.',
            ),
        ).toBeInTheDocument();
    });

    it('shows at most 6 playbooks until See all is pressed', () => {
        const many = Array.from({ length: 8 }, (_, index) => playbook(`p-${index}`));
        renderShell(data({ playbooks: { items: many, total: 8, error: false } }));
        expect(playbookSlugs()).toHaveLength(6);
        fireEvent.click(within(section('playbooks')).getByRole('button', { name: 'See all (8)' }));
        expect(playbookSlugs()).toHaveLength(8);
    });

    it('moves focus between cards with the arrow keys', () => {
        renderShell();
        const cards = within(section('playbooks')).getAllByTestId('playbook-card');
        cards[0].focus();
        fireEvent.keyDown(cards[0], { key: 'ArrowRight' });
        expect(cards[1]).toHaveFocus();
        fireEvent.keyDown(cards[1], { key: 'ArrowLeft' });
        expect(cards[0]).toHaveFocus();
    });
});
