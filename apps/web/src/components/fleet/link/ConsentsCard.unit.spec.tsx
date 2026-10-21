import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FleetNodeView } from '@ever-works/contracts';

vi.mock('next-intl', async () => {
    const { testTranslations } = await import('../health/fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});

import ConsentsCard, { kindCannotGive } from './ConsentsCard';

/**
 * Fleet node link (FL-02, T-16, spec §5.2, S1, S2, U12) — the consents card on
 * a computer's Overview: ✔ / ✖ per consent, the exact command for each one
 * that is off (keeping the others), the kind-cannot variant, the shared
 * viewer's "ask the owner", and the inferred note for an older daemon. Runs
 * over the real `en.json`, so a missing string fails here.
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
        ...over,
    }) as FleetNodeView;

function renderCard(value: FleetNodeView) {
    return render(<ConsentsCard nodes={[value]} flags={{}} />);
}

describe('ConsentsCard', () => {
    it('ticks what is on and offers the command for what is off (S1)', () => {
        renderCard(node());
        expect(screen.getByTestId('fleet-consents-card')).toHaveTextContent(
            'What build-01 lets Ever Works do',
        );
        expect(screen.getByTestId('fleet-consent-work')).toHaveAttribute('data-granted', 'true');
        expect(screen.getByTestId('fleet-consent-attend')).toHaveAttribute('data-granted', 'false');
        expect(screen.getByTestId('fleet-consent-manage')).toHaveAttribute('data-granted', 'true');
        expect(screen.getByTestId('fleet-consent-command-attend-text')).toHaveTextContent(
            'ever-works-node start --work --attend --manage',
        );
        expect(screen.queryByTestId('fleet-consent-command-work')).toBeNull();
        expect(screen.queryByTestId('fleet-consents-inferred')).toBeNull();
    });

    it('offers one command per missing consent for an enrolled-only computer (S2)', () => {
        renderCard(
            node({ consents: { work: false, attend: false, manage: false, usageScan: false } }),
        );
        expect(screen.getByTestId('fleet-consent-command-work-text')).toHaveTextContent(
            'ever-works-node start --work',
        );
        expect(screen.getByTestId('fleet-consent-command-attend-text')).toHaveTextContent(
            'ever-works-node start --attend',
        );
        expect(screen.getByTestId('fleet-consent-command-manage-text')).toHaveTextContent(
            'ever-works-node start --manage',
        );
    });

    it('says everything is on when it is', () => {
        renderCard(
            node({ consents: { work: true, attend: true, manage: true, usageScan: false } }),
        );
        expect(screen.getByTestId('fleet-consents-card')).toHaveTextContent(
            'Everything this computer can allow is on.',
        );
    });

    it('reads an older daemon from its tags and says so (U12)', () => {
        renderCard(node({ consents: null, capabilities: ['attended'], workerState: 'idle' }));
        expect(screen.getByTestId('fleet-consents-card')).toHaveAttribute('data-reported', 'false');
        expect(screen.getByTestId('fleet-consents-inferred')).toBeInTheDocument();
        expect(screen.getByTestId('fleet-consent-attend')).toHaveAttribute('data-granted', 'true');
        expect(screen.getByTestId('fleet-consent-manage')).toHaveAttribute('data-granted', 'false');
    });

    it('never offers a command the desktop app cannot honour yet (R-10)', () => {
        renderCard(
            node({
                kind: 'desktop-node',
                consents: { work: true, attend: false, manage: false, usageScan: false },
            }),
        );
        expect(screen.getByTestId('fleet-consent-kind-cannot-attend')).toHaveTextContent(
            'Live viewing is not available on this kind of computer yet.',
        );
        expect(screen.getByTestId('fleet-consent-kind-cannot-manage')).toBeInTheDocument();
        expect(screen.queryByTestId('fleet-consent-command-attend')).toBeNull();
    });

    it('asks a shared viewer to ask the owner instead of giving a command', () => {
        renderCard(node({ viewerRole: 'org-member' }));
        expect(screen.getByTestId('fleet-consent-ask-owner-attend')).toHaveTextContent(
            'Ask the owner of build-01 to start it with --attend.',
        );
        expect(screen.queryByTestId('fleet-consent-command-attend')).toBeNull();
    });

    it('renders nothing for a cluster row', () => {
        const { container } = renderCard(node({ kind: 'k8s' }));
        expect(container).toBeEmptyDOMElement();
    });
});

describe('kindCannotGive', () => {
    it('knows which kinds cannot give which consent yet', () => {
        expect(kindCannotGive({ kind: 'node' }, 'manage')).toBe(false);
        expect(kindCannotGive({ kind: 'desktop-node' }, 'work')).toBe(false);
        expect(kindCannotGive({ kind: 'desktop-node' }, 'attend')).toBe(true);
        expect(kindCannotGive({ kind: 'k8s' }, 'work')).toBe(true);
    });
});
