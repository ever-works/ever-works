import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { MessageRetryBar, failureMessageKey, formatKilobytes } from './MessageRetryBar';

/**
 * A message that did not send must say why in plain language and offer Retry
 * and Discard (FR-42..FR-46). Rate limits, provider outages and a dropped
 * connection each read differently, because what the person should do next is
 * different for each.
 */
describe('MessageRetryBar', () => {
    afterEach(cleanup);

    it('maps every failure reason to its own line, never a raw code', () => {
        expect(failureMessageKey('rate_limited')).toBe('rateLimited');
        expect(failureMessageKey('provider_unavailable')).toBe('providerUnavailable');
        expect(failureMessageKey('offline')).toBe('offline');
        expect(failureMessageKey('network')).toBe('network');
        expect(failureMessageKey('secret_detected')).toBe('secretDetected');
        expect(failureMessageKey('too_large')).toBe('tooLong');
        expect(failureMessageKey('capacity_limited')).toBe('capacityLimited');
        expect(failureMessageKey('budget_exceeded')).toBe('budgetRefused');
        expect(failureMessageKey('forbidden')).toBe('forbidden');
        expect(failureMessageKey(null)).toBe('providerUnavailable');
    });

    it('renders the rate-limit line with Retry and Discard', () => {
        const onRetry = vi.fn();
        const onDiscard = vi.fn();
        render(
            <MessageRetryBar
                failureCode="rate_limited"
                agentName="Nova"
                onRetry={onRetry}
                onDiscard={onDiscard}
            />,
        );
        expect(screen.getByRole('alert')).toHaveTextContent('rateLimited');
        fireEvent.click(screen.getByRole('button', { name: 'retry' }));
        fireEvent.click(screen.getByRole('button', { name: 'discard' }));
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onDiscard).toHaveBeenCalledTimes(1);
    });

    it('names the Agent and links to its caps when its budget refused the reply', () => {
        render(
            <MessageRetryBar
                failureCode="budget_exceeded"
                agentName="Nova"
                agentId="agent-1"
                onRetry={vi.fn()}
                onDiscard={vi.fn()}
            />,
        );
        expect(screen.getByRole('alert')).toHaveTextContent('budgetRefused:{"agent":"Nova"}');
        expect(screen.getByRole('link', { name: 'openCaps' })).toHaveAttribute(
            'href',
            '/agents/agent-1/budgets',
        );
    });

    it('states the actual size of a body that is too long and offers attaching it', () => {
        const onAttachInstead = vi.fn();
        render(
            <MessageRetryBar
                failureCode="too_large"
                agentName="Nova"
                size={40 * 1024}
                onRetry={vi.fn()}
                onDiscard={vi.fn()}
                onAttachInstead={onAttachInstead}
            />,
        );
        expect(screen.getByRole('alert')).toHaveTextContent(
            'tooLong:{"size":"40 KB","max":"16 KB"}',
        );
        fireEvent.click(screen.getByRole('button', { name: 'attachInstead' }));
        expect(onAttachInstead).toHaveBeenCalledTimes(1);
    });

    it('shows Sending… and no actions while a Retry is on its way, so it cannot be tapped twice', () => {
        render(
            <MessageRetryBar
                failureCode="network"
                agentName="Nova"
                sending
                onRetry={vi.fn()}
                onDiscard={vi.fn()}
            />,
        );
        expect(screen.getByRole('status')).toHaveTextContent('sending');
        expect(screen.queryByRole('button', { name: 'retry' })).toBeNull();
    });

    it('retries with Ctrl+Enter on the focused Retry, once', () => {
        const onRetry = vi.fn();
        render(
            <MessageRetryBar
                failureCode="offline"
                agentName="Nova"
                onRetry={onRetry}
                onDiscard={vi.fn()}
            />,
        );
        fireEvent.keyDown(screen.getByRole('button', { name: 'retry' }), {
            key: 'Enter',
            ctrlKey: true,
        });
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('rounds sizes up so a body just over the cap never reads as equal to it', () => {
        expect(formatKilobytes(16 * 1024 + 1)).toBe('17 KB');
    });
});
