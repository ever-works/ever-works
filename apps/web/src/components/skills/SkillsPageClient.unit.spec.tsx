import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AnchorHTMLAttributes, ComponentProps, ReactNode } from 'react';
import type { Skill, SkillCatalogEntry } from '@/lib/api/skills';

const routerReplace = vi.fn();
const routerRefresh = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, params?: Record<string, string | number>) => {
        if (key === 'pagination.showing') {
            return `Showing ${params?.start}-${params?.end} of ${params?.total}`;
        }
        return key;
    },
}));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({
        replace: routerReplace,
        refresh: routerRefresh,
        push: vi.fn(),
    }),
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: ReactNode;
    } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const installCatalogSkillAction = vi.fn();
vi.mock('@/app/actions/skills', () => ({
    installCatalogSkillAction: (...args: unknown[]) => installCatalogSkillAction(...args),
    createCustomSkillAction: vi.fn(),
}));

import { SkillsPageClient } from './SkillsPageClient';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
        id: 'skill-1',
        userId: 'u1',
        ownerType: 'tenant',
        ownerId: 'u1',
        slug: 'custom',
        title: 'Custom',
        description: 'Custom skill',
        frontmatter: { name: 'custom', description: 'Custom skill' },
        instructionsMd: '# Custom',
        contentHash: 'hash',
        sourcePath: null,
        sourceCatalogSlug: null,
        sourceCatalogVersion: null,
        version: '1.0.0',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

function makeCatalogEntry(overrides: Partial<SkillCatalogEntry> = {}): SkillCatalogEntry {
    return {
        slug: 'catalog-one',
        title: 'Catalog One',
        description: 'Catalog skill',
        frontmatter: { name: 'catalog-one', description: 'Catalog skill' },
        body: '# Catalog',
        version: '1.0.0',
        tags: [],
        ...overrides,
    };
}

function renderPage(overrides: Partial<ComponentProps<typeof SkillsPageClient>> = {}) {
    return render(
        <SkillsPageClient
            installed={[]}
            installedMeta={{ total: 0, limit: 50, offset: 0 }}
            catalog={[]}
            catalogTotal={0}
            catalogLimit={50}
            filters={{
                section: 'installed',
                search: '',
                installedOffset: 0,
                catalogOffset: 0,
            }}
            {...overrides}
        />,
    );
}

describe('SkillsPageClient', () => {
    it('shows load errors instead of rendering only empty states', () => {
        renderPage({ loadErrors: { installed: 'installed', catalog: 'catalog' } });
        expect(screen.getByText('errors.installed')).toBeTruthy();
        expect(screen.getByText('errors.catalog')).toBeTruthy();
    });

    it('renders section controls as tabs with selected state', () => {
        renderPage();
        const installed = screen.getByRole('tab', { name: 'tabs.installed' });
        const available = screen.getByRole('tab', { name: 'tabs.available' });
        expect(installed.getAttribute('aria-selected')).toBe('true');
        fireEvent.click(available);
        expect(routerReplace).toHaveBeenCalledWith('/skills?section=available');
    });

    it('guards pagination copy when the current page is empty', () => {
        renderPage({
            installedMeta: { total: 75, limit: 50, offset: 50 },
            filters: {
                section: 'installed',
                search: '',
                installedOffset: 50,
                catalogOffset: 0,
            },
        });
        expect(screen.getByText('pagination.emptyPage')).toBeTruthy();
    });

    it('marks a catalog skill installed and updates local installed state after install', async () => {
        const created = makeSkill({
            id: 'installed-catalog',
            slug: 'catalog-one',
            title: 'Catalog One',
            sourceCatalogSlug: 'catalog-one',
            sourceCatalogVersion: '1.0.0',
        });
        installCatalogSkillAction.mockResolvedValueOnce(created);
        renderPage({
            catalog: [makeCatalogEntry()],
            catalogTotal: 1,
            filters: {
                section: 'available',
                search: '',
                installedOffset: 0,
                catalogOffset: 0,
            },
        });

        fireEvent.click(screen.getByRole('button', { name: /catalog.install/ }));

        await waitFor(() => {
            expect(screen.getByRole('button', { name: /catalog.installed/ })).toBeTruthy();
        });
        expect(installCatalogSkillAction).toHaveBeenCalledWith({ slug: 'catalog-one' });
        expect(routerRefresh).toHaveBeenCalled();
    });
});
