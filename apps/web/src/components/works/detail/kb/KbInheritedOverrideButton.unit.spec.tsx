import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { actionMock, pushMock } = vi.hoisted(() => ({
    actionMock: vi.fn(),
    pushMock: vi.fn(),
}));

vi.mock('@/app/actions/works/kb-document', () => ({
    overrideInheritedKbDocumentAction: actionMock,
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: pushMock }),
}));

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { KbInheritedOverrideButton } from './KbInheritedOverrideButton';

describe('KbInheritedOverrideButton (row 38d)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders the live CTA with the locked test-id + active label', () => {
        render(
            <KbInheritedOverrideButton workId="work-1" orgId="org-1" idOrPath="legal/privacy.md" />,
        );
        const btn = screen.getByTestId('kb-inherited-override-cta');
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.hasAttribute('disabled')).toBe(false);
        expect(btn.textContent).toContain('inherited.overrideCta');
        expect(btn.hasAttribute('data-busy')).toBe(false);
    });

    it('invokes the server action with the right args on click and navigates on success', async () => {
        actionMock.mockResolvedValueOnce({
            success: true,
            data: { id: 'new-doc', path: 'legal/privacy.md' },
        });

        render(
            <KbInheritedOverrideButton workId="work-1" orgId="org-1" idOrPath="legal/privacy.md" />,
        );

        fireEvent.click(screen.getByTestId('kb-inherited-override-cta'));

        await waitFor(() => {
            expect(actionMock).toHaveBeenCalledWith({
                workId: 'work-1',
                orgId: 'org-1',
                idOrPath: 'legal/privacy.md',
            });
        });
        await waitFor(() => {
            expect(pushMock).toHaveBeenCalledWith('/works/work-1/kb/legal/privacy.md');
        });
    });

    it('shows the inline error and does NOT navigate when the action fails', async () => {
        actionMock.mockResolvedValueOnce({
            success: false,
            error: 'path already exists',
        });

        render(
            <KbInheritedOverrideButton workId="work-1" orgId="org-1" idOrPath="legal/privacy.md" />,
        );

        fireEvent.click(screen.getByTestId('kb-inherited-override-cta'));

        const err = await screen.findByTestId('kb-inherited-override-error');
        expect(err.textContent).toBe('path already exists');
        expect(err.getAttribute('role')).toBe('alert');
        expect(pushMock).not.toHaveBeenCalled();
    });

    it('falls back to the i18n error key when the action returns no error message', async () => {
        actionMock.mockResolvedValueOnce({ success: false, error: '' });

        render(
            <KbInheritedOverrideButton workId="work-1" orgId="org-1" idOrPath="legal/privacy.md" />,
        );

        fireEvent.click(screen.getByTestId('kb-inherited-override-cta'));

        const err = await screen.findByTestId('kb-inherited-override-error');
        expect(err.textContent).toBe('inherited.overrideErrorFallback');
    });
});
