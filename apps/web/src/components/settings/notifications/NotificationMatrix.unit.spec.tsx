import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { NotificationMatrixDto, NotificationMatrixEventDto } from '@ever-works/contracts';

const MESSAGES: Record<string, string> = {
    title: 'Notification Preferences',
    'columns.inApp': 'In-app',
    'columns.email': 'Email',
    switchLabel: '{event} → {column}',
    'rowState.saving': 'Saving…',
    'rowState.saved': 'Saved',
    'rowState.failed': "Couldn't save",
    'rowState.retry': 'Try again',
    'errors.tooManyTargets': 'An event can be sent to at most {max} places. Turn one off first.',
    'errors.load': "Couldn't load your notification settings. Nothing has changed.",
    'emptyState.title': 'Nothing to configure yet',
    'announce.saved': 'Saved',
    'announce.failed': "Couldn't save {event}",
};

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) => {
        let text = MESSAGES[key] ?? key;
        for (const [name, value] of Object.entries(values ?? {})) {
            text = text.replace(`{${name}}`, String(value));
        }
        return text;
    },
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const { setTargets, loadMatrix, resetMatrix, unmute, setQuietHours } = vi.hoisted(() => ({
    setTargets: vi.fn(),
    loadMatrix: vi.fn(),
    resetMatrix: vi.fn(),
    unmute: vi.fn(),
    setQuietHours: vi.fn(),
}));
vi.mock('@/app/actions/notification-preferences', () => ({
    setNotificationEventTargets: (...args: unknown[]) => setTargets(...args),
    loadNotificationMatrix: (...args: unknown[]) => loadMatrix(...args),
    resetNotificationMatrix: (...args: unknown[]) => resetMatrix(...args),
    unmuteNotificationCategory: (...args: unknown[]) => unmute(...args),
    setNotificationQuietHours: (...args: unknown[]) => setQuietHours(...args),
}));

import { NotificationMatrix } from './NotificationMatrix';
import { NotificationPreferencesSettings } from '../NotificationPreferencesSettings';

function ev(
    key: string,
    title: string,
    over: Partial<NotificationMatrixEventDto> = {},
): NotificationMatrixEventDto {
    return {
        key,
        group: 'signals',
        category: 'generation',
        muteCategory: 'generation',
        title,
        description: `${title} description`,
        alternativeSurface: null,
        urgent: false,
        source: 'core',
        pluginId: null,
        inAppLocked: false,
        emailGovernedByProfile: false,
        defaultTargets: ['in-app'],
        selectedTargets: ['in-app'],
        explicit: false,
        mutedUntil: null,
        muted: false,
        ...over,
    };
}

function matrix(over: Partial<NotificationMatrixDto> = {}): NotificationMatrixDto {
    return {
        columns: [
            {
                id: 'in-app',
                kind: 'in-app',
                label: '',
                providerLabel: null,
                pluginId: null,
                disabled: false,
                disabledReason: null,
                createdAt: null,
            },
            {
                id: 'email',
                kind: 'email',
                label: '',
                providerLabel: null,
                pluginId: null,
                disabled: false,
                disabledReason: null,
                createdAt: null,
            },
        ],
        events: [
            ev('agent_run_escalated', 'Agent needs a decision', {
                group: 'needsYou',
                urgent: true,
                inAppLocked: true,
                selectedTargets: ['in-app', 'email'],
                defaultTargets: ['in-app', 'email'],
            }),
            ev('generation_error', 'Generation failed'),
            ev('agent_run_finished', 'Agent run finished', {
                group: 'routine',
                alternativeSurface: 'liveFeedRunsHome',
            }),
        ],
        quietHours: { start: null, end: null, timezone: null },
        mutes: [],
        email: { availability: 'available', profileBudgetAlerts: true },
        budgets: [],
        limits: { maxTargets: 20, maxColumns: 6 },
        ...over,
    };
}

const box = (name: string) => screen.getByRole('checkbox', { name });

describe('NotificationMatrix', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        setTargets.mockReset();
        setTargets.mockImplementation(async (_key: string, ids: string[]) => ({
            success: true,
            data: { targetIds: ids },
        }));
        loadMatrix.mockReset();
        loadMatrix.mockResolvedValue({ success: true, data: matrix() });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders one switch per event and column with the existing accessible names', () => {
        render(<NotificationMatrix initialMatrix={matrix()} />);
        expect(
            screen.getByRole('heading', { level: 1, name: 'Notification Preferences' }),
        ).toBeTruthy();
        expect(box('Agent run finished → In-app').getAttribute('aria-checked')).toBe('true');
        expect(box('Agent run finished → Email').getAttribute('aria-checked')).toBe('false');
        expect(screen.getAllByRole('checkbox')).toHaveLength(6);
    });

    it('turns four rapid clicks on one switch into exactly one write carrying the final position', async () => {
        render(<NotificationMatrix initialMatrix={matrix()} />);
        const email = box('Generation failed → Email');
        for (let i = 0; i < 4; i++) fireEvent.click(email);
        expect(email.getAttribute('aria-checked')).toBe('false');
        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(setTargets).toHaveBeenCalledTimes(1);
        expect(setTargets).toHaveBeenCalledWith('generation_error', ['in-app']);
    });

    it('collapses an odd burst of clicks into one write with the switch on, then clears "Saved"', async () => {
        render(<NotificationMatrix initialMatrix={matrix()} />);
        const email = box('Generation failed → Email');
        for (let i = 0; i < 5; i++) fireEvent.click(email);
        expect(email.getAttribute('aria-checked')).toBe('true');
        expect(screen.getByText('Saving…')).toBeTruthy();
        expect(setTargets).not.toHaveBeenCalled();

        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(setTargets).toHaveBeenCalledTimes(1);
        expect(setTargets).toHaveBeenCalledWith('generation_error', ['in-app', 'email']);
        expect(screen.getAllByText('Saved').length).toBeGreaterThan(0);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(2_000);
        });
        expect(screen.queryByText('Saving…')).toBeNull();
    });

    it('saves an explicit "nothing" when every switch in a row is turned off', async () => {
        render(<NotificationMatrix initialMatrix={matrix()} />);
        fireEvent.click(box('Generation failed → In-app'));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(setTargets).toHaveBeenCalledWith('generation_error', []);
    });

    it('reverts only the row whose write failed; the other row keeps its change', async () => {
        setTargets.mockImplementation(async (key: string, ids: string[]) =>
            key === 'generation_error'
                ? { success: false, error: 'boom' }
                : { success: true, data: { targetIds: ids } },
        );
        render(<NotificationMatrix initialMatrix={matrix()} />);
        fireEvent.click(box('Generation failed → Email'));
        fireEvent.click(box('Agent run finished → Email'));

        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
        });

        expect(box('Generation failed → Email').getAttribute('aria-checked')).toBe('false');
        expect(box('Agent run finished → Email').getAttribute('aria-checked')).toBe('true');
        expect(screen.getByText("Couldn't save")).toBeTruthy();
        expect(screen.getByRole('status').textContent).toBe('Saved');
    });

    it('treats a write that has not resolved within 8 seconds as failed and reverts the row', async () => {
        setTargets.mockImplementation(() => new Promise(() => undefined));
        render(<NotificationMatrix initialMatrix={matrix()} />);
        fireEvent.click(box('Generation failed → Email'));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(400 + 8_000);
        });
        expect(box('Generation failed → Email').getAttribute('aria-checked')).toBe('false');
        expect(screen.getByText("Couldn't save")).toBeTruthy();
        expect(screen.getByRole('status').textContent).toBe("Couldn't save Generation failed");
    });

    it('never moves a locked switch', async () => {
        render(<NotificationMatrix initialMatrix={matrix()} />);
        const locked = box('Agent needs a decision → In-app');
        expect(locked.getAttribute('aria-disabled')).toBe('true');
        fireEvent.click(locked);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(setTargets).not.toHaveBeenCalled();
        expect(locked.getAttribute('aria-checked')).toBe('true');
    });

    it('refuses a target beyond the limit, naming the number, and writes nothing', async () => {
        render(
            <NotificationMatrix
                initialMatrix={matrix({ limits: { maxTargets: 1, maxColumns: 6 } })}
            />,
        );
        fireEvent.click(box('Generation failed → Email'));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(setTargets).not.toHaveBeenCalled();
        expect(
            screen.getByText('An event can be sent to at most 1 places. Turn one off first.'),
        ).toBeTruthy();
        expect(box('Generation failed → Email').getAttribute('aria-checked')).toBe('false');
    });

    describe('keyboard', () => {
        it('holds a single tab stop and moves it with the arrow keys', () => {
            render(<NotificationMatrix initialMatrix={matrix()} />);
            const tabbable = () =>
                screen.getAllByRole('checkbox').filter((el) => el.tabIndex === 0);
            expect(tabbable()).toHaveLength(1);
            expect(tabbable()[0]).toBe(box('Agent needs a decision → In-app'));

            fireEvent.keyDown(box('Agent needs a decision → In-app'), { key: 'ArrowRight' });
            expect(tabbable()).toEqual([box('Agent needs a decision → Email')]);

            fireEvent.keyDown(box('Agent needs a decision → Email'), { key: 'ArrowDown' });
            expect(tabbable()).toEqual([box('Generation failed → Email')]);

            fireEvent.keyDown(box('Generation failed → Email'), { key: 'End', ctrlKey: true });
            expect(tabbable()).toEqual([box('Agent run finished → Email')]);
        });

        it('toggles with Space and Enter', async () => {
            render(<NotificationMatrix initialMatrix={matrix()} />);
            fireEvent.keyDown(box('Generation failed → Email'), { key: ' ' });
            expect(box('Generation failed → Email').getAttribute('aria-checked')).toBe('true');
            fireEvent.keyDown(box('Generation failed → Email'), { key: 'Enter' });
            expect(box('Generation failed → Email').getAttribute('aria-checked')).toBe('false');
        });

        it('flips the whole row with Shift+Space in one write', async () => {
            render(<NotificationMatrix initialMatrix={matrix()} />);
            // In-app is on, so the row goes to "nothing".
            fireEvent.keyDown(box('Generation failed → In-app'), { key: ' ', shiftKey: true });
            expect(box('Generation failed → In-app').getAttribute('aria-checked')).toBe('false');
            expect(box('Generation failed → Email').getAttribute('aria-checked')).toBe('false');
            await act(async () => {
                await vi.advanceTimersByTimeAsync(400);
            });
            expect(setTargets).toHaveBeenCalledTimes(1);
            expect(setTargets).toHaveBeenCalledWith('generation_error', []);
        });
    });

    it('refetches and takes the server’s values when the page returns after 30 seconds away', async () => {
        const base = matrix();
        const fresh: NotificationMatrixDto = {
            ...base,
            events: base.events.map((e) =>
                e.key === 'generation_error'
                    ? { ...e, selectedTargets: ['in-app', 'email'], explicit: true }
                    : e,
            ),
        };
        loadMatrix.mockResolvedValue({ success: true, data: fresh });
        render(<NotificationMatrix initialMatrix={matrix()} />);

        const visibility = vi.spyOn(document, 'visibilityState', 'get');
        visibility.mockReturnValue('hidden');
        fireEvent(document, new Event('visibilitychange'));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(31_000);
        });
        visibility.mockReturnValue('visible');
        await act(async () => {
            fireEvent(document, new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(0);
        });

        expect(loadMatrix).toHaveBeenCalledTimes(1);
        expect(box('Generation failed → Email').getAttribute('aria-checked')).toBe('true');
        visibility.mockRestore();
    });
});

describe('NotificationPreferencesSettings', () => {
    it('keeps the page heading and shows a load error that promises nothing changed', () => {
        render(<NotificationPreferencesSettings initialMatrix={null} />);
        expect(
            screen.getByRole('heading', { level: 1, name: 'Notification Preferences' }),
        ).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toContain('Nothing has changed.');
    });

    it('explains an empty registry instead of rendering an empty table', () => {
        render(<NotificationPreferencesSettings initialMatrix={matrix({ events: [] })} />);
        expect(screen.getByText('Nothing to configure yet')).toBeTruthy();
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    });
});
