import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

const pushMock = vi.fn();

vi.mock('@/i18n/navigation', () => ({
    useRouter: () => ({ push: pushMock }),
    usePathname: () => '/',
}));

import {
    __resetShortcutRegistryForTests,
    isModKey,
    SHORTCUT_PRIORITY,
} from '@/lib/keyboard/shortcut-registry';
import { useKeyboardShortcuts, WORKS_SEARCH_HREF } from './use-keyboard-shortcuts';
import { useShortcut } from './use-shortcut';

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
}

describe('useKeyboardShortcuts', () => {
    beforeEach(() => {
        pushMock.mockReset();
    });

    afterEach(() => {
        cleanup();
        __resetShortcutRegistryForTests();
        document.body.innerHTML = '';
    });

    it('opens the command palette on Ctrl/Cmd+K instead of navigating', () => {
        const onOpenPalette = vi.fn();
        renderHook(() => useKeyboardShortcuts({ onOpenPalette }));

        const event = press({ key: 'k', ctrlKey: true });
        press({ key: 'K', metaKey: true });

        expect(onOpenPalette).toHaveBeenCalledTimes(2);
        expect(onOpenPalette).toHaveBeenCalledWith('shortcut');
        expect(pushMock).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(true);
    });

    it('opens the palette on Ctrl+K even from inside a text field, inserting nothing', () => {
        const onOpenPalette = vi.fn();
        renderHook(() => useKeyboardShortcuts({ onOpenPalette }));
        const composer = document.createElement('textarea');
        document.body.appendChild(composer);

        const event = press({ key: 'k', ctrlKey: true }, composer);

        expect(onOpenPalette).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
    });

    it('keeps the original Works search destination when no palette is mounted', () => {
        renderHook(() => useKeyboardShortcuts());
        press({ key: 'k', ctrlKey: true });
        expect(pushMock).toHaveBeenCalledWith(WORKS_SEARCH_HREF);
    });

    it('opens the palette on "/" only outside text fields', () => {
        const onOpenPalette = vi.fn();
        renderHook(() => useKeyboardShortcuts({ onOpenPalette }));
        const input = document.createElement('input');
        document.body.appendChild(input);

        const typed = press({ key: '/' }, input);
        expect(onOpenPalette).not.toHaveBeenCalled();
        expect(typed.defaultPrevented).toBe(false);

        press({ key: '/' });
        expect(onOpenPalette).toHaveBeenCalledWith('slash');
    });

    it('does not bind "/" without a palette', () => {
        renderHook(() => useKeyboardShortcuts());
        const event = press({ key: '/' });
        expect(event.defaultPrevented).toBe(false);
        expect(pushMock).not.toHaveBeenCalled();
    });

    it('keeps C (new Work) and ? (help) exactly as before', () => {
        const onOpenHelp = vi.fn();
        renderHook(() => useKeyboardShortcuts({ onOpenHelp, onOpenPalette: vi.fn() }));
        const input = document.createElement('input');
        document.body.appendChild(input);

        press({ key: 'c' }, input);
        press({ key: '?' }, input);
        expect(pushMock).not.toHaveBeenCalled();
        expect(onOpenHelp).not.toHaveBeenCalled();

        press({ key: 'c' });
        press({ key: '?', shiftKey: true });
        press({ key: 'c', ctrlKey: true });
        expect(pushMock).toHaveBeenCalledTimes(1);
        expect(pushMock).toHaveBeenCalledWith('/works/new');
        expect(onOpenHelp).toHaveBeenCalledTimes(1);
    });

    it('yields Ctrl/Cmd+K to a screen-scoped palette on that screen, and takes it back after', () => {
        const onOpenPalette = vi.fn();
        const screenPalette = vi.fn();
        renderHook(() => useKeyboardShortcuts({ onOpenPalette }));
        const screen = renderHook(() =>
            useShortcut(
                {
                    id: 'kb',
                    scope: 'kb-workbench',
                    priority: SHORTCUT_PRIORITY.screen,
                    allowInInput: true,
                },
                (event) => isModKey(event, 'k'),
                screenPalette,
            ),
        );

        press({ key: 'k', ctrlKey: true });
        expect(screenPalette).toHaveBeenCalledTimes(1);
        expect(onOpenPalette).not.toHaveBeenCalled();
        expect(pushMock).not.toHaveBeenCalled();

        screen.unmount();
        press({ key: 'k', ctrlKey: true });
        expect(onOpenPalette).toHaveBeenCalledTimes(1);
        expect(screenPalette).toHaveBeenCalledTimes(1);
    });
});
