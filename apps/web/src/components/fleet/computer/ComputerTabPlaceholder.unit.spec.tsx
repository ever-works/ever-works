import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComputerTabPlaceholder } from './ComputerTabPlaceholder';

/**
 * Fleet hub (FL-01, FR-18 – FR-20, U4 – U6, ACC-FL01-10) — the four things a
 * computer tab says instead of its content, each one sentence, never a
 * spinner; the missing consent is named with the exact command to copy.
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));

describe('ComputerTabPlaceholder', () => {
    it('names the epic a tab arrives with, with the tracker link', () => {
        render(
            <ComputerTabPlaceholder
                tab="logs"
                nodeName="build-01"
                state={{ kind: 'not-shipped', epic: 'FL-08' }}
            />,
        );
        const status = screen.getByRole('status');
        expect(status).toHaveAttribute('data-state', 'not-shipped');
        expect(status).toHaveTextContent('placeholder.notShipped:tabs.logs,FL-08,logs');
        expect(screen.getByRole('link', { name: 'placeholder.tracker' })).toHaveAttribute(
            'target',
            '_blank',
        );
    });

    it('says a shipped tab is switched off on this deployment', () => {
        render(
            <ComputerTabPlaceholder
                tab="logs"
                nodeName="build-01"
                state={{ kind: 'switched-off', epic: 'FL-08' }}
            />,
        );
        expect(screen.getByRole('status')).toHaveTextContent(
            'placeholder.switchedOff:tabs.logs,logs',
        );
    });

    it('names the missing consent and offers the exact command to copy', async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        render(
            <ComputerTabPlaceholder
                tab="logs"
                nodeName="build-01"
                state={{
                    kind: 'consent-missing',
                    consent: 'manage',
                    command: 'ever-works-node start --manage',
                }}
            />,
        );
        expect(screen.getByRole('status')).toHaveTextContent(
            'placeholder.consentMissing:--manage,build-01,tabs.logs',
        );
        expect(screen.getByTestId('fleet-computer-consent-command')).toHaveTextContent(
            'ever-works-node start --manage',
        );
        await userEvent.click(screen.getByTestId('fleet-computer-consent-copy'));
        await waitFor(() =>
            expect(writeText).toHaveBeenCalledWith('ever-works-node start --manage'),
        );
        expect(screen.getByTestId('fleet-computer-consent-copy')).toHaveTextContent(
            'placeholder.copied',
        );
    });

    it('says a kind of computer cannot do it yet (R-10)', () => {
        render(
            <ComputerTabPlaceholder
                tab="desktop"
                nodeName="design-mac"
                state={{ kind: 'kind-cannot' }}
            />,
        );
        expect(screen.getByRole('status')).toHaveTextContent('placeholder.kindCannot');
    });
});
