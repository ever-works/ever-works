import { act, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookSubscription } from '@/lib/api/webhooks';
import messages from '../../../messages/en.json';

/**
 * Settings → Webhooks (EW-P1-5): list every subscription with the right
 * controls for its status, create a v2 subscription from the dialog, show the
 * signing secret once, and pause / resume / rotate through the server actions.
 */
const actions = vi.hoisted(() => ({
    createWebhook: vi.fn(),
    updateWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    rotateWebhookSecret: vi.fn(),
    testWebhook: vi.fn(),
    listWebhookDeliveries: vi.fn(),
    listWebhooks: vi.fn(),
    redeliverWebhook: vi.fn(),
}));
vi.mock('@/app/actions/webhooks', () => actions);

import { WebhooksSettings, eventPatternOptions } from './WebhooksSettings';

const ORG = { id: 'org-1', slug: 'acme', displayName: 'Acme' };

function render(ui: ReactElement) {
    return rtlRender(
        <NextIntlClientProvider locale="en" messages={messages}>
            {ui}
        </NextIntlClientProvider>,
    );
}

function sub(overrides: Partial<WebhookSubscription> = {}): WebhookSubscription {
    return {
        id: 'wh-1',
        accountId: 'acct-1',
        workId: null,
        url: 'https://hooks.example.com/ever',
        status: 'active',
        consecutiveFailures: 0,
        lastDeliveryAt: null,
        createdAt: '2026-10-16T00:00:00.000Z',
        updatedAt: '2026-10-16T00:00:00.000Z',
        version: 2,
        ownerType: 'user',
        events: ['task.*'],
        organizationIds: [ORG.id],
        excludeOriginTags: [],
        description: 'Gauzy sync',
        ...overrides,
    };
}

describe('WebhooksSettings', () => {
    beforeEach(() => {
        for (const fn of Object.values(actions)) fn.mockReset();
    });

    it('offers one <prefix>.* pattern per catalog domain', () => {
        expect(eventPatternOptions(['task.created', 'task.updated', 'team.created'])).toEqual([
            'task.*',
            'team.*',
        ]);
        expect(eventPatternOptions()).toContain('task.*');
    });

    it('lists subscriptions with status-appropriate controls', () => {
        render(
            <WebhooksSettings
                initialSubscriptions={[
                    sub(),
                    sub({
                        id: 'wh-2',
                        url: 'https://legacy.example.com',
                        version: 1,
                        events: null,
                        organizationIds: null,
                        status: 'failed',
                        consecutiveFailures: 10,
                    }),
                ]}
                organizations={[ORG]}
            />,
        );
        expect(screen.getByText('https://hooks.example.com/ever')).toBeTruthy();
        expect(screen.getByText('Acme')).toBeTruthy();
        expect(screen.getByText('Work & deployment (v1)')).toBeTruthy();
        expect(screen.getByText('10 failed in a row')).toBeTruthy();
        expect(screen.getAllByText('Pause')).toHaveLength(1);
        expect(screen.getAllByText('Resume')).toHaveLength(1);
    });

    it('resumes a failed subscription through PATCH status active', async () => {
        actions.updateWebhook.mockResolvedValue({
            success: true,
            subscription: sub({ status: 'active' }),
        });
        render(
            <WebhooksSettings
                initialSubscriptions={[sub({ status: 'failed' })]}
                organizations={[ORG]}
            />,
        );
        await act(async () => {
            fireEvent.click(screen.getByText('Resume'));
        });
        expect(actions.updateWebhook).toHaveBeenCalledWith('wh-1', { status: 'active' });
        expect(screen.getByText('Resumed')).toBeTruthy();
    });

    it('creates a v2 subscription and shows its secret once', async () => {
        actions.createWebhook.mockResolvedValue({
            success: true,
            subscription: sub({ id: 'wh-new' }),
            signingSecret: 'secret-shown-once-0123456789abcdef',
        });
        render(<WebhooksSettings initialSubscriptions={[]} organizations={[ORG]} />);
        fireEvent.click(screen.getByText('New webhook'));
        fireEvent.change(screen.getByPlaceholderText('https://example.com/ever-works'), {
            target: { value: 'https://hooks.example.com/ever' },
        });
        fireEvent.change(screen.getByPlaceholderText('gauzy:<connection-id>'), {
            target: { value: 'gauzy:conn-1, ' },
        });
        await act(async () => {
            fireEvent.click(screen.getByText('Create'));
        });
        expect(actions.createWebhook).toHaveBeenCalledWith({
            url: 'https://hooks.example.com/ever',
            description: null,
            organizationIds: ['org-1'],
            events: ['task.*'],
            excludeOriginTags: ['gauzy:conn-1'],
        });
        expect(screen.getByTestId('webhook-secret').textContent).toBe(
            'secret-shown-once-0123456789abcdef',
        );
        fireEvent.click(screen.getByText('Done'));
        expect(screen.queryByTestId('webhook-secret')).toBeNull();
    });

    // Review 2026-10-17 U6: Rotate and Delete ask first, and the secret names its subscription.
    it('asks before Rotate and Delete, warns for v1 and integration-owned ones, and labels the secret', async () => {
        const confirm = vi.spyOn(window, 'confirm');
        actions.rotateWebhookSecret.mockResolvedValue({
            success: true,
            signingSecret: 'rotated-1',
        });
        actions.deleteWebhook.mockResolvedValue({ success: true });
        render(
            <WebhooksSettings
                initialSubscriptions={[
                    sub({ id: 'wh-1', version: 1, ownerType: 'integration_key', ownerId: 'key-1' }),
                    sub({ id: 'wh-2', url: 'https://second.example.com/hook' }),
                ]}
                organizations={[ORG]}
            />,
        );
        confirm.mockReturnValueOnce(false);
        await act(async () => {
            fireEvent.click(screen.getAllByText('Rotate secret')[0]);
        });
        expect(actions.rotateWebhookSecret).not.toHaveBeenCalled();
        const question = confirm.mock.calls[0][0] as string;
        expect(question).toContain('https://hooks.example.com/ever');
        expect(question).toContain('v1 subscription');
        expect(question).toContain('Ever Gauzy');

        confirm.mockReturnValueOnce(true);
        await act(async () => {
            fireEvent.click(screen.getAllByText('Rotate secret')[0]);
        });
        expect(actions.rotateWebhookSecret).toHaveBeenCalledWith('wh-1');
        expect(screen.getByTestId('webhook-secret-for').textContent).toContain(
            'https://hooks.example.com/ever',
        );
        // One secret on screen at a time: another row's Rotate waits for Done.
        expect((screen.getAllByText('Rotate secret')[1] as HTMLButtonElement).disabled).toBe(true);

        confirm.mockReturnValueOnce(false);
        await act(async () => {
            fireEvent.click(screen.getAllByText('Delete')[1]);
        });
        expect(actions.deleteWebhook).not.toHaveBeenCalled();
        confirm.mockReturnValueOnce(true);
        await act(async () => {
            fireEvent.click(screen.getAllByText('Delete')[1]);
        });
        expect(actions.deleteWebhook).toHaveBeenCalledWith('wh-2');
        confirm.mockRestore();
    });

    it('refuses to submit without an organization', async () => {
        render(
            <WebhooksSettings
                initialSubscriptions={[]}
                organizations={[ORG, { id: 'org-2', slug: 'b', displayName: 'B' }]}
            />,
        );
        fireEvent.click(screen.getByText('New webhook'));
        fireEvent.change(screen.getByPlaceholderText('https://example.com/ever-works'), {
            target: { value: 'https://hooks.example.com/ever' },
        });
        await act(async () => {
            fireEvent.click(screen.getByText('Create'));
        });
        expect(screen.getByText('Pick at least one organization.')).toBeTruthy();
        expect(actions.createWebhook).not.toHaveBeenCalled();
    });

    it('shows a subscription deliveries and redelivers one', async () => {
        actions.listWebhookDeliveries.mockResolvedValue({
            success: true,
            deliveries: [
                {
                    id: 'dlv-1',
                    subscriptionId: 'wh-1',
                    event: 'task.updated',
                    status: 'failed',
                    attempts: 3,
                    lastResponseStatus: 500,
                    lastOutcome: 'server_error',
                    lastError: null,
                    durationMs: 12,
                    triggerRunId: null,
                    lastAttemptAt: null,
                    createdAt: '2026-10-16T00:00:00.000Z',
                    updatedAt: '2026-10-16T00:00:00.000Z',
                },
            ],
        });
        actions.redeliverWebhook.mockResolvedValue({ success: true, deliveryId: 'dlv-2' });
        render(<WebhooksSettings initialSubscriptions={[sub()]} organizations={[ORG]} />);
        await act(async () => {
            fireEvent.click(screen.getByText('Deliveries'));
        });
        expect(actions.listWebhookDeliveries).toHaveBeenCalledWith('wh-1');
        expect(screen.getByText('task.updated')).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByText('Redeliver'));
        });
        expect(actions.redeliverWebhook).toHaveBeenCalledWith('dlv-1');
        expect(screen.getByText('Re-sent')).toBeTruthy();
    });

    it('keeps Redeliver after a failed redelivery and shows the error beside it', async () => {
        actions.listWebhookDeliveries.mockResolvedValue({
            success: true,
            deliveries: [
                {
                    id: 'dlv-1',
                    subscriptionId: 'wh-1',
                    event: 'task.updated',
                    status: 'failed',
                    attempts: 3,
                    lastResponseStatus: 500,
                    lastOutcome: 'server_error',
                    lastError: null,
                    durationMs: 12,
                    triggerRunId: null,
                    lastAttemptAt: null,
                    createdAt: '2026-10-16T00:00:00.000Z',
                    updatedAt: '2026-10-16T00:00:00.000Z',
                },
            ],
        });
        actions.redeliverWebhook.mockResolvedValue({ success: false, error: 'Busy' });
        render(<WebhooksSettings initialSubscriptions={[sub()]} organizations={[ORG]} />);
        await act(async () => {
            fireEvent.click(screen.getByText('Deliveries'));
        });
        await act(async () => {
            fireEvent.click(screen.getByText('Redeliver'));
        });
        expect(screen.getByText('Redeliver failed: Busy')).toBeTruthy();
        expect(screen.getByText('Redeliver')).toBeTruthy();
    });

    it('re-reads the subscription after a test fire (a failure can fail it)', async () => {
        actions.testWebhook.mockResolvedValue({
            success: false,
            result: { ok: false, outcome: 'server_error', status: 500 },
        });
        actions.listWebhooks.mockResolvedValue({
            success: true,
            subscriptions: [sub({ status: 'failed', consecutiveFailures: 10 })],
        });
        render(<WebhooksSettings initialSubscriptions={[sub()]} organizations={[ORG]} />);
        await act(async () => {
            fireEvent.click(screen.getByText('Test'));
        });
        expect(screen.getByText('Failed: server_error (HTTP 500)')).toBeTruthy();
        expect(screen.getByText('Resume')).toBeTruthy();
        expect(screen.queryByText('Pause')).toBeNull();
    });

    it('says the list failed to load instead of "No webhooks yet"', () => {
        render(<WebhooksSettings initialSubscriptions={[]} organizations={[ORG]} loadFailed />);
        expect(screen.getByRole('alert').textContent).toContain('Could not load your webhooks');
        expect(screen.queryByText('No webhooks yet.')).toBeNull();
    });
});
