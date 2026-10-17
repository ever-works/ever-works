import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { AppTargetOwner } from '@ever-works/contracts';
import messages from '../../../../messages/en.json';
import { AppModeCards } from './AppModeCards';
import { AppTargetOwnerPicker } from './AppTargetOwnerPicker';
import { appSourceReasonParams } from '@/lib/work-kinds/app-source-reasons';

/** APW-01 T22 — the mode cards (spec §6.2, §6.6) and the target owner picker (FR-9). */

const params = appSourceReasonParams({ owner: 'acme', size: '600 MB' });

function wrap(node: React.ReactNode) {
    return render(
        <NextIntlClientProvider locale="en" messages={messages}>
            {node}
        </NextIntlClientProvider>,
    );
}

afterEach(cleanup);

describe('AppModeCards', () => {
    const modes = {
        link: { available: true },
        fork: { available: true },
        'private-copy': { available: false, reason: 'too_large_for_private_copy' as const },
    };

    it('announces a disabled mode’s reason as text wired through aria-describedby', () => {
        wrap(<AppModeCards modes={modes} value="fork" onChange={vi.fn()} reasonParams={params} />);
        const copy = screen.getByTestId('app-work-mode-private-copy');
        expect(copy.getAttribute('aria-disabled')).toBe('true');
        expect(copy.getAttribute('aria-describedby')).toBe('app-work-mode-private-copy-reason');
        expect(screen.getByTestId('app-work-mode-private-copy-reason').textContent).toBe(
            'Too large for a private copy (600 MB). Fork it instead.',
        );
    });

    it('↑/↓ move between available modes and skip disabled ones', () => {
        const onChange = vi.fn();
        wrap(<AppModeCards modes={modes} value="fork" onChange={onChange} reasonParams={params} />);
        // Order is Fork, Private copy, Link — ↓ from Fork skips the disabled copy.
        fireEvent.keyDown(screen.getByTestId('app-work-mode-fork'), { key: 'ArrowDown' });
        expect(onChange).toHaveBeenLastCalledWith('link');
        fireEvent.keyDown(screen.getByTestId('app-work-mode-link'), { key: 'ArrowDown' });
        expect(onChange).toHaveBeenLastCalledWith('fork');
        fireEvent.keyDown(screen.getByTestId('app-work-mode-fork'), { key: 'ArrowUp' });
        expect(onChange).toHaveBeenLastCalledWith('link');
    });

    it('a click on a disabled card does nothing', () => {
        const onChange = vi.fn();
        wrap(<AppModeCards modes={modes} value="fork" onChange={onChange} reasonParams={params} />);
        fireEvent.click(screen.getByTestId('app-work-mode-private-copy'));
        expect(onChange).not.toHaveBeenCalled();
    });

    it('titles Link “don’t follow upstream” on the member’s own fork', () => {
        wrap(
            <AppModeCards
                modes={modes}
                value="link"
                onChange={vi.fn()}
                reasonParams={params}
                ownFork
            />,
        );
        expect(screen.getByTestId('app-work-mode-link').textContent).toContain(
            "Link — don't follow upstream",
        );
    });
});

describe('AppTargetOwnerPicker', () => {
    const owners: AppTargetOwner[] = [
        {
            login: 'me',
            type: 'user',
            available: true,
            existingForkChecked: true,
            existingFork: {
                owner: 'me',
                repo: 'tasks-app',
                fullName: 'me/tasks-app',
                url: 'https://github.com/me/tasks-app',
                inUseByAnotherAccount: false,
            },
        },
        { login: 'big-org', type: 'organization', available: true, existingForkChecked: false },
        {
            login: 'locked-org',
            type: 'organization',
            available: false,
            reason: 'target_owner_forbidden',
            existingForkChecked: true,
        },
    ];

    it('shows the existing fork line for a checked owner that has one', () => {
        wrap(
            <AppTargetOwnerPicker
                owners={owners}
                value="me"
                onChange={vi.fn()}
                mode="fork"
                reasonParams={params}
            />,
        );
        expect(screen.getByTestId('app-work-existing-fork').textContent).toBe(
            'You already have a fork: me/tasks-app. Ever Works will use it.',
        );
    });

    it('keeps an owner the scan did not reach selectable, with no existing-fork line (ACC-01-26)', () => {
        wrap(
            <AppTargetOwnerPicker
                owners={owners}
                value="big-org"
                onChange={vi.fn()}
                mode="fork"
                reasonParams={params}
            />,
        );
        const option = screen.getByRole('option', { name: /big-org/ }) as HTMLOptionElement;
        expect(option.disabled).toBe(false);
        expect(option.textContent).toContain('not checked for an existing fork');
        expect(screen.queryByTestId('app-work-existing-fork')).toBeNull();
    });

    it('disables an owner the member cannot create in, naming it in the reason', () => {
        wrap(
            <AppTargetOwnerPicker
                owners={owners}
                value="me"
                onChange={vi.fn()}
                mode="fork"
                reasonParams={params}
            />,
        );
        const option = screen.getByRole('option', { name: /locked-org/ }) as HTMLOptionElement;
        expect(option.disabled).toBe(true);
        expect(option.textContent).toContain("You can't create repositories in locked-org.");
    });

    it('offers a search box only past ten owners', () => {
        const many: AppTargetOwner[] = Array.from({ length: 11 }, (_, i) => ({
            login: `org-${i}`,
            type: 'organization',
            available: true,
            existingForkChecked: false,
        }));
        wrap(
            <AppTargetOwnerPicker
                owners={many}
                value="org-0"
                onChange={vi.fn()}
                mode="fork"
                reasonParams={params}
            />,
        );
        const filter = screen.getByTestId('app-work-owner-filter');
        fireEvent.change(filter, { target: { value: 'org-1' } });
        // org-1 and org-10 match, and the selected org-0 always stays listed.
        expect(screen.getAllByRole('option')).toHaveLength(3);
    });
});
