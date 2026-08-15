import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MergePolicyOverride, ResolvedMergePolicy } from '@ever-works/contracts';
// `Button` pulls in `@/i18n/navigation`, whose next-intl client entry does
// not resolve under vitest's ESM loader. Same stub the other component
// specs use; nothing about the card's behaviour is mocked.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { MergePolicyCard } from './MergePolicyCard';

/**
 * Merge-policy matrix (Wave 3, D4) — the settings card.
 *
 * These specs are about LEGIBILITY, which is the whole reason the card
 * exists: a resolved policy is a fold of up to five layers, so showing
 * only effective values would make a user believe a switch is theirs when
 * it belongs to their organization. Every control has to name its owner,
 * and reset-to-inherit has to DELETE the key rather than write a falsy
 * value.
 */
const RESOLUTION: ResolvedMergePolicy = {
    policy: {
        allowAgentMerge: true,
        requireGreenGate: true,
        requireHumanApproval: false,
        allowedMergeMethods: ['squash'],
        protectedBranches: ['main', 'develop'],
    },
    source: 'work',
    chain: [
        { scope: 'default', id: null, fields: ['protectedBranches'] },
        { scope: 'tenant', id: 't1', fields: ['requireGreenGate'] },
        { scope: 'organization', id: 'o1', fields: ['requireHumanApproval'] },
        { scope: 'work', id: 'w1', fields: ['allowAgentMerge', 'allowedMergeMethods'] },
    ],
};

function mountCard(
    storedOverride: MergePolicyOverride | null,
    onSave = vi.fn().mockResolvedValue({ success: true }),
) {
    render(
        <MergePolicyCard
            scope="work"
            workId="w1"
            storedOverride={storedOverride}
            onSave={onSave}
            title="Merge policy"
            subtitle="Whether agents may land pull requests."
            testIdPrefix="mp"
        />,
    );
    return onSave;
}

/**
 * Wait until the card has the resolved policy.
 *
 * The whole card renders immediately — switches, reset buttons, the summary —
 * while `mp-summary` reads "Loading the effective policy…" until the resolver
 * answers (`lib/merge-policy.ts`: `if (!policy) return …`). So `findByTestId`
 * hands back a control that exists but is not yet backed by data: a click lands
 * on a pre-hydration element and the save assertion that follows never sees its
 * call. It fails only when the resolver is slower than the test — i.e. on a
 * loaded CI runner, which is exactly where it failed.
 *
 * Waiting on the loading text disappearing is the honest barrier: it is the
 * component's own signal that the policy arrived.
 */
async function waitForLoaded() {
    await waitFor(() =>
        expect(screen.getByTestId('mp-summary')).not.toHaveTextContent(
            'Loading the effective policy',
        ),
    );
}

describe('MergePolicyCard', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => RESOLUTION,
            }),
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('renders each field’s owning scope from the resolution chain', async () => {
        mountCard({ allowAgentMerge: true, allowedMergeMethods: ['squash'] });

        // Wait for the resolved origin label rather than for the element: the
        // origin badges render alongside mp-summary's loading placeholder, so
        // findByTestId can hand back a row that has not been populated yet. The
        // getBy assertions that follow are then safe — one poll settles the card.
        await waitFor(() =>
            expect(screen.getByTestId('mp-allowAgentMerge-origin')).toHaveTextContent('Set here'),
        );
        expect(screen.getByTestId('mp-requireGreenGate-origin')).toHaveTextContent(
            'Inherited from tenant',
        );
        expect(screen.getByTestId('mp-requireHumanApproval-origin')).toHaveTextContent(
            'Inherited from organization',
        );
        expect(screen.getByTestId('mp-protectedBranches-origin')).toHaveTextContent(
            'Platform default',
        );
    });

    it('resolves against the card’s subject only', async () => {
        mountCard(null);
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
            '/api/merge-policy/resolve?workId=w1',
        );
    });

    it('summarizes the effective policy in one sentence', async () => {
        mountCard(null);
        // findByTestId resolves as soon as the ELEMENT exists — and mp-summary
        // always exists, rendering "Loading the effective policy…" until the
        // resolver answers (lib/merge-policy.ts: `if (!policy) return …`). The
        // synchronous toHaveTextContent then read the placeholder and failed on
        // a loaded CI runner. Poll the assertion itself, so the wait is for the
        // CONTENT this test is actually about.
        await waitFor(() =>
            expect(screen.getByTestId('mp-summary')).toHaveTextContent(
                'Agents may merge using squash when the quality gate is green.',
            ),
        );
    });

    it('offers reset-to-inherit ONLY for fields this scope actually set', async () => {
        mountCard({ allowAgentMerge: true });

        expect(await screen.findByTestId('mp-allowAgentMerge-reset')).toBeInTheDocument();
        expect(screen.queryByTestId('mp-requireGreenGate-reset')).toBeNull();
        expect(screen.queryByTestId('mp-requireHumanApproval-reset')).toBeNull();
    });

    it('reset-to-inherit DELETES the key rather than writing false', async () => {
        const onSave = mountCard({ allowAgentMerge: true, requireGreenGate: false });
        await waitForLoaded();

        fireEvent.click(await screen.findByTestId('mp-requireGreenGate-reset'));

        await waitFor(() => expect(onSave).toHaveBeenCalled());
        expect(onSave).toHaveBeenCalledWith({ allowAgentMerge: true });
        const written = onSave.mock.calls[0][0] as MergePolicyOverride;
        expect('requireGreenGate' in written).toBe(false);
    });

    it('clearing the only override sends null, so the row stores NULL', async () => {
        const onSave = mountCard({ allowAgentMerge: true });
        await waitForLoaded();
        fireEvent.click(screen.getByTestId('mp-allowAgentMerge-reset'));
        await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
    });

    it('toggling a switch writes a PARTIAL that touches one field', async () => {
        const onSave = mountCard(null);
        await waitForLoaded();
        fireEvent.click(screen.getByTestId('mp-requireHumanApproval'));
        await waitFor(() => expect(onSave).toHaveBeenCalledWith({ requireHumanApproval: true }));
    });

    it('seeds the branch textarea from the EFFECTIVE policy, not the local override', async () => {
        mountCard({ allowAgentMerge: true });
        // `protectedBranches` is owned by the platform default here, so the
        // textarea must show the inherited list rather than an empty box —
        // otherwise saving any other field would silently wipe it.
        await waitFor(() =>
            expect(screen.getByTestId('mp-protected-branches')).toHaveValue('main\ndevelop'),
        );
    });

    it('saving branches parses the textarea into a normalized list', async () => {
        const onSave = mountCard({ allowAgentMerge: true });
        const textarea = await screen.findByTestId('mp-protected-branches');
        // Wait for the resolution to land: until it does the controls are
        // disabled (there is no effective policy to edit yet).
        await waitFor(() => expect(textarea).not.toBeDisabled());
        fireEvent.change(textarea, { target: { value: 'main\n main \nrelease' } });
        fireEvent.click(screen.getByTestId('mp-protected-branches-save'));
        await waitFor(() =>
            expect(onSave).toHaveBeenCalledWith({
                allowAgentMerge: true,
                protectedBranches: ['main', 'release'],
            }),
        );
    });

    it('surfaces a save failure instead of pretending it worked', async () => {
        const onSave = vi.fn().mockResolvedValue({ success: false, error: 'Forbidden' });
        mountCard(null, onSave);
        await waitForLoaded();
        fireEvent.click(screen.getByTestId('mp-allowAgentMerge'));
        // Same shape: wait for the message, not merely for the element.
        await waitFor(() =>
            expect(screen.getByTestId('mp-save-error')).toHaveTextContent('Forbidden'),
        );
    });

    it('surfaces an unreachable resolver rather than rendering a fabricated policy', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
        mountCard(null);
        expect(await screen.findByTestId('mp-error')).toBeInTheDocument();
        expect(screen.getByTestId('mp-summary')).toHaveTextContent('Loading the effective policy');
    });
});
