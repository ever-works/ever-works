import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
        `${namespace}.${key}${values ? JSON.stringify(values) : ''}`,
}));
vi.mock('@/components/help/HelpCenterPanel', () => ({
    HelpCenterPanel: ({
        initialTarget,
        lead,
    }: {
        initialTarget?: string | null;
        lead?: React.ReactNode;
    }) => (
        <div data-testid="help-center-panel" data-initial-target={initialTarget ?? ''}>
            {lead}
        </div>
    ),
}));

import { HelpDrawer } from './HelpDrawer';

const onboarding = { currentStep: 2, totalSteps: 7, onOpen: vi.fn() };

beforeEach(() => onboarding.onOpen.mockReset());

function tabNames() {
    return screen.getAllByRole('tab').map((tab) => tab.textContent);
}

describe('HelpDrawer — the Manual tab (AW-25) beside the existing four', () => {
    it('puts the Manual first and keeps Tips, Shortcuts, FAQ and Resources in their order', () => {
        render(<HelpDrawer open onClose={vi.fn()} />);
        expect(tabNames()).toEqual([
            'dashboard.helpCenter.tabLabel',
            'dashboard.header.help.tabs.tips',
            'dashboard.header.help.tabs.shortcuts',
            'dashboard.header.help.tabs.faq',
            'dashboard.header.help.tabs.resources',
        ]);
        expect(
            screen.getByRole('heading', { name: 'dashboard.header.help.title' }),
        ).toBeInTheDocument();
    });

    it('opens on the Manual when no tab is asked for', () => {
        render(<HelpDrawer open onClose={vi.fn()} />);
        expect(screen.getByTestId('help-center-panel')).toBeInTheDocument();
        expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true');
    });

    it('still opens on the tab a command asks for', () => {
        render(<HelpDrawer open onClose={vi.fn()} initialTab="shortcuts" />);
        expect(screen.getByText('dashboard.header.help.shortcuts.title')).toBeInTheDocument();
        expect(screen.queryByTestId('help-center-panel')).toBeNull();
    });

    it('opens on the Manual at an article when a help link asks, over any tab', () => {
        render(
            <HelpDrawer
                open
                onClose={vi.fn()}
                initialTab="faq"
                initialTarget="tasks#creating-a-task"
            />,
        );
        expect(screen.getByTestId('help-center-panel')).toHaveAttribute(
            'data-initial-target',
            'tasks#creating-a-task',
        );
    });

    it('keeps every existing tab rendering its own content', () => {
        render(<HelpDrawer open onClose={vi.fn()} onboarding={onboarding} />);
        fireEvent.click(screen.getByRole('tab', { name: 'dashboard.header.help.tabs.tips' }));
        expect(screen.getByText('dashboard.header.help.quickTips.title')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: 'dashboard.header.help.tabs.faq' }));
        expect(screen.getByText('dashboard.header.help.faq.q1')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: 'dashboard.header.help.tabs.resources' }));
        expect(
            screen.getByRole('link', { name: 'dashboard.header.help.links.docs' }),
        ).toHaveAttribute('href', 'https://docs.ever.works/docs');
    });

    it('offers the onboarding entry on the Manual and on Tips, and it still opens onboarding', () => {
        const onClose = vi.fn();
        render(<HelpDrawer open onClose={onClose} onboarding={onboarding} />);
        const label = 'dashboard.header.help.onboarding.action{"currentStep":2,"totalSteps":7}';
        fireEvent.click(
            screen.getByRole('button', { name: new RegExp(label.replace(/[{}"]/g, '.')) }),
        );
        expect(onboarding.onOpen).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole('tab', { name: 'dashboard.header.help.tabs.tips' }));
        expect(screen.getByText(label)).toBeInTheDocument();
    });
});
