import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
    __resetShortcutRegistryForTests,
    registerShortcut,
    SHORTCUT_PRIORITY,
} from '@/lib/keyboard/shortcut-registry';

/**
 * Fleet hub (FL-01, FR-34, spec §5.12, T-28) — the computer page's shortcut
 * sheet: `?` opens it from anywhere on the page, never while typing and never
 * on a modifier chord, and it takes the key over from the dashboard's own help
 * while the page is open (one keystroke, one sheet).
 */

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { ComputerShortcutSheet, FLEET_COMPUTER_SHORTCUTS } from './ComputerShortcutSheet';

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
        target.dispatchEvent(event);
    });
    return event;
}

afterEach(() => {
    cleanup();
    __resetShortcutRegistryForTests();
    document.body.innerHTML = '';
});

describe('ComputerShortcutSheet', () => {
    it('is closed until `?` is pressed', () => {
        render(<ComputerShortcutSheet />);
        expect(screen.queryByTestId('fleet-computer-shortcuts')).toBeNull();
    });

    it('opens on `?` and lists every key of the page, in order', async () => {
        render(<ComputerShortcutSheet />);
        const event = press({ key: '?', shiftKey: true });
        expect(event.defaultPrevented).toBe(true);
        const sheet = await screen.findByTestId('fleet-computer-shortcuts');
        expect(sheet).toHaveTextContent('title');
        const labels = Array.from(sheet.querySelectorAll('dd')).map((dd) => dd.textContent);
        expect(labels).toEqual(FLEET_COMPUTER_SHORTCUTS.map((s) => `keys.${s.label}`));
        // Words are translated, symbols are shown as they are.
        const keys = Array.from(sheet.querySelectorAll('kbd')).map((kbd) => kbd.textContent);
        expect(keys).toEqual(['F', '←', '→', 'kbd.home', 'kbd.end', '?']);
    });

    it('never opens while the viewer is typing', () => {
        render(<ComputerShortcutSheet />);
        const input = document.createElement('input');
        document.body.appendChild(input);
        const typed = press({ key: '?', shiftKey: true }, input);
        expect(typed.defaultPrevented).toBe(false);
        expect(screen.queryByTestId('fleet-computer-shortcuts')).toBeNull();

        const area = document.createElement('textarea');
        document.body.appendChild(area);
        press({ key: '?', shiftKey: true }, area);
        expect(screen.queryByTestId('fleet-computer-shortcuts')).toBeNull();
    });

    it('ignores `?` on a modifier chord', () => {
        render(<ComputerShortcutSheet />);
        press({ key: '?', ctrlKey: true });
        press({ key: '?', metaKey: true });
        press({ key: '?', altKey: true });
        expect(screen.queryByTestId('fleet-computer-shortcuts')).toBeNull();
    });

    it('takes `?` over from a dashboard-wide binding while mounted, and gives it back after', async () => {
        const dashboardHelp = vi.fn();
        registerShortcut({
            id: 'dashboard.help',
            scope: 'global',
            priority: SHORTCUT_PRIORITY.global,
            match: (event) => event.key === '?',
            handler: dashboardHelp,
        });
        const { unmount } = render(<ComputerShortcutSheet />);
        press({ key: '?', shiftKey: true });
        expect(await screen.findByTestId('fleet-computer-shortcuts')).toBeInTheDocument();
        expect(dashboardHelp).not.toHaveBeenCalled();

        unmount();
        press({ key: '?', shiftKey: true });
        expect(dashboardHelp).toHaveBeenCalledTimes(1);
    });
});
