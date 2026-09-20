import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactElement } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { usePaletteKeyboard } from '@/components/command-palette/hooks/use-palette-keyboard';

const nav = vi.hoisted(() => ({ pathname: '/missions' }));
vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
    useLocale: () => 'en',
    useFormatter: () => ({ dateTime: () => '14 Sept 2026' }),
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
    usePathname: () => nav.pathname,
}));
vi.mock('@/lib/help/help-body', () => ({ loadHelpArticleBody: vi.fn(async () => null) }));
const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/help/help-telemetry', () => ({ captureHelpEvent: capture }));

import { HelpCenterPanel } from './HelpCenterPanel';
import { HELP_SEARCH_DEBOUNCE_MS } from '@/lib/help/help-search';

beforeEach(() => {
    nav.pathname = '/missions';
    capture.mockReset();
    Element.prototype.scrollIntoView = vi.fn();
    vi.useRealTimers();
});

async function typeQuery(value: string) {
    vi.useFakeTimers();
    fireEvent.change(screen.getByTestId('help-search-input'), { target: { value } });
    await act(async () => {
        vi.advanceTimersByTime(HELP_SEARCH_DEBOUNCE_MS + 1);
    });
    vi.useRealTimers();
}

function pressEscape(target: EventTarget) {
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
        target.dispatchEvent(escape);
    });
    return escape;
}

const drawerTeardown: Array<() => void> = [];
afterEach(() => {
    while (drawerTeardown.length) drawerTeardown.pop()!();
});

/**
 * Renders the panel the way the Help drawer does: inside the drawer's dialog
 * element (the Headless UI Dialog root carries `role="dialog"`), beside a close
 * button that is in that dialog but NOT inside the panel, under a Dialog whose
 * Esc handler is a window-level, bubble-phase `keydown` listener that closes
 * the drawer unless the event was already default-prevented
 * (@headlessui/react `useEscape`). Opened from a help link, the Dialog's
 * initial focus lands on that close button, so the panel's Esc has to work
 * with focus outside the panel. `above` renders a second overlay OUTSIDE the
 * drawer's dialog, the way the command palette stacks above the drawer.
 */
function renderInDrawer(panel: ReactElement, above?: ReactElement) {
    const closeDrawer = vi.fn();
    const dialogEscape = (event: KeyboardEvent) => {
        if (!event.defaultPrevented && event.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', dialogEscape);
    drawerTeardown.push(() => window.removeEventListener('keydown', dialogEscape));
    const view = render(
        <>
            <div role="dialog" aria-label="Help drawer">
                <button type="button">close drawer</button>
                {panel}
            </div>
            {above}
        </>,
    );
    const closeButton = screen.getByRole('button', { name: 'close drawer' });
    closeButton.focus();
    expect(closeButton).toHaveFocus();
    expect(screen.getByTestId('help-center-panel')).not.toContainElement(closeButton);
    return { ...view, closeButton, closeDrawer };
}

const noop = () => undefined;

/**
 * Stands in for the dashboard command palette opened on top of the drawer
 * (Ctrl/Cmd+K works while Help is open): its own dialog, outside the drawer's,
 * handling keys with the palette's real key map — which consumes Esc and
 * closes whether or not an earlier listener already claimed the key.
 */
function PaletteAbove() {
    const [open, setOpen] = useState(true);
    const onKeyDown = usePaletteKeyboard(
        { query: '', hasFilter: false, retryPending: false },
        {
            close: () => setOpen(false),
            applyFilter: noop,
            removeFilter: noop,
            openInNewTab: noop,
            activateIndex: noop,
            retry: noop,
        },
    );
    if (!open) return null;
    return (
        <div role="dialog" aria-label="Command palette" onKeyDown={onKeyDown}>
            <input aria-label="palette search" />
        </div>
    );
}

function focusPaletteInput() {
    const input = screen.getByRole('textbox', { name: 'palette search' });
    input.focus();
    expect(input).toHaveFocus();
    return input;
}

describe('HelpCenterPanel — browse', () => {
    it('shows the lead, On this screen for the current screen, and every section with its count', () => {
        render(<HelpCenterPanel onClose={vi.fn()} lead={<p>onboarding entry</p>} />);
        expect(screen.getByText('onboarding entry')).toBeInTheDocument();
        const onThisScreen = screen.getByTestId('help-on-this-screen');
        expect(within(onThisScreen).getByRole('button', { name: /Missions/ })).toBeInTheDocument();
        expect(document.querySelectorAll('[data-help-section]')).toHaveLength(6);
        expect(screen.getAllByText(/articleCount/)).toHaveLength(6);
    });

    it('omits On this screen when no article documents the current screen', () => {
        nav.pathname = '/definitely-not-a-screen';
        render(<HelpCenterPanel onClose={vi.fn()} />);
        expect(screen.queryByTestId('help-on-this-screen')).toBeNull();
    });

    it('opens an article from browse and walks back with Esc', () => {
        render(<HelpCenterPanel onClose={vi.fn()} />);
        fireEvent.click(
            within(screen.getByTestId('help-on-this-screen')).getByRole('button', {
                name: /Missions/,
            }),
        );
        expect(screen.getByTestId('help-article')).toHaveAttribute('data-article-id', 'missions');
        expect(capture).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'help_article_opened',
                properties: expect.objectContaining({
                    article_id: 'missions',
                    source: 'on_this_screen',
                }),
            }),
        );
        const escape = new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        });
        act(() => {
            screen.getByTestId('help-article').dispatchEvent(escape);
        });
        expect(escape.defaultPrevented).toBe(true);
        expect(screen.getByTestId('help-browse')).toBeInTheDocument();
    });

    it('lets Esc in browse reach the drawer so it can close', () => {
        render(<HelpCenterPanel onClose={vi.fn()} />);
        const escape = new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        });
        act(() => {
            screen.getByTestId('help-search-input').dispatchEvent(escape);
        });
        expect(escape.defaultPrevented).toBe(false);
    });
});

describe('HelpCenterPanel — deep links', () => {
    it('opens straight at the target article and reports the deep link', () => {
        render(<HelpCenterPanel onClose={vi.fn()} initialTarget="tasks#creating-a-task" />);
        expect(screen.getByTestId('help-article')).toHaveAttribute('data-article-id', 'tasks');
        expect(capture).toHaveBeenCalledWith({
            name: 'help_article_opened',
            properties: {
                article_id: 'tasks',
                section: 'running-the-loop',
                source: 'deep_link',
                via_heading: true,
            },
        });
        expect(screen.getByTestId('help-open-full-page')).toHaveAttribute(
            'href',
            '/help/tasks#creating-a-task',
        );
    });

    it('walks a deep-linked article back to browse with Esc while focus is outside the panel, and only then lets the drawer close', () => {
        const { closeButton, closeDrawer } = renderInDrawer(
            <HelpCenterPanel onClose={vi.fn()} initialTarget="tasks#creating-a-task" />,
        );
        expect(screen.getByTestId('help-article')).toHaveAttribute('data-article-id', 'tasks');

        const first = pressEscape(closeButton);
        expect(first.defaultPrevented).toBe(true);
        expect(closeDrawer).not.toHaveBeenCalled();
        expect(screen.queryByTestId('help-article')).toBeNull();
        expect(screen.getByTestId('help-browse')).toBeInTheDocument();

        const second = pressEscape(document.body);
        expect(second.defaultPrevented).toBe(false);
        expect(closeDrawer).toHaveBeenCalledTimes(1);
    });

    it('claims Esc dispatched at the window itself while an article is open', () => {
        const { closeDrawer } = renderInDrawer(
            <HelpCenterPanel onClose={vi.fn()} initialTarget="ideas" />,
        );
        const escape = pressEscape(window);
        expect(escape.defaultPrevented).toBe(true);
        expect(closeDrawer).not.toHaveBeenCalled();
        expect(screen.getByTestId('help-browse')).toBeInTheDocument();
    });

    it('claims Esc aimed at the page body while an article is open (focus fell out of the clicked row)', () => {
        const { closeDrawer } = renderInDrawer(<HelpCenterPanel onClose={vi.fn()} />);
        const row = within(screen.getByTestId('help-on-this-screen')).getByRole('button', {
            name: /Missions/,
        });
        row.focus();
        fireEvent.click(row);
        expect(screen.getByTestId('help-article')).toHaveAttribute('data-article-id', 'missions');

        const escape = pressEscape(document.body);
        expect(escape.defaultPrevented).toBe(true);
        expect(closeDrawer).not.toHaveBeenCalled();
        expect(screen.getByTestId('help-browse')).toBeInTheDocument();
    });

    it('leaves Esc aimed at an overlay stacked above the drawer to that overlay', () => {
        renderInDrawer(
            <HelpCenterPanel onClose={vi.fn()} initialTarget="tasks#creating-a-task" />,
            <PaletteAbove />,
        );
        expect(screen.getByTestId('help-article')).toHaveAttribute('data-article-id', 'tasks');

        pressEscape(focusPaletteInput());

        expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
        expect(screen.getByTestId('help-article')).toHaveAttribute('data-article-id', 'tasks');
    });

    it('leaves an open article alone when an earlier listener already claimed the Esc', () => {
        // The claimer is a window CAPTURE listener registered before the panel
        // mounts, so it runs before the panel's own window-capture listener
        // (same target and phase run in registration order; the panel re-adds
        // its listener on state changes, which only appends it later still).
        // A document- or element-level listener would run after the panel's.
        let claim = true;
        const claimer = vi.fn((event: KeyboardEvent) => {
            if (claim && event.key === 'Escape') event.preventDefault();
        });
        window.addEventListener('keydown', claimer, true);
        drawerTeardown.push(() => window.removeEventListener('keydown', claimer, true));
        const { closeButton, closeDrawer } = renderInDrawer(
            <HelpCenterPanel onClose={vi.fn()} initialTarget="tasks#creating-a-task" />,
        );
        expect(screen.getByTestId('help-article')).toHaveAttribute('data-article-id', 'tasks');

        const claimed = pressEscape(closeButton);
        expect(claimer).toHaveBeenCalledTimes(1);
        expect(claimed.defaultPrevented).toBe(true);
        expect(closeDrawer).not.toHaveBeenCalled();
        expect(screen.getByTestId('help-article')).toHaveAttribute('data-article-id', 'tasks');
        expect(screen.queryByTestId('help-browse')).toBeNull();

        // Control: the panel's listener is live — the same press, unclaimed,
        // steps back — so the article stayed open because the Esc was claimed.
        claim = false;
        expect(pressEscape(closeButton).defaultPrevented).toBe(true);
        expect(screen.queryByTestId('help-article')).toBeNull();
        expect(screen.getByTestId('help-browse')).toBeInTheDocument();
        expect(closeDrawer).not.toHaveBeenCalled();
    });

    it('stops claiming Esc once the panel unmounts', () => {
        const { closeDrawer, unmount } = renderInDrawer(
            <HelpCenterPanel onClose={vi.fn()} initialTarget="tasks" />,
        );
        unmount();
        const escape = pressEscape(document.body);
        expect(escape.defaultPrevented).toBe(false);
        expect(closeDrawer).toHaveBeenCalledTimes(1);
    });

    it('falls back to browse for a target this build does not have', () => {
        render(<HelpCenterPanel onClose={vi.fn()} initialTarget="agent-computers" />);
        expect(screen.getByTestId('help-browse')).toBeInTheDocument();
        expect(screen.getByTestId('help-open-full-page')).toHaveAttribute('href', '/help');
    });
});

describe('HelpCenterPanel — search', () => {
    it('does not search on one character and searches on two (spec FR-18.2)', async () => {
        render(<HelpCenterPanel onClose={vi.fn()} />);
        await typeQuery('t');
        expect(screen.getByTestId('help-browse')).toBeInTheDocument();
        await typeQuery('ta');
        expect(screen.getByTestId('help-search-results')).toBeInTheDocument();
        expect(screen.getByTestId('help-result-announcement').textContent).toMatch(/resultCount/);
    });

    it('moves through results with the arrow keys, never onto a section heading, and opens with Enter', async () => {
        render(<HelpCenterPanel onClose={vi.fn()} />);
        await typeQuery('agent');
        const input = screen.getByTestId('help-search-input');
        const options = screen.getAllByRole('option');
        expect(options.length).toBeGreaterThan(1);
        expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        expect(input).toHaveAttribute('aria-activedescendant', options[1].id);
        fireEvent.keyDown(input, { key: 'End' });
        expect(input).toHaveAttribute('aria-activedescendant', options[options.length - 1].id);
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        expect(input).toHaveAttribute('aria-activedescendant', options[options.length - 1].id);
        fireEvent.keyDown(input, { key: 'Home' });
        expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
        const firstId = options[0].getAttribute('data-help-result');
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(screen.getByTestId('help-article')).toHaveAttribute('data-article-id', firstId);
    });

    it('shows the no-results line and clears back to browse with Esc', async () => {
        render(<HelpCenterPanel onClose={vi.fn()} />);
        await typeQuery('zzzqqq');
        expect(screen.getByText(/noResults/)).toHaveTextContent('zzzqqq');
        const escape = new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        });
        act(() => {
            screen.getByTestId('help-search-input').dispatchEvent(escape);
        });
        expect(escape.defaultPrevented).toBe(true);
        expect(screen.getByTestId('help-browse')).toBeInTheDocument();
    });

    it('walks article → results → browse with Esc while focus is outside the panel, one step per press', async () => {
        const { closeButton, closeDrawer } = renderInDrawer(<HelpCenterPanel onClose={vi.fn()} />);
        await typeQuery('agent');
        fireEvent.keyDown(screen.getByTestId('help-search-input'), { key: 'Enter' });
        expect(screen.getByTestId('help-article')).toBeInTheDocument();
        closeButton.focus();

        expect(pressEscape(closeButton).defaultPrevented).toBe(true);
        expect(screen.getByTestId('help-search-results')).toBeInTheDocument();
        expect(screen.getByTestId('help-search-input')).toHaveValue('agent');

        expect(pressEscape(closeButton).defaultPrevented).toBe(true);
        expect(screen.getByTestId('help-browse')).toBeInTheDocument();
        expect(screen.getByTestId('help-search-input')).toHaveValue('');
        expect(closeDrawer).not.toHaveBeenCalled();

        expect(pressEscape(closeButton).defaultPrevented).toBe(false);
        expect(closeDrawer).toHaveBeenCalledTimes(1);
    });

    it('keeps the typed search when Esc is aimed at an overlay stacked above the drawer', async () => {
        renderInDrawer(<HelpCenterPanel onClose={vi.fn()} />, <PaletteAbove />);
        await typeQuery('agent');
        expect(screen.getByTestId('help-search-results')).toBeInTheDocument();

        pressEscape(focusPaletteInput());

        expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
        expect(screen.getByTestId('help-search-input')).toHaveValue('agent');
        expect(screen.getByTestId('help-search-results')).toBeInTheDocument();
    });

    it('focuses search with / from inside the panel', () => {
        render(<HelpCenterPanel onClose={vi.fn()} />);
        const summary = document.querySelector('summary')!;
        fireEvent.keyDown(summary, { key: '/' });
        expect(screen.getByTestId('help-search-input')).toHaveFocus();
    });
});
