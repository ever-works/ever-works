import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FleetNodeView } from '@ever-works/contracts';

vi.mock('next-intl', async () => {
    const { testTranslations } = await import('../health/fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});

import { LinkLine } from './LinkLine';

/**
 * Fleet node link (FL-02, T-16, spec §5.1, FR-28, FR-41, FR-42) — the link
 * line under a computer's header, over the real `en.json`: the platform's own
 * socket state in words, the consents in force, the bytes, and the missing
 * consent's flag with its command.
 */

const node = (over: Partial<FleetNodeView> = {}): FleetNodeView =>
    ({
        id: 'n1',
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '0.3.0',
        capabilities: [],
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: null,
        persisted: true,
        viewerRole: 'owner',
        consents: { work: true, attend: false, manage: true, usageScan: false },
        link: {
            state: 'connected',
            since: new Date(Date.now() - 60_000).toISOString(),
            linkGeneration: 2,
            bytesIn: 12_000_000,
            bytesOut: 400_000,
            openChannels: 1,
        },
        ...over,
    }) as FleetNodeView;

const idle = { since: null, linkGeneration: null, bytesIn: 0, bytesOut: 0, openChannels: 0 };

describe('LinkLine', () => {
    it('says connected with the consents in force and the bytes (S1, FR-41)', () => {
        render(<LinkLine node={node()} />);
        const line = screen.getByTestId('fleet-computer-link');
        expect(line).toHaveAttribute('role', 'status');
        expect(line).toHaveAttribute('data-state', 'connected');
        expect(screen.getByTestId('fleet-computer-link-state')).toHaveTextContent('connected');
        expect(screen.getByTestId('fleet-computer-link-consent-work')).toHaveTextContent('work');
        expect(screen.getByTestId('fleet-computer-link-consent-manage')).toHaveTextContent(
            'manage',
        );
        expect(screen.queryByTestId('fleet-computer-link-consent-attend')).toBeNull();
        expect(screen.getByTestId('fleet-computer-link-bytes')).toHaveTextContent(
            '12 MB this link',
        );
        expect(screen.getByTestId('fleet-computer-link-missing')).toHaveTextContent('--attend off');
        expect(screen.getByTestId('fleet-computer-link-missing')).toHaveAttribute(
            'title',
            'To turn it on, run this on build-01: ever-works-node start --work --attend --manage',
        );
    });

    it('says a computer with no consent only reports health (S2)', () => {
        render(
            <LinkLine
                node={node({
                    consents: { work: false, attend: false, manage: false, usageScan: false },
                    link: { state: 'not-open', ...idle },
                })}
            />,
        );
        expect(screen.getByTestId('fleet-computer-link-state')).toHaveTextContent(
            'not open — this computer only reports health',
        );
        expect(screen.queryByTestId('fleet-computer-link-bytes')).toBeNull();
    });

    it('says reconnecting with when it was last connected (U8)', () => {
        render(
            <LinkLine
                node={node({
                    link: {
                        state: 'reconnecting',
                        ...idle,
                        since: new Date(Date.now() - 20_000).toISOString(),
                    },
                })}
            />,
        );
        expect(screen.getByTestId('fleet-computer-link-state')).toHaveTextContent(
            /reconnecting… \(last connected .+\)/,
        );
    });

    it('says the deployment does not accept links, and names no command there (U2)', () => {
        render(<LinkLine node={node({ link: { state: 'refused', ...idle } })} />);
        expect(screen.getByTestId('fleet-computer-link-state')).toHaveTextContent(
            'not accepted by this deployment',
        );
        expect(screen.queryByTestId('fleet-computer-link-missing')).toBeNull();
    });

    it('says a kind of computer that cannot link yet (R-10)', () => {
        render(
            <LinkLine
                node={node({ kind: 'desktop-node', link: { state: 'unsupported-kind', ...idle } })}
            />,
        );
        expect(screen.getByTestId('fleet-computer-link-state')).toHaveTextContent(
            'not available on this kind of computer yet',
        );
        expect(screen.queryByTestId('fleet-computer-link-missing')).toBeNull();
    });

    it('renders nothing when the view carries no link (FR-42: never a guess)', () => {
        const { container } = render(<LinkLine node={node({ link: undefined })} />);
        expect(container).toBeEmptyDOMElement();
    });
});
