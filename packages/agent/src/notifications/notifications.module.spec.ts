jest.mock('@src/database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));

import { NotificationsModule } from './notifications.module';
import { NotificationService } from './notification.service';

describe('NotificationsModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, NotificationsModule) ?? [];

    it('declares NotificationService as a provider', () => {
        expect(meta('providers')).toContain(NotificationService);
    });

    it('exports NotificationService for downstream modules', () => {
        expect(meta('exports')).toContain(NotificationService);
    });

    it('imports DatabaseModule by name', () => {
        const imports = meta('imports') as Array<{ name?: string }>;
        expect(imports.map((m) => m?.name)).toContain('DatabaseModule');
    });

    it('keeps the imports list at the documented 1-module shape', () => {
        expect(meta('imports')).toHaveLength(1);
    });
});

describe('notifications barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('./index');

    it('re-exports NotificationService and NotificationsModule', () => {
        expect(barrel.NotificationService).toBe(NotificationService);
        expect(barrel.NotificationsModule).toBe(NotificationsModule);
    });
});
