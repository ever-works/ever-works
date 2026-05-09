// `database.module` transitively pulls in TypeORM + the entity tree, which
// fails to load under Jest without a real DB. Replace it with an empty shell
// — the module-wiring tests only need the class identity for the imports
// metadata, not the real provider list.
jest.mock('@src/database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));

import { WorkOperationsModule } from './work-operations.module';
import { WorkOperationsService } from './work-operations.service';
import { DatabaseModule } from '@src/database/database.module';

describe('WorkOperationsModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, WorkOperationsModule) ?? [];

    it('declares WorkOperationsService as a provider', () => {
        expect(meta('providers')).toContain(WorkOperationsService);
    });

    it('exports BOTH WorkOperationsService AND DatabaseModule (re-export pattern)', () => {
        const exports = meta('exports');
        expect(exports).toContain(WorkOperationsService);
        // Pin the re-export of DatabaseModule — downstream callers rely on
        // it being available transitively without re-importing themselves.
        expect(exports).toContain(DatabaseModule);
    });

    it('imports DatabaseModule by name', () => {
        const imports = meta('imports') as Array<{ name?: string }>;
        expect(imports.map((m) => m?.name)).toContain('DatabaseModule');
    });

    it('keeps the imports list at the documented 1-module shape', () => {
        expect(meta('imports')).toHaveLength(1);
    });
});

describe('work-operations barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('./index');

    it('re-exports WorkOperationsService and WorkOperationsModule', () => {
        expect(barrel.WorkOperationsService).toBe(WorkOperationsService);
        expect(barrel.WorkOperationsModule).toBe(WorkOperationsModule);
    });
});
