import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/app/actions/auth', () => ({ connectProvider: vi.fn() }));
// `Button` reaches @/i18n/navigation, whose next-intl client entry does not
// resolve under vitest's ESM loader — the same stub the other component specs
// use. Nothing about the gate's behaviour is mocked.
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { SocialLoginButtons } from './social-login';
import { OAuthProvider } from '@/lib/api/enums';

/**
 * Registration presents a `required` consent checkbox and disables Create
 * account until the legal documents load — but the social buttons sit inside
 * that same form as `type="button"`, so a click never ran HTML5 constraint
 * validation and never reached the submit handler. An account was created with
 * the box unticked, and the only call to `termsAcceptanceService.record()`
 * lives on the email/password branch, so nothing was recorded either.
 *
 * This pins the gate itself. It is deliberately a RENDER test: the defect was a
 * path that skipped a precondition, which a predicate test cannot observe.
 */
describe('SocialLoginButtons — consent gate', () => {
    const providers = [OAuthProvider.GOOGLE, OAuthProvider.GITHUB];
    const buttons = () => screen.getAllByRole('button');

    it('control: the providers really do render when nothing blocks them', () => {
        // Without this, "all buttons disabled" below could be satisfied by the
        // component rendering no buttons at all.
        render(<SocialLoginButtons providers={providers} />);
        expect(buttons().length).toBe(providers.length);
        expect(buttons().every((b) => !b.hasAttribute('disabled'))).toBe(true);
    });

    it('disables every provider while the page precondition is unmet', () => {
        render(<SocialLoginButtons providers={providers} disabled disabledReason="accept terms" />);
        expect(buttons().length).toBe(providers.length);
        for (const b of buttons()) {
            expect(b).toBeDisabled();
            expect(b.getAttribute('aria-disabled')).toBe('true');
        }
    });

    it('explains itself rather than being mysteriously inert', () => {
        render(<SocialLoginButtons providers={providers} disabled disabledReason="accept terms" />);
        expect(buttons()[0].getAttribute('title')).toBe('accept terms');
    });

    it('leaves the login page untouched — disabled defaults to false', () => {
        // The login page has no consent precondition and passes no flag; it must
        // keep working exactly as before.
        render(<SocialLoginButtons providers={providers} />);
        for (const b of buttons()) {
            expect(b).not.toBeDisabled();
            expect(b.getAttribute('title')).toBeNull();
        }
    });
});
