import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock('@/components/ai/conversations/ConversationEntryButtons', () => ({
    ChatAboutButton: () => <button type="button">chat</button>,
}));
vi.mock('./RequestChangeDialog', () => ({
    RequestChangeDialog: () => <button type="button">request-change</button>,
}));
vi.mock('./WorkCostSummary', () => ({ WorkCostSummary: () => null }));

import { AppWorkOverviewCard } from './AppWorkOverviewCard';

/**
 * APW-08 T49 (FR-74, R-30, S34) — with the operator's change switch off, the App Work's Overview
 * says "Changes to apps are paused by the operator." and offers no change request; everything else
 * on the card stays readable.
 */
describe('AppWorkOverviewCard — the operator switch banner (APW-08 T49)', () => {
    const base = { workId: 'w1', workName: 'Bookings', upstreamState: null, appSpec: null };

    it('changes on (the default): no banner, and Request a change is offered', () => {
        render(<AppWorkOverviewCard {...base} />);
        expect(screen.queryByTestId('app-work-changes-paused')).toBeNull();
        expect(screen.getByText('request-change')).toBeTruthy();
    });

    it('changes off: the banner is a polite status and Request a change is not offered', () => {
        render(<AppWorkOverviewCard {...base} changesPaused />);
        const banner = screen.getByTestId('app-work-changes-paused');
        expect(banner.textContent).toBe('changesPaused');
        expect(banner.getAttribute('role')).toBe('status');
        expect(screen.queryByText('request-change')).toBeNull();
        // The rest of the card is still there: the chat entry stays readable.
        expect(screen.getByText('chat')).toBeTruthy();
    });
});
