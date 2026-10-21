import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FleetNodeView } from '@ever-works/contracts';

vi.mock('next-intl', async () => {
    const { testTranslations } = await import('../health/fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});

import { UpgradeRequiredSection } from './UpgradeRequiredSection';
import { nodeUpgradeCommand, selfUpdateMessageKey } from './link.shared';

/**
 * Fleet node link (FL-02, T-24, spec §5.4, S11, S12, U16) — the Settings
 * tab's "Node version" section, over the real `en.json`.
 */

const node = (over: Partial<FleetNodeView> = {}): FleetNodeView =>
    ({
        id: 'n2',
        name: 'build-02',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '0.2.1',
        capabilities: [],
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: null,
        persisted: true,
        viewerRole: 'owner',
        upgradeRequired: true,
        minNodeVersion: '0.3.0',
        selfUpdate: {
            enabled: false,
            failedAt: null,
            error: null,
            targetVersion: null,
            updatedAt: null,
            fromVersion: null,
        },
        ...over,
    }) as FleetNodeView;

describe('UpgradeRequiredSection', () => {
    it('says upgrade required with the version, the floor and the exact command (S11)', () => {
        render(<UpgradeRequiredSection node={node()} />);
        const section = screen.getByTestId('fleet-upgrade-section');
        expect(section).toHaveAttribute('data-required', 'true');
        expect(screen.getByTestId('fleet-upgrade-required')).toHaveTextContent('Upgrade required');
        expect(screen.getByTestId('fleet-upgrade-version')).toHaveTextContent(
            'build-02 runs ever-works-node 0.2.1. This deployment needs 0.3.0 or newer.',
        );
        expect(section).toHaveTextContent('It keeps reporting health but takes no work');
        expect(screen.getByTestId('fleet-upgrade-command-text')).toHaveTextContent(
            'npm install -g ever-works-node@latest && sudo systemctl restart ever-works-node@$USER',
        );
        expect(screen.getByTestId('fleet-upgrade-self-update')).toHaveTextContent(
            'Self-update: off on this computer. Start it with --auto-update',
        );
    });

    it('says when a self-update failed — run the command yourself (U16)', () => {
        render(
            <UpgradeRequiredSection
                node={node({
                    selfUpdate: {
                        enabled: true,
                        failedAt: '2026-10-21T09:12:00.000Z',
                        error: 'npm install exited 1',
                        targetVersion: '0.3.0',
                        updatedAt: null,
                        fromVersion: null,
                    },
                })}
            />,
        );
        const line = screen.getByTestId('fleet-upgrade-self-update');
        expect(line).toHaveAttribute('data-state', 'selfUpdateFailed');
        expect(line).toHaveTextContent(
            /Self-update failed on build-02 at .+ — run the command yourself\./,
        );
        expect(line).toHaveTextContent('Reason: npm install exited 1');
    });

    it('is one line for a computer that meets the floor, with no command', () => {
        render(
            <UpgradeRequiredSection
                node={node({
                    upgradeRequired: false,
                    version: '0.3.0',
                    selfUpdate: {
                        enabled: true,
                        failedAt: null,
                        error: null,
                        targetVersion: null,
                        updatedAt: '2026-10-21T09:20:00.000Z',
                        fromVersion: '0.2.1',
                    },
                })}
            />,
        );
        expect(screen.getByTestId('fleet-upgrade-version')).toHaveTextContent(
            'build-02 runs ever-works-node 0.3.0. It meets this deployment’s minimum (0.3.0).',
        );
        expect(screen.queryByTestId('fleet-upgrade-command')).toBeNull();
        expect(screen.getByTestId('fleet-upgrade-self-update')).toHaveTextContent(
            'Self-update: on',
        );
        expect(screen.getByTestId('fleet-upgrade-last-update')).toHaveTextContent('from 0.2.1');
    });

    it('says the report is missing for an older daemon, and nothing for a cluster row', () => {
        const { unmount } = render(
            <UpgradeRequiredSection node={node({ selfUpdate: undefined })} />,
        );
        expect(screen.getByTestId('fleet-upgrade-self-update')).toHaveAttribute(
            'data-state',
            'selfUpdateUnknown',
        );
        unmount();
        const { container } = render(<UpgradeRequiredSection node={node({ kind: 'k8s' })} />);
        expect(container).toBeEmptyDOMElement();
    });
});

describe('nodeUpgradeCommand / selfUpdateMessageKey', () => {
    it('restarts the shipped service per OS', () => {
        expect(nodeUpgradeCommand('linux/x64')).toContain(
            'systemctl restart ever-works-node@$USER',
        );
        expect(nodeUpgradeCommand('win32/x64')).toContain('Restart-Service EverWorksNode');
        expect(nodeUpgradeCommand('darwin/arm64')).toBe('npm install -g ever-works-node@latest');
    });

    it('reads failed only while no later success supersedes it', () => {
        expect(selfUpdateMessageKey(null)).toBe('selfUpdateUnknown');
        expect(selfUpdateMessageKey({ enabled: false })).toBe('selfUpdateOff');
        expect(selfUpdateMessageKey({ enabled: true, failedAt: '2026-10-21T09:00:00Z' })).toBe(
            'selfUpdateFailed',
        );
        expect(
            selfUpdateMessageKey({
                enabled: true,
                failedAt: '2026-10-21T09:00:00Z',
                updatedAt: '2026-10-21T10:00:00Z',
            }),
        ).toBe('selfUpdateOn');
    });
});
