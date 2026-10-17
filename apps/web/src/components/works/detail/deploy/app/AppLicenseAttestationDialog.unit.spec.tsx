import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../../../../messages/en.json';
import type { WorkAppLicenseView } from '@/lib/api/app-license.types';

const { attestMock, getMock } = vi.hoisted(() => ({ attestMock: vi.fn(), getMock: vi.fn() }));
vi.mock('@/app/actions/dashboard/app-license', () => ({
    attestAppLicenseAction: attestMock,
    getAppLicenseAction: getMock,
}));

// `Button` pulls in the locale-aware `Link`; next-intl's navigation factory needs
// a Next runtime that jsdom does not provide.
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import { AppLicenseAttestationDialog } from './AppLicenseAttestationDialog';
import { AppLicenseCard } from './AppLicenseCard';

const COPY = messages.dashboard.workDetail.appDeploy.license;

function license(over: Partial<WorkAppLicenseView> = {}): WorkAppLicenseView {
    return {
        workId: 'w1',
        spdx: 'BUSL-1.1',
        class: 'amber',
        source: 'detected',
        mixed: false,
        scanIncomplete: false,
        obligations: [],
        commitSha: 'abc123',
        evaluatedAt: null,
        attestationRequired: true,
        attestation: null,
        attestationText: {
            textId: 'busl-1.1-v1',
            text: 'I will not offer this as a competing hosted service.',
        },
        isOwner: true,
        ...over,
    };
}

function wrap(node: React.ReactNode) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            {node}
        </NextIntlClientProvider>,
    );
}

beforeEach(() => {
    attestMock.mockReset();
    getMock.mockReset();
});
afterEach(cleanup);

describe('AppLicenseAttestationDialog (APW-03 §6.3, ACC-06-39)', () => {
    it('quotes the registry text and keeps Confirm disabled until the box is ticked', () => {
        wrap(
            <AppLicenseAttestationDialog
                open
                onOpenChange={vi.fn()}
                workId="w1"
                license={license()}
                onAttested={vi.fn()}
                onLicenseChanged={vi.fn()}
            />,
        );
        expect(screen.getByText(COPY.dialogTitle)).toBeTruthy();
        expect(screen.getByTestId('app-license-attest-text').textContent).toBe(
            'I will not offer this as a competing hosted service.',
        );
        const confirm = screen.getByTestId('app-license-attest-confirm') as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        fireEvent.click(screen.getByTestId('app-license-attest-checkbox'));
        expect(confirm.disabled).toBe(false);
    });

    it('sends the reviewed classification and closes on success', async () => {
        attestMock.mockResolvedValue({ success: true, data: { attestation: {} } });
        const onOpenChange = vi.fn();
        const onAttested = vi.fn();
        wrap(
            <AppLicenseAttestationDialog
                open
                onOpenChange={onOpenChange}
                workId="w1"
                license={license()}
                onAttested={onAttested}
                onLicenseChanged={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByTestId('app-license-attest-checkbox'));
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-license-attest-confirm'));
        });
        expect(attestMock).toHaveBeenCalledWith('w1', { spdx: 'BUSL-1.1', class: 'amber' });
        expect(onAttested).toHaveBeenCalledTimes(1);
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('a 403 renders the owner-only line; a 409 re-reads the licence', async () => {
        attestMock.mockResolvedValueOnce({ success: false, code: 'ownerOnly', httpStatus: 403 });
        const onLicenseChanged = vi.fn();
        wrap(
            <AppLicenseAttestationDialog
                open
                onOpenChange={vi.fn()}
                workId="w1"
                license={license()}
                onAttested={vi.fn()}
                onLicenseChanged={onLicenseChanged}
            />,
        );
        fireEvent.click(screen.getByTestId('app-license-attest-checkbox'));
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-license-attest-confirm'));
        });
        expect(screen.getByTestId('app-license-attest-error').textContent).toBe(
            "Only the App Work's owner can attest.",
        );

        attestMock.mockResolvedValueOnce({
            success: false,
            code: 'licenseChanged',
            httpStatus: 409,
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-license-attest-confirm'));
        });
        expect(onLicenseChanged).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('app-license-attest-error').textContent).toBe(
            COPY.refusals.licenseChanged,
        );
    });
});

describe('AppLicenseCard', () => {
    it('offers Review and confirm to the owner of an unconfirmed licence', () => {
        wrap(<AppLicenseCard workId="w1" initialLicense={license()} />);
        expect(screen.getByTestId('app-license-headline').textContent).toBe(
            `BUSL-1.1 — ${COPY.classes.amber}`,
        );
        expect(screen.getByTestId('app-license-review')).toBeTruthy();
    });

    it('shows a non-owner the owner-only line instead of the button', () => {
        wrap(<AppLicenseCard workId="w1" initialLicense={license({ isOwner: false })} />);
        expect(screen.queryByTestId('app-license-review')).toBeNull();
        expect(screen.getByTestId('app-license-owner-only').textContent).toBe(
            "Only the App Work's owner can attest.",
        );
    });

    it('says when the licence route is not on this instance', async () => {
        getMock.mockResolvedValue({ success: false, code: 'route_unavailable', httpStatus: 404 });
        wrap(<AppLicenseCard workId="w1" />);
        expect(await screen.findByText(COPY.unavailable)).toBeTruthy();
    });
});
