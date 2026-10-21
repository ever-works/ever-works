import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../../../../../../messages/en.json';
import type { AppEnvListResponse, AppEnvVariableView } from '@/lib/api/app-env.types';

/**
 * Lane aw-env-smtp (APW-07 T24) — the Deploy tab's **Environment** card and its edit dialog, rendered
 * with the REAL English catalogue; the two server actions are mocked at their module boundary.
 */

const { getMock, updateMock, toastSuccess } = vi.hoisted(() => ({
    getMock: vi.fn(),
    updateMock: vi.fn(),
    toastSuccess: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/app-env', () => ({
    getAppEnvAction: getMock,
    updateAppEnvAction: updateMock,
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children }: { href: string; children: ReactNode }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { AppEnvironmentCard } from './AppEnvironmentCard';

const WORK_ID = '5a07fa3f-367a-444e-9d1e-311d03cc1327';

function entry(over: Partial<AppEnvVariableView>): AppEnvVariableView {
    return {
        name: 'X',
        declared: true,
        source: 'prompt',
        origin: null,
        overrides: null,
        secret: false,
        phase: 'runtime',
        required: false,
        set: false,
        description: null,
        group: null,
        reference: null,
        specValue: null,
        validation: null,
        generator: null,
        generatorChanged: false,
        publicPrefixWarning: false,
        publicValue: null,
        changedSinceBuild: false,
        changedSinceDeploy: false,
        updatedAt: null,
        updatedBy: null,
        masked: false,
        dependency: null,
        editable: true,
        ...over,
    };
}

function env(over: Partial<AppEnvListResponse> = {}): AppEnvListResponse {
    const entries = over.entries ?? [
        entry({
            name: 'FIXTURE_MARKER',
            required: true,
            description: 'Any text; GET /marker returns it',
        }),
        entry({
            name: 'FIXTURE_MAIL_TO',
            required: true,
            description: 'Address POST /mail/test sends to',
        }),
        entry({
            name: 'SMTP_HOST',
            source: 'from',
            reference: 'deps.smtp.host',
            dependency: { kind: 'smtp', output: 'host' },
        }),
        entry({
            name: 'SMTP_PASSWORD',
            source: 'from',
            secret: true,
            masked: true,
            reference: 'deps.smtp.password',
            dependency: { kind: 'smtp', output: 'password' },
        }),
        entry({
            name: 'FIXTURE_SESSION_SECRET',
            source: 'generate',
            secret: true,
            masked: true,
            set: true,
            origin: 'generated',
            editable: false,
        }),
    ];
    return {
        workId: WORK_ID,
        secureStorage: true,
        canEdit: true,
        summary: { total: entries.length, set: 1, missingRequired: 2, missingRequiredBuild: 0 },
        entries,
        ...over,
    };
}

function renderCard(initialEnv: AppEnvListResponse | null = env()) {
    render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <AppEnvironmentCard workId={WORK_ID} initialEnv={initialEnv} />
        </NextIntlClientProvider>,
    );
}

function row(name: string): HTMLElement {
    const found = screen
        .getAllByTestId('app-env-row')
        .find((element) => element.dataset.name === name);
    if (!found) throw new Error(`no row ${name}`);
    return found;
}

describe('AppEnvironmentCard', () => {
    beforeEach(() => {
        getMock.mockReset();
        updateMock.mockReset();
        toastSuccess.mockReset();
        getMock.mockResolvedValue({ success: true, data: env() });
    });
    afterEach(() => cleanup());

    it('lists every variable with its state, the missing required ones first', () => {
        renderCard();

        expect(screen.getByTestId('app-env-summary').textContent).toContain('1 of 5 set');
        expect(screen.getByTestId('app-env-summary').textContent).toContain(
            '2 required values are missing',
        );
        const names = screen.getAllByTestId('app-env-row').map((element) => element.dataset.name);
        expect(names.slice(0, 2)).toEqual(['FIXTURE_MARKER', 'FIXTURE_MAIL_TO']);

        expect(
            within(row('FIXTURE_MARKER')).getByTestId('app-env-row-state').textContent,
        ).toContain('Required — not set');
        expect(within(row('SMTP_HOST')).getByTestId('app-env-row-state').textContent).toBe(
            'Injected by SMTP mail',
        );
        expect(within(row('SMTP_PASSWORD')).getByText('Secret')).toBeTruthy();
        expect(
            within(row('FIXTURE_SESSION_SECRET')).getByTestId('app-env-row-state').textContent,
        ).toBe('Generated');
        // A generated value has no Edit; everything editable has one.
        expect(within(row('FIXTURE_SESSION_SECRET')).queryByTestId('app-env-edit')).toBeNull();
        expect(within(row('FIXTURE_MARKER')).getByTestId('app-env-edit').textContent).toContain(
            'Set value',
        );
    });

    it('hides every Edit for a viewer, and says so when secure storage is off', () => {
        renderCard(env({ canEdit: false }));
        expect(screen.queryAllByTestId('app-env-edit')).toHaveLength(0);
        cleanup();

        renderCard(env({ secureStorage: false }));
        expect(screen.getByTestId('app-env-no-storage')).toBeTruthy();
        expect(screen.queryAllByTestId('app-env-edit')).toHaveLength(0);
    });

    it('saves a missing required value through the merge patch and refreshes the table', async () => {
        const saved = env({
            entries: env().entries.map((item) =>
                item.name === 'FIXTURE_MARKER' ? { ...item, set: true, origin: 'prompted' } : item,
            ),
        });
        updateMock.mockResolvedValue({
            success: true,
            data: {
                workId: WORK_ID,
                changed: ['FIXTURE_MARKER'],
                results: [
                    {
                        name: 'FIXTURE_MARKER',
                        action: 'set',
                        code: null,
                        message: null,
                        version: 1,
                    },
                ],
                warnings: [],
                activityRecorded: true,
                entries: saved.entries,
            },
        });
        getMock.mockResolvedValue({ success: true, data: saved });
        renderCard();

        fireEvent.click(within(row('FIXTURE_MARKER')).getByTestId('app-env-edit'));
        fireEvent.change(screen.getByTestId('app-env-value-input'), {
            target: { value: 'run-42' },
        });
        fireEvent.click(screen.getByTestId('app-env-value-save'));

        await waitFor(() =>
            expect(updateMock).toHaveBeenCalledWith(WORK_ID, { FIXTURE_MARKER: 'run-42' }),
        );
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('FIXTURE_MARKER saved'));
        await waitFor(() => expect(row('FIXTURE_MARKER').dataset.set).toBe('true'));
    });

    it('never pre-fills a secret, uses a password field, and explains the dependency override', () => {
        renderCard();
        fireEvent.click(within(row('SMTP_PASSWORD')).getByTestId('app-env-edit'));

        const input = screen.getByTestId('app-env-value-input') as HTMLInputElement;
        expect(input.type).toBe('password');
        expect(input.value).toBe('');
        expect(screen.getByTestId('app-env-secret-hint').textContent).toContain('stored encrypted');
        expect(screen.getByTestId('app-env-value-dialog').textContent).toContain(
            'Normally injected by SMTP mail. A value you set here overrides it',
        );
    });

    it('shows a per-name refusal in our copy, and keeps the dialog open', async () => {
        updateMock.mockResolvedValue({
            success: true,
            data: {
                workId: WORK_ID,
                changed: [],
                results: [
                    {
                        name: 'FIXTURE_MARKER',
                        action: 'refused',
                        code: 'controlCharacter',
                        message: 'raw',
                        version: null,
                    },
                ],
                warnings: [],
                activityRecorded: false,
                entries: env().entries,
            },
        });
        renderCard();
        fireEvent.click(within(row('FIXTURE_MARKER')).getByTestId('app-env-edit'));
        fireEvent.change(screen.getByTestId('app-env-value-input'), { target: { value: 'bad' } });
        fireEvent.click(screen.getByTestId('app-env-value-save'));

        await waitFor(() =>
            expect(screen.getByTestId('app-env-value-error').textContent).toBe(
                messages.dashboard.workDetail.appEnv.errors.controlCharacter,
            ),
        );
        expect(screen.getByTestId('app-env-value-dialog')).toBeTruthy();
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('removes a stored value with null', async () => {
        const withHost = env({
            entries: [
                entry({
                    name: 'SMTP_HOST',
                    source: 'from',
                    set: true,
                    origin: 'user',
                    reference: 'deps.smtp.host',
                    dependency: { kind: 'smtp', output: 'host' },
                }),
            ],
        });
        updateMock.mockResolvedValue({
            success: true,
            data: {
                workId: WORK_ID,
                changed: ['SMTP_HOST'],
                results: [],
                warnings: [],
                activityRecorded: true,
                entries: withHost.entries,
            },
        });
        renderCard(withHost);
        fireEvent.click(within(row('SMTP_HOST')).getByTestId('app-env-edit'));
        fireEvent.click(screen.getByTestId('app-env-value-remove'));

        await waitFor(() => expect(updateMock).toHaveBeenCalledWith(WORK_ID, { SMTP_HOST: null }));
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('SMTP_HOST removed'));
    });

    it('reads the table on mount when the server gave none, and degrades on a missing route', async () => {
        getMock.mockResolvedValue({ success: false, code: 'route_unavailable' });
        renderCard(null);
        await waitFor(() =>
            expect(screen.getByTestId('app-env-card').textContent).toBe(
                messages.dashboard.workDetail.appDeploy.environment.unavailable,
            ),
        );
    });
});
