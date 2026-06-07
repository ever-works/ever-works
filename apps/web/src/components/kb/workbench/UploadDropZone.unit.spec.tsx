import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
}));

import { UploadDropZone } from './UploadDropZone';

/**
 * Minimal DataTransfer shim — JSDOM doesn't ship one and React's
 * synthetic event reads `dataTransfer.types` (string array) plus
 * `dataTransfer.files` (FileList-like). We supply both via the
 * second arg to `fireEvent.*`.
 */
function dt(files: File[] = [], types: string[] = ['Files']): DataTransfer {
    const list = {
        length: files.length,
        item: (i: number) => files[i] ?? null,
    } as unknown as FileList;
    return {
        types,
        files: list,
        dropEffect: 'none',
        effectAllowed: 'all',
    } as unknown as DataTransfer;
}

function makeFile(name: string, mime = 'text/plain', body = 'hello'): File {
    return new File([body], name, { type: mime });
}

describe('workbench UploadDropZone', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('highlights the zone on dragover and clears it on dragleave', () => {
        const onDrop = vi.fn();
        render(
            <UploadDropZone onDrop={onDrop}>
                <div data-testid="kb-workbench-group-brand" data-kb-class="brand">
                    brand group
                </div>
            </UploadDropZone>,
        );
        const zone = screen.getByTestId('kb-workbench-dropzone');
        expect(zone.getAttribute('data-active')).toBe('false');

        act(() => {
            fireEvent.dragEnter(zone, { dataTransfer: dt() });
            fireEvent.dragOver(zone, { dataTransfer: dt() });
        });
        expect(screen.getByTestId('kb-workbench-dropzone').getAttribute('data-active')).toBe(
            'true',
        );
        expect(screen.getByTestId('kb-workbench-dropzone-overlay')).toBeTruthy();

        act(() => {
            fireEvent.dragLeave(zone, { dataTransfer: dt() });
        });
        expect(screen.getByTestId('kb-workbench-dropzone').getAttribute('data-active')).toBe(
            'false',
        );
    });

    it('drops files and resolves the target class from the closest data-kb-class ancestor', () => {
        const onDrop = vi.fn();
        render(
            <UploadDropZone onDrop={onDrop}>
                <div data-testid="kb-workbench-group-legal" data-kb-class="legal">
                    <span data-testid="legal-inner">legal</span>
                </div>
            </UploadDropZone>,
        );
        const inner = screen.getByTestId('legal-inner');
        const file = makeFile('terms.pdf', 'application/pdf');
        act(() => {
            fireEvent.drop(inner, { dataTransfer: dt([file]) });
        });
        expect(onDrop).toHaveBeenCalledTimes(1);
        const [files, cls] = onDrop.mock.calls[0];
        expect(Array.isArray(files)).toBe(true);
        expect((files as File[])[0].name).toBe('terms.pdf');
        expect(cls).toBe('legal');
    });

    it('falls back to defaultClass when the drop lands outside any data-kb-class container', () => {
        const onDrop = vi.fn();
        render(
            <UploadDropZone onDrop={onDrop} defaultClass="freeform">
                <div data-testid="empty-tree">no groups</div>
            </UploadDropZone>,
        );
        const zone = screen.getByTestId('kb-workbench-dropzone');
        const file = makeFile('note.txt');
        act(() => {
            fireEvent.drop(zone, { dataTransfer: dt([file]) });
        });
        expect(onDrop).toHaveBeenCalledTimes(1);
        expect(onDrop.mock.calls[0][1]).toBe('freeform');
    });

    it('ignores non-file drags (e.g. text/html from in-page drags)', () => {
        const onDrop = vi.fn();
        render(
            <UploadDropZone onDrop={onDrop}>
                <div data-testid="kb-workbench-group-brand" data-kb-class="brand">
                    brand group
                </div>
            </UploadDropZone>,
        );
        const zone = screen.getByTestId('kb-workbench-dropzone');
        act(() => {
            fireEvent.dragEnter(zone, { dataTransfer: dt([], ['text/html']) });
            fireEvent.dragOver(zone, { dataTransfer: dt([], ['text/html']) });
        });
        expect(zone.getAttribute('data-active')).toBe('false');
        act(() => {
            fireEvent.drop(zone, { dataTransfer: dt([], ['text/html']) });
        });
        expect(onDrop).not.toHaveBeenCalled();
    });
});
