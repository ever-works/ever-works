import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) =>
        React.createElement('a', { href, ...rest }, children),
    useRouter: () => ({
        push: vi.fn(),
        refresh: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        forward: vi.fn(),
        prefetch: vi.fn(),
    }),
    usePathname: () => '/',
}));

const acceptMock = vi.fn();
const archiveMock = vi.fn();
vi.mock('@/app/actions/works/kb-review', () => ({
    acceptKbDocumentAction: (...args: unknown[]) => acceptMock(...args),
    archiveKbDocumentAction: (...args: unknown[]) => archiveMock(...args),
}));

import { KbReviewBanner } from './KbReviewBanner';

describe('KbReviewBanner', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => vi.clearAllMocks());

    it('renders nothing for an accepted document (additive by construction)', () => {
        const { container } = render(
            <KbReviewBanner
                workId="work-1"
                document={{ id: 'doc-1', path: 'output/n.md', reviewState: 'accepted' }}
            />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders nothing for a pre-M7 document whose review state is null', () => {
        const { container } = render(
            <KbReviewBanner
                workId="work-1"
                document={{ id: 'doc-1', path: 'output/n.md', reviewState: null }}
            />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders for a proposed document with both review actions', () => {
        render(
            <KbReviewBanner
                workId="work-1"
                document={{ id: 'doc-1', path: 'output/n.md', reviewState: 'proposed' }}
            />,
        );
        expect(screen.getByTestId('kb-review-banner')).toBeTruthy();
        expect(screen.getByTestId('kb-review-banner-accept')).toBeTruthy();
        expect(screen.getByTestId('kb-review-banner-archive')).toBeTruthy();
    });

    it('accepts in place and then hides itself (edit-then-accept completion)', async () => {
        acceptMock.mockResolvedValue({ success: true, data: {} });
        render(
            <KbReviewBanner
                workId="work-1"
                document={{ id: 'doc-1', path: 'output/n.md', reviewState: 'proposed' }}
            />,
        );

        fireEvent.click(screen.getByTestId('kb-review-banner-accept'));
        await waitFor(() => expect(screen.queryByTestId('kb-review-banner')).toBeNull());
        expect(acceptMock).toHaveBeenCalledWith({
            workId: 'work-1',
            docId: 'doc-1',
            path: 'output/n.md',
        });
    });

    it('keeps the banner and shows the error when the action fails', async () => {
        archiveMock.mockResolvedValue({ success: false, error: 'denied' });
        render(
            <KbReviewBanner
                workId="work-1"
                document={{ id: 'doc-1', path: 'output/n.md', reviewState: 'proposed' }}
            />,
        );

        fireEvent.click(screen.getByTestId('kb-review-banner-archive'));
        await waitFor(() =>
            expect(screen.getByTestId('kb-review-banner-error').textContent).toBe('denied'),
        );
        expect(screen.getByTestId('kb-review-banner')).toBeTruthy();
    });
});
