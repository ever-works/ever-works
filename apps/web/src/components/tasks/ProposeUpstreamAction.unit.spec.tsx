import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { UPSTREAM_REFUSAL_CODES } from '@ever-works/contracts';
import messages from '../../../messages/en.json';

// `Button` imports the locale-aware `Link`; the action never navigates, so a plain anchor will do.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
import { ProposeUpstreamAction, type ProposeUpstreamActionView } from './ProposeUpstreamAction';

/**
 * APW-09 T11 — the Task's **Propose upstream** action, rendered with the REAL English
 * catalogue (ACC-09-02): hidden for a link, disabled with the S10 copy for a private copy,
 * disabled with the refusal copy otherwise, and never enabled while nothing can be prepared.
 */

const target = { owner: 'acme', repo: 'bookings', forkOwner: 'maya', forkRepo: 'bookings' };

function view(over: Partial<ProposeUpstreamActionView> = {}): ProposeUpstreamActionView {
    return {
        allowed: false,
        relation: 'fork',
        preparationAvailable: false,
        target,
        ...over,
    };
}

function renderAction(v: ProposeUpstreamActionView) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <ProposeUpstreamAction view={v} />
        </NextIntlClientProvider>,
    );
}

afterEach(() => cleanup());

describe('ProposeUpstreamAction (APW-09 T11)', () => {
    it('is hidden for a linked repository and for a Work with no relation (S11)', () => {
        const { container } = renderAction(view({ relation: 'link' }));
        expect(container.innerHTML).toBe('');
        cleanup();
        const none = renderAction(view({ relation: null }));
        expect(none.container.innerHTML).toBe('');
    });

    it('is disabled with the S10 copy for a private copy', () => {
        renderAction(view({ relation: 'private-copy' }));
        expect(screen.getByTestId('propose-upstream-button')).toBeDisabled();
        expect(screen.getByTestId('propose-upstream-reason').textContent).toBe(
            "A private copy isn't connected to acme/bookings on GitHub, so it can't propose pull requests there. Use a fork to contribute.",
        );
    });

    it('stays disabled for an eligible Task while preparation has not shipped', () => {
        renderAction(view({ allowed: true, preparationAvailable: false }));
        expect(screen.getByTestId('propose-upstream-button')).toBeDisabled();
        expect(screen.getByTestId('propose-upstream-reason').textContent).toContain(
            "preparing an upstream pull request isn't available yet",
        );
    });

    it('is enabled only when the server says eligible AND preparation is available', () => {
        renderAction(view({ allowed: true, preparationAvailable: true }));
        expect(screen.getByTestId('propose-upstream-button')).not.toBeDisabled();
    });

    it('shows the refusal copy of the server’s code', () => {
        renderAction(view({ code: 'sourceNotMerged' }));
        expect(screen.getByTestId('propose-upstream-reason').textContent).toBe(
            'This change has to be merged into your fork before it can be proposed upstream.',
        );
        cleanup();
        renderAction(view({ code: 'deniedUpstream' }));
        expect(screen.getByTestId('propose-upstream-reason').textContent).toBe(
            'Ever Works has been asked not to open pull requests on acme/bookings.',
        );
    });

    it('names the limit that refused (FR-27)', () => {
        renderAction(view({ code: 'rateLimited', limit: 'openPerUpstream', limitValue: 3 }));
        expect(screen.getByTestId('propose-upstream-reason').textContent).toBe(
            'You already have 3 open pull request on acme/bookings.',
        );
    });

    it('says the Task already has a proposal (FR-5)', () => {
        renderAction(view({ activeProposalId: 'r1' }));
        expect(screen.getByTestId('propose-upstream-reason').textContent).toBe(
            'This Task already has a proposal. Open it instead of starting another.',
        );
    });

    it('has English copy for every refusal code (spec §6.5, 30 of 30)', () => {
        const refusals = (
            messages as {
                dashboard: { workDetail: { upstream: { refusals: Record<string, string> } } };
            }
        ).dashboard.workDetail.upstream.refusals;
        expect(Object.keys(refusals).sort()).toEqual([...UPSTREAM_REFUSAL_CODES].sort());
    });
});
