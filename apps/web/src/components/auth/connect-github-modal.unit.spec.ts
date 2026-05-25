import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: 'a',
    usePathname: () => '/dashboard',
}));

vi.mock('next/navigation', () => ({
    useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/app/actions/dashboard/oauth', () => ({
    connectOAuthProvider: vi.fn(),
}));

import { shouldOpenConnectGithubModal } from './connect-github-modal';

describe('shouldOpenConnectGithubModal', () => {
    it('does not auto-open for an unconnected user without an explicit prompt', () => {
        expect(
            shouldOpenConnectGithubModal({
                hasGithubConnected: false,
                shouldForcePrompt: false,
                dismissed: false,
            }),
        ).toBe(false);
    });

    it('still opens for explicit connectGithub prompts', () => {
        expect(
            shouldOpenConnectGithubModal({
                hasGithubConnected: false,
                shouldForcePrompt: true,
                dismissed: true,
            }),
        ).toBe(true);
    });

    it('does not open when GitHub is already connected', () => {
        expect(
            shouldOpenConnectGithubModal({
                hasGithubConnected: true,
                shouldForcePrompt: true,
                dismissed: false,
            }),
        ).toBe(false);
    });
});
