import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { KbAgentToolsService, type KbToolResult } from '../kb-agent-tools.service';
import { KnowledgeBaseService } from '../knowledge-base.service';
import type { KbDocumentBodyDto, KbDocumentDto } from '@ever-works/contracts';

const WORK_ID = 'work-1';
const USER_ID = 'user-1';

/** Type-narrow helpers — TS doesn't always narrow generic
 *  discriminated unions through plain `if` branches, so we use
 *  explicit user-defined type guards. Both happy-path and error-
 *  path tests use these so a wrong variant surfaces as a test
 *  failure rather than a TS type error. */
function isOk<T>(r: KbToolResult<T>): r is { ok: true; data: T } {
    return r.ok;
}

function expectOk<T>(r: KbToolResult<T>): T {
    if (!isOk(r)) {
        throw new Error(`expected ok:true result, got error: ${r.error}`);
    }
    return r.data;
}

function expectErr<T>(r: KbToolResult<T>): string {
    if (isOk(r)) {
        throw new Error('expected ok:false result, got data');
    }
    return r.error;
}

function makeBody(overrides: Partial<KbDocumentBodyDto> = {}): KbDocumentBodyDto {
    return {
        id: overrides.id ?? 'doc-1',
        workId: overrides.workId ?? WORK_ID,
        organizationId: overrides.organizationId ?? null,
        path: overrides.path ?? 'brand/voice.md',
        slug: overrides.slug ?? 'voice',
        title: overrides.title ?? 'Brand voice',
        description: overrides.description ?? null,
        class: overrides.class ?? 'brand',
        tags: overrides.tags ?? [],
        categories: overrides.categories ?? [],
        status: overrides.status ?? 'active',
        locked: overrides.locked ?? false,
        lockMode: overrides.lockMode ?? null,
        language: overrides.language ?? 'en',
        wordCount: overrides.wordCount ?? null,
        tokenCount: overrides.tokenCount ?? null,
        source: overrides.source ?? 'user',
        sourceUploadId: overrides.sourceUploadId ?? null,
        sourceUrl: overrides.sourceUrl ?? null,
        generatedByAgentRunId: overrides.generatedByAgentRunId ?? null,
        createdById: overrides.createdById ?? null,
        updatedById: overrides.updatedById ?? null,
        createdAt: overrides.createdAt ?? '2026-05-23T00:00:00.000Z',
        updatedAt: overrides.updatedAt ?? '2026-05-23T00:00:00.000Z',
        lastCommitSha: overrides.lastCommitSha ?? null,
        body: overrides.body ?? 'body',
        assets: overrides.assets ?? [],
    } as KbDocumentBodyDto;
}

function makeDtoFromBody(b: KbDocumentBodyDto): KbDocumentDto {
    // Stripped form for the list response (no body / assets).
    const { body: _b, assets: _a, ...rest } = b;
    return rest as KbDocumentDto;
}

describe('KbAgentToolsService', () => {
    let service: KbAgentToolsService;
    let kb: {
        listDocuments: jest.Mock;
        getDocument: jest.Mock;
        createDocument: jest.Mock;
        updateDocument: jest.Mock;
        lockDocument: jest.Mock;
        unlockDocument: jest.Mock;
    };

    beforeEach(async () => {
        kb = {
            listDocuments: jest.fn(),
            getDocument: jest.fn(),
            createDocument: jest.fn(),
            updateDocument: jest.fn(),
            lockDocument: jest.fn(),
            unlockDocument: jest.fn(),
        };
        const module: TestingModule = await Test.createTestingModule({
            providers: [KbAgentToolsService, { provide: KnowledgeBaseService, useValue: kb }],
        }).compile();
        service = module.get(KbAgentToolsService);
    });

    describe('kbSearch', () => {
        it('returns { ok: true, data: { items, total } } on happy path', async () => {
            const doc = makeBody({ id: 'd1' });
            kb.listDocuments.mockResolvedValueOnce({
                items: [makeDtoFromBody(doc)],
                total: 1,
            });

            const result = await service.kbSearch(WORK_ID, USER_ID, { q: 'voice', limit: 5 });
            const data = expectOk(result);
            expect(data.total).toBe(1);
            expect(data.items).toHaveLength(1);
            expect(kb.listDocuments).toHaveBeenCalledWith(WORK_ID, USER_ID, {
                q: 'voice',
                class: undefined,
                status: undefined,
                limit: 5,
            });
        });

        it('clamps limit to <=50 and defaults to 20 when omitted', async () => {
            kb.listDocuments.mockResolvedValueOnce({ items: [], total: 0 });

            await service.kbSearch(WORK_ID, USER_ID, { limit: 999 });
            expect(kb.listDocuments).toHaveBeenLastCalledWith(
                WORK_ID,
                USER_ID,
                expect.objectContaining({ limit: 50 }),
            );

            kb.listDocuments.mockResolvedValueOnce({ items: [], total: 0 });
            await service.kbSearch(WORK_ID, USER_ID, {});
            expect(kb.listDocuments).toHaveBeenLastCalledWith(
                WORK_ID,
                USER_ID,
                expect.objectContaining({ limit: 20 }),
            );

            kb.listDocuments.mockResolvedValueOnce({ items: [], total: 0 });
            await service.kbSearch(WORK_ID, USER_ID, { limit: 0 });
            expect(kb.listDocuments).toHaveBeenLastCalledWith(
                WORK_ID,
                USER_ID,
                expect.objectContaining({ limit: 1 }),
            );
        });

        it('returns { ok: false, error } when ensureCanView denies access', async () => {
            kb.listDocuments.mockRejectedValueOnce(new ForbiddenException('no access'));

            const result = await service.kbSearch(WORK_ID, USER_ID, {});
            expect(expectErr(result)).toMatch(/no access|Forbidden/);
        });

        it('forwards optional class + status filters verbatim', async () => {
            kb.listDocuments.mockResolvedValueOnce({ items: [], total: 0 });
            await service.kbSearch(WORK_ID, USER_ID, {
                q: 'foo',
                class: 'brand',
                status: 'archived',
            });
            expect(kb.listDocuments).toHaveBeenCalledWith(WORK_ID, USER_ID, {
                q: 'foo',
                class: 'brand',
                status: 'archived',
                limit: 20,
            });
        });
    });

    describe('kbRead', () => {
        it('returns the doc body on happy path', async () => {
            const doc = makeBody({ id: 'd1' });
            kb.getDocument.mockResolvedValueOnce(doc);

            const result = await service.kbRead(WORK_ID, USER_ID, 'brand/voice.md');
            const data = expectOk(result);
            expect(data.id).toBe('d1');
            expect(kb.getDocument).toHaveBeenCalledWith(WORK_ID, 'brand/voice.md', USER_ID);
        });

        it('returns { ok: false, error } on NotFound', async () => {
            kb.getDocument.mockRejectedValueOnce(new NotFoundException('missing'));

            const result = await service.kbRead(WORK_ID, USER_ID, 'brand/ghost');
            expect(expectErr(result)).toContain('missing');
        });
    });

    describe('kbWrite', () => {
        it('updates an existing doc when the path matches', async () => {
            const existing = makeBody({ id: 'd1', path: 'brand/voice.md' });
            const updated = makeBody({
                id: 'd1',
                path: 'brand/voice.md',
                title: 'Brand voice v2',
                body: 'new body',
            });
            kb.getDocument.mockResolvedValueOnce(existing);
            kb.updateDocument.mockResolvedValueOnce(updated);

            const result = await service.kbWrite(WORK_ID, USER_ID, {
                path: 'brand/voice.md',
                title: 'Brand voice v2',
                class: 'brand',
                body: 'new body',
            });

            const data = expectOk(result);
            expect(data.action).toBe('updated');
            expect(data.document.id).toBe('d1');
            expect(kb.updateDocument).toHaveBeenCalledWith(
                WORK_ID,
                'd1',
                USER_ID,
                expect.objectContaining({ title: 'Brand voice v2', body: 'new body' }),
            );
            expect(kb.createDocument).not.toHaveBeenCalled();
        });

        it('creates a new doc when the path does not exist (NotFound)', async () => {
            const created = makeBody({
                id: 'd2',
                path: 'brand/manifesto.md',
                source: 'agent',
            });
            kb.getDocument.mockRejectedValueOnce(new NotFoundException('miss'));
            kb.createDocument.mockResolvedValueOnce(created);

            const result = await service.kbWrite(WORK_ID, USER_ID, {
                path: 'brand/manifesto.md',
                title: 'Brand manifesto',
                class: 'brand',
                body: 'hello',
                generatedByAgentRunId: 'run-99',
            });

            const data = expectOk(result);
            expect(data.action).toBe('created');
            // Source stamped 'agent' + run id forwarded.
            expect(kb.createDocument).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: WORK_ID,
                    userId: USER_ID,
                    path: 'brand/manifesto.md',
                    title: 'Brand manifesto',
                    class: 'brand',
                    body: 'hello',
                    source: 'agent',
                    generatedByAgentRunId: 'run-99',
                }),
            );
            expect(kb.updateDocument).not.toHaveBeenCalled();
        });

        it('returns { ok: false, error } when ensureCanEdit denies the upsert', async () => {
            // The probe succeeds; updateDocument throws Forbidden.
            const existing = makeBody({ id: 'd1' });
            kb.getDocument.mockResolvedValueOnce(existing);
            kb.updateDocument.mockRejectedValueOnce(new ForbiddenException('viewer cannot edit'));

            const result = await service.kbWrite(WORK_ID, USER_ID, {
                path: 'brand/voice.md',
                title: 't',
                class: 'brand',
                body: 'b',
            });
            expect(expectErr(result)).toMatch(/viewer|Forbidden/);
        });

        it('propagates non-NotFound probe errors as tool errors (does not silently create)', async () => {
            // Probe throws something OTHER than NotFound — should NOT
            // fall through to createDocument, must surface as ok:false.
            kb.getDocument.mockRejectedValueOnce(new ForbiddenException('no view access'));

            const result = await service.kbWrite(WORK_ID, USER_ID, {
                path: 'brand/voice.md',
                title: 't',
                class: 'brand',
                body: 'b',
            });
            expect(expectErr(result)).toMatch(/no view access|Forbidden/);
            expect(kb.createDocument).not.toHaveBeenCalled();
        });
    });

    describe('kbLock', () => {
        it('returns the locked doc on happy path', async () => {
            const locked = makeBody({ id: 'd1', locked: true, lockMode: 'full' });
            kb.lockDocument.mockResolvedValueOnce(locked);

            const result = await service.kbLock(WORK_ID, USER_ID, 'd1', 'full');
            const data = expectOk(result);
            expect(data.locked).toBe(true);
            expect(data.lockMode).toBe('full');
            expect(kb.lockDocument).toHaveBeenCalledWith(WORK_ID, 'd1', USER_ID, 'full');
        });

        it('returns { ok: false, error } when role gate denies (editor cannot lock)', async () => {
            kb.lockDocument.mockRejectedValueOnce(
                new ForbiddenException('Locking a KB document requires manager+ role'),
            );

            const result = await service.kbLock(WORK_ID, USER_ID, 'd1', 'full');
            expect(expectErr(result)).toMatch(/manager\+/);
        });
    });

    describe('kbUnlock', () => {
        it('returns the unlocked doc on happy path', async () => {
            const unlocked = makeBody({ id: 'd1', locked: false, lockMode: null });
            kb.unlockDocument.mockResolvedValueOnce(unlocked);

            const result = await service.kbUnlock(WORK_ID, USER_ID, 'd1');
            const data = expectOk(result);
            expect(data.locked).toBe(false);
            expect(kb.unlockDocument).toHaveBeenCalledWith(WORK_ID, 'd1', USER_ID);
        });

        it('returns { ok: false, error } on role-gate denial', async () => {
            kb.unlockDocument.mockRejectedValueOnce(
                new ForbiddenException('Unlocking a KB document requires manager+ role'),
            );

            const result = await service.kbUnlock(WORK_ID, USER_ID, 'd1');
            expect(expectErr(result)).toMatch(/manager\+/);
        });
    });
});
