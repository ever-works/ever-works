import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentsPageTabs, TeamsPageTabs } from './AgentsPageTabs';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

describe('AgentsPageTabs', () => {
    it('renders Teams | Agents | Sessions | Archived in that order and marks the active one', () => {
        render(<AgentsPageTabs active="teams" />);
        const tabs = screen.getAllByRole('link');
        expect(tabs.map((a) => a.getAttribute('data-testid'))).toEqual([
            'agents-page-tab-teams',
            'agents-page-tab-agents',
            'agents-page-tab-sessions',
            'agents-page-tab-archived',
        ]);
        expect(tabs[0].getAttribute('href')).toBe('/teams');
        expect(tabs[0].className).toContain('border-primary');
        expect(tabs[1].className).not.toContain('border-primary');
    });

    it('keeps the existing tab hrefs and the strip test id', () => {
        const { container } = render(<AgentsPageTabs active="agents" />);
        expect(container.querySelector('[data-testid="agents-page-tabs"]')).not.toBeNull();
        const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
        expect(hrefs).toEqual(['/teams', '/agents', '/agents/sessions', '/agents/archived']);
        expect(screen.getByTestId('agents-page-tab-agents').className).toContain('border-primary');
        expect(screen.getByTestId('agents-page-tab-teams').className).not.toContain(
            'border-primary',
        );
    });

    it('marks sessions and archived active when selected', () => {
        const { unmount } = render(<AgentsPageTabs active="sessions" />);
        expect(screen.getByTestId('agents-page-tab-sessions').className).toContain(
            'border-primary',
        );
        unmount();

        render(<AgentsPageTabs active="archived" />);
        expect(screen.getByTestId('agents-page-tab-archived').className).toContain(
            'border-primary',
        );
    });

    it('exposes a TeamsPageTabs alias for the Teams hub entry point', () => {
        expect(TeamsPageTabs).toBe(AgentsPageTabs);
        render(<TeamsPageTabs active="teams" />);
        expect(screen.getByTestId('agents-page-tab-teams').className).toContain('border-primary');
    });
});
