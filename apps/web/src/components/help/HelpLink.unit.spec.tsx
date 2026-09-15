import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}));
const capture = vi.hoisted(() => vi.fn());
vi.mock('@/lib/help/help-telemetry', () => ({ captureHelpEvent: capture }));

import { HelpCenterProvider } from './HelpCenterProvider';
import { HelpLink } from './HelpLink';
import type { HelpTarget } from '@/lib/help/help-target';

afterEach(() => {
    capture.mockReset();
    vi.unstubAllEnvs();
});

function renderInShell(ui: React.ReactNode, onOpenTarget = vi.fn()) {
    const utils = render(<HelpCenterProvider onOpenTarget={onOpenTarget}>{ui}</HelpCenterProvider>);
    return { ...utils, onOpenTarget };
}

describe('HelpLink (spec FR-20–FR-25)', () => {
    it('reads "How this works" on an empty state and "Why am I seeing this?" on an error', () => {
        renderInShell(
            <>
                <HelpLink target="missions" variant="emptyState" />
                <HelpLink target="job-runtimes#settings--job-runtime" variant="error" />
            </>,
        );
        const links = screen.getAllByTestId('help-link');
        expect(links.map((link) => link.textContent)).toEqual([
            'dashboard.helpCenter.link.howThisWorks',
            'dashboard.helpCenter.link.whyAmISeeingThis',
        ]);
    });

    it('opens Help in place at the target instead of navigating', () => {
        const { onOpenTarget } = renderInShell(
            <HelpLink target="tasks#creating-a-task" variant="emptyState" />,
        );
        const link = screen.getByTestId('help-link');
        expect(link.tagName).toBe('BUTTON');
        expect(link).toHaveAttribute('type', 'button');
        expect(link).not.toHaveAttribute('href');
        fireEvent.click(link);
        expect(onOpenTarget).toHaveBeenCalledWith('tasks#creating-a-task');
        expect(capture).toHaveBeenCalledWith({
            name: 'help_deep_link_followed',
            properties: { target: 'tasks#creating-a-task', surface: 'empty_state' },
        });
    });

    it('reports the surface it sits on', () => {
        renderInShell(<HelpLink target="tasks" variant="error" surface="attention_item" />);
        fireEvent.click(screen.getByTestId('help-link'));
        expect(capture.mock.calls[0][0].properties.surface).toBe('attention_item');
    });

    it('is always secondary: text weight, never a filled button', () => {
        renderInShell(<HelpLink target="missions" variant="emptyState" />);
        const className = screen.getByTestId('help-link').className;
        expect(className).toContain('underline');
        expect(className).not.toMatch(/\bbg-(button-)?primary\b/);
    });

    it('renders nothing at all for an article this build does not have (spec S-16)', () => {
        vi.stubEnv('NODE_ENV', 'development');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { container } = renderInShell(
            <HelpLink target={'removed-article' as HelpTarget} variant="emptyState" />,
        );
        expect(container).toBeEmptyDOMElement();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed-article'));
        warn.mockRestore();
    });

    it('renders nothing outside the dashboard shell', () => {
        const { container } = render(<HelpLink target="missions" variant="emptyState" />);
        expect(container).toBeEmptyDOMElement();
    });
});
