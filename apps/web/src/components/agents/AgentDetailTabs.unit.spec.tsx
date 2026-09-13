import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentDetailTabs } from './AgentDetailTabs';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    usePathname: () => '/agents/agent-1/computer',
    Link: ({
        children,
        href,
        className,
    }: {
        children: React.ReactNode;
        href: string;
        className?: string;
    }) => (
        <a href={href} className={className}>
            {children}
        </a>
    ),
}));

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
