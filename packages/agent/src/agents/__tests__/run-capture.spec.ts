import {
    buildCapturePreview,
    createRunCaptureState,
    extractTouchedFiles,
    CAPTURE_MESSAGE_MAX_CHARS,
    CAPTURE_PREVIEW_MAX_CHARS,
} from '../run-capture';

/**
 * Session detail (Feature K) — the pure capture helpers. The loop-level
 * behaviour (rows written, caps enforced across a run, failure
 * swallowing) is pinned in `agent-run-capture.spec.ts`; this file pins
 * the preview builder's THREE contracts — serialize, redact, cap — and
 * the touched-file extraction table.
 */
describe('run-capture helpers (Feature K)', () => {
    const GITHUB_PAT = 'ghp_' + 'a'.repeat(40);

    describe('buildCapturePreview', () => {
        it('passes short strings through untouched', () => {
            expect(buildCapturePreview('hello world')).toEqual({
                preview: 'hello world',
                truncated: false,
            });
        });

        it('JSON-stringifies non-string payloads', () => {
            expect(buildCapturePreview({ a: 1, b: 'two' })).toEqual({
                preview: '{"a":1,"b":"two"}',
                truncated: false,
            });
        });

        it('returns null for empty payloads so metadata keys are skipped', () => {
            expect(buildCapturePreview(null)).toBeNull();
            expect(buildCapturePreview(undefined)).toBeNull();
            expect(buildCapturePreview('')).toBeNull();
        });

        it('⭐ redacts secrets before they can be persisted', () => {
            const built = buildCapturePreview({ token: GITHUB_PAT, note: 'deploy key' });
            expect(built!.preview).not.toContain(GITHUB_PAT);
            expect(built!.preview).toContain('[redacted secret]');
            expect(built!.preview).toContain('deploy key');
        });

        it('⭐ redacts BEFORE truncating so a capped secret cannot survive as a prefix', () => {
            // Secret placed so the raw text's cap boundary would fall inside
            // it: redaction must run on the full string first. (The space
            // preserves the pattern's leading word boundary.)
            const body = 'x'.repeat(CAPTURE_PREVIEW_MAX_CHARS - 11) + ' ' + GITHUB_PAT;
            const built = buildCapturePreview(body);
            expect(built!.preview).not.toContain('ghp_');
        });

        it('caps oversized payloads with an ellipsis + truncated flag', () => {
            const built = buildCapturePreview('y'.repeat(CAPTURE_PREVIEW_MAX_CHARS + 100));
            expect(built!.truncated).toBe(true);
            expect(built!.preview.length).toBe(CAPTURE_PREVIEW_MAX_CHARS + 1); // + '…'
            expect(built!.preview.endsWith('…')).toBe(true);
        });

        it('honours a caller-supplied cap (message rows use 8 KB)', () => {
            const built = buildCapturePreview('z'.repeat(10_000), CAPTURE_MESSAGE_MAX_CHARS);
            expect(built!.truncated).toBe(true);
            expect(built!.preview.length).toBe(CAPTURE_MESSAGE_MAX_CHARS + 1);
        });

        it('never throws on circular payloads', () => {
            const circular: Record<string, unknown> = {};
            circular.self = circular;
            expect(buildCapturePreview(circular)).toEqual({
                preview: '[unserializable payload]',
                truncated: false,
            });
        });
    });

    describe('extractTouchedFiles', () => {
        it('maps commitToRepo file paths', () => {
            expect(
                extractTouchedFiles('commitToRepo', {
                    message: 'feat: x',
                    files: [
                        { path: 'src/a.ts', body: '…' },
                        { path: 'README.md', body: '…' },
                        { body: 'no path — dropped' },
                    ],
                }),
            ).toEqual(['src/a.ts', 'README.md']);
        });

        it('maps editAgentFile names', () => {
            expect(
                extractTouchedFiles('editAgentFile', { name: 'HEARTBEAT.md', body: '…' }),
            ).toEqual(['HEARTBEAT.md']);
        });

        it('returns [] for tools without explicit paths and for malformed args', () => {
            expect(extractTouchedFiles('searchWeb', { query: 'x' })).toEqual([]);
            expect(extractTouchedFiles('commitToRepo', null)).toEqual([]);
            expect(extractTouchedFiles('commitToRepo', { files: 'not-an-array' })).toEqual([]);
            expect(extractTouchedFiles('editAgentFile', {})).toEqual([]);
        });
    });

    describe('createRunCaptureState', () => {
        it('starts empty', () => {
            expect(createRunCaptureState()).toEqual({
                entries: 0,
                truncatedMarkerWritten: false,
                filesTouched: new Set(),
            });
        });
    });
});
