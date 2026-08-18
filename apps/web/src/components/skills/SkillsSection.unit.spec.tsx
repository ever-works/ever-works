import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { SkillsPageData, SkillsPageFilters } from '@/lib/skills-page-data';

vi.mock('next-intl/server', () => ({
    getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
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

// The catalog itself is exercised by SkillsPageClient.unit.spec.tsx; here we
// only care that the block hands it the right host-page props.
vi.mock('./SkillsPageClient', () => ({
    SkillsPageClient: (props: { basePath?: string; hash?: string; filters: SkillsPageFilters }) => (
        <div
            data-testid="skills-page-client"
            data-base-path={props.basePath}
            data-hash={props.hash}
            data-section={props.filters.section}
        />
    ),
}));

import { SkillsSection } from './SkillsSection';

const FILTERS: SkillsPageFilters = {
    section: 'custom',
    search: '',
    installedOffset: 0,
    catalogOffset: 0,
};

const DATA: SkillsPageData = {
    installed: [],
    installedMeta: { total: 0, limit: 50, offset: 0 },
    catalog: [],
    catalogTotal: 0,
    catalogLimit: 50,
    loadErrors: { installed: null, catalog: null },
};

describe('SkillsSection', () => {
    it('renders an anchorable block whose heading does not compete with the page h1', async () => {
        const { container } = render(await SkillsSection({ data: DATA, filters: FILTERS }));

        const section = container.querySelector('#skills');
        expect(section).not.toBeNull();
        expect(section?.getAttribute('data-testid')).toBe('agents-skills-section');
        expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
        expect(
            screen.getByRole('heading', {
                level: 2,
                name: 'dashboard.agentsPage.skillsBlock.title',
            }),
        ).toBeTruthy();
        expect(screen.getByText('dashboard.agentsPage.skillsBlock.subtitle')).toBeTruthy();
    });

    it('keeps the catalog CTAs from the retired /skills page', async () => {
        render(await SkillsSection({ data: DATA, filters: FILTERS }));

        expect(
            screen.getByRole('link', { name: 'dashboard.skillsPage.list.browseTemplates' }),
        ).toHaveAttribute('href', '/skills/templates');
        expect(
            screen.getByRole('link', { name: /dashboard\.skillsPage\.list\.newSkill/ }),
        ).toHaveAttribute('href', '/skills/new');
    });

    it('hosts the catalog client on /agents with the #skills anchor', async () => {
        render(await SkillsSection({ data: DATA, filters: FILTERS }));

        const client = screen.getByTestId('skills-page-client');
        expect(client.getAttribute('data-base-path')).toBe('/agents');
        expect(client.getAttribute('data-hash')).toBe('#skills');
        expect(client.getAttribute('data-section')).toBe('custom');
    });
});
