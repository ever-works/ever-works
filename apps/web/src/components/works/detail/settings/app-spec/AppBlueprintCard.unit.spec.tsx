import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { WorkAppSpecStateDto } from '@ever-works/contracts';
import en from '../../../../../../messages/en.json';

/**
 * APW-03 T31 (lane aw-blueprints) — the Blueprint card (ACC-03-29): the match chips
 * (incl. "Chosen for this repository" for an explicit match), the upgrade notice with
 * its Breaking badge, the pending and proposed states with their conflicts, dismiss
 * hiding only that version, and no control at all for a viewer.
 */

const { applyMock, upgradeMock, dismissMock } = vi.hoisted(() => ({
    applyMock: vi.fn(),
    upgradeMock: vi.fn(),
    dismissMock: vi.fn(),
}));

// `Button` pulls in the locale-aware `Link`; next-intl's navigation factory needs a Next
// runtime that jsdom does not provide.
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

vi.mock('@/app/actions/dashboard/app-spec', () => ({
    applyBlueprintAction: applyMock,
    upgradeBlueprintAction: upgradeMock,
    dismissBlueprintUpgradeAction: dismissMock,
}));

import {
    AppBlueprintCard,
    blueprintRunActive,
    blueprintUpgradeNotice,
    isNewerVersion,
} from './AppBlueprintCard';

const WORK = '00000000-0000-4000-8000-0000000000d1';

function state(overrides: Partial<WorkAppSpecStateDto> = {}): WorkAppSpecStateDto {
    return {
        blueprintId: 'umami',
        blueprintVersion: '0.1.0',
        blueprintRepo: 'ever-works/umami-template',
        blueprintSha: null,
        blueprintMatchSource: 'explicit',
        blueprintApplyStatus: 'applied',
        blueprintMatchedAt: null,
        blueprintApplyError: null,
        blueprintApplyRef: null,
        blueprintLatestVersion: null,
        blueprintUpgradeDismissedVersion: null,
        blueprintUpgradePr: null,
        blueprintUpgradeStatus: null,
        blueprintUpgradeError: null,
        ...overrides,
    } as WorkAppSpecStateDto;
}

function renderCard(props: {
    state: WorkAppSpecStateDto;
    canEdit?: boolean;
    onStateChange?: (p: unknown) => void;
}) {
    const onStateChange = props.onStateChange ?? vi.fn();
    render(
        <NextIntlClientProvider locale="en" messages={en as never}>
            <AppBlueprintCard
                workId={WORK}
                state={props.state}
                canEdit={props.canEdit ?? true}
                onStateChange={onStateChange as never}
            />
        </NextIntlClientProvider>,
    );
    return { onStateChange };
}

describe('AppBlueprintCard — helpers', () => {
    it('orders versions by semver, a pre-release before its release', () => {
        expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
        expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
        expect(isNewerVersion('1.0.0', '1.0.0-rc.1')).toBe(true);
        expect(isNewerVersion('1.0.0-rc.1', '1.0.0')).toBe(false);
        expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
        expect(isNewerVersion('next', '0.1.0')).toBe(false);
    });

    it('shows a notice only for a newer, undismissed, not-yet-proposed version', () => {
        expect(blueprintUpgradeNotice(state({ blueprintLatestVersion: '0.2.0' }))).toEqual({
            version: '0.2.0',
            breaking: false,
        });
        expect(blueprintUpgradeNotice(state({ blueprintLatestVersion: '1.0.0' }))).toEqual({
            version: '1.0.0',
            breaking: true,
        });
        expect(blueprintUpgradeNotice(state({ blueprintLatestVersion: '0.1.0' }))).toBeNull();
        expect(
            blueprintUpgradeNotice(
                state({
                    blueprintLatestVersion: '0.2.0',
                    blueprintUpgradeDismissedVersion: '0.2.0',
                }),
            ),
        ).toBeNull();
        // Dismissing 0.2.0 does not hide 0.3.0.
        expect(
            blueprintUpgradeNotice(
                state({
                    blueprintLatestVersion: '0.3.0',
                    blueprintUpgradeDismissedVersion: '0.2.0',
                }),
            ),
        ).toEqual({ version: '0.3.0', breaking: false });
        expect(
            blueprintUpgradeNotice(
                state({
                    blueprintLatestVersion: '0.2.0',
                    blueprintUpgradeStatus: 'proposed',
                    blueprintUpgradePr: { number: 4, url: 'u', version: '0.2.0', breaking: false },
                }),
            ),
        ).toBeNull();
        expect(
            blueprintUpgradeNotice(state({ blueprintId: null, blueprintLatestVersion: '0.2.0' })),
        ).toBeNull();
    });

    it('treats queued and running as an active run', () => {
        expect(blueprintRunActive({ blueprintUpgradeStatus: 'queued' })).toBe(true);
        expect(blueprintRunActive({ blueprintUpgradeStatus: 'running' })).toBe(true);
        expect(blueprintRunActive({ blueprintUpgradeStatus: 'proposed' })).toBe(false);
        expect(blueprintRunActive({ blueprintUpgradeStatus: null })).toBe(false);
    });
});

describe('AppBlueprintCard', () => {
    beforeEach(() => {
        applyMock.mockReset();
        upgradeMock.mockReset();
        dismissMock.mockReset();
    });
    afterEach(() => cleanup());

    it('names the Blueprint, its version and the explicit-match chip', () => {
        renderCard({ state: state() });
        expect(screen.getByTestId('app-blueprint-current').textContent).toContain(
            'Follows the umami Blueprint, version 0.1.0.',
        );
        expect(screen.getByTestId('app-blueprint-match').textContent).toBe(
            'Chosen for this repository',
        );
    });

    it('shows the notice with the Breaking badge, and opens the upgrade dialog', async () => {
        upgradeMock.mockResolvedValue({
            success: true,
            code: null,
            data: {
                status: 'queued',
                mode: 'upgrade',
                blueprintId: 'umami',
                version: '1.0.0',
                runId: 'r',
            },
        });
        const { onStateChange } = renderCard({ state: state({ blueprintLatestVersion: '1.0.0' }) });
        expect(screen.getByTestId('app-blueprint-notice').textContent).toContain('Version 1.0.0');
        expect(screen.getByTestId('app-blueprint-breaking')).toBeTruthy();

        fireEvent.click(screen.getByTestId('app-blueprint-review-upgrade'));
        expect(screen.getByTestId('app-blueprint-dialog').getAttribute('data-variant')).toBe(
            'upgrade',
        );
        expect(screen.getByTestId('app-blueprint-dialog-breaking')).toBeTruthy();

        await act(async () => {
            fireEvent.click(screen.getByTestId('app-blueprint-dialog-confirm'));
        });
        expect(upgradeMock).toHaveBeenCalledWith(WORK, '1.0.0');
        expect(onStateChange).toHaveBeenCalledWith({
            blueprintUpgradeStatus: 'queued',
            blueprintUpgradeError: null,
        });
    });

    it('dismiss hides only that version', async () => {
        dismissMock.mockResolvedValue({
            success: true,
            code: null,
            data: { status: 'dismissed', version: '0.2.0' },
        });
        const { onStateChange } = renderCard({ state: state({ blueprintLatestVersion: '0.2.0' }) });
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-blueprint-dismiss'));
        });
        expect(dismissMock).toHaveBeenCalledWith(WORK, '0.2.0');
        expect(onStateChange).toHaveBeenCalledWith({ blueprintUpgradeDismissedVersion: '0.2.0' });
    });

    it('renders the pending state, then the pull request with its conflicts', () => {
        renderCard({ state: state({ blueprintUpgradeStatus: 'running' }) });
        expect(screen.getByTestId('app-blueprint-run-pending').textContent).toBe(
            'Preparing the pull request…',
        );
        cleanup();

        renderCard({
            state: state({
                blueprintLatestVersion: '0.2.0',
                blueprintUpgradeStatus: 'proposed',
                blueprintUpgradePr: {
                    number: 41,
                    url: 'https://github.com/member/umami/pull/41',
                    version: '0.2.0',
                    breaking: false,
                    mode: 'upgrade',
                    conflictCount: 1,
                    conflicts: [
                        {
                            path: 'spec.env[name=LOG_LEVEL].value',
                            kind: 'both_changed',
                            proposed: '"warn"',
                        },
                    ],
                },
            }),
        });
        expect(screen.queryByTestId('app-blueprint-notice')).toBeNull();
        const link = screen.getByTestId('app-blueprint-pr');
        expect(link.getAttribute('href')).toBe('https://github.com/member/umami/pull/41');
        expect(link.textContent).toBe('Pull request #41 upgrades to version 0.2.0');
        expect(screen.getByTestId('app-blueprint-conflict-count').textContent).toBe(
            '1 conflict: your value was kept.',
        );
        expect(screen.getByTestId('app-blueprint-conflicts').textContent).toContain(
            'spec.env[name=LOG_LEVEL].value',
        );
    });

    it('offers Apply a Blueprint to an App Work with none, and shows a refusal as copy', async () => {
        applyMock.mockResolvedValue({ success: false, data: null, code: 'blueprintNotFound' });
        renderCard({
            state: state({ blueprintId: null, blueprintVersion: null, blueprintMatchSource: null }),
        });
        expect(screen.getByTestId('app-blueprint-none').textContent).toContain(
            'This App Work follows no Blueprint.',
        );
        fireEvent.change(screen.getByTestId('app-blueprint-apply-id'), {
            target: { value: 'umami' },
        });
        fireEvent.click(screen.getByTestId('app-blueprint-apply'));
        expect(screen.getByTestId('app-blueprint-dialog').getAttribute('data-variant')).toBe(
            'apply',
        );
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-blueprint-dialog-confirm'));
        });
        expect(applyMock).toHaveBeenCalledWith(WORK, 'umami');
        expect(screen.getByTestId('app-blueprint-refusal').textContent).toBe(
            'No Blueprint has that id.',
        );
    });

    it('gives a viewer the facts and no control', () => {
        renderCard({ state: state({ blueprintLatestVersion: '0.2.0' }), canEdit: false });
        expect(screen.getByTestId('app-blueprint-notice')).toBeTruthy();
        expect(screen.queryByTestId('app-blueprint-review-upgrade')).toBeNull();
        expect(screen.queryByTestId('app-blueprint-dismiss')).toBeNull();
        cleanup();
        renderCard({ state: state({ blueprintId: null, blueprintVersion: null }), canEdit: false });
        expect(screen.queryByTestId('app-blueprint-apply')).toBeNull();
    });
});
