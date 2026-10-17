import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import {
    APP_SOURCE_REASON_CODES,
    type AppSourceInspectResponse,
    type AppSourceReasonCode,
} from '@ever-works/contracts';
import messages from '../../../../messages/en.json';

/**
 * APW-01 T22 — the App Work create form, rendered with the REAL English
 * catalogue so the asserted copy is the copy a member reads. The two server
 * actions are mocked at their module boundary.
 */

const { inspectMock, createMock, pushMock, catalogMock, curatedMock } = vi.hoisted(() => ({
    inspectMock: vi.fn(),
    createMock: vi.fn(),
    pushMock: vi.fn(),
    catalogMock: vi.fn(),
    curatedMock: vi.fn(),
}));

vi.mock('@/app/actions/dashboard/apps-catalog', () => ({
    listAppsCatalogBlueprintsAction: catalogMock,
    listAppsCatalogAction: curatedMock,
}));

vi.mock('@/app/actions/dashboard/works', () => ({
    inspectAppSourceAction: inspectMock,
    createWork: createMock,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: pushMock, back: vi.fn(), refresh: vi.fn() }),
    Link: ({ children, href }: { children: ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import { AppWorkForm } from './AppWorkForm';

const REASONS = messages.dashboard.workCreation.app.reasons as Record<AppSourceReasonCode, string>;

function preview(over: Partial<AppSourceInspectResponse> = {}): AppSourceInspectResponse {
    return {
        repository: {
            owner: 'acme',
            repo: 'tasks-app',
            fullName: 'acme/tasks-app',
            url: 'https://github.com/acme/tasks-app',
            defaultBranch: 'main',
            stars: 12408,
            sizeKb: 2048,
            visibility: 'public',
            archived: false,
            empty: false,
            isFork: false,
            allowForking: true,
            usesLfs: false,
        },
        access: { canPush: false, canAdmin: false },
        modes: {
            link: { available: false, reason: 'no_push_access' },
            fork: { available: true },
            'private-copy': { available: true },
        },
        defaultMode: 'fork',
        targetOwners: [
            { login: 'me', type: 'user', available: true, existingForkChecked: true },
            { login: 'my-org', type: 'organization', available: true, existingForkChecked: false },
        ],
        blueprint: { status: 'none' },
        license: { spdx: 'MIT', class: 'green', source: 'detected' },
        deployTargets: {
            none: { available: true },
            'your-cluster': { available: true, providerId: 'k8s' },
            'ever-works-apps': { available: false, reason: 'managed_hosting_unavailable' },
        },
        scanIncomplete: false,
        ...over,
    };
}

function renderForm(props: Partial<Parameters<typeof AppWorkForm>[0]> = {}) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <AppWorkForm gitProvider="github" {...props} />
        </NextIntlClientProvider>,
    );
}

async function pasteAndCheck(url = 'https://github.com/acme/tasks-app') {
    fireEvent.change(screen.getByTestId('app-work-url'), { target: { value: url } });
    await act(async () => {
        fireEvent.click(screen.getByTestId('app-work-check'));
    });
}

beforeEach(() => {
    cleanup();
    inspectMock.mockReset();
    createMock.mockReset();
    pushMock.mockReset();
});

describe('AppWorkForm', () => {
    it('inspects only on Check / Enter — never while typing', async () => {
        inspectMock.mockResolvedValue({ success: true, data: preview() });
        renderForm();
        fireEvent.change(screen.getByTestId('app-work-url'), {
            target: { value: 'https://github.com/acme/tasks-app' },
        });
        expect(inspectMock).not.toHaveBeenCalled();

        await act(async () => {
            fireEvent.keyDown(screen.getByTestId('app-work-url'), { key: 'Enter' });
        });
        expect(inspectMock).toHaveBeenCalledTimes(1);
        expect(inspectMock).toHaveBeenCalledWith({
            repositoryUrl: 'https://github.com/acme/tasks-app',
            gitProvider: 'github',
        });
        expect(await screen.findByTestId('app-work-preview')).toBeTruthy();
    });

    it('clears the preview when the URL changes', async () => {
        inspectMock.mockResolvedValue({ success: true, data: preview() });
        renderForm();
        await pasteAndCheck();
        expect(await screen.findByTestId('app-work-preview')).toBeTruthy();
        fireEvent.change(screen.getByTestId('app-work-url'), {
            target: { value: 'https://github.com/acme/other' },
        });
        expect(screen.queryByTestId('app-work-preview')).toBeNull();
    });

    it('renders every spec §6.3 reason string from a fixture', async () => {
        const details = { owner: 'acme', fullName: 'acme/tasks-app', workName: 'Tasks' };
        for (const code of APP_SOURCE_REASON_CODES) {
            cleanup();
            inspectMock.mockReset();
            inspectMock.mockResolvedValue({ success: false, error: 'x', code, details });
            renderForm();
            await pasteAndCheck();
            const expected = REASONS[code]
                .replaceAll('{owner}', 'acme')
                .replaceAll('{fullName}', 'acme/tasks-app')
                .replaceAll('{workName}', 'Tasks')
                // No preview in hand: size, name and time fall back to a dash.
                .replaceAll('{size}', '—')
                .replaceAll('{name}', '—')
                .replaceAll('{time}', '—');
            const alert = await screen.findByTestId('app-work-inspect-error');
            expect(alert.textContent, code).toBe(expected);
        }
    });

    it('shows a disabled mode with its reason and defaults to the preview’s mode', async () => {
        inspectMock.mockResolvedValue({ success: true, data: preview() });
        renderForm();
        await pasteAndCheck();
        const link = await screen.findByTestId('app-work-mode-link');
        expect(link.getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByTestId('app-work-mode-link-reason').textContent).toBe(
            REASONS.no_push_access,
        );
        expect(screen.getByTestId('app-work-mode-fork').getAttribute('aria-checked')).toBe('true');
        expect(screen.getByTestId('app-work-submit').textContent).toContain(
            'Fork and create App Work',
        );
    });

    it('defaults the deploy target to None and disables Ever Works Apps with its reason', async () => {
        inspectMock.mockResolvedValue({ success: true, data: preview() });
        renderForm();
        await pasteAndCheck();
        expect((screen.getByTestId('app-work-deploy-none') as HTMLInputElement).checked).toBe(true);
        expect(
            (screen.getByTestId('app-work-deploy-ever-works-apps') as HTMLInputElement).disabled,
        ).toBe(true);
        expect(screen.getByTestId('app-work-deploy-ever-works-apps-reason').textContent).toBe(
            REASONS.managed_hosting_unavailable,
        );
    });

    it('submits mode, owner and the chosen target’s providerId; autoProvision only when unticked', async () => {
        inspectMock.mockResolvedValue({ success: true, data: preview() });
        createMock.mockResolvedValue({ success: true, work: { id: 'w-1' } });
        renderForm();
        await pasteAndCheck();
        fireEvent.click(screen.getByTestId('app-work-deploy-your-cluster'));
        // Ticked by default when no Blueprint applies; untick it.
        const auto = screen.getByTestId('app-work-auto-provision') as HTMLInputElement;
        expect(auto.checked).toBe(true);
        fireEvent.click(auto);
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-work-submit'));
        });
        expect(createMock).toHaveBeenCalledTimes(1);
        const payload = createMock.mock.calls[0][0];
        expect(payload).toMatchObject({
            kind: 'app',
            repositoryUrl: 'https://github.com/acme/tasks-app',
            repositoryMode: 'fork',
            targetOwner: 'me',
            deployProvider: 'k8s',
            autoProvision: false,
            name: 'tasks-app',
            slug: 'tasks-app',
        });
        expect(payload).not.toHaveProperty('blueprintId');
        await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/works/w-1'));
    });

    it('omits autoProvision while ticked, and sends a matched Blueprint’s id with its prompts', async () => {
        inspectMock.mockResolvedValue({
            success: true,
            data: preview({
                blueprint: {
                    status: 'matched',
                    id: 'umami',
                    name: 'Umami',
                    verified: true,
                    prompts: [
                        { name: 'APP_SECRET', description: 'A random secret', required: true },
                    ],
                },
            }),
        });
        createMock.mockResolvedValue({ success: true, work: { id: 'w-2' } });
        renderForm();
        await pasteAndCheck();
        // A matched Blueprint: no provisioning switch.
        expect(screen.queryByTestId('app-work-auto-provision')).toBeNull();
        // A required prompt left empty disables submit with its copy.
        expect((screen.getByTestId('app-work-submit') as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('app-work-prompts-incomplete').textContent).toBe(
            'Fill in the values the app needs first.',
        );
        fireEvent.change(screen.getByTestId('app-work-prompt-APP_SECRET'), {
            target: { value: 's3cret' },
        });
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-work-submit'));
        });
        const payload = createMock.mock.calls[0][0];
        expect(payload.blueprintId).toBe('umami');
        expect(payload.appEnv).toEqual({ APP_SECRET: 's3cret' });
        expect(payload).not.toHaveProperty('autoProvision');
        expect(payload).not.toHaveProperty('deployProvider');
    });

    it('is single-flight: a double click creates once', async () => {
        inspectMock.mockResolvedValue({ success: true, data: preview() });
        let resolve: (value: unknown) => void = () => undefined;
        createMock.mockReturnValue(new Promise((r) => (resolve = r)));
        renderForm();
        await pasteAndCheck();
        const submit = screen.getByTestId('app-work-submit');
        await act(async () => {
            fireEvent.click(submit);
            fireEvent.click(submit);
        });
        expect(createMock).toHaveBeenCalledTimes(1);
        await act(async () => resolve({ success: true, work: { id: 'w-3' } }));
    });

    it('a curated catalog pick fills the upstream URL, carries the Blueprint id and inspects once (ACC-01-19)', async () => {
        curatedMock.mockResolvedValue({
            success: true,
            data: {
                items: [
                    {
                        id: 'umami',
                        name: 'Umami',
                        summary: '',
                        status: 'beta',
                        selectable: true,
                        featured: false,
                        tags: [],
                        upstream: {
                            repo: 'umami-software/umami',
                            url: 'https://github.com/umami-software/umami',
                            defaultBranch: 'master',
                        },
                        blueprint: {
                            repo: 'ever-works/umami-template',
                            version: '0.1.0',
                            ref: 'v0.1.0',
                            sha: null,
                            verified: false,
                        },
                        license: { spdx: 'MIT', class: 'green' },
                        managedHosting: { allowed: true, reason: null },
                        trademark: null,
                        yourCluster: true,
                    },
                ],
                total: 1,
                available: true,
                page: 1,
                limit: 100,
                source: 'manifest',
                repo: 'ever-works/templates',
                ref: 'main',
            },
        });
        inspectMock.mockResolvedValue({
            success: true,
            data: preview({
                blueprint: { status: 'matched', id: 'umami', name: 'Umami', prompts: [] },
            }),
        });
        createMock.mockResolvedValue({ success: true, work: { id: 'w-umami' } });
        renderForm();
        fireEvent.click(screen.getByTestId('app-work-tab-catalog'));
        const card = await screen.findByTestId('apps-catalog-card');
        await act(async () => {
            fireEvent.click(card);
        });
        expect(inspectMock).toHaveBeenCalledTimes(1);
        expect(inspectMock.mock.calls[0][0]).toMatchObject({
            repositoryUrl: 'https://github.com/umami-software/umami',
            blueprintId: 'umami',
        });
        await screen.findByTestId('app-work-preview');
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-work-submit'));
        });
        expect(createMock.mock.calls[0][0].blueprintId).toBe('umami');
    });

    it('a topic-listed pick (curated catalog unavailable) fills the URL and inspects it exactly once', async () => {
        curatedMock.mockResolvedValue({ success: false, error: 'Not Found', httpStatus: 404 });
        catalogMock.mockResolvedValue({
            success: true,
            data: {
                items: [
                    {
                        id: 'umami',
                        name: 'Umami',
                        summary: '',
                        repo: 'ever-works/umami-template',
                        url: 'https://github.com/ever-works/umami-template',
                        stars: null,
                        spdx: 'MIT',
                        topics: [],
                    },
                ],
                total: 1,
                available: true,
                source: 'github-topic',
            },
        });
        inspectMock.mockResolvedValue({ success: true, data: preview() });
        renderForm();
        fireEvent.click(screen.getByTestId('app-work-tab-catalog'));
        const card = await screen.findByTestId('apps-catalog-card');
        await act(async () => {
            fireEvent.click(card);
        });
        expect(inspectMock).toHaveBeenCalledTimes(1);
        expect(inspectMock.mock.calls[0][0].repositoryUrl).toBe(
            'https://github.com/ever-works/umami-template',
        );
        expect((screen.getByTestId('app-work-url') as HTMLInputElement).value).toBe(
            'https://github.com/ever-works/umami-template',
        );
        expect(await screen.findByTestId('app-work-preview')).toBeTruthy();
    });

    it('renders a create refusal’s §6.3 copy instead of the API message', async () => {
        inspectMock.mockResolvedValue({ success: true, data: preview() });
        createMock.mockResolvedValue({
            success: false,
            error: 'raw api text',
            code: 'target_owner_forbidden',
            details: { owner: 'my-org' },
        });
        renderForm();
        await pasteAndCheck();
        await act(async () => {
            fireEvent.click(screen.getByTestId('app-work-submit'));
        });
        expect((await screen.findByTestId('app-work-create-error')).textContent).toBe(
            "You can't create repositories in my-org.",
        );
    });

    it('shows the private-copy trade-off before submit and the owner switch needs no request', async () => {
        inspectMock.mockResolvedValue({ success: true, data: preview() });
        renderForm();
        await pasteAndCheck();
        fireEvent.click(screen.getByTestId('app-work-mode-private-copy'));
        expect(screen.getByTestId('app-work-setup-note').textContent).toContain(
            'A private copy is not linked to the original on GitHub',
        );
        fireEvent.change(screen.getByTestId('app-work-owner'), { target: { value: 'my-org' } });
        expect(inspectMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('app-work-submit').textContent).toContain(
            'Copy and create App Work',
        );
    });
});
