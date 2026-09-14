import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
}));

import { WhatsNewButton } from './WhatsNewButton';

/**
 * What's new (AW-14) — the top-bar control. The badge is the only signal the
 * reader gets without opening anything, so it must never lie: no badge for
 * an unknown or zero count, `9+` above nine, and an accessible name that
 * carries the same number (spec FR-24, S-11, S-22).
 */
describe('WhatsNewButton', () => {
    function renderButton(unreadCount: number | null, isOpen = false) {
        const onOpen = vi.fn();
        render(<WhatsNewButton unreadCount={unreadCount} onOpen={onOpen} isOpen={isOpen} />);
        return { onOpen, button: screen.getByTestId('whats-new-button') };
    }

    it('FR-24: renders no badge when the count is 0', () => {
        renderButton(0);
        expect(screen.queryByTestId('whats-new-badge')).not.toBeInTheDocument();
    });

    it('S-11: renders no badge — and no 0 — when the count is unknown', () => {
        const { button } = renderButton(null);
        expect(screen.queryByTestId('whats-new-badge')).not.toBeInTheDocument();
        expect(button).not.toHaveTextContent('0');
    });

    it('FR-24: renders the count as-is up to 9', () => {
        renderButton(3);
        expect(screen.getByTestId('whats-new-badge')).toHaveTextContent(/^3$/);
    });

    it('FR-24: renders 9+ above 9', () => {
        renderButton(27);
        expect(screen.getByTestId('whats-new-badge')).toHaveTextContent(/^9\+$/);
    });

    it('S-22: the accessible name switches between controlLabel and controlLabelUnread', () => {
        const { button } = renderButton(0);
        expect(button).toHaveAttribute('aria-label', 'controlLabel');
    });

    it('S-22: the accessible name carries the badge value when there is unread', () => {
        const { button } = renderButton(27);
        expect(button).toHaveAttribute('aria-label', 'controlLabelUnread:{"count":"9+"}');
    });

    it('FR-51: aria-expanded follows isOpen and the control announces a dialog', () => {
        const { button } = renderButton(1, true);
        expect(button).toHaveAttribute('aria-expanded', 'true');
        expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    });

    it('opens on activation and never on render', () => {
        const { onOpen, button } = renderButton(2);
        expect(onOpen).not.toHaveBeenCalled();
        fireEvent.click(button);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });
});
