import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentEmailSendPolicyView } from '@/lib/agent-email-policy';

const { saveMock, assignMock, removeMock } = vi.hoisted(() => ({
    saveMock: vi.fn(),
    assignMock: vi.fn(),
    removeMock: vi.fn(),
}));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('@/app/[locale]/(dashboard)/agents/[id]/inbox/actions', () => ({
    saveAgentInboxSettingsAction: saveMock,
    assignAgentAddressAction: assignMock,
    removeAgentAddressAction: removeMock,
}));

import { AgentEmailSendPolicyPanel } from './AgentEmailSendPolicyPanel';

function policy(overrides: Partial<AgentEmailSendPolicyView> = {}): AgentEmailSendPolicyView {
    return {
        inbox: null,
        meter: {
            agentId: 'agent-1',
            enforced: true,
            mode: 'auto-send',
            modeSource: 'platform',
            pausedUntil: null,
            windows: [
                {
                    kind: 'recipientsPerMessage',
                    scope: 'message',
                    used: 0,
                    cap: 50,
                    windowSeconds: 0,
                    source: 'platform',
                },
                {
                    kind: 'inboxDaily',
                    scope: 'inbox',
                    used: 12,
                    cap: 100,
                    windowSeconds: 86_400,
                    source: 'platform',
                },
                {
                    kind: 'workspaceMonthly',
                    scope: 'workspace',
                    used: 40,
                    cap: null,
                    windowSeconds: 2_592_000,
                    source: 'organization',
                },
            ],
        },
        ...overrides,
    };
}

const ADDRESSES = [
    { id: 'addr-out', address: 'nova@x.com', direction: 'outbound' as const },
    { id: 'addr-in', address: 'inbox@x.com', direction: 'inbound' as const },
];

describe('AgentEmailSendPolicyPanel', () => {
    beforeEach(() => {
        saveMock.mockReset();
        assignMock.mockReset();
        removeMock.mockReset();
        saveMock.mockImplementation(async (_agentId, input) => ({
            ok: true,
            policy: policy({
                inbox: {
                    id: 'inbox-1',
                    agentId: 'agent-1',
                    emailAddressId: null,
                    mode: input.mode ?? 'draft-review',
                    state: 'active',
                    caps: {
                        inboxDailySends: input.dailySendCap ?? null,
                        inboxBurstSends: null,
                        inboxBurstRecipients: null,
                        recipientsPerMessage: null,
                    },
                    capPausedUntil: null,
                    createdAt: '2026-09-14T00:00:00.000Z',
                    updatedAt: '2026-09-14T00:00:00.000Z',
                },
            }),
        }));
    });

    const renderPanel = (initial = policy()) =>
        render(
            <AgentEmailSendPolicyPanel
                agentId="agent-1"
                initialPolicy={initial}
                initialAssignments={[]}
                addresses={ADDRESSES}
            />,
        );

    it('renders nothing when the policy could not be read', () => {
        const { container } = render(
            <AgentEmailSendPolicyPanel
                agentId="agent-1"
                initialPolicy={null}
                initialAssignments={[]}
                addresses={[]}
            />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('shows each limit with its usage and where it comes from', () => {
        renderPanel();
        const meter = screen.getByTestId('email-cap-meter');
        expect(meter.textContent).toContain('policy.usage:{"used":12,"cap":100}');
        expect(meter.textContent).toContain('policy.usageUnlimited:{"used":40}');
        expect(meter.textContent).toContain('policy.source.organization');
    });

    it('keeps the current mode on the first save so creating settings changes nothing unexpectedly', async () => {
        renderPanel();
        fireEvent.change(screen.getByTestId('email-cap-dailySendCap'), { target: { value: '25' } });
        fireEvent.click(screen.getByRole('button', { name: 'policy.save' }));

        await waitFor(() =>
            expect(saveMock).toHaveBeenCalledWith('agent-1', {
                mode: 'auto-send',
                dailySendCap: 25,
            }),
        );
        expect(await screen.findByText('policy.saved')).toBeInTheDocument();
    });

    it('asks before turning the approval gate off, and keeps it on when told to', () => {
        renderPanel(
            policy({ meter: { ...policy().meter, mode: 'draft-review', modeSource: 'inbox' } }),
        );
        const autoSend = screen.getByRole('radio', { name: 'policy.modeAutoSend' });

        fireEvent.click(autoSend);
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: 'policy.modeDraftReview' })).toBeChecked();

        fireEvent.click(screen.getByRole('button', { name: 'policy.keepGate' }));
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(screen.getByRole('radio', { name: 'policy.modeDraftReview' })).toBeChecked();

        fireEvent.click(autoSend);
        fireEvent.click(screen.getByRole('button', { name: 'policy.turnItOff' }));
        expect(autoSend).toBeChecked();
    });

    it('refuses to save a limit that is not a whole number', () => {
        renderPanel();
        fireEvent.change(screen.getByTestId('email-cap-burstSendCap'), { target: { value: '-2' } });
        fireEvent.click(screen.getByRole('button', { name: 'policy.save' }));
        expect(screen.getByText('policy.invalidNumber')).toBeInTheDocument();
        expect(saveMock).not.toHaveBeenCalled();
    });

    it('sends 0 for "no limit" and null to go back to inheriting', async () => {
        const existing = policy({
            inbox: {
                id: 'inbox-1',
                agentId: 'agent-1',
                emailAddressId: null,
                mode: 'auto-send',
                state: 'active',
                caps: {
                    inboxDailySends: 10,
                    inboxBurstSends: 3,
                    inboxBurstRecipients: null,
                    recipientsPerMessage: null,
                },
                capPausedUntil: null,
                createdAt: '2026-09-14T00:00:00.000Z',
                updatedAt: '2026-09-14T00:00:00.000Z',
            },
            meter: { ...policy().meter, mode: 'auto-send', modeSource: 'inbox' },
        });
        renderPanel(existing);
        fireEvent.change(screen.getByTestId('email-cap-dailySendCap'), { target: { value: '0' } });
        fireEvent.change(screen.getByTestId('email-cap-burstSendCap'), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: 'policy.save' }));

        await waitFor(() =>
            expect(saveMock).toHaveBeenCalledWith('agent-1', {
                dailySendCap: 0,
                burstSendCap: null,
            }),
        );
    });

    describe('an Agent with no limits configured', () => {
        const unconfigured = (): AgentEmailSendPolicyView =>
            policy({
                meter: {
                    ...policy().meter,
                    limitsConfigured: false,
                    windows: [
                        {
                            kind: 'recipientsPerMessage',
                            scope: 'message',
                            used: 0,
                            cap: null,
                            windowSeconds: 0,
                            source: 'unconfigured',
                        },
                        {
                            kind: 'inboxBurst',
                            scope: 'inbox',
                            used: 1,
                            cap: null,
                            windowSeconds: 60,
                            source: 'unconfigured',
                        },
                        {
                            kind: 'inboxRecipients',
                            scope: 'inbox',
                            used: 1,
                            cap: null,
                            windowSeconds: 300,
                            source: 'unconfigured',
                        },
                        {
                            kind: 'inboxDaily',
                            scope: 'inbox',
                            used: 240,
                            cap: null,
                            windowSeconds: 86_400,
                            source: 'unconfigured',
                        },
                        {
                            kind: 'workspaceDaily',
                            scope: 'workspace',
                            used: 240,
                            cap: null,
                            windowSeconds: 86_400,
                            source: 'unconfigured',
                        },
                    ],
                },
            });

        it('says clearly that nothing is configured, on the panel and on the meter', () => {
            renderPanel(unconfigured());
            const notice = screen.getByTestId('email-no-limits-notice');
            expect(notice).toHaveTextContent('policy.noLimitsTitle');
            expect(notice).toHaveTextContent(
                'policy.noLimitsConfigured:{"daily":100,"perMinute":10,"recipients":20,"perMessage":50}',
            );
            const meter = screen.getByTestId('email-cap-meter');
            expect(meter.textContent).toContain('policy.usageNotConfigured:{"used":240}');
            expect(meter.textContent).toContain('policy.notConfigured');
            // Never presented as a number it does not enforce.
            expect(meter.textContent).not.toContain('policy.usage:');
        });

        it('offers the recommended limits and keeps the mode the Agent has today', async () => {
            renderPanel(unconfigured());
            fireEvent.click(screen.getByRole('button', { name: 'policy.applyRecommended' }));
            await waitFor(() =>
                expect(saveMock).toHaveBeenCalledWith('agent-1', {
                    mode: 'auto-send',
                    dailySendCap: 100,
                    burstSendCap: 10,
                    recipientBurstCap: 20,
                    recipientsPerMessageCap: 50,
                }),
            );
            expect(await screen.findByText('policy.recommendedApplied')).toBeInTheDocument();
        });

        it('pre-fills the recommended numbers, so a first save protects the Agent by default', async () => {
            renderPanel(unconfigured());
            expect(screen.getByTestId('email-cap-dailySendCap')).toHaveValue('100');
            expect(screen.getByTestId('email-cap-burstSendCap')).toHaveValue('10');
            expect(screen.getByTestId('email-cap-recipientBurstCap')).toHaveValue('20');
            expect(screen.getByTestId('email-cap-recipientsPerMessageCap')).toHaveValue('50');

            fireEvent.click(screen.getByRole('button', { name: 'policy.save' }));
            await waitFor(() =>
                expect(saveMock).toHaveBeenCalledWith('agent-1', {
                    mode: 'auto-send',
                    dailySendCap: 100,
                    burstSendCap: 10,
                    recipientBurstCap: 20,
                    recipientsPerMessageCap: 50,
                }),
            );
        });

        it('does not claim "no limits" once any source configures a per-Agent limit', () => {
            renderPanel();
            expect(screen.queryByTestId('email-no-limits-notice')).not.toBeInTheDocument();
            // …and leaves a limit someone else sets blank, to keep inheriting it.
            expect(screen.getByTestId('email-cap-dailySendCap')).toHaveValue('');
        });
    });

    it('only offers addresses that can be used the chosen way, and assigns one', async () => {
        assignMock.mockResolvedValue({
            ok: true,
            assignment: {
                id: 'as-1',
                agentId: 'agent-1',
                emailAddressId: 'addr-out',
                address: 'nova@x.com',
                direction: 'outbound',
                priority: 100,
                dispatchMode: 'task-spawn',
                createdAt: '2026-09-14T00:00:00.000Z',
            },
        });
        renderPanel();
        const choose = screen.getByRole('combobox', { name: 'addresses.choose' });
        expect(Array.from((choose as HTMLSelectElement).options).map((o) => o.value)).toEqual([
            '',
            'addr-out',
        ]);

        fireEvent.change(choose, { target: { value: 'addr-out' } });
        fireEvent.click(screen.getByRole('button', { name: 'addresses.add' }));

        await waitFor(() =>
            expect(assignMock).toHaveBeenCalledWith('agent-1', {
                emailAddressId: 'addr-out',
                direction: 'outbound',
            }),
        );
        expect(await screen.findByTestId('agent-email-assignments')).toHaveTextContent(
            'nova@x.com',
        );
    });

    it('says so when an address is already assigned', async () => {
        assignMock.mockResolvedValue({ ok: false, error: 'duplicate' });
        renderPanel();
        fireEvent.change(screen.getByRole('combobox', { name: 'addresses.choose' }), {
            target: { value: 'addr-out' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'addresses.add' }));
        expect(await screen.findByText('addresses.duplicate')).toBeInTheDocument();
    });
});
