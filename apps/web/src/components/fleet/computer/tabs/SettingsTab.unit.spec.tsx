import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FleetNodeView } from '@ever-works/contracts';

/**
 * Fleet hub (FL-01, T-24, spec §5.10) — a computer's Settings tab: who can do
 * what (everyone who may see it), and the machine's own settings for its
 * owner only — never part of what a computer shares.
 */

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('../PolicyFamiliesEditor', () => ({
    PolicyFamiliesEditor: () => <div data-testid="stub-policy" />,
}));
vi.mock('../ComputerMachineSettings', () => ({
    ComputerMachineSettings: ({ apiBaseUrl }: { apiBaseUrl: string }) => (
        <div data-testid="stub-machine" data-api={apiBaseUrl} />
    ),
}));

import SettingsTab from './SettingsTab';

const node = (over: Partial<FleetNodeView> = {}): FleetNodeView =>
    ({
        id: 'n1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '1.0.0',
        capabilities: [],
        lastHeartbeatAt: null,
        createdAt: null,
        persisted: true,
        viewerRole: 'owner',
        ...over,
    }) as FleetNodeView;

const machine = {
    apiBaseUrl: 'http://localhost:3100',
    desktopDownloadUrl: 'https://example.test/d',
    nodeDownloadUrl: 'https://example.test/n',
};

describe('SettingsTab', () => {
    it('gives the owner who-can-do-what and the machine settings', () => {
        render(<SettingsTab node={node()} flags={{}} machine={machine} />);
        expect(screen.getByTestId('stub-policy')).toBeInTheDocument();
        expect(screen.getByTestId('stub-machine')).toHaveAttribute('data-api', machine.apiBaseUrl);
    });

    it('never gives the machine settings to someone the computer is shared with', () => {
        render(
            <SettingsTab node={node({ viewerRole: 'org-admin' })} flags={{}} machine={machine} />,
        );
        expect(screen.getByTestId('stub-policy')).toBeInTheDocument();
        expect(screen.queryByTestId('stub-machine')).toBeNull();
        expect(screen.queryByText('moreSettingsLink')).toBeNull();
    });

    it('points the owner at the Computers tab when the page passes no hand-over details', () => {
        render(<SettingsTab node={node()} flags={{}} />);
        expect(screen.queryByTestId('stub-machine')).toBeNull();
        expect(screen.getByText('moreSettingsLink')).toHaveAttribute('href', '/fleet/computers');
    });
});
