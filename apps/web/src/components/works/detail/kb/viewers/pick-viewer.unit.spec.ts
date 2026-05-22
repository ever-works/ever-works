import { describe, expect, it } from 'vitest';
import { pickKbViewer } from './pick-viewer';

describe('pickKbViewer', () => {
    it('returns "text" for null / undefined / empty inputs', () => {
        expect(pickKbViewer(null)).toBe('text');
        expect(pickKbViewer(undefined)).toBe('text');
        expect(pickKbViewer('')).toBe('text');
        expect(pickKbViewer('   ')).toBe('text');
    });

    it('maps application/pdf to "pdf"', () => {
        expect(pickKbViewer('application/pdf')).toBe('pdf');
        expect(pickKbViewer('APPLICATION/PDF')).toBe('pdf');
        expect(pickKbViewer('application/pdf; charset=binary')).toBe('pdf');
    });

    it('maps the openxml spreadsheet MIME to "xlsx"', () => {
        expect(
            pickKbViewer('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
        ).toBe('xlsx');
    });

    it('maps the openxml word document MIME to "docx"', () => {
        expect(
            pickKbViewer('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
        ).toBe('docx');
    });

    it('maps image/* to "image"', () => {
        expect(pickKbViewer('image/png')).toBe('image');
        expect(pickKbViewer('image/jpeg')).toBe('image');
        expect(pickKbViewer('image/webp')).toBe('image');
        expect(pickKbViewer('image/svg+xml')).toBe('image');
    });

    it('maps video/* to "video"', () => {
        expect(pickKbViewer('video/mp4')).toBe('video');
        expect(pickKbViewer('video/webm')).toBe('video');
    });

    it('maps audio/* to "audio"', () => {
        expect(pickKbViewer('audio/mpeg')).toBe('audio');
        expect(pickKbViewer('audio/ogg')).toBe('audio');
        expect(pickKbViewer('audio/wav')).toBe('audio');
    });

    it('falls through to "text" for text/markdown, text/plain, text/csv', () => {
        // The KB editor / viewer pane already renders these from doc.body —
        // no need to swap to a binary viewer. CSV intentionally falls
        // through (the XLSX viewer parses via exceljs which rejects plain
        // CSV).
        expect(pickKbViewer('text/markdown')).toBe('text');
        expect(pickKbViewer('text/plain')).toBe('text');
        expect(pickKbViewer('text/csv')).toBe('text');
        expect(pickKbViewer('text/html')).toBe('text');
    });

    it('falls through to "text" for unknown / off-list MIMEs', () => {
        expect(pickKbViewer('application/octet-stream')).toBe('text');
        expect(pickKbViewer('application/zip')).toBe('text');
        expect(pickKbViewer('application/x-this-does-not-exist')).toBe('text');
    });

    it('strips Content-Type parameters and lowercases before matching', () => {
        expect(pickKbViewer('Image/PNG; charset=binary')).toBe('image');
        expect(pickKbViewer('  video/MP4  ')).toBe('video');
    });
});
