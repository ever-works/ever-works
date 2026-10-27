import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// The REAL English strings: a key a component asks for that `en.json` lacks
// fails the test instead of echoing (see `fleet-test-intl.ts`).
vi.mock('next-intl', async () => {
    const { testTranslations } = await import('../health/fleet-test-intl');
    return { useLocale: () => 'en-GB', useTranslations: testTranslations };
});

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));

import { GrantAccessCard } from './GrantAccessCard';

/** Actions runners on computers (FL-18 P2, spec §5.6, FR-26) — "Organisation runners need one more permission". */
describe('GrantAccessCard', () => {
    it('names the account and the exact permission, and links the installation on GitHub', () => {
        render(
            <GrantAccessCard
                account="acme"
                permission="Self-hosted runners: Read and write"
                grantUrl="https://github.com/organizations/acme/settings/installations/1"
                onCheckAgain={vi.fn()}
            />,
        );
        expect(
            screen.getByText('Organisation runners need one more permission'),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                'The Ever Works GitHub App on acme needs “Self-hosted runners: Read and write”. Grant it on GitHub, then come back and press Check again.',
            ),
        ).toBeInTheDocument();
        const grant = screen.getByTestId('fleet-runners-grant-access-grant');
        expect(grant).toHaveAttribute(
            'href',
            'https://github.com/organizations/acme/settings/installations/1',
        );
        expect(grant).toHaveAttribute('target', '_blank');
        expect(grant).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('still asks for the permission when the API did not name it, and has no link without a URL', () => {
        render(
            <GrantAccessCard
                account="acme"
                permission={null}
                grantUrl={null}
                onCheckAgain={vi.fn()}
            />,
        );
        expect(
            screen.getByText(/needs one more permission\. Grant it on GitHub/),
        ).toBeInTheDocument();
        expect(screen.queryByTestId('fleet-runners-grant-access-grant')).toBeNull();
    });

    it('re-asks on Check again and switches to a repository when the caller offers it', () => {
        const onCheckAgain = vi.fn();
        const onUseRepository = vi.fn();
        render(
            <GrantAccessCard
                account="acme"
                permission={null}
                grantUrl={null}
                onCheckAgain={onCheckAgain}
                onUseRepository={onUseRepository}
            />,
        );
        fireEvent.click(screen.getByText('Check again'));
        expect(onCheckAgain).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByText('Use a repository instead'));
        expect(onUseRepository).toHaveBeenCalledTimes(1);
    });

    it('offers no "Use a repository instead" when the caller cannot switch, and shows a running check', () => {
        render(
            <GrantAccessCard
                account="acme"
                permission={null}
                grantUrl={null}
                checking
                onCheckAgain={vi.fn()}
            />,
        );
        expect(screen.queryByText('Use a repository instead')).toBeNull();
        expect(screen.getByTestId('fleet-runners-grant-access-check')).toBeDisabled();
        expect(screen.getByTestId('fleet-runners-grant-access-check')).toHaveTextContent(
            'Checking…',
        );
    });

    it('says exactly what to accept on GitHub (FL-18 A16, owner decision 2026-10-27)', () => {
        render(
            <GrantAccessCard
                account="acme"
                permission="Self-hosted runners: Read and write"
                grantUrl="https://github.com/organizations/acme/settings/installations/1"
                onCheckAgain={vi.fn()}
            />,
        );
        expect(screen.getByTestId('fleet-runners-grant-access-accept')).toHaveTextContent(
            'What to accept: in the Ever Works GitHub App’s installation settings on GitHub, press “Review request”, check that “Self-hosted runners: Read and write” is listed, then press “Accept new permissions”.',
        );
    });

    it('says what to accept when the permission was not named', () => {
        render(
            <GrantAccessCard
                account="acme"
                permission={null}
                grantUrl={null}
                onCheckAgain={vi.fn()}
            />,
        );
        expect(screen.getByTestId('fleet-runners-grant-access-accept')).toHaveTextContent(
            /press “Review request”, then “Accept new permissions”\. No request there\?/,
        );
    });
});
