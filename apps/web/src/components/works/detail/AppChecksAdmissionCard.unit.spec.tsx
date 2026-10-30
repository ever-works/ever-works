import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
        vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccess(...args),
        error: (...args: unknown[]) => toastError(...args),
    },
}));

const refresh = vi.fn();
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ refresh, push: vi.fn() }),
    // `@/components/ui/button` re-wraps `Link` from the same module.
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

const getAppSpecChecksAction = vi.fn();
vi.mock('@/app/actions/dashboard/app-spec', () => ({
    getAppSpecChecksAction: (...args: unknown[]) => getAppSpecChecksAction(...args),
}));

const updateRepoDeclaredCommands = vi.fn();
const updateQualityGatesSettings = vi.fn();
vi.mock('@/app/actions/dashboard/works', () => ({
    updateRepoDeclaredCommands: (...args: unknown[]) => updateRepoDeclaredCommands(...args),
    updateQualityGatesSettings: (...args: unknown[]) => updateQualityGatesSettings(...args),
}));

let work: Record<string, unknown> = {};
vi.mock('./settings/SettingsContext', () => ({
    useSettings: () => ({ context: { work } }),
}));

import { AppChecksAdmissionCard } from './AppChecksAdmissionCard';
import { QualityGatesSettings } from './settings/QualityGatesSettings';

/**
 * APW-08 T14 (FR-14) — the App checks review surface: the App spec's checks with
 * their admitted state, and **Admit for my machines**, which writes the Work's
 * existing EW-807 allow-list through the Work update path. App Works only.
 */
describe('AppChecksAdmissionCard', () => {
    const CHECKS = [
        { name: 'type-check', command: 'pnpm type-check', required: true },
        { name: 'e2e', command: 'pnpm   e2e', required: false },
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        getAppSpecChecksAction.mockResolvedValue({ success: true, checks: CHECKS });
        updateRepoDeclaredCommands.mockResolvedValue({ success: true });
        work = {
            id: 'work-app',
            kind: 'app',
            checksPolicy: 'required',
            maxGateAttempts: 2,
            checkDefaults: null,
            repoDeclaredCommands: { mode: 'allowlist', allow: ['pnpm lint', 'pnpm type-check'] },
        };
    });

    it('renders admitted and not-admitted rows with their text', async () => {
        render(
            <AppChecksAdmissionCard
                workId="work-app"
                policy={{ mode: 'allowlist', allow: ['pnpm type-check'] }}
            />,
        );

        const admitted = await screen.findByTestId('app-check-row-0');
        const notAdmitted = screen.getByTestId('app-check-row-1');
        expect(getAppSpecChecksAction).toHaveBeenCalledWith('work-app');

        expect(admitted.getAttribute('data-admitted')).toBe('true');
        expect(admitted.textContent).toContain('type-check');
        expect(admitted.textContent).toContain('pnpm type-check');
        expect(admitted.textContent).toContain('required');
        expect(admitted.textContent).toContain('admitted');
        expect(admitted.textContent).not.toContain('notAdmitted');
        expect(screen.queryByTestId('app-check-admit-0')).toBeNull();

        expect(notAdmitted.getAttribute('data-admitted')).toBe('false');
        expect(notAdmitted.textContent).toContain('e2e');
        expect(notAdmitted.textContent).toContain('advisory');
        expect(notAdmitted.textContent).toContain('notAdmitted');
        // The command shown is the one the Fleet planner compares: whitespace collapsed.
        expect(notAdmitted.textContent).toContain('pnpm e2e');
        expect(screen.getByTestId('app-check-admit-1').textContent).toBe('admit');
    });

    it('lists every check not admitted while the Work reads no repository commands', async () => {
        render(<AppChecksAdmissionCard workId="work-app" policy={null} />);
        await screen.findByTestId('app-check-row-0');
        expect(screen.getByTestId('app-check-row-0').getAttribute('data-admitted')).toBe('false');
        expect(screen.getByTestId('app-check-row-1').getAttribute('data-admitted')).toBe('false');
    });

    it('Admit for my machines sends exactly the listed command, added to the existing allow-list', async () => {
        const user = userEvent.setup();
        render(
            <AppChecksAdmissionCard
                workId="work-app"
                policy={{ mode: 'allowlist', allow: ['pnpm lint', 'pnpm type-check'] }}
            />,
        );
        await user.click(await screen.findByTestId('app-check-admit-1'));

        expect(updateRepoDeclaredCommands).toHaveBeenCalledTimes(1);
        expect(updateRepoDeclaredCommands).toHaveBeenCalledWith('work-app', {
            mode: 'allowlist',
            allow: ['pnpm lint', 'pnpm type-check', 'pnpm e2e'],
        });
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('admitSaved'));
        expect(refresh).toHaveBeenCalled();
        await waitFor(() =>
            expect(screen.getByTestId('app-check-row-1').getAttribute('data-admitted')).toBe('true'),
        );
    });

    it('turns the allow-list on when the Work had it off, admitting only that command', async () => {
        const user = userEvent.setup();
        render(
            <AppChecksAdmissionCard workId="work-app" policy={{ mode: 'off', allow: [] }} />,
        );
        await user.click(await screen.findByTestId('app-check-admit-0'));
        expect(updateRepoDeclaredCommands).toHaveBeenCalledWith('work-app', {
            mode: 'allowlist',
            allow: ['pnpm type-check'],
        });
    });

    it('says so when the write is refused, and leaves the row not admitted', async () => {
        updateRepoDeclaredCommands.mockResolvedValue({ success: false, error: 'nope' });
        const user = userEvent.setup();
        render(<AppChecksAdmissionCard workId="work-app" policy={null} />);
        await user.click(await screen.findByTestId('app-check-admit-0'));
        await waitFor(() => expect(toastError).toHaveBeenCalledWith('admitFailed'));
        expect(screen.getByTestId('app-check-row-0').getAttribute('data-admitted')).toBe('false');
    });

    it('renders the empty and the load-failed states', async () => {
        getAppSpecChecksAction.mockResolvedValueOnce({ success: true, checks: [] });
        const { unmount } = render(<AppChecksAdmissionCard workId="work-app" policy={null} />);
        expect(await screen.findByText('empty')).toBeTruthy();
        unmount();

        getAppSpecChecksAction.mockResolvedValueOnce({ success: false, checks: null });
        render(<AppChecksAdmissionCard workId="work-app" policy={null} />);
        expect(await screen.findByText('loadFailed')).toBeTruthy();
    });

    describe('mounted by QualityGatesSettings', () => {
        it('is present for an App Work', async () => {
            render(<QualityGatesSettings />);
            expect(screen.getByTestId('app-checks-admission-card')).toBeTruthy();
            // T11's checks-change notification links to `/works/<id>/settings#app-checks`.
            expect(screen.getByTestId('app-checks-admission-card').id).toBe('app-checks');
            expect(document.getElementById('app-checks')).toBe(
                screen.getByTestId('app-checks-admission-card'),
            );
            await screen.findByTestId('app-check-row-0');
        });

        it.each([['website'], ['directory'], ['repo'], ['default']])(
            'is absent for a %s Work',
            (kind) => {
                work = { ...work, kind };
                render(<QualityGatesSettings />);
                expect(screen.getByTestId('quality-gates-settings')).toBeTruthy();
                expect(screen.queryByTestId('app-checks-admission-card')).toBeNull();
                expect(getAppSpecChecksAction).not.toHaveBeenCalled();
            },
        );
    });
});
