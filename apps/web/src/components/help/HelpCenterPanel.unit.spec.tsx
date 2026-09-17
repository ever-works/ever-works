import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

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

    it('focuses search with / from inside the panel', () => {
        render(<HelpCenterPanel onClose={vi.fn()} />);
        const summary = document.querySelector('summary')!;
        fireEvent.keyDown(summary, { key: '/' });
        expect(screen.getByTestId('help-search-input')).toHaveFocus();
    });
});
