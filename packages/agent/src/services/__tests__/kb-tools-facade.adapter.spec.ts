import { Test, TestingModule } from '@nestjs/testing';
import { KbToolsFacadeAdapter } from '../kb-tools-facade.adapter';
import { KbAgentToolsService } from '../kb-agent-tools.service';

describe('KbToolsFacadeAdapter (row 36c)', () => {
    let adapter: KbToolsFacadeAdapter;
    let kbAgentTools: {
        kbSearch: jest.Mock;
        kbRead: jest.Mock;
        kbWrite: jest.Mock;
        kbLock: jest.Mock;
        kbUnlock: jest.Mock;
    };

    beforeEach(async () => {
        kbAgentTools = {
            kbSearch: jest.fn().mockResolvedValue({ ok: true, data: { items: [], total: 0 } }),
            kbRead: jest.fn().mockResolvedValue({ ok: true, data: {} }),
            kbWrite: jest
                .fn()
                .mockResolvedValue({ ok: true, data: { document: {}, action: 'created' } }),
            kbLock: jest.fn().mockResolvedValue({ ok: true, data: {} }),
            kbUnlock: jest.fn().mockResolvedValue({ ok: true, data: {} }),
        };
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KbToolsFacadeAdapter,
                { provide: KbAgentToolsService, useValue: kbAgentTools },
            ],
        }).compile();
        adapter = module.get(KbToolsFacadeAdapter);
    });

    it('kbSearch forwards every argument to KbAgentToolsService.kbSearch verbatim', async () => {
        const result = await adapter.kbSearch('work-1', 'user-1', {
            q: 'voice',
            class: 'brand',
            limit: 5,
        });
        expect(kbAgentTools.kbSearch).toHaveBeenCalledWith('work-1', 'user-1', {
            q: 'voice',
            class: 'brand',
            limit: 5,
        });
        expect(result).toEqual({ ok: true, data: { items: [], total: 0 } });
    });

    it('kbRead forwards workId/userId/idOrPath', async () => {
        await adapter.kbRead('work-1', 'user-1', 'brand/voice.md');
        expect(kbAgentTools.kbRead).toHaveBeenCalledWith('work-1', 'user-1', 'brand/voice.md');
    });

    it('kbWrite forwards the full input object', async () => {
        await adapter.kbWrite('work-1', 'user-1', {
            path: 'brand/voice.md',
            title: 'Voice',
            class: 'brand',
            body: 'hi',
            generatedByAgentRunId: 'run-1',
        });
        expect(kbAgentTools.kbWrite).toHaveBeenCalledWith('work-1', 'user-1', {
            path: 'brand/voice.md',
            title: 'Voice',
            class: 'brand',
            body: 'hi',
            generatedByAgentRunId: 'run-1',
        });
    });

    it('kbLock forwards docId + mode', async () => {
        await adapter.kbLock('work-1', 'user-1', 'd1', 'full');
        expect(kbAgentTools.kbLock).toHaveBeenCalledWith('work-1', 'user-1', 'd1', 'full');
    });

    it('kbUnlock forwards docId', async () => {
        await adapter.kbUnlock('work-1', 'user-1', 'd1');
        expect(kbAgentTools.kbUnlock).toHaveBeenCalledWith('work-1', 'user-1', 'd1');
    });

    it('does NOT translate / transform the service result envelope', async () => {
        // The discriminated KbToolResult must pass through unchanged so
        // the agent-pipeline tool layer can surface { ok: false, error }
        // to the LLM directly.
        kbAgentTools.kbRead.mockResolvedValueOnce({ ok: false, error: 'not found' });
        const result = await adapter.kbRead('work-1', 'user-1', 'ghost');
        expect(result).toEqual({ ok: false, error: 'not found' });
    });
});
