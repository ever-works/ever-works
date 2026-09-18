import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { SchedulesCreateMenu } from './SchedulesCreateMenu';

const T = 'dashboard.schedules';
const T_TRIGGERS = 'dashboard.triggers';

async function openMenu() {
    fireEvent.click(screen.getByTestId('schedules-create'));
    await waitFor(() =>
        expect(screen.getByTestId('schedules-create-inbound-trigger')).toBeTruthy(),
    );
}

/**
 * The list's Create control.
 *
 * It exists because a Schedule has no create form of its own — every row is a
 * view of a recurring setting owned by a Task, an Agent, a Work or an inbound
 * trigger — so "Create" is the four doors, not one form. Pinned here because
 * the menu is rendered from the list header, which the workspace's own spec
 * mocks away: nothing else would notice if it stopped opening.
 */
describe('SchedulesCreateMenu', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('opens on the trigger and offers the three owner surfaces by link', async () => {
        render(<SchedulesCreateMenu />);
        expect(screen.getByTestId('schedules-create')).toBeTruthy();

        await openMenu();

        // Each door is the screen that already owns that setting, so nothing is
        // created here that could only be created here.
        for (const href of ['/tasks', '/agents', '/works']) {
            const entry = screen.getByTestId(`schedules-create-${href}`);
            expect(entry.getAttribute('href')).toBe(href);
            expect(entry.textContent).toBeTruthy();
        }
    });

    it('asks the host to open the inbound-trigger dialog in place', async () => {
        const onNewTrigger = vi.fn();
        render(<SchedulesCreateMenu onNewTrigger={onNewTrigger} />);
        await openMenu();

        // A link would navigate away from the list; the trigger form is already
        // on this page, so the menu opens it instead.
        const entry = screen.getByTestId('schedules-create-inbound-trigger');
        expect(entry.getAttribute('href')).toBeNull();
        expect(entry.textContent).toContain(`${T_TRIGGERS}.new`);

        fireEvent.click(entry);
        expect(onNewTrigger).toHaveBeenCalledTimes(1);
    });

    it('still opens when no host is listening — the menu never throws', async () => {
        render(<SchedulesCreateMenu />);
        await openMenu();

        expect(() =>
            fireEvent.click(screen.getByTestId('schedules-create-inbound-trigger')),
        ).not.toThrow();
    });

    it('says what the inbound-trigger door is, so it is not a mystery entry', async () => {
        render(<SchedulesCreateMenu />);
        await openMenu();

        // The label carries the name; the hint sits beside it (the item itself
        // takes no test id, so the two are asserted separately).
        expect(screen.getByTestId('schedules-create-inbound-trigger').textContent).toBe(
            `${T_TRIGGERS}.new`,
        );
        expect(screen.getByText(`${T}.create.inboundTriggerHint`)).toBeTruthy();
    });
});
