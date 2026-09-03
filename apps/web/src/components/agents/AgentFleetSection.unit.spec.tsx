import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FleetExecutionPreferenceView, FleetNodeView } from '@ever-works/contracts';
import { AgentFleetSection } from './AgentFleetSection';
import type { AgentFleetData } from './agent-fleet.shared';

/**
 * Execution section — the wiring assertions.
 *
 * The policy (offerable nodes, availability, routing row) is covered by
 * `agent-fleet.shared.unit.spec.ts`; what this spec pins is that the
 * picker routes a choice to the right server action, rolls back when the
 * action refuses, and that each "cannot pin" situation renders the
 * explanation it is supposed to instead of a misleading picker.
 */

const setFleetAgentAffinityAction = vi.fn();
const clearFleetAgentAffinityAction = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({
        children,
        href,
        ...rest
    }: {
        children: React.ReactNode;
        href: string;
        'data-testid'?: string;
    }) => (
        <a href={href} data-testid={rest['data-testid']}>
            {children}
        </a>
    ),
}));
vi.mock('sonner', () => ({
    toast: {
        error: (...args: unknown[]) => toastError(...args),
        success: (...args: unknown[]) => toastSuccess(...args),
    },
}));
vi.mock('@/app/actions/settings/fleet', () => ({
    setFleetAgentAffinityAction: (...args: unknown[]) => setFleetAgentAffinityAction(...args),
    clearFleetAgentAffinityAction: (...args: unknown[]) => clearFleetAgentAffinityAction(...args),
}));

const AGENT_ID = 'agent-1';

function node(over: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'node-1',
        name: 'Office PC',
        kind: 'desktop-node',
        status: 'online',
        platform: 'win32/x64',
        version: '0.1.0',
        capabilities: [],
        lastHeartbeatAt: null,
        createdAt: null,
        persisted: true,
        ...over,
    };
}

function preference(
    over: Partial<FleetExecutionPreferenceView> = {},
): FleetExecutionPreferenceView {
    return {
        id: 'pref-1',
        scopeType: 'user',
        scopeId: null,
        mode: 'cloud',
        createdAt: null,
        updatedAt: null,
        ...over,
    };
}

const NODES = [
    node(),
    node({ id: 'node-2', name: 'Build server', kind: 'node', status: 'offline' }),
];

function renderSection(over: Partial<AgentFleetData> = {}) {
    const fleet: AgentFleetData = {
        nodes: NODES,
        affinity: { available: true, nodeId: null },
        preferences: [],
        ...over,
    };
    render(<AgentFleetSection agentId={AGENT_ID} fleet={fleet} />);
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('AgentFleetSection — preferred node picker', () => {
    it('offers "Any node" plus every enrolled node with its platform and status', async () => {
        const user = userEvent.setup();
        renderSection();

        const trigger = screen.getByTestId('capabilities-fleet-node');
        expect(trigger).toHaveTextContent('anyNode');
        await user.click(trigger);

        expect(screen.getByRole('option', { name: 'anyNode' })).toBeInTheDocument();
        expect(
            screen.getByRole('option', { name: 'Office PC · win32/x64 · statuses.online' }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole('option', { name: 'Build server · win32/x64 · statuses.offline' }),
        ).toBeInTheDocument();
    });

    it('never offers a cluster-sourced row', async () => {
        const user = userEvent.setup();
        renderSection({
            nodes: [...NODES, node({ id: 'k8s', name: 'worker-1', kind: 'k8s', persisted: false })],
        });

        await user.click(screen.getByTestId('capabilities-fleet-node'));
        expect(screen.queryByRole('option', { name: /worker-1/ })).toBeNull();
    });

    it('PUTs the chosen node through the affinity action and adopts it', async () => {
        const user = userEvent.setup();
        setFleetAgentAffinityAction.mockResolvedValue({
            success: true,
            data: { agentId: AGENT_ID, nodeId: 'node-1' },
            error: null,
        });
        renderSection();

        await user.click(screen.getByTestId('capabilities-fleet-node'));
        await user.click(screen.getByRole('option', { name: /Office PC/ }));

        await waitFor(() =>
            expect(setFleetAgentAffinityAction).toHaveBeenCalledWith(AGENT_ID, 'node-1'),
        );
        expect(clearFleetAgentAffinityAction).not.toHaveBeenCalled();
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('saved'));
        expect(screen.getByTestId('capabilities-fleet-node')).toHaveTextContent('Office PC');
    });

    it('DELETEs the binding when "Any node" is picked', async () => {
        const user = userEvent.setup();
        clearFleetAgentAffinityAction.mockResolvedValue({
            success: true,
            data: { cleared: true },
            error: null,
        });
        renderSection({ affinity: { available: true, nodeId: 'node-1' } });

        await user.click(screen.getByTestId('capabilities-fleet-node'));
        await user.click(screen.getByRole('option', { name: 'anyNode' }));

        await waitFor(() => expect(clearFleetAgentAffinityAction).toHaveBeenCalledWith(AGENT_ID));
        expect(setFleetAgentAffinityAction).not.toHaveBeenCalled();
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('cleared'));
    });

    /**
     * Server Actions return the refusal as data (prod redacts thrown
     * messages), so the picker must read `success` and restore the
     * previous binding rather than showing a node the API never bound.
     */
    it('restores the previous choice and toasts when the action refuses', async () => {
        const user = userEvent.setup();
        setFleetAgentAffinityAction.mockResolvedValue({
            success: false,
            data: null,
            error: 'Fleet Agent or node not found',
        });
        renderSection();

        await user.click(screen.getByTestId('capabilities-fleet-node'));
        await user.click(screen.getByRole('option', { name: /Build server/ }));

        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith('Fleet Agent or node not found'),
        );
        await waitFor(() =>
            expect(screen.getByTestId('capabilities-fleet-node')).toHaveTextContent('anyNode'),
        );
    });

    it('shows no hint while the bound node is online', () => {
        renderSection({ affinity: { available: true, nodeId: 'node-1' } });
        expect(screen.queryByTestId('capabilities-fleet-node-hint')).toBeNull();
    });

    it('warns, naming the node, when the bound node is offline', () => {
        renderSection({ affinity: { available: true, nodeId: 'node-2' } });
        expect(screen.getByTestId('capabilities-fleet-node-hint')).toHaveTextContent(
            'hintOffline:Build server',
        );
    });

    it('warns about a drained node separately from an offline one', () => {
        renderSection({
            nodes: [node({ status: 'paused' })],
            affinity: { available: true, nodeId: 'node-1' },
        });
        expect(screen.getByTestId('capabilities-fleet-node-hint')).toHaveTextContent(
            'hintDraining:Office PC',
        );
    });

    /**
     * The binding outlives the node row; the trigger must name the
     * situation rather than fall back to "Any node" for a binding that is
     * still in force.
     */
    it('keeps a binding to a removed node visible and warns about it', () => {
        renderSection({ affinity: { available: true, nodeId: 'gone' } });
        expect(screen.getByTestId('capabilities-fleet-node')).toHaveTextContent('missingNode');
        expect(screen.getByTestId('capabilities-fleet-node-hint')).toHaveTextContent('hintMissing');
    });

    it('hides the picker and points at Settings › Fleet when no machine is enrolled', () => {
        renderSection({ nodes: [node({ id: 'k8s', kind: 'k8s', persisted: false })] });

        expect(screen.queryByTestId('capabilities-fleet-node')).toBeNull();
        expect(screen.getByTestId('capabilities-fleet-no-nodes')).toHaveTextContent('noNodes');
        expect(screen.getByTestId('capabilities-fleet-enroll-link')).toHaveAttribute(
            'href',
            '/settings/fleet',
        );
    });

    it('explains that a personal workspace cannot pin an agent', () => {
        renderSection({ affinity: { available: false, reason: 'personal-scope' } });
        expect(screen.queryByTestId('capabilities-fleet-node')).toBeNull();
        expect(screen.getByTestId('capabilities-fleet-affinity-unavailable')).toHaveTextContent(
            'affinityPersonalScope',
        );
    });

    it('never renders an "unbound" picker when the binding could not be read', () => {
        renderSection({ affinity: { available: false, reason: 'unavailable' } });
        expect(screen.queryByTestId('capabilities-fleet-node')).toBeNull();
        expect(screen.getByTestId('capabilities-fleet-affinity-unavailable')).toHaveTextContent(
            'affinityUnavailable',
        );
    });
});

describe('AgentFleetSection — execution routing (read-only)', () => {
    it('shows the configured account mode with the Fleet page wording', () => {
        renderSection({ preferences: [preference({ mode: 'local-wait' })] });

        expect(screen.getByTestId('capabilities-fleet-routing-mode')).toHaveTextContent(
            'routing.modes.local-wait.label',
        );
        expect(screen.getByTestId('capabilities-fleet-routing-source')).toHaveTextContent(
            'routingAccountDefault',
        );
        expect(screen.queryByTestId('capabilities-fleet-routing-overrides')).toBeNull();
    });

    it('labels the platform default as such when nothing is configured', () => {
        renderSection({ preferences: [] });
        expect(screen.getByTestId('capabilities-fleet-routing-mode')).toHaveTextContent(
            'routing.modes.local-fallback.label',
        );
        expect(screen.getByTestId('capabilities-fleet-routing-source')).toHaveTextContent(
            'routingPlatformDefault',
        );
    });

    it('counts Work / Goal overrides next to the account mode', () => {
        renderSection({
            preferences: [
                preference({ mode: 'cloud' }),
                preference({ id: 'w', scopeType: 'work', scopeId: 'w1', mode: 'local-wait' }),
            ],
        });
        expect(screen.getByTestId('capabilities-fleet-routing-mode')).toHaveTextContent(
            'routing.modes.cloud.label',
        );
        expect(screen.getByTestId('capabilities-fleet-routing-overrides')).toHaveTextContent(
            'routingOverrides:1',
        );
    });

    it('says the preference could not be loaded rather than showing the default as fact', () => {
        renderSection({ preferences: null });
        expect(screen.queryByTestId('capabilities-fleet-routing-mode')).toBeNull();
        expect(screen.getByTestId('capabilities-fleet-routing-unavailable')).toBeInTheDocument();
    });

    it('links to Settings › Fleet to change it — no per-agent editor', () => {
        renderSection();
        expect(screen.getByTestId('capabilities-fleet-routing-link')).toHaveAttribute(
            'href',
            '/settings/fleet',
        );
        expect(screen.getByTestId('capabilities-manage-fleet')).toHaveAttribute(
            'href',
            '/settings/fleet',
        );
    });
});
