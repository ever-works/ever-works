import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { FleetNodeWakeAvailability } from '@ever-works/contracts';

vi.mock('next-intl', async () => {
    const { testTranslations } = await import('./fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});
// `Button` (95ac05a22) imports the locale-aware Link, whose `next-intl/navigation`
// loads `next/navigation`: not an ES module outside Next. Mocking `next-intl` alone leaves
// that path, so this file never loaded.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import { WakePanel } from './overview/WakePanel';

/**
 * Computer health, second phase (FL-03, spec S7, §5.5, U4, U6, U7, FR-26) —
 * the Wake panel: every disabled reason in words, then "Waking… listening",
 * and the 20 s / 60 s answers.
 */

const NODE = { id: 'n1', name: 'win-lab' };

function available(overrides: Partial<FleetNodeWakeAvailability> = {}): FleetNodeWakeAvailability {
    return {
        available: true,
        reason: null,
        via: { nodeId: 'n2', name: 'build-01' },
        lastWakeAttemptAt: null,
        ...overrides,
    };
}

const sent = {
    ok: true as const,
    data: {
        nodeId: 'n1',
        via: { nodeId: 'n2', name: 'build-01' },
        sentAt: '2026-10-21T10:00:00.000Z',
        listenUntil: '2026-10-21T10:01:00.000Z',
        checkAfterMs: [20_000, 60_000],
    },
};

function status(answered: boolean) {
    return {
        ok: true as const,
        data: {
            nodeId: 'n1',
            lastWakeAttemptAt: '2026-10-21T10:00:00.000Z',
            lastHeartbeatAt: answered ? '2026-10-21T10:00:30.000Z' : '2026-10-21T08:00:00.000Z',
            answered,
            listening: true,
        },
    };
}

describe('WakePanel', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('says which computer it would go through when it can wake', () => {
        render(
            <WakePanel
                node={NODE}
                availability={available()}
                sendWake={vi.fn()}
                readStatus={vi.fn()}
            />,
        );
        expect(screen.getByTestId('fleet-wake-button')).not.toBeDisabled();
        expect(screen.getByTestId('fleet-wake-line')).toHaveTextContent(
            'Can be woken from build-01 (same network)',
        );
    });

    it.each([
        ['no-sibling', "No online computer on win-lab's network can wake it"],
        ['no-hardware-address', 'win-lab has not reported a hardware address yet'],
        ['rate-limited', 'Already tried 3 times; give it a minute'],
        ['not-allowed', 'Ask the owner of win-lab to allow you: machines'],
        ['kill-switch', 'Live actions are paused while all computers are stopped'],
    ] as const)('is disabled with its reason for %s', (reason, text) => {
        render(
            <WakePanel
                node={NODE}
                availability={available({ available: false, reason, via: null })}
                sendWake={vi.fn()}
                readStatus={vi.fn()}
            />,
        );
        const button = screen.getByTestId('fleet-wake-button');
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute(
            'aria-describedby',
            screen.getByTestId('fleet-wake-line').id,
        );
        expect(screen.getByTestId('fleet-wake-line')).toHaveTextContent(text);
    });

    it('renders nothing for a computer that is not offline', () => {
        const { container } = render(
            <WakePanel
                node={NODE}
                availability={available({ available: false, reason: 'not-offline', via: null })}
                sendWake={vi.fn()}
                readStatus={vi.fn()}
            />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it('sends, listens, and says it is back when the 20 s check finds a beat', async () => {
        const sendWake = vi.fn(async () => sent);
        const readStatus = vi.fn(async () => status(true));
        const onBack = vi.fn();
        render(
            <WakePanel
                node={NODE}
                availability={available()}
                sendWake={sendWake}
                readStatus={readStatus}
                onBack={onBack}
            />,
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('fleet-wake-button'));
        });
        expect(sendWake).toHaveBeenCalledWith('n1');
        expect(screen.getByTestId('fleet-wake-line')).toHaveTextContent(
            'Waking… sent through build-01 · listening for win-lab',
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });
        expect(screen.getByTestId('fleet-wake-line')).toHaveTextContent(
            'win-lab is back · checked just now',
        );
        expect(onBack).toHaveBeenCalledTimes(1);
        // Back means the 60 s check never runs.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(readStatus).toHaveBeenCalledTimes(1);
    });

    it('says "not yet" at 20 s and "may be powered off" at 60 s, then offers Try again', async () => {
        const readStatus = vi.fn(async () => status(false));
        render(
            <WakePanel
                node={NODE}
                availability={available()}
                sendWake={vi.fn(async () => sent)}
                readStatus={readStatus}
            />,
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('fleet-wake-button'));
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(20_000);
        });
        expect(screen.getByTestId('fleet-wake-line')).toHaveTextContent(
            'win-lab has not answered yet',
        );
        expect(screen.getByTestId('fleet-wake-button')).toBeDisabled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(40_000);
        });
        expect(screen.getByTestId('fleet-wake-line')).toHaveTextContent(
            'win-lab has not answered — it may be powered off or on another network',
        );
        expect(screen.getByTestId('fleet-wake-button')).toHaveTextContent('Try again');
        expect(screen.getByTestId('fleet-wake-button')).not.toBeDisabled();
    });

    it('shows the refusal hint when the wake could not be sent', async () => {
        render(
            <WakePanel
                node={NODE}
                availability={available()}
                sendWake={vi.fn(async () => ({
                    ok: false as const,
                    error: 'Already tried 3 times; give it a minute',
                }))}
                readStatus={vi.fn()}
            />,
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('fleet-wake-button'));
        });
        expect(screen.getByTestId('fleet-wake-line')).toHaveTextContent(
            'Could not send the wake: Already tried 3 times; give it a minute',
        );
        expect(screen.getByRole('alert')).toBeInTheDocument();
    });
});
