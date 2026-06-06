import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

// Stub the locale-aware Link primitive consumed by `<Button>` for href-mode
// renders. The modal only uses the button-mode, so an inert passthrough is fine.
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
    redirect: vi.fn(),
    getPathname: ({ href }: { href: string }) => href,
}));

import { UploadClassificationModal } from './UploadClassificationModal';

function makeFile(name: string, mime = 'application/pdf', body = 'pdfbytes'): File {
    return new File([body], name, { type: mime });
}

describe('workbench UploadClassificationModal', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('pre-fills the target class chip from defaultClass and renders the file list', () => {
        render(
            <UploadClassificationModal
                files={[makeFile('terms.pdf')]}
                defaultClass="legal"
                onUpload={vi.fn()}
                onCancel={vi.fn()}
            />,
        );
        expect(screen.getByTestId('kb-workbench-upload-modal')).toBeTruthy();
        expect(
            screen.getByTestId('kb-workbench-upload-modal-class-legal').getAttribute('data-active'),
        ).toBe('true');
        expect(
            screen.getByTestId('kb-workbench-upload-modal-class-brand').getAttribute('data-active'),
        ).toBe('false');
        expect(screen.getByTestId('kb-workbench-upload-modal-file-0').textContent).toContain(
            'terms.pdf',
        );
    });

    it('switching the chip changes which class is marked active', () => {
        render(
            <UploadClassificationModal
                files={[makeFile('a.pdf')]}
                defaultClass="freeform"
                onUpload={vi.fn()}
                onCancel={vi.fn()}
            />,
        );
        act(() => {
            fireEvent.click(screen.getByTestId('kb-workbench-upload-modal-class-research'));
        });
        expect(
            screen
                .getByTestId('kb-workbench-upload-modal-class-research')
                .getAttribute('data-active'),
        ).toBe('true');
    });

    it('adds tags via Enter and removes via the per-chip button', () => {
        render(
            <UploadClassificationModal
                files={[makeFile('a.pdf')]}
                defaultClass="freeform"
                onUpload={vi.fn()}
                onCancel={vi.fn()}
            />,
        );
        const input = screen.getByTestId('kb-workbench-upload-modal-tag-input') as HTMLInputElement;
        act(() => {
            fireEvent.change(input, { target: { value: 'q4' } });
            fireEvent.keyDown(input, { key: 'Enter' });
        });
        expect(screen.getByTestId('kb-workbench-upload-modal-tag-q4')).toBeTruthy();
        // Add another via comma
        act(() => {
            fireEvent.change(input, { target: { value: 'report' } });
            fireEvent.keyDown(input, { key: ',' });
        });
        expect(screen.getByTestId('kb-workbench-upload-modal-tag-report')).toBeTruthy();
        // Remove the first
        act(() => {
            fireEvent.click(screen.getByTestId('kb-workbench-upload-modal-tag-remove-q4'));
        });
        expect(screen.queryByTestId('kb-workbench-upload-modal-tag-q4')).toBeNull();
    });

    it('toggles auto-classify when the checkbox is clicked', () => {
        render(
            <UploadClassificationModal
                files={[makeFile('a.pdf')]}
                defaultClass="freeform"
                onUpload={vi.fn()}
                onCancel={vi.fn()}
            />,
        );
        const checkbox = screen.getByTestId(
            'kb-workbench-upload-modal-autoclassify',
        ) as HTMLInputElement;
        expect(checkbox.checked).toBe(false);
        act(() => {
            fireEvent.click(checkbox);
        });
        expect(checkbox.checked).toBe(true);
    });

    it('upload button invokes onUpload with the collected form input', () => {
        const onUpload = vi.fn();
        render(
            <UploadClassificationModal
                files={[makeFile('intake.pdf')]}
                defaultClass="freeform"
                onUpload={onUpload}
                onCancel={vi.fn()}
            />,
        );
        // Choose a different class
        act(() => {
            fireEvent.click(screen.getByTestId('kb-workbench-upload-modal-class-research'));
        });
        // Add a tag
        const tagInput = screen.getByTestId(
            'kb-workbench-upload-modal-tag-input',
        ) as HTMLInputElement;
        act(() => {
            fireEvent.change(tagInput, { target: { value: 'priority' } });
            fireEvent.keyDown(tagInput, { key: 'Enter' });
        });
        // Description
        const desc = screen.getByTestId(
            'kb-workbench-upload-modal-description',
        ) as HTMLTextAreaElement;
        act(() => {
            fireEvent.change(desc, { target: { value: 'A short note.' } });
        });
        // Auto-classify
        act(() => {
            fireEvent.click(screen.getByTestId('kb-workbench-upload-modal-autoclassify'));
        });
        // Submit
        act(() => {
            fireEvent.click(screen.getByTestId('kb-workbench-upload-modal-upload'));
        });
        expect(onUpload).toHaveBeenCalledTimes(1);
        const arg = onUpload.mock.calls[0][0];
        expect(arg).toEqual({
            class: 'research',
            tags: ['priority'],
            description: 'A short note.',
            autoClassify: true,
        });
    });

    it('cancel button calls onCancel', () => {
        const onCancel = vi.fn();
        render(
            <UploadClassificationModal
                files={[makeFile('a.pdf')]}
                defaultClass="freeform"
                onUpload={vi.fn()}
                onCancel={onCancel}
            />,
        );
        act(() => {
            fireEvent.click(screen.getByTestId('kb-workbench-upload-modal-cancel'));
        });
        expect(onCancel).toHaveBeenCalledTimes(1);
    });
});
