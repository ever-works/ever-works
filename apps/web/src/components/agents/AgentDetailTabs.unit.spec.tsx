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
