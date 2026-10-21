import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { __resetShortcutRegistryForTests } from '@/lib/keyboard/shortcut-registry';

/**
 * Fleet hub (FL-01, spec §5.12 / §5.13, FR-3, T-28) — the hub's tab strip: a
 * `tablist` of links in the order of CONTRACTS §11.1 with a roving tab index
 * (Left / Right / Home / End move the focus, Space opens the focused tab), and
 * `1` – `6` open the tabs in order from anywhere on a hub page — never while
 * typing, never on a modifier chord, and never for the tab already open.
 */

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => router,
    // React 19: `ref` arrives as a plain prop and is spread onto the anchor.
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

import { FleetHubTabs } from './FleetHubTabs';

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    act(() => {
        target.dispatchEvent(event);
    });
    return event;
}

beforeEach(() => {
    router.push.mockReset();
});

afterEach(() => {
    cleanup();
    __resetShortcutRegistryForTests();
    document.body.innerHTML = '';
});

describe('FleetHubTabs — the strip', () => {
    it('renders the six tabs as links, the open one selected and the only one in the tab order', () => {
        render(<FleetHubTabs active="computers" />);
        const tabs = screen.getAllByRole('tab');
        expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual([
            '/fleet',
            '/fleet/computers',
            '/fleet/sessions',
            '/fleet/checkouts',
            '/fleet/commands',
            '/fleet/usage',
        ]);
        const selected = screen.getByTestId('fleet-hub-tab-computers');
        expect(selected).toHaveAttribute('aria-selected', 'true');
        expect(selected).toHaveAttribute('aria-current', 'page');
        expect(selected).toHaveAttribute('aria-controls', 'fleet-hub-panel');
        expect(selected).toHaveAttribute('tabindex', '0');
        for (const tab of tabs.filter((candidate) => candidate !== selected)) {
            expect(tab).toHaveAttribute('aria-selected', 'false');
            expect(tab).toHaveAttribute('tabindex', '-1');
            expect(tab).not.toHaveAttribute('aria-controls');
        }
    });

    it('moves the focus with Left / Right (wrapping) and Home / End', () => {
        render(<FleetHubTabs active="overview" />);
        const overview = screen.getByTestId('fleet-hub-tab-overview');
        overview.focus();
        fireEvent.keyDown(overview, { key: 'ArrowRight' });
        expect(screen.getByTestId('fleet-hub-tab-computers')).toHaveFocus();
        fireEvent.keyDown(screen.getByTestId('fleet-hub-tab-computers'), { key: 'ArrowLeft' });
        expect(overview).toHaveFocus();
        fireEvent.keyDown(overview, { key: 'ArrowLeft' });
        expect(screen.getByTestId('fleet-hub-tab-usage')).toHaveFocus();
        fireEvent.keyDown(screen.getByTestId('fleet-hub-tab-usage'), { key: 'ArrowRight' });
        expect(overview).toHaveFocus();
        fireEvent.keyDown(overview, { key: 'End' });
        expect(screen.getByTestId('fleet-hub-tab-usage')).toHaveFocus();
        fireEvent.keyDown(screen.getByTestId('fleet-hub-tab-usage'), { key: 'Home' });
        expect(overview).toHaveFocus();
        // Moving the focus never navigates.
        expect(router.push).not.toHaveBeenCalled();
    });

    it('opens the focused tab on Space', () => {
        render(<FleetHubTabs active="overview" />);
        fireEvent.keyDown(screen.getByTestId('fleet-hub-tab-commands'), { key: ' ' });
        expect(router.push).toHaveBeenCalledWith('/fleet/commands');
    });
});

describe('FleetHubTabs — `1` – `6`', () => {
    it('opens the tab of the digit pressed', () => {
        render(<FleetHubTabs active="overview" />);
        const event = press({ key: '3' });
        expect(router.push).toHaveBeenCalledWith('/fleet/sessions');
        expect(event.defaultPrevented).toBe(true);
        press({ key: '6' });
        expect(router.push).toHaveBeenLastCalledWith('/fleet/usage');
        press({ key: '2' });
        expect(router.push).toHaveBeenLastCalledWith('/fleet/computers');
    });

    it('does nothing for the tab already open', () => {
        render(<FleetHubTabs active="sessions" />);
        press({ key: '3' });
        expect(router.push).not.toHaveBeenCalled();
    });

    it('lets digits past the last tab, and 0, through', () => {
        render(<FleetHubTabs active="overview" />);
        const seven = press({ key: '7' });
        const zero = press({ key: '0' });
        expect(router.push).not.toHaveBeenCalled();
        expect(seven.defaultPrevented).toBe(false);
        expect(zero.defaultPrevented).toBe(false);
    });

    it('never fires while the viewer is typing', () => {
        render(<FleetHubTabs active="overview" />);
        const input = document.createElement('input');
        document.body.appendChild(input);
        const typed = press({ key: '2' }, input);
        expect(typed.defaultPrevented).toBe(false);
        const editor = document.createElement('div');
        editor.contentEditable = 'true';
        // jsdom does not derive isContentEditable from the attribute.
        Object.defineProperty(editor, 'isContentEditable', { value: true });
        document.body.appendChild(editor);
        press({ key: '2' }, editor);
        expect(router.push).not.toHaveBeenCalled();
    });

    it('never fires on a modifier chord (browser tab switching keeps working)', () => {
        render(<FleetHubTabs active="overview" />);
        const ctrl = press({ key: '2', ctrlKey: true });
        press({ key: '2', metaKey: true });
        press({ key: '2', altKey: true });
        expect(router.push).not.toHaveBeenCalled();
        expect(ctrl.defaultPrevented).toBe(false);
    });

    it('stops answering once the strip is gone', () => {
        const { unmount } = render(<FleetHubTabs active="overview" />);
        unmount();
        press({ key: '2' });
        expect(router.push).not.toHaveBeenCalled();
    });
});
