import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({
        href,
        children,
        ...rest
    }: {
        href: string;
        children: React.ReactNode;
    } & Record<string, unknown>) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

vi.mock('sonner', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

const enablePlugin = vi.fn();
vi.mock('@/app/actions/plugins', () => ({
    enablePlugin: (...args: unknown[]) => enablePlugin(...args),
}));

// `OnboardingPluginStep` pulls in the whole plugin-settings stack
// (server actions, hooks). The step under test only has to RENDER it in
// place — the settings round-trip has its own coverage — so stub it with
// a marker element.
vi.mock('../OnboardingPluginStep', () => ({
    OnboardingPluginStep: ({ plugin }: { plugin: { pluginId: string } }) => (
        <div data-testid="stub-plugin-settings">settings:{plugin.pluginId}</div>
    ),
}));

import { CommunicationStep, SLACK_CONNECTOR_PLUGIN_ID } from './CommunicationStep';
import type { UserPlugin } from '@/lib/api/plugins';

function slackPlugin(overrides: Partial<UserPlugin> = {}): UserPlugin {
    return {
        pluginId: SLACK_CONNECTOR_PLUGIN_ID,
        name: 'Slack Connector',
        category: 'connector',
        capabilities: ['connector', 'connector-slack'],
        installed: true,
        enabled: false,
        ...overrides,
    } as unknown as UserPlugin;
}

describe('CommunicationStep', () => {
    beforeEach(() => {
        enablePlugin.mockReset();
        enablePlugin.mockResolvedValue({ success: true });
    });

    it('falls back to the Settings link when the connector is not installed', () => {
        render(<CommunicationStep />);
        const action = screen.getByTestId('onboarding-communication-connect-slack');
        // A link OUT — the pre-existing degraded path, kept for images
        // that ship without the connector.
        expect(action.tagName).toBe('A');
        expect(action).toHaveAttribute('href', `/plugins/${SLACK_CONNECTOR_PLUGIN_ID}`);
        expect(screen.queryByTestId('onboarding-communication-slack-panel')).toBeNull();
    });

    it('connects IN PLACE (no navigation) when the connector is installed', async () => {
        render(<CommunicationStep slackPlugin={slackPlugin()} />);

        const action = screen.getByTestId('onboarding-communication-connect-slack');
        // A button, not an anchor — the user never leaves the wizard.
        expect(action.tagName).toBe('BUTTON');
        expect(action).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByTestId('onboarding-communication-slack-panel')).toBeNull();

        await userEvent.click(action);

        const panel = screen.getByTestId('onboarding-communication-slack-panel');
        expect(panel).toBeInTheDocument();
        // The connector's own settings panel renders inline.
        expect(screen.getByTestId('stub-plugin-settings')).toHaveTextContent(
            `settings:${SLACK_CONNECTOR_PLUGIN_ID}`,
        );
        expect(screen.getByTestId('onboarding-communication-connect-slack')).toHaveAttribute(
            'aria-expanded',
            'true',
        );
    });

    it('collapses the panel again on a second click', async () => {
        render(<CommunicationStep slackPlugin={slackPlugin()} />);
        const action = screen.getByTestId('onboarding-communication-connect-slack');
        await userEvent.click(action);
        expect(screen.getByTestId('onboarding-communication-slack-panel')).toBeInTheDocument();
        await userEvent.click(screen.getByTestId('onboarding-communication-connect-slack'));
        expect(screen.queryByTestId('onboarding-communication-slack-panel')).toBeNull();
    });

    it('enables the connector through the existing enablePlugin flow', async () => {
        const onConnected = vi.fn();
        render(<CommunicationStep slackPlugin={slackPlugin()} onConnected={onConnected} />);

        await userEvent.click(screen.getByTestId('onboarding-communication-connect-slack'));
        await userEvent.click(screen.getByTestId('onboarding-communication-slack-enable'));

        expect(enablePlugin).toHaveBeenCalledWith(SLACK_CONNECTOR_PLUGIN_ID);
        await waitFor(() => {
            expect(
                screen.getByTestId('onboarding-communication-slack-enabled'),
            ).toBeInTheDocument();
        });
        expect(onConnected).toHaveBeenCalledWith(SLACK_CONNECTOR_PLUGIN_ID);
        expect(screen.queryByTestId('onboarding-communication-slack-enable')).toBeNull();
    });

    it('keeps the Enable action available when the server rejects the enable', async () => {
        enablePlugin.mockResolvedValue({ success: false, error: 'nope' });
        const onConnected = vi.fn();
        render(<CommunicationStep slackPlugin={slackPlugin()} onConnected={onConnected} />);

        await userEvent.click(screen.getByTestId('onboarding-communication-connect-slack'));
        await userEvent.click(screen.getByTestId('onboarding-communication-slack-enable'));

        await waitFor(() => expect(enablePlugin).toHaveBeenCalledTimes(1));
        expect(onConnected).not.toHaveBeenCalled();
        expect(screen.getByTestId('onboarding-communication-slack-enable')).toBeInTheDocument();
        expect(screen.queryByTestId('onboarding-communication-slack-enabled')).toBeNull();
    });

    it('shows the connected state up-front for an already-enabled connector', async () => {
        render(<CommunicationStep slackPlugin={slackPlugin({ enabled: true })} />);
        await userEvent.click(screen.getByTestId('onboarding-communication-connect-slack'));
        expect(screen.getByTestId('onboarding-communication-slack-enabled')).toBeInTheDocument();
        expect(screen.queryByTestId('onboarding-communication-slack-enable')).toBeNull();
    });

    it('keeps the advanced-settings escape hatch and the Discord coming-soon chip', async () => {
        render(<CommunicationStep slackPlugin={slackPlugin()} />);
        expect(screen.getByTestId('onboarding-communication-discord-soon')).toBeInTheDocument();

        await userEvent.click(screen.getByTestId('onboarding-communication-connect-slack'));
        expect(screen.getByTestId('onboarding-communication-slack-settings-link')).toHaveAttribute(
            'href',
            `/plugins/${SLACK_CONNECTOR_PLUGIN_ID}`,
        );
    });
});
