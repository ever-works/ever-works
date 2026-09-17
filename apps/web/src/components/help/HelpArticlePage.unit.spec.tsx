import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));
vi.mock('@/i18n/navigation', () => ({
    useRouter: () => router,
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));
vi.mock('@/lib/help/help-telemetry', () => ({ captureHelpEvent: vi.fn() }));
vi.mock('./HelpBuildStamp', () => ({ HelpBuildStamp: () => null }));
vi.mock('./HelpArticleReader', () => ({
    HelpArticleReader: ({ headingId }: { headingId: string | null }) => (
        <div data-testid="reader" data-heading={headingId ?? ''} />
    ),
}));

import { HelpArticlePage } from './HelpArticlePage';

function setHash(hash: string) {
    window.history.replaceState(null, '', `/help/missions${hash}`);
}

beforeEach(() => setHash(''));
afterEach(() => setHash(''));

describe('HelpArticlePage — the URL fragment', () => {
    it('opens at the heading the fragment names, decoding percent-encoding', () => {
        setHash('#caf%C3%A9');
        render(<HelpArticlePage articleId="missions" />);
        expect(screen.getByTestId('reader')).toHaveAttribute('data-heading', 'café');
    });

    it('does not crash on a malformed fragment when the page loads (spec S-15)', () => {
        setHash('#%E0%A4%A');
        expect(() => render(<HelpArticlePage articleId="missions" />)).not.toThrow();
        expect(screen.getByTestId('reader')).toHaveAttribute('data-heading', '%E0%A4%A');
    });

    it('does not crash on a malformed fragment after a hash change', () => {
        render(<HelpArticlePage articleId="missions" />);
        expect(screen.getByTestId('reader')).toHaveAttribute('data-heading', '');
        act(() => {
            setHash('#%E0%A4%A');
            window.dispatchEvent(new HashChangeEvent('hashchange'));
        });
        expect(screen.getByTestId('reader')).toHaveAttribute('data-heading', '%E0%A4%A');
    });
});
