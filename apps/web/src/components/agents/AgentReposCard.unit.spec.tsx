import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentRepoDto } from '@/lib/api/repo-connections';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/app/actions/repo-connections', () => ({
    setAgentRepoAttachment: vi.fn(),
    removeAgentRepoAttachment: vi.fn(),
}));

import { AgentReposCard } from './AgentReposCard';

/**
 * Repositories card on the agent settings page. What is pinned here is the
 * one sentence multi-repo Task workspaces (self-build slice C) added: an
 * operator toggling an attachment must be told, right there, that the
 * repository is mounted next to the Task's repository on fleet runs and
 * gets its own pull request when it changes — with and without rows.
 */
describe('AgentReposCard', () => {
    const repo: AgentRepoDto = {
        id: 'conn-1',
        name: 'directory-web-template',
        url: 'https://github.com/ever-works/directory-web-template',
        attached: true,
        attachmentEnabled: true,
    } as unknown as AgentRepoDto;

    it('explains what attaching a repository means for fleet runs, next to the toggles', () => {
        render(<AgentReposCard agentId="agent-1" repos={[repo]} />);
        expect(screen.getByText('subtitle')).toBeInTheDocument();
        expect(screen.getByTestId('agent-repos-fleet-hint')).toHaveTextContent('fleetHint');
        expect(screen.getByTestId('agent-repo-toggle-directory-web-template')).toBeInTheDocument();
    });

    it('keeps the hint when the registry is empty', () => {
        render(<AgentReposCard agentId="agent-1" repos={[]} />);
        expect(screen.getByTestId('agent-repos-fleet-hint')).toHaveTextContent('fleetHint');
        expect(screen.getByText('empty')).toBeInTheDocument();
    });
});
