import {
    KB_EMBED_DOCUMENT_DISPATCHER,
    type KbEmbedDocumentDispatcher,
} from './kb-embed-document-dispatcher';
import type { KbEmbedDocumentPayload } from './kb-embed-document.types';

/**
 * EW-641 Phase 2/a row 29b1.
 *
 * The barrel symbol-count test in `tasks.spec.ts` covers presence;
 * these cases pin the dispatcher's identity + contract so a future
 * refactor that accidentally widens the return type or breaks the
 * Symbol() registry isolation is caught locally instead of via the
 * downstream `KnowledgeBaseService` integration tests.
 *
 * Mirrors `kb-mirror-document-dispatcher` (no separate spec exists for
 * that one — the barrel test covers it transitively; adding this
 * focused spec is the slightly nicer pattern we want to follow for new
 * dispatchers going forward).
 */
describe('KB_EMBED_DOCUMENT_DISPATCHER', () => {
    it('is a process-local Symbol with the documented description', () => {
        expect(typeof KB_EMBED_DOCUMENT_DISPATCHER).toBe('symbol');
        expect(KB_EMBED_DOCUMENT_DISPATCHER.description).toBe('KB_EMBED_DOCUMENT_DISPATCHER');
    });

    it('is NOT registered via Symbol.for (DI-token isolation invariant)', () => {
        // If a future refactor switched to `Symbol.for(...)` the token
        // would collide across worker processes — guard the pattern
        // explicitly, same as work-generation/work-import.
        expect(KB_EMBED_DOCUMENT_DISPATCHER).not.toBe(Symbol.for('KB_EMBED_DOCUMENT_DISPATCHER'));
    });

    it('is the same singleton when re-imported (ESM module-cache pin)', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const reimported = require('./kb-embed-document-dispatcher').KB_EMBED_DOCUMENT_DISPATCHER;
        expect(reimported).toBe(KB_EMBED_DOCUMENT_DISPATCHER);
    });
});

describe('KbEmbedDocumentDispatcher contract', () => {
    it('matches the documented dispatch signature at runtime via a mock impl', async () => {
        const dispatchMock = jest.fn(async (_p: KbEmbedDocumentPayload) => 'run-42');
        const impl: KbEmbedDocumentDispatcher = { dispatchKbEmbedDocument: dispatchMock };

        const payload: KbEmbedDocumentPayload = {
            workId: 'work-1',
            documentId: 'doc-1',
        };

        await expect(impl.dispatchKbEmbedDocument(payload)).resolves.toBe('run-42');
        expect(dispatchMock).toHaveBeenCalledWith(payload);
    });

    it('dispatchKbEmbedDocument may resolve to null (Trigger.dev not configured branch)', async () => {
        const impl: KbEmbedDocumentDispatcher = {
            dispatchKbEmbedDocument: async () => null,
        };
        await expect(
            impl.dispatchKbEmbedDocument({ workId: 'work-1', documentId: 'doc-1' }),
        ).resolves.toBeNull();
    });

    // EW-742 P3.2 T22 — KB-embed is the PoC dispatcher for enqueue-site
    // (providerId, credentialVersion) capture. The fields are optional
    // so existing payload sites stay compiling.
    it('accepts the optional T22 tenant runtime binding fields', async () => {
        const dispatchMock = jest.fn(async (_p: KbEmbedDocumentPayload) => 'run-99');
        const impl: KbEmbedDocumentDispatcher = { dispatchKbEmbedDocument: dispatchMock };

        const payload: KbEmbedDocumentPayload = {
            workId: 'work-1',
            documentId: 'doc-1',
            providerId: 'trigger',
            credentialVersion: 7,
        };

        await expect(impl.dispatchKbEmbedDocument(payload)).resolves.toBe('run-99');
        expect(dispatchMock).toHaveBeenCalledWith(payload);
    });

    it('accepts explicit null T22 fields (no overlay = legacy default path)', async () => {
        const dispatchMock = jest.fn(async (_p: KbEmbedDocumentPayload) => 'run-100');
        const impl: KbEmbedDocumentDispatcher = { dispatchKbEmbedDocument: dispatchMock };

        // Per stamper contract: both null means "no tenant overlay was
        // active when this was enqueued"; worker host runs against the
        // instance default — byte-identical to the pre-overlay code path.
        const payload: KbEmbedDocumentPayload = {
            workId: 'work-1',
            documentId: 'doc-1',
            providerId: null,
            credentialVersion: null,
        };

        await expect(impl.dispatchKbEmbedDocument(payload)).resolves.toBe('run-100');
        expect(dispatchMock).toHaveBeenCalledWith(payload);
    });
});
