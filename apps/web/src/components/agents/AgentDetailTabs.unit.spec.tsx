import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentDetailTabs } from './AgentDetailTabs';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    usePathname: () => '/en/agents/agent-1/inbox',
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

describe('AgentDetailTabs', () => {
    it('reaches the Inbox by clicking, and keeps every existing tab where it was', () => {
        render(<AgentDetailTabs agentId="agent-1" />);
        const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
        expect(hrefs).toEqual([
            '/agents/agent-1',
            '/agents/agent-1/activity',
            '/agents/agent-1/terminal',
            '/agents/agent-1/instructions',
            '/agents/agent-1/skills',
            '/agents/agent-1/capabilities',
            '/agents/agent-1/mcp-servers',
            '/agents/agent-1/collaborators',
            '/agents/agent-1/budgets',
            '/agents/agent-1/inbox',
            '/agents/agent-1/settings',
        ]);
    });

    it('marks the Inbox tab active on the inbox route', () => {
        render(<AgentDetailTabs agentId="agent-1" />);
        const inbox = screen.getByRole('link', { name: 'inbox' });
        expect(inbox.className).toContain('border-primary');
        expect(screen.getByRole('link', { name: 'settings' }).className).not.toContain(
            'border-primary',
        );
    });
});

describe('AgentDetailTabs — the Computer tab', () => {
    it('is absent unless the fleet is on, leaving the strip exactly as it was', () => {
        render(<AgentDetailTabs agentId="agent-1" />);
        expect(screen.queryByRole('link', { name: 'computer' })).not.toBeInTheDocument();
        expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
            'dashboard',
            'activity',
            'terminal',
            'instructions',
            'skills',
            'capabilities',
            'mcpServers',
            'collaborators',
            'budgets',
            'inbox',
            'settings',
        ]);
    });

    it('sits immediately after Terminal when the fleet is on, and reaches the computer page', () => {
        render(<AgentDetailTabs agentId="agent-1" showComputer />);
        const labels = screen.getAllByRole('link').map((link) => link.textContent);
        expect(labels.indexOf('computer')).toBe(labels.indexOf('terminal') + 1);
        expect(screen.getByRole('link', { name: 'computer' })).toHaveAttribute(
            'href',
            '/agents/agent-1/computer',
        );
    });
});
