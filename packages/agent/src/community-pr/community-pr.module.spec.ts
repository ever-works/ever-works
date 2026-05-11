jest.mock('../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));

import { CommunityPrModule } from './community-pr.module';
import { CommunityPrProcessorService } from './community-pr-processor.service';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';

describe('CommunityPrModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, CommunityPrModule) ?? [];

    it('declares both CommunityPrProcessorService and DistributedTaskLockService as providers', () => {
        const providers = meta('providers');
        expect(providers).toContain(CommunityPrProcessorService);
        // DistributedTaskLockService is a peer dependency provided locally
        // because the cache module isn't imported globally — pinned so a
        // future "move it to cache module" refactor is a deliberate change.
        expect(providers).toContain(DistributedTaskLockService);
    });

    it('exports CommunityPrProcessorService ONLY (not the lock service)', () => {
        const exports = meta('exports');
        expect(exports).toContain(CommunityPrProcessorService);
        // The lock is intentionally NOT exported — pinned so a future
        // "expose the lock too" refactor is a deliberate change.
        expect(exports).not.toContain(DistributedTaskLockService);
    });

    it('imports DatabaseModule + FacadesModule by name', () => {
        const imports = meta('imports') as Array<{ name?: string }>;
        const names = imports.map((m) => m?.name);
        expect(names).toEqual(expect.arrayContaining(['DatabaseModule', 'FacadesModule']));
    });

    it('keeps the imports list at the documented 2-module shape', () => {
        expect(meta('imports')).toHaveLength(2);
    });
});

describe('community-pr barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('./index');

    it('re-exports CommunityPrProcessorService and CommunityPrModule', () => {
        expect(barrel.CommunityPrProcessorService).toBe(CommunityPrProcessorService);
        expect(barrel.CommunityPrModule).toBe(CommunityPrModule);
    });
});
