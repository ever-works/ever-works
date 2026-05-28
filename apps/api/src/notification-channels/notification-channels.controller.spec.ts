// Stub the agent subpaths + auth barrel so their transitive
// `@ever-works/agent/database` → `database.config.ts` (which imports the
// api-only `@src/config` alias) is never pulled into this controller test.
jest.mock('@ever-works/agent/facades', () => ({
    NotificationChannelFacadeService: class NotificationChannelFacadeService {},
}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('../auth', () => ({
    CurrentUser: () => () => undefined,
    Public: () => () => undefined,
    AuthSessionGuard: class AuthSessionGuard {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationChannelsService } from './notification-channels.service';
import { AuthSessionGuard } from '../auth';

/**
 * EW-673 / T12 — NotificationChannelsController wiring smoke tests.
 */
describe('NotificationChannelsController', () => {
    let controller: NotificationChannelsController;
    let service: jest.Mocked<NotificationChannelsService>;

    beforeEach(async () => {
        service = {
            list: jest.fn().mockResolvedValue([]),
            create: jest.fn().mockResolvedValue({ id: 'ch-1' }),
            update: jest.fn().mockResolvedValue({ id: 'ch-1' }),
            remove: jest.fn().mockResolvedValue(undefined),
            sendTest: jest.fn().mockResolvedValue({ status: 'delivered' }),
        } as unknown as jest.Mocked<NotificationChannelsService>;
        const moduleRef: TestingModule = await Test.createTestingModule({
            controllers: [NotificationChannelsController],
            providers: [{ provide: NotificationChannelsService, useValue: service }],
        })
            .overrideGuard(AuthSessionGuard)
            .useValue({ canActivate: () => true })
            .compile();
        controller = moduleRef.get(NotificationChannelsController);
    });

    it('list delegates to the service', async () => {
        await controller.list({ userId: 'user-1' } as any);
        expect(service.list).toHaveBeenCalledWith('user-1');
    });

    it('sendTest delegates to the service', async () => {
        await controller.sendTest({ userId: 'user-1' } as any, 'ch-1');
        expect(service.sendTest).toHaveBeenCalledWith('user-1', 'ch-1');
    });
});
