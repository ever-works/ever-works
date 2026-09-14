import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ComponentProps, ReactNode } from 'react';
import type { Skill, SkillCardStateCounts } from '@/lib/api/skills';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, params?: Record<string, string | number>) =>
        params ? `${key}(${Object.values(params).join(',')})` : key,
}));

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
}));

vi.mock('@/lib/api/skill-shelf-client', () => ({
    setSkillEnabled: vi.fn(),
    refreshSkillReadiness: vi.fn(),
}));

import { SkillShelf } from './SkillShelf';

const COUNTS: SkillCardStateCounts = {
    ready: 28,
    needs_setup: 4,
    missing_requirements: 2,
    blocked_by_access: 0,
    unknown: 0,
    check_failed: 0,
    disabled: 0,
    needs_review: 0,
};

function skill(id: string): Skill {
    return {
        id,
        userId: 'u1',
        ownerType: 'tenant',
        ownerId: 'u1',
        slug: id,
        title: id,
        description: 'd',
        frontmatter: { name: id, description: 'd' },
        instructionsMd: '#',
        contentHash: 'h',
        sourcePath: null,
        sourceCatalogSlug: null,
        sourceCatalogVersion: null,
        version: '1.0.0',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        cardState: 'ready',
        readiness: 'ready',
    };
}

function renderShelf(over: Partial<ComponentProps<typeof SkillShelf>> = {}) {
    const onFiltersChange = vi.fn();
    const onFirstPage = vi.fn();
    const onBrowseCatalog = vi.fn();
    render(
        <SkillShelf
            skills={[skill('a'), skill('b')]}
            meta={{ total: 34, limit: 50, offset: 0 }}
            counts={COUNTS}
            tagFacets={[{ tag: 'billing', count: 3 }]}
            filters={{ search: '' }}
            onFiltersChange={onFiltersChange}
            onFirstPage={onFirstPage}
            onBrowseCatalog={onBrowseCatalog}
            {...over}
        />,
    );
    return { onFiltersChange, onFirstPage, onBrowseCatalog };
}

describe('SkillShelf', () => {
    it('summarises how many Skills need attention, and the summary is the attention filter', () => {
        const { onFiltersChange } = renderShelf();
        expect(screen.getByTestId('skill-shelf-summary').textContent).toBe(
            'attentionSummary(6,34)',
        );
        fireEvent.click(screen.getByTestId('skill-shelf-attention-toggle'));
        expect(onFiltersChange).toHaveBeenCalledWith({ readiness: 'attention' });
    });

    it('offers to show everything again while the attention filter is on', () => {
        const { onFiltersChange } = renderShelf({
            filters: { search: '', readiness: 'attention' },
        });
        const toggle = screen.getByTestId('skill-shelf-attention-toggle');
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        expect(toggle.textContent).toBe('attentionFilterOff');
        fireEvent.click(toggle);
        expect(onFiltersChange).toHaveBeenCalledWith({ readiness: undefined });
    });

    it('says everything is ready when nothing needs attention', () => {
        renderShelf({ counts: { ...COUNTS, needs_setup: 0, missing_requirements: 0 } });
        expect(screen.getByTestId('skill-shelf-summary').textContent).toBe('attentionAllReady(28)');
    });

    it('changes sort and readiness through the host, omitting defaults', () => {
        const { onFiltersChange } = renderShelf();
        fireEvent.change(screen.getByTestId('skill-shelf-sort'), { target: { value: 'name' } });
        expect(onFiltersChange).toHaveBeenLastCalledWith({ sort: 'name' });
        fireEvent.change(screen.getByTestId('skill-shelf-sort'), { target: { value: 'updated' } });
        expect(onFiltersChange).toHaveBeenLastCalledWith({ sort: undefined });
        fireEvent.change(screen.getByTestId('skill-shelf-readiness'), {
            target: { value: 'disabled' },
        });
        expect(onFiltersChange).toHaveBeenLastCalledWith({ readiness: 'disabled' });
    });

    it('passes tag chip selection up', () => {
        const { onFiltersChange } = renderShelf();
        fireEvent.click(screen.getByTestId('skill-tag-chip'));
        expect(onFiltersChange).toHaveBeenLastCalledWith({ tags: ['billing'] });
    });

    it('renders the grid of cards', () => {
        renderShelf();
        expect(screen.getAllByTestId('skill-shelf-card')).toHaveLength(2);
    });

    it('empty state 1 — no Skills at all, with its three recoveries', () => {
        const { onBrowseCatalog } = renderShelf({
            skills: [],
            meta: { total: 0, limit: 50, offset: 0 },
            counts: { ...COUNTS, ready: 0, needs_setup: 0, missing_requirements: 0 },
            tagFacets: [],
        });
        expect(screen.getByTestId('skill-shelf-empty')).toBeTruthy();
        expect(screen.getByText('emptyTitle')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'emptyBrowse' }));
        expect(onBrowseCatalog).toHaveBeenCalled();
        expect(screen.getByRole('link', { name: /emptyNew/ }).getAttribute('href')).toBe(
            '/skills/new',
        );
        expect(
            (screen.getByRole('button', { name: 'emptyFromRun' }) as HTMLButtonElement).disabled,
        ).toBe(true);
    });

    it('empty state 2 — nothing matches the filters, chip row stays interactive, Clear filters resets', () => {
        const { onFiltersChange } = renderShelf({
            skills: [],
            meta: { total: 0, limit: 50, offset: 0 },
            filters: { search: 'refund', tags: ['email'] },
        });
        expect(screen.getByTestId('skill-shelf-no-results').textContent).toContain(
            'noResultsTagged(refund,email)',
        );
        expect(screen.getByTestId('skill-tag-filter')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'clearFilters' }));
        expect(onFiltersChange).toHaveBeenCalledWith({
            search: '',
            tags: [],
            readiness: undefined,
        });
    });

    it('empty state 3 — a page past the end, with a way back', () => {
        const { onFirstPage } = renderShelf({
            skills: [],
            meta: { total: 34, limit: 50, offset: 50 },
        });
        expect(screen.getByTestId('skill-shelf-past-end')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'backToFirstPage' }));
        expect(onFirstPage).toHaveBeenCalled();
    });
});
