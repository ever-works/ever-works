jest.mock('../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));

import { ActivityLogModule } from './activity-log.module';
import { ActivityLogService } from './activity-log.service';

describe('ActivityLogModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, ActivityLogModule) ?? [];

    it('declares ActivityLogService as a provider', () => {
        expect(meta('providers')).toContain(ActivityLogService);
    });

    it('exports ActivityLogService for downstream modules', () => {
        expect(meta('exports')).toContain(ActivityLogService);
    });

    it('imports DatabaseModule by name', () => {
        const imports = meta('imports') as Array<{ name?: string }>;
        expect(imports.map((m) => m?.name)).toContain('DatabaseModule');
    });

    it('keeps the imports list at the documented 1-module shape', () => {
        expect(meta('imports')).toHaveLength(1);
    });
});

describe('activity-log barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('./index');

    it('re-exports ActivityLogService and ActivityLogModule', () => {
        expect(barrel.ActivityLogService).toBe(ActivityLogService);
        expect(barrel.ActivityLogModule).toBe(ActivityLogModule);
    });
});
