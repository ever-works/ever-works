import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../../../../../../messages/en.json';

/**
 * APW-06 T37 — **Deploy now**: single-flight, and every answer of
 * `POST /api/works/:id/deploy` rendered (ACC-06-19, ACC-06-21).
 */

const { requestMock, toastSuccess } = vi.hoisted(() => ({
    requestMock: vi.fn(),
    toastSuccess: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/app-runtime', () => ({
    requestAppDeployAction: requestMock,
    saveAppTargetAction: vi.fn(),
    checkAppTargetAction: vi.fn(),
    getAppTargetAction: vi.fn(),
}));
vi.mock('@/i18n/navigation', () => ({
    // The shared Button primitive reads `Link` at module scope.
    Link: ({ href, children }: { href: string; children: ReactNode }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

import { AppDeployNowButton } from './AppDeployNowButton';

const WORK_ID = '6f1c1b6e-2f7a-4c55-9a0e-2a1d4c8b9e10';

function empty() {
    return { unmet: [], advisory: [], warnings: [] };
}

function renderButton() {
    render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <AppDeployNowButton workId={WORK_ID} />
        </NextIntlClientProvider>,
    );
    return screen.getByTestId('app-deploy-now-button') as HTMLButtonElement;
}

describe('AppDeployNowButton', () => {
    beforeEach(() => {
        requestMock.mockReset();
        toastSuccess.mockReset();
    });
    afterEach(() => cleanup());

    it('renders one row per unmet precondition, in our copy or the API words (ACC-06-19)', async () => {
        requestMock.mockResolvedValue({
            success: false,
            httpStatus: 422,
            code: 'APP_DEPLOY_PRECONDITIONS',
            data: {
                ...empty(),
                code: 'APP_DEPLOY_PRECONDITIONS',
                unmet: [
                    { code: 'no_green_build', message: 'no build' },
                    { code: 'target_not_checked', message: 'check it' },
                    {
                        code: 'some_future_code',
                        message: 'A future refusal the web does not know.',
                    },
                ],
            },
        });
        fireEvent.click(renderButton());

        await waitFor(() => expect(screen.getByTestId('app-deploy-preconditions')).toBeTruthy());
        expect(screen.getByText('Fix these before deploying:')).toBeTruthy();
        const rows = screen.getAllByTestId('app-deploy-precondition').map((row) => row.textContent);
        expect(rows).toEqual([
            "There's no successful Build to deploy yet. Start a Build first.",
            'Check the cluster connection first.',
            'A future refusal the web does not know.',
        ]);
    });

    it('is single-flight: a second press while the request runs sends nothing', async () => {
        let resolve: (value: unknown) => void = () => undefined;
        requestMock.mockReturnValue(new Promise((r) => (resolve = r)));
        const button = renderButton();

        fireEvent.click(button);
        fireEvent.click(button);
        fireEvent.click(button);
        expect(requestMock).toHaveBeenCalledTimes(1);

        resolve({
            success: true,
            httpStatus: 202,
            data: { ...empty(), deploymentId: 'd-1', status: 'pending' },
        });
        await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
        expect(toastSuccess.mock.calls[0][0]).toContain('Deployment started.');
        expect(toastSuccess.mock.calls[0][0]).toContain('d-1');
    });

    it('names the running Deployment on 409 (ACC-06-21)', async () => {
        requestMock.mockResolvedValue({
            success: false,
            httpStatus: 409,
            code: 'APP_DEPLOY_IN_PROGRESS',
            data: { ...empty(), code: 'APP_DEPLOY_IN_PROGRESS', runningDeploymentId: 'run-7' },
        });
        fireEvent.click(renderButton());
        await waitFor(() =>
            expect(screen.getByTestId('app-deploy-in-progress').textContent).toBe(
                'Another Deployment is running (run-7). Wait for it to finish, then deploy again.',
            ),
        );
    });

    it('explains worker_not_isolated', async () => {
        requestMock.mockResolvedValue({
            success: false,
            httpStatus: 422,
            code: 'worker_not_isolated',
            data: { ...empty(), code: 'worker_not_isolated' },
        });
        fireEvent.click(renderButton());
        await waitFor(() =>
            expect(screen.getByTestId('app-deploy-message').textContent).toBe(
                "Deployments can't start yet: this instance has no isolated App cluster worker.",
            ),
        );
    });
});
