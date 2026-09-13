import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WorkspaceSearchResponse } from '@ever-works/contracts/api';
import { createEnTranslator } from './__tests__/en-translator';

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    sendMessage: vi.fn(),
    fetch: vi.fn(),
    pathname: '/dashboard',
}));

vi.mock('next-intl', async () => {
    const { createEnTranslator: create } = await import('./__tests__/en-translator');
    const root = create();
    return {
        useTranslations: (namespace?: string) => {
            if (!namespace) return root;
            const scoped = (key: string, values?: Record<string, string | number | Date>) =>
                root(`${namespace}.${key}`, values);
            scoped.has = (key: string) => root.has(`${namespace}.${key}`);
            return scoped;
        },
    };
});

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: mocks.push, replace: vi.fn(), prefetch: vi.fn() }),
    usePathname: () => mocks.pathname,
}));
vi.mock('@/i18n/navigation-client', () => ({
    withWorkspaceHref: (href: string) => href,
}));
vi.mock('@/app/actions/auth', () => ({ logout: vi.fn() }));
vi.mock('@/components/ai/ChatProvider', () => ({
    useChatContextOptional: () => ({ sendMessage: mocks.sendMessage }),
}));
vi.mock('@/lib/hooks/use-theme', () => ({
    useTheme: () => ({ theme: 'light', isDark: false, toggleTheme: vi.fn(), mounted: true }),
}));
vi.mock('@/lib/hooks/use-organizations', () => ({
    useOrganizations: () => ({ organizations: [], isLoading: false, error: null, mutate: vi.fn() }),
}));
vi.mock('@/lib/hooks/use-active-scope', () => ({
    useActiveScope: () => ({ slug: null, activeOrganization: null }),
}));
vi.mock('@/lib/workspace-navigation', () => ({
    persistActiveOrganization: vi.fn(),
    navigateToWorkspaceDashboard: vi.fn(),
}));
vi.mock('@/lib/api/browser-api', () => ({
    browserApiFetch: (input: string, init: RequestInit) => mocks.fetch(input, init),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
    __resetShortcutRegistryForTests,
    isModKey,
    SHORTCUT_PRIORITY,
} from '@/lib/keyboard/shortcut-registry';
import { useKeyboardShortcuts } from '@/lib/hooks/use-keyboard-shortcuts';
import { useShortcut } from '@/lib/hooks/use-shortcut';
import { CommandPalette } from './CommandPalette';
import { CommandPaletteProvider, useCommandPalette } from './CommandPaletteProvider';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';

function searchResponse(overrides: Partial<WorkspaceSearchResponse> = {}): WorkspaceSearchResponse {
    return {
        query: 'invoice',
        groups: [
            {
                kind: 'mission',
                total: 1,
                hits: [
                    {
                        id: 'mission:m1',
                        kind: 'mission',
                        sourceId: 'm1',
                        title: 'Invoice reconciliation',
                        subtitle: null,
                        statusLabel: 'active',
                        destination: '/missions/m1',
                        score: 90,
                        matchReason: 'prefix',
                        updatedAt: null,
                    },
                ],
            },
            {
                kind: 'task',
                total: 1,
                hits: [
                    {
                        id: 'task:t1',
                        kind: 'task',
                        sourceId: 't1',
                        title: 'Invoice follow-up',
                        subtitle: 'T-418',
                        statusLabel: 'in_review',
                        destination: '/tasks/t1',
                        score: 90,
                        matchReason: 'prefix',
                        updatedAt: null,
                    },
                ],
            },
        ],
        degradedKinds: [],
        servedBy: 'fanout',
        tookMs: 5,
        ...overrides,
    };
}

function respondWith(body: WorkspaceSearchResponse) {
    mocks.fetch.mockImplementation(
        async () =>
            new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
    );
}

function Shortcuts() {
    const palette = useCommandPalette();
    useKeyboardShortcuts({ onOpenPalette: palette?.openPalette });
    return null;
}

const onOpenHelp = vi.fn();

function renderShell(extra?: React.ReactNode) {
    return render(
        <CommandPaletteProvider>
            <Shortcuts />
            <button type="button">before</button>
            <CommandPaletteTrigger />
            {extra}
            <CommandPalette
                userId="u1"
                onOpenHelp={onOpenHelp}
                chatOpen={false}
                onChatOpenChange={vi.fn()}
            />
        </CommandPaletteProvider>,
    );
}

function pressCtrlK(target: EventTarget = document.body) {
    act(() => {
        target.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'k',
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
    });
}

function input(): HTMLInputElement {
    return screen.getByTestId('command-palette-input') as HTMLInputElement;
}

function groupKinds(): string[] {
    return screen
        .queryAllByTestId('command-palette-group')
        .map((node) => node.getAttribute('data-group-kind') ?? '');
}

describe('CommandPalette', () => {
    beforeAll(() => {
        if (!Element.prototype.scrollIntoView) {
            Element.prototype.scrollIntoView = () => undefined;
        }
    });

    beforeEach(() => {
        mocks.push.mockReset();
        mocks.sendMessage.mockReset();
        mocks.fetch.mockReset();
        onOpenHelp.mockReset();
        mocks.pathname = '/dashboard';
        respondWith(searchResponse());
        window.localStorage.clear();
    });

    afterEach(() => {
        cleanup();
        __resetShortcutRegistryForTests();
    });

    it('opens on Ctrl+K as a labelled dialog with Suggested commands and no request', async () => {
        renderShell();
        expect(screen.queryByTestId('command-palette')).toBeNull();

        pressCtrlK();

        const dialog = await screen.findByRole('dialog', { name: 'Search and commands' });
        expect(dialog).toBeInTheDocument();
        await waitFor(() => expect(input()).toHaveFocus());
        expect(input()).toHaveAttribute('role', 'combobox');
        expect(groupKinds()).toEqual(['suggested']);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('opens from the top-bar trigger too', async () => {
        renderShell();
        fireEvent.click(screen.getByTestId('command-palette-trigger'));
        expect(await screen.findByTestId('command-palette')).toBeInTheDocument();
    });

    it('runs "New Mission" from the Commands group', async () => {
        renderShell();
        pressCtrlK();
        await screen.findByTestId('command-palette');

        fireEvent.change(input(), { target: { value: 'new mission' } });
        expect(groupKinds()[0]).toBe('command');
        fireEvent.keyDown(input(), { key: 'Enter' });

        expect(mocks.push).toHaveBeenCalledWith('/missions/new');
        await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());
    });

    it('shows Missions and Tasks as separate groups and remembers an opened record', async () => {
        renderShell();
        pressCtrlK();
        await screen.findByTestId('command-palette');

        fireEvent.change(input(), { target: { value: 'invoice' } });
        await waitFor(() => expect(groupKinds()).toEqual(['mission', 'task']));
        expect(mocks.fetch).toHaveBeenCalledTimes(1);
        expect(String(mocks.fetch.mock.calls[0][0])).toContain('/api/workspace-search?q=invoice');
        expect(screen.getByText('In review')).toBeInTheDocument();
        await waitFor(() =>
            expect(screen.getByTestId('command-palette-announcer')).toHaveTextContent('2 results'),
        );

        fireEvent.keyDown(input(), { key: 'Enter' });
        expect(mocks.push).toHaveBeenCalledWith('/missions/m1');
        await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());

        pressCtrlK();
        await screen.findByTestId('command-palette');
        const recent = screen
            .getAllByTestId('command-palette-group')
            .find((node) => node.getAttribute('data-group-kind') === 'recent');
        expect(recent).toBeDefined();
        expect(
            within(recent as HTMLElement).getByText('Invoice reconciliation'),
        ).toBeInTheDocument();
    });

    it('narrows with Tab, removes the chip with Esc, then closes with Esc', async () => {
        renderShell();
        pressCtrlK();
        await screen.findByTestId('command-palette');
        fireEvent.change(input(), { target: { value: 'invoice' } });
        await waitFor(() => expect(groupKinds()).toEqual(['mission', 'task']));

        fireEvent.keyDown(input(), { key: 'ArrowDown' });
        fireEvent.keyDown(input(), { key: 'Tab' });

        const chip = await screen.findByTestId('command-palette-filter-chip');
        expect(chip).toHaveAttribute('data-filter', 'task');
        await waitFor(() =>
            expect(String(mocks.fetch.mock.calls.at(-1)?.[0])).toContain('kinds=task'),
        );
        expect(String(mocks.fetch.mock.calls.at(-1)?.[0])).toContain('perKindLimit=25');

        fireEvent.keyDown(input(), { key: 'Escape' });
        expect(screen.queryByTestId('command-palette-filter-chip')).toBeNull();
        expect(screen.getByTestId('command-palette')).toBeInTheDocument();

        fireEvent.keyDown(input(), { key: 'Escape' });
        await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());
    });

    it('offers the three fallbacks when nothing matches', async () => {
        respondWith(searchResponse({ query: 'zzzqqq', groups: [] }));
        renderShell();
        pressCtrlK();
        await screen.findByTestId('command-palette');
        fireEvent.change(input(), { target: { value: 'zzzqqq' } });

        expect(await screen.findByTestId('command-palette-no-results')).toHaveTextContent(
            'No matches for “zzzqqq”',
        );
        const rows = screen
            .getAllByTestId('command-palette-row')
            .map((row) => row.getAttribute('data-action'));
        expect(rows).toEqual(['askChat', 'createTask', 'openHelp']);

        fireEvent.keyDown(input(), { key: 'Enter' });
        expect(mocks.sendMessage).toHaveBeenCalledWith('zzzqqq');
    });

    it('keeps healthy groups and says so when one source failed', async () => {
        respondWith(searchResponse({ degradedKinds: ['knowledge'] }));
        renderShell();
        pressCtrlK();
        await screen.findByTestId('command-palette');
        fireEvent.change(input(), { target: { value: 'invoice' } });

        const banner = await screen.findByTestId('command-palette-banner');
        expect(banner).toHaveAttribute('data-banner', 'partial');
        expect(groupKinds()).toEqual(['mission', 'task']);
    });

    it('asks for one more character before searching', async () => {
        renderShell();
        pressCtrlK();
        await screen.findByTestId('command-palette');
        fireEvent.change(input(), { target: { value: 'i' } });
        expect(screen.getByTestId('command-palette-banner')).toHaveAttribute(
            'data-banner',
            'tooShort',
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('hands Ctrl+K to a screen-scoped palette instead of opening a second overlay', async () => {
        const screenPalette = vi.fn();
        function ScreenPalette() {
            useShortcut(
                {
                    id: 'kb',
                    scope: 'kb-workbench',
                    priority: SHORTCUT_PRIORITY.screen,
                    allowInInput: true,
                },
                (event) => isModKey(event, 'k'),
                screenPalette,
            );
            return null;
        }
        renderShell(<ScreenPalette />);

        pressCtrlK();
        expect(screenPalette).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('command-palette')).toBeNull();

        fireEvent.click(screen.getByTestId('command-palette-trigger'));
        await screen.findByTestId('command-palette');
        pressCtrlK(input());
        expect(screenPalette).toHaveBeenCalledTimes(2);
        await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());
    });

    it('opens Help from the palette without navigating', async () => {
        renderShell();
        pressCtrlK();
        await screen.findByTestId('command-palette');
        fireEvent.change(input(), { target: { value: 'open help' } });
        fireEvent.keyDown(input(), { key: 'Enter' });
        expect(onOpenHelp).toHaveBeenCalledTimes(1);
        expect(mocks.push).not.toHaveBeenCalled();
    });

    it('closes when the route changes', async () => {
        const view = renderShell();
        pressCtrlK();
        await screen.findByTestId('command-palette');
        mocks.pathname = '/tasks';
        view.rerender(
            <CommandPaletteProvider>
                <Shortcuts />
                <button type="button">before</button>
                <CommandPaletteTrigger />
                {undefined}
                <CommandPalette
                    userId="u1"
                    onOpenHelp={onOpenHelp}
                    chatOpen={false}
                    onChatOpenChange={vi.fn()}
                />
            </CommandPaletteProvider>,
        );
        await waitFor(() => expect(screen.queryByTestId('command-palette')).toBeNull());
    });
});

// Keep the translator helper exercised directly so a broken en.json path fails loudly here too.
describe('en translator helper', () => {
    it('resolves palette copy', () => {
        expect(createEnTranslator()('dashboard.commandPalette.showAll', { count: 3 })).toBe(
            'Show all 3',
        );
    });
});
