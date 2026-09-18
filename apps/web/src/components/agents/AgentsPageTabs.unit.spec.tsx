import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentsPageTabs, TeamsPageTabs } from './AgentsPageTabs';
import { AgentsHubTabs } from './AgentsHubTabs';

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

/**
 * The Agents hub's two strips. The TOP strip lost its Sessions tab in the
 * Activity merge (Sessions became the Activity sub-tab, next to Skills), so the
 * shape pinned here is Teams | Agents | Archived — and the sub-strip that
 * replaced it is Agents | Skills | Activity.
 */
describe('AgentsPageTabs', () => {
    it('renders Teams | Agents | Archived in that order and marks the active one', () => {
        render(<AgentsPageTabs active="teams" />);
        const tabs = screen.getAllByRole('link');
        expect(tabs.map((a) => a.getAttribute('data-testid'))).toEqual([
            'agents-page-tab-teams',
            'agents-page-tab-agents',
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
        expect(hrefs).toEqual(['/teams', '/agents', '/agents/archived']);
        expect(screen.getByTestId('agents-page-tab-agents').className).toContain('border-primary');
        expect(screen.getByTestId('agents-page-tab-teams').className).not.toContain(
            'border-primary',
        );
    });

    it('marks archived active when selected', () => {
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

describe('AgentsHubTabs', () => {
    it('renders Agents | Skills | Activity with the routes each moved to', () => {
        const { container } = render(<AgentsHubTabs active="agents" />);
        expect(container.querySelector('[data-testid="agents-hub-tabs"]')).not.toBeNull();

        const tabs = screen.getAllByRole('link');
        expect(tabs.map((a) => a.getAttribute('data-testid'))).toEqual([
            'agents-hub-tab-agents',
            'agents-hub-tab-skills',
            'agents-hub-tab-activity',
        ]);
        // Skills has a URL of its own now (it was an `#skills` anchor on
        // /agents) and Activity is where the old Sessions tab went.
        expect(tabs.map((a) => a.getAttribute('href'))).toEqual([
            '/agents',
            '/agents/skills',
            '/agents/activity',
        ]);
        expect(screen.getByTestId('agents-hub-tab-agents').className).toContain('border-primary');
        expect(screen.getByTestId('agents-hub-tab-activity').className).not.toContain(
            'border-primary',
        );
    });

    it('marks the Skills and Activity sub-tabs active when they are the page', () => {
        const { unmount } = render(<AgentsHubTabs active="skills" />);
        expect(screen.getByTestId('agents-hub-tab-skills').className).toContain('border-primary');
        expect(screen.getByTestId('agents-hub-tab-skills').getAttribute('aria-current')).toBe(
            'page',
        );
        unmount();

        render(<AgentsHubTabs active="activity" />);
        expect(screen.getByTestId('agents-hub-tab-activity').className).toContain('border-primary');
    });
});
