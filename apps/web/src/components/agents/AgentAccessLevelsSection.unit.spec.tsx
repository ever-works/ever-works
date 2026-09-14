import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectionScopePresetStateDto } from '@ever-works/contracts';
import { AgentAccessLevelsSection } from './AgentAccessLevelsSection';
import type { AgentAccessLevelRow } from './agent-access-levels.shared';

/**
 * Access levels section — the wiring assertions. Policy (which option is
 * selected, what the hint says) is covered by
 * `agent-access-levels.shared.unit.spec.ts`; this spec pins that a choice
 * reaches the right server action, that the picker only moves on success,
 * and that each refusal renders the explanation it should.
 */

const setAgentAccessLevelAction = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('sonner', () => ({
    toast: {
        error: (...args: unknown[]) => toastError(...args),
        success: (...args: unknown[]) => toastSuccess(...args),
    },
}));
vi.mock('@/app/actions/agent-capabilities', () => ({
    setAgentAccessLevelAction: (...args: unknown[]) => setAgentAccessLevelAction(...args),
}));

const AGENT_ID = 'agent-1';

function state(over: Partial<ConnectionScopePresetStateDto> = {}): ConnectionScopePresetStateDto {
    return {
        providerId: 'github',
        scopeType: 'agent',
        scopeId: AGENT_ID,
        presets: ['read', 'write'],
        requested: 'write',
        effective: 'write',
        clampedBy: null,
        ...over,
    };
}

function rows(over: Partial<AgentAccessLevelRow> = {}): AgentAccessLevelRow[] {
    return [
        {
            providerId: 'github',
            providerName: 'GitHub',
            presets: ['read', 'write'],
            state: state(),
            ...over,
        },
    ];
}

function renderSection(input: AgentAccessLevelRow[] = rows(), onCapabilitiesChange = vi.fn()) {
    render(
        <AgentAccessLevelsSection
            agentId={AGENT_ID}
            rows={input}
            onCapabilitiesChange={onCapabilitiesChange}
        />,
    );
    return { onCapabilitiesChange };
}

describe('AgentAccessLevelsSection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders nothing when no provider declares levels', () => {
        const { container } = render(
            <AgentAccessLevelsSection
                agentId={AGENT_ID}
                rows={[]}
                onCapabilitiesChange={vi.fn()}
            />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('shows the stored level as checked', () => {
        renderSection();
        expect(screen.getByTestId('capabilities-access-level-github-write')).toHaveAttribute(
            'aria-checked',
            'true',
        );
        expect(screen.getByTestId('capabilities-access-level-github-read')).toHaveAttribute(
            'aria-checked',
            'false',
        );
        expect(screen.getByTestId('capabilities-access-level-hint-github')).toHaveTextContent(
            'levelHints.write',
        );
    });

    it('narrowing calls the action and refreshes the tool list from its payload', async () => {
        const capabilities = { tools: [] };
        setAgentAccessLevelAction.mockResolvedValue({
            success: true,
            state: state({ requested: 'read', effective: 'read' }),
            capabilities,
        });
        const { onCapabilitiesChange } = renderSection();

        await userEvent.click(screen.getByTestId('capabilities-access-level-github-read'));

        await waitFor(() =>
            expect(screen.getByTestId('capabilities-access-level-github-read')).toHaveAttribute(
                'aria-checked',
                'true',
            ),
        );
        expect(setAgentAccessLevelAction).toHaveBeenCalledWith(AGENT_ID, 'github', 'read');
        expect(onCapabilitiesChange).toHaveBeenCalledWith(capabilities);
        expect(toastSuccess).toHaveBeenCalled();
    });

    it('never moves the picker when widening needs re-approval, and says why', async () => {
        setAgentAccessLevelAction.mockResolvedValue({
            success: false,
            reason: 'reapproval',
            error: 'Reconnect github',
        });
        const { onCapabilitiesChange } = renderSection(
            rows({ state: state({ requested: 'read', effective: 'read' }) }),
        );

        await userEvent.click(screen.getByTestId('capabilities-access-level-github-write'));

        await waitFor(() =>
            expect(
                screen.getByTestId('capabilities-access-level-reapproval-github'),
            ).toBeInTheDocument(),
        );
        expect(screen.getByTestId('capabilities-access-level-github-read')).toHaveAttribute(
            'aria-checked',
            'true',
        );
        expect(onCapabilitiesChange).not.toHaveBeenCalled();
        expect(toastError).not.toHaveBeenCalled();
    });

    it('surfaces any other refusal and keeps the stored level', async () => {
        setAgentAccessLevelAction.mockResolvedValue({
            success: false,
            reason: 'failed',
            error: 'boom',
        });
        renderSection();

        await userEvent.click(screen.getByTestId('capabilities-access-level-github-read'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('boom'));
        expect(screen.getByTestId('capabilities-access-level-github-write')).toHaveAttribute(
            'aria-checked',
            'true',
        );
    });

    it('a rejected action rolls nothing forward', async () => {
        setAgentAccessLevelAction.mockRejectedValue(new Error('network'));
        renderSection();

        await userEvent.click(screen.getByTestId('capabilities-access-level-github-read'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('network'));
        expect(screen.getByTestId('capabilities-access-level-github-write')).toHaveAttribute(
            'aria-checked',
            'true',
        );
    });

    it('clicking the level already stored does nothing', async () => {
        renderSection();
        await userEvent.click(screen.getByTestId('capabilities-access-level-github-write'));
        expect(setAgentAccessLevelAction).not.toHaveBeenCalled();
    });

    it('explains a level narrowed by a parent scope', () => {
        renderSection(
            rows({ state: state({ requested: 'write', effective: 'read', clampedBy: 'work' }) }),
        );
        expect(screen.getByTestId('capabilities-access-level-hint-github')).toHaveTextContent(
            'narrowed:',
        );
    });

    it('disables the picker when the level could not be loaded', () => {
        renderSection(rows({ state: null }));
        expect(screen.getByTestId('capabilities-access-level-github-read')).toBeDisabled();
        expect(screen.getByTestId('capabilities-access-level-hint-github')).toHaveTextContent(
            'unavailable',
        );
    });
});
