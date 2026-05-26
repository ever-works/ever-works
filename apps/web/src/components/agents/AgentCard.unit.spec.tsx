import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentCard } from './AgentCard';
import type { Agent } from '@/lib/api/agents';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: 'tenant',
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'CEO',
        slug: 'ceo',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: null,
        maxSkillContextTokens: 4000,
        status: 'draft',
        permissions: {
            canCreateAgents: false,
            canAssignTasks: false,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: false,
            canOpenPullRequests: false,
            canCallExternalTools: false,
        },
        targets: null,
        heartbeatCadence: null,
        idleBehavior: 'propose',
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: 'initials',
        avatarIcon: null,
        avatarImageUploadId: null,
        contentHash: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...over,
    };
}

describe('AgentCard', () => {
    it('renders the agent name and scope label', () => {
        render(<AgentCard agent={makeAgent({ name: 'CEO', scope: 'tenant' })} />);
        expect(screen.getByText('CEO')).toBeTruthy();
        expect(screen.getByText('scopeTenant')).toBeTruthy();
    });

    it('shows initials when avatarMode is "initials"', () => {
        render(<AgentCard agent={makeAgent({ name: 'Quality Assurance' })} />);
        expect(screen.getByText('QA')).toBeTruthy();
    });

    it('renders heartbeat cadence when present', () => {
        render(<AgentCard agent={makeAgent({ heartbeatCadence: '*/15 * * * *' })} />);
        expect(screen.getByText(/cadencePrefix \*\/15/)).toBeTruthy();
    });

    it('falls back to "noCadence" when not set', () => {
        render(<AgentCard agent={makeAgent({ heartbeatCadence: null })} />);
        expect(screen.getByText('noCadence')).toBeTruthy();
    });
});
