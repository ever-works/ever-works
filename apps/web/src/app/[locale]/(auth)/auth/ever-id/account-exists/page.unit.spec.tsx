import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readEverIdPendingMock } = vi.hoisted(() => ({ readEverIdPendingMock: vi.fn() }));

vi.mock('next-intl', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { useTranslations: enUseTranslations };
});
vi.mock('next-intl/server', async () => {
    const { enUseTranslations } = await import('@/lib/auth/__tests__/en-messages');
    return { getTranslations: async (namespace: string) => enUseTranslations(namespace) };
});
vi.mock('@/lib/auth/ever-id-cookies', () => ({ readEverIdPending: readEverIdPendingMock }));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
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

import EverIdAccountExistsPage from './page';

/**
 * APW-12 T25 — "You already have an Ever Works account" (S3, ACC-12-15 web half).
 *
 * The address comes from the encrypted pending cookie only (never from the
 * address bar), no account identifier appears, and the two ways back in are
 * "Forgot password?" and "Go to sign in".
 */
describe('EverIdAccountExistsPage', () => {
    beforeEach(() => {
        readEverIdPendingMock.mockReset();
    });

    afterEach(() => cleanup());

    it('shows the S3 copy with the address from the pending cookie, and both ways back', async () => {
        readEverIdPendingMock.mockResolvedValue({
            kind: 'emailInUse',
            pending: 'sealed-value',
            email: 'alice@example.com',
            name: null,
            accountEmail: null,
        });

        const { container } = render(await EverIdAccountExistsPage());

        expect(readEverIdPendingMock).toHaveBeenCalledWith('emailInUse');
        expect(
            screen.getByRole('heading', { name: 'You already have an Ever Works account' }),
        ).toBeInTheDocument();
        expect(screen.getByTestId('auth-subtitle')).toHaveTextContent(
            'An Ever Works account already uses alice@example.com. Sign in to it the way you usually do, then connect Ever ID in Settings → Security.',
        );
        expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
            'href',
            '/forgot-password',
        );
        expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
            'href',
            '/login',
        );
        // No account identifier and no sealed value reach the page.
        expect(container.innerHTML).not.toContain('sealed-value');
        for (const link of screen.getAllByRole('link')) {
            expect(link.getAttribute('href')).not.toContain('alice');
        }
    });

    it('without a pending value it says so and keeps both ways back', async () => {
        readEverIdPendingMock.mockResolvedValue(null);

        render(await EverIdAccountExistsPage());

        expect(screen.getByTestId('ever-id-account-exists-expired')).toHaveTextContent(
            'That took too long. Start again.',
        );
        expect(screen.getByRole('link', { name: 'Go to sign in' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Forgot password?' })).toBeInTheDocument();
    });
});
