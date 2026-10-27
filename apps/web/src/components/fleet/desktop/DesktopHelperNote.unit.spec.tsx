import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetHelperStatusView } from '@ever-works/contracts';

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});

import { DesktopHelperNote } from './DesktopHelperNote';

/** FL-07 T-44: the helper note in its three states. */
const helper = (extra: Partial<FleetHelperStatusView> = {}) =>
    ({
        trust: 'hash-pinned',
        present: true,
        admitted: true,
        version: '0.1.0',
        fingerprintPrefix: 'ab12cd34',
        verifiedAt: '2026-10-27T09:00:00.000Z',
        published: true,
        ...extra,
    }) satisfies FleetHelperStatusView;

describe('DesktopHelperNote', () => {
    afterEach(() => cleanup());

    it('shows nothing for a signed helper', () => {
        const { container } = render(
            <DesktopHelperNote nodeName="studio" trust="signed" helper={helper({ trust: 'signed' })} />,
        );
        expect(container.textContent).toBe('');
    });

    it('says Reduced trust for a hash-pinned helper, with its fingerprint', () => {
        render(<DesktopHelperNote nodeName="studio" trust="hash-pinned" helper={helper()} />);
        const note = screen.getByTestId('desktop-reduced-trust');
        expect(note.textContent).toContain('Reduced trust — the screen helper on studio is hash-pinned');
        expect(note.textContent).toContain('Fingerprint ab12cd34');
        expect(screen.queryByTestId('desktop-signed-available')).toBeNull();
    });

    it('offers the signed helper when this node version publishes one', () => {
        render(
            <DesktopHelperNote
                nodeName="studio"
                trust="hash-pinned"
                helper={helper({ signedAvailable: true })}
            />,
        );
        const offer = screen.getByTestId('desktop-signed-available');
        expect(offer.textContent).toContain('A signed helper is available');
        expect(offer.textContent).toContain('ever-works-node helper admit --signed');
    });
});
