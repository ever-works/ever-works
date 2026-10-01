import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TermsAcceptanceDocument } from '@/lib/api/types-only';

const mocks = vi.hoisted(() => ({ startEverIdSignIn: vi.fn(), refresh: vi.fn() }));

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh }),
}));
vi.mock('@/app/actions/auth', () => ({ register: vi.fn(), connectProvider: vi.fn() }));
vi.mock('@/app/actions/ever-id', () => ({ startEverIdSignIn: mocks.startEverIdSignIn }));
vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }));

import RegisterForm from './register-form';
import { OAuthProvider } from '@/lib/api/enums';

/**
 * APW-12 T24 — "Sign up with Ever ID" on the registration page.
 *
 * Kept beside `register-form.unit.spec.tsx` (which stays as it was): the button
 * honours the same consent gate as the social buttons — disabled, with "Accept
 * the terms above to continue.", until the box is ticked — and is absent when
 * Ever ID is not offered.
 */

const TERMS: TermsAcceptanceDocument[] = [
    {
        documentId: 'tos:default',
        version: '2026-01-01',
        sha256: 'a'.repeat(64),
        locale: 'en',
        url: '/tos',
    } as TermsAcceptanceDocument,
];

describe('RegisterForm — Sign up with Ever ID', () => {
    beforeEach(() => {
        mocks.startEverIdSignIn.mockReset();
    });

    afterEach(() => cleanup());

    it('is absent unless Ever ID is offered — the form is unchanged', () => {
        render(<RegisterForm availableSocialProviders={[]} termsDocuments={TERMS} />);

        expect(screen.queryByTestId('ever-id-button')).not.toBeInTheDocument();
        expect(screen.queryByText('Or sign up with')).not.toBeInTheDocument();
    });

    it('is disabled with "Accept the terms above to continue." until consent', () => {
        render(<RegisterForm availableSocialProviders={[]} termsDocuments={TERMS} everIdEnabled />);

        const button = screen.getByRole('button', { name: 'Sign up with Ever ID' });
        expect(button).toBeDisabled();
        expect(screen.getByTestId('ever-id-button-reason')).toHaveTextContent(
            'Accept the terms above to continue.',
        );

        fireEvent.click(screen.getByRole('checkbox'));

        expect(screen.getByRole('button', { name: 'Sign up with Ever ID' })).toBeEnabled();
        expect(screen.queryByTestId('ever-id-button-reason')).not.toBeInTheDocument();
    });

    it('stays disabled while the terms could not be loaded, ticked or not', () => {
        render(<RegisterForm availableSocialProviders={[]} termsDocuments={[]} everIdEnabled />);

        expect(screen.getByRole('button', { name: 'Sign up with Ever ID' })).toBeDisabled();
    });

    it('sits with the social buttons, gated by the same condition', () => {
        render(
            <RegisterForm
                availableSocialProviders={[OAuthProvider.GITHUB]}
                termsDocuments={TERMS}
                everIdEnabled
            />,
        );

        expect(screen.getByRole('button', { name: 'Sign up with Ever ID' })).toBeDisabled();
        expect(screen.getByRole('button', { name: /GitHub/ })).toBeDisabled();

        fireEvent.click(screen.getByRole('checkbox'));

        expect(screen.getByRole('button', { name: 'Sign up with Ever ID' })).toBeEnabled();
        expect(screen.getByRole('button', { name: /GitHub/ })).toBeEnabled();
    });
});
