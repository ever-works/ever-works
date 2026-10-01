import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TermsAcceptanceDocument } from '@/lib/api/types-only';

const mocks = vi.hoisted(() => ({
    confirmEverIdSignUp: vi.fn(),
    cancelEverIdSignUp: vi.fn(),
    refresh: vi.fn(),
    readEverIdPending: vi.fn(),
    getRequiredTerms: vi.fn(),
}));

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});
vi.mock('next-intl/server', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return {
        getTranslations: async (namespace: string) => enUseTranslations(namespace),
        getLocale: async () => 'en',
    };
});
vi.mock('@/app/actions/ever-id', () => ({
    confirmEverIdSignUp: mocks.confirmEverIdSignUp,
    cancelEverIdSignUp: mocks.cancelEverIdSignUp,
}));
vi.mock('@/lib/auth/ever-id-cookies', () => ({ readEverIdPending: mocks.readEverIdPending }));
vi.mock('@/lib/api', () => ({ authAPI: { getRequiredTerms: mocks.getRequiredTerms } }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh }),
}));
vi.mock('@/components/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@/components/layout/AuthLayout', () => ({
    AuthLayout: ({
        title,
        subtitle,
        children,
    }: {
        title: string;
        subtitle: string;
        children: React.ReactNode;
    }) => (
        <main>
            <h1>{title}</h1>
            <p data-testid="auth-subtitle">{subtitle}</p>
            {children}
        </main>
    ),
}));

import EverIdCreateAccountPage from './page';
import { EverIdCreateAccountClient } from './create-account-client';

/**
 * APW-12 T25 — "Create your Ever Works account" (S2, spec §6.2; ACC-12-14 web
 * half): the identity read-only, the consent checkbox over the published terms,
 * Cancel creates nothing, and an expired pending value says so.
 */

const TERMS: TermsAcceptanceDocument[] = [
    {
        documentId: 'tos:default',
        version: '2026-01-01',
        sha256: 'a'.repeat(64),
        locale: 'en',
        url: '/tos',
    } as TermsAcceptanceDocument,
    {
        documentId: 'privacy:default',
        version: '2026-01-01',
        sha256: 'b'.repeat(64),
        locale: 'en',
        url: '/privacy',
    } as TermsAcceptanceDocument,
];

const PERSON = { name: 'Alice Martin', email: 'alice@example.com' };

describe('EverIdCreateAccountClient', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    it('shows the spec §6.2 copy, with the identity from Ever ID read-only', () => {
        render(<EverIdCreateAccountClient identity={PERSON} termsDocuments={TERMS} />);

        expect(
            screen.getByRole('heading', { name: 'Create your Ever Works account' }),
        ).toBeInTheDocument();
        expect(screen.getByTestId('auth-subtitle')).toHaveTextContent(
            'Signed in to Ever ID as Alice Martin · alice@example.com',
        );
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
    });

    it('names only the address when Ever ID sent no name', () => {
        render(
            <EverIdCreateAccountClient
                identity={{ name: null, email: 'alice@example.com' }}
                termsDocuments={TERMS}
            />,
        );

        expect(screen.getByTestId('auth-subtitle')).toHaveTextContent(
            'Signed in to Ever ID as alice@example.com',
        );
    });

    it('the consent checkbox reads as one sentence and links to the documents it records', () => {
        render(<EverIdCreateAccountClient identity={PERSON} termsDocuments={TERMS} />);

        const checkbox = screen.getByRole('checkbox');
        expect(checkbox).not.toBeChecked();
        expect(
            screen.getByText((_content, element) =>
                element?.tagName === 'LABEL'
                    ? element.textContent === 'I agree to the Terms of Service and Privacy Policy'
                    : false,
            ),
        ).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Terms of Service' }).getAttribute('href')).toMatch(
            /\/tos$/,
        );
        expect(screen.getByRole('link', { name: 'Privacy Policy' }).getAttribute('href')).toMatch(
            /\/privacy$/,
        );
    });

    it('requires the terms: nothing is sent until the box is ticked', () => {
        render(<EverIdCreateAccountClient identity={PERSON} termsDocuments={TERMS} />);

        fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

        expect(screen.getByRole('alert')).toHaveTextContent('Accept the terms above to continue.');
        expect(mocks.confirmEverIdSignUp).not.toHaveBeenCalled();
    });

    it('sends exactly the documents displayed once the box is ticked', async () => {
        mocks.confirmEverIdSignUp.mockReturnValue(new Promise(() => {}));
        render(<EverIdCreateAccountClient identity={PERSON} termsDocuments={TERMS} />);

        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.submit(screen.getByTestId('ever-id-create-account-form'));

        await waitFor(() => expect(mocks.confirmEverIdSignUp).toHaveBeenCalledTimes(1));
        expect(mocks.confirmEverIdSignUp).toHaveBeenCalledWith(
            TERMS.map(({ documentId, version, sha256, locale }) => ({
                documentId,
                version,
                sha256,
                locale,
            })),
        );
    });

    it('announces a refusal as it was translated', async () => {
        mocks.confirmEverIdSignUp.mockResolvedValue({
            success: false,
            error: "New accounts can't be created with Ever ID here. Ask an administrator for an invitation.",
            code: 'sign_up_not_allowed',
        });
        render(<EverIdCreateAccountClient identity={PERSON} termsDocuments={TERMS} />);

        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.submit(screen.getByTestId('ever-id-create-account-form'));

        expect(await screen.findByTestId('ever-id-create-account-error')).toHaveTextContent(
            "New accounts can't be created with Ever ID here.",
        );
    });

    it('an expired pending value on submit becomes "That took too long. Start again."', async () => {
        mocks.confirmEverIdSignUp.mockResolvedValue({
            success: false,
            error: 'That took too long. Start again.',
            code: 'pending_expired',
        });
        render(<EverIdCreateAccountClient identity={PERSON} termsDocuments={TERMS} />);

        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.submit(screen.getByTestId('ever-id-create-account-form'));

        expect(await screen.findByTestId('ever-id-create-account-expired')).toHaveTextContent(
            'That took too long. Start again.',
        );
        expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
            'href',
            '/login',
        );
    });

    it('"Cancel" creates nothing', async () => {
        render(<EverIdCreateAccountClient identity={PERSON} termsDocuments={TERMS} />);

        fireEvent.click(screen.getByRole('checkbox'));
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(mocks.cancelEverIdSignUp).toHaveBeenCalledTimes(1));
        expect(mocks.confirmEverIdSignUp).not.toHaveBeenCalled();
    });

    it('without a pending value: "That took too long. Start again." and a link to sign in', () => {
        render(<EverIdCreateAccountClient identity={null} termsDocuments={[]} />);

        expect(screen.getByTestId('ever-id-create-account-expired')).toHaveAttribute(
            'role',
            'alert',
        );
        expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
            'href',
            '/login',
        );
        expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument();
    });

    it('blocks creating, visibly and with a retry, when the terms could not be loaded', () => {
        render(<EverIdCreateAccountClient identity={PERSON} termsDocuments={[]} />);

        expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
        expect(screen.getByRole('checkbox')).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(mocks.refresh).toHaveBeenCalled();
    });
});

describe('EverIdCreateAccountPage', () => {
    beforeEach(() => {
        for (const fn of Object.values(mocks)) fn.mockReset();
    });

    afterEach(() => cleanup());

    it('reads the identity from the sign-up pending cookie and the terms from the API', async () => {
        mocks.readEverIdPending.mockResolvedValue({
            kind: 'signUp',
            pending: 'sealed',
            email: 'alice@example.com',
            name: 'Alice Martin',
            accountEmail: null,
        });
        mocks.getRequiredTerms.mockResolvedValue(TERMS);

        render(await EverIdCreateAccountPage());

        expect(mocks.readEverIdPending).toHaveBeenCalledWith('signUp');
        expect(mocks.getRequiredTerms).toHaveBeenCalledWith('en');
        expect(screen.getByTestId('auth-subtitle')).toHaveTextContent(
            'Signed in to Ever ID as Alice Martin · alice@example.com',
        );
    });

    it('renders the expired state, without asking for terms, when there is no pending value', async () => {
        mocks.readEverIdPending.mockResolvedValue(null);

        render(await EverIdCreateAccountPage());

        expect(screen.getByTestId('ever-id-create-account-expired')).toBeInTheDocument();
        expect(mocks.getRequiredTerms).not.toHaveBeenCalled();
    });
});
