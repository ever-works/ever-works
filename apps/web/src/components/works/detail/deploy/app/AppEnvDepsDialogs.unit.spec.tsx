import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '../../../../../../messages/en.json';
import type { AppDependencyEntry } from '@/lib/api/app-dependencies.types';
import type { AppEnvVariableView } from '@/lib/api/app-env.types';

/**
 * Lane aw-ops (APW-07 T24/T28/T29) — the Environment card's **Import .env** and **Rotate**, and
 * the Dependencies card's **Configure**.
 *
 * Pinned: an import is previewed first, and a paste naming something the App spec does not
 * declare cannot be imported; Rotate is sent only with the exact typed name; Configure sends only
 * what changed, never an empty secret, and refuses to shrink a volume.
 */

const { previewMock, importMock, rotateMock, configureMock, toastSuccess, toastError } = vi.hoisted(
    () => ({
        previewMock: vi.fn(),
        importMock: vi.fn(),
        rotateMock: vi.fn(),
        configureMock: vi.fn(),
        toastSuccess: vi.fn(),
        toastError: vi.fn(),
    }),
);

vi.mock('@/app/actions/dashboard/app-env', () => ({
    previewAppEnvImportAction: previewMock,
    importAppEnvAction: importMock,
    rotateAppEnvAction: rotateMock,
    getAppEnvAction: vi.fn(),
    updateAppEnvAction: vi.fn(),
}));
vi.mock('@/app/actions/dashboard/app-dependencies', () => ({
    configureAppDependencyAction: configureMock,
    getAppDependenciesAction: vi.fn(),
    retryAppDependencyAction: vi.fn(),
    deleteAppDependencyDataAction: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ href, children }: { href: string; children: ReactNode }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { AppEnvImportDialog } from './AppEnvImportDialog';
import { AppEnvRotateDialog } from './AppEnvRotateDialog';
import { AppDependencyConfigureDialog } from './AppDependencyConfigureDialog';

const WORK_ID = '6f1c1b6e-2f7a-4c55-9a0e-2a1d4c8b9e10';
const SECRET = 'sentinel-secret-value-1618';

function wrap(node: ReactNode) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            {node}
        </NextIntlClientProvider>,
    );
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('AppEnvImportDialog', () => {
    it('previews per line by name, then imports the paste', async () => {
        previewMock.mockResolvedValueOnce({
            success: true,
            data: {
                workId: WORK_ID,
                lines: [
                    { line: 1, name: 'API_TOKEN', action: 'replace', code: null, message: null },
                    { line: 2, name: 'MAIL_TO', action: 'add', code: null, message: null },
                ],
                changes: { add: ['MAIL_TO'], replace: ['API_TOKEN'], remove: [] },
                refused: 0,
                limits: null,
                undeclared: [],
            },
        });
        importMock.mockResolvedValueOnce({
            success: true,
            data: {
                workId: WORK_ID,
                changed: ['API_TOKEN', 'MAIL_TO'],
                results: [],
                warnings: [],
                activityRecorded: true,
                entries: [],
            },
        });
        const onImported = vi.fn();
        wrap(
            <AppEnvImportDialog
                workId={WORK_ID}
                onOpenChange={() => undefined}
                onImported={onImported}
            />,
        );

        const paste = `API_TOKEN=${SECRET}\nMAIL_TO=a@b.c`;
        expect(screen.getByTestId('app-env-import-submit')).toBeDisabled();
        fireEvent.change(screen.getByTestId('app-env-import-text'), { target: { value: paste } });
        fireEvent.click(screen.getByTestId('app-env-import-preview'));

        await waitFor(() => expect(screen.getAllByTestId('app-env-import-line')).toHaveLength(2));
        expect(previewMock).toHaveBeenCalledWith(WORK_ID, paste);
        expect(screen.getByTestId('app-env-import-preview-table')).toHaveTextContent(
            '1 new · 1 replaced',
        );
        expect(screen.getByTestId('app-env-import-preview-table')).not.toHaveTextContent(SECRET);

        fireEvent.click(screen.getByTestId('app-env-import-submit'));
        await waitFor(() => expect(importMock).toHaveBeenCalledWith(WORK_ID, paste));
        await waitFor(() => expect(onImported).toHaveBeenCalled());
    });

    it('keeps Import disabled while the paste names something the App spec does not declare', async () => {
        previewMock.mockResolvedValueOnce({
            success: true,
            data: {
                workId: WORK_ID,
                lines: [
                    {
                        line: 1,
                        name: 'TYPO',
                        action: 'refused',
                        code: 'undeclaredName',
                        message: 'The App spec does not declare this name.',
                    },
                ],
                changes: { add: [], replace: [], remove: [] },
                refused: 1,
                limits: null,
                undeclared: ['TYPO'],
            },
        });
        wrap(
            <AppEnvImportDialog
                workId={WORK_ID}
                onOpenChange={() => undefined}
                onImported={vi.fn()}
            />,
        );
        fireEvent.change(screen.getByTestId('app-env-import-text'), {
            target: { value: 'TYPO=x' },
        });
        fireEvent.click(screen.getByTestId('app-env-import-preview'));
        expect(await screen.findByTestId('app-env-import-undeclared')).toHaveTextContent('TYPO');
        expect(screen.getByTestId('app-env-import-submit')).toBeDisabled();
        expect(importMock).not.toHaveBeenCalled();
    });
});

describe('AppEnvRotateDialog', () => {
    const entry = {
        name: 'SESSION',
        source: 'generate',
        set: true,
        secret: true,
    } as unknown as AppEnvVariableView;

    it('sends only with the exact typed name, and shows a refusal in place', async () => {
        rotateMock.mockResolvedValueOnce({
            success: false,
            code: 'rotateConfirmationMismatch',
            httpStatus: 422,
        });
        wrap(
            <AppEnvRotateDialog
                workId={WORK_ID}
                entry={entry}
                onOpenChange={() => undefined}
                onRotated={vi.fn()}
            />,
        );

        fireEvent.change(screen.getByTestId('app-env-rotate-confirm'), {
            target: { value: 'session' },
        });
        expect(screen.getByTestId('app-env-rotate-submit')).toBeDisabled();
        fireEvent.change(screen.getByTestId('app-env-rotate-confirm'), {
            target: { value: 'SESSION' },
        });
        fireEvent.click(screen.getByTestId('app-env-rotate-submit'));

        await waitFor(() => expect(rotateMock).toHaveBeenCalledWith(WORK_ID, 'SESSION', 'SESSION'));
        expect(await screen.findByTestId('app-env-rotate-error')).toHaveTextContent(
            "doesn't match",
        );
    });
});

describe('AppDependencyConfigureDialog', () => {
    const entry = {
        kind: 'smtp',
        declared: true,
        inSpec: true,
        status: 'awaiting_config',
        awaitingConfig: true,
        sizeGiB: 10,
        provider: { pluginId: 'k8s', providerId: 'in-namespace-mail', label: 'Mail sink' },
        availableProviders: [
            { providerId: 'in-namespace-mail', label: 'Mail sink', promptFields: [] },
            {
                providerId: 'external-smtp',
                label: 'Your SMTP server',
                promptFields: [
                    { key: 'host', label: 'Host', secret: false, required: true, set: false },
                    {
                        key: 'password',
                        label: 'Password',
                        secret: true,
                        required: false,
                        set: true,
                    },
                ],
            },
        ],
    } as unknown as AppDependencyEntry;

    it('sends the provider and the filled settings only — never an empty secret', async () => {
        configureMock.mockResolvedValueOnce({ success: true, data: { dependency: null } });
        const onConfigured = vi.fn();
        wrap(
            <AppDependencyConfigureDialog
                workId={WORK_ID}
                entry={entry}
                kindLabel="SMTP mail"
                onOpenChange={() => undefined}
                onConfigured={onConfigured}
            />,
        );
        fireEvent.change(screen.getByTestId('app-dependency-configure-provider'), {
            target: { value: 'external-smtp' },
        });
        const fields = screen.getAllByTestId('app-dependency-configure-field');
        expect(fields).toHaveLength(2);
        expect(fields[1].querySelector('input')?.getAttribute('type')).toBe('password');
        expect(screen.getByTestId('app-dependency-configure-save')).toBeDisabled(); // host is required
        fireEvent.change(fields[0].querySelector('input')!, {
            target: { value: 'smtp.example.com' },
        });
        fireEvent.click(screen.getByTestId('app-dependency-configure-save'));

        await waitFor(() =>
            expect(configureMock).toHaveBeenCalledWith(WORK_ID, 'smtp', {
                providerId: 'external-smtp',
                config: { host: 'smtp.example.com' },
            }),
        );
        await waitFor(() => expect(onConfigured).toHaveBeenCalled());
    });

    it('refuses a smaller volume before anything is sent', () => {
        wrap(
            <AppDependencyConfigureDialog
                workId={WORK_ID}
                entry={entry}
                kindLabel="SMTP mail"
                onOpenChange={() => undefined}
                onConfigured={vi.fn()}
            />,
        );
        fireEvent.change(screen.getByTestId('app-dependency-configure-size'), {
            target: { value: '5' },
        });
        expect(screen.getByTestId('app-dependency-configure-save')).toBeDisabled();
        expect(screen.getByText(/at least 10 GiB/)).toBeInTheDocument();
        expect(configureMock).not.toHaveBeenCalled();
    });
});
