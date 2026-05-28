// Stub the agent subpaths + auth barrel so their transitive
// `@ever-works/agent/database` → `database.config.ts` (which imports the
// api-only `@src/config` alias) is never pulled into this controller test.
jest.mock('@ever-works/agent/facades', () => ({
    EmailFacadeService: class EmailFacadeService {},
}));
jest.mock('@ever-works/agent/notifications', () => ({
    AGENT_INBOUND_EMAIL_DISPATCHER: 'AGENT_INBOUND_EMAIL_DISPATCHER',
}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('../auth', () => ({
    CurrentUser: () => () => undefined,
    Public: () => () => undefined,
    AuthSessionGuard: class AuthSessionGuard {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { EmailFacadeService } from '@ever-works/agent/facades';
import { AuthSessionGuard } from '../auth';

/**
 * EW-669 / T12 — EmailController wiring smoke tests. Per-route behaviour
 * lives in service-level + plugin-level test suites.
 */
describe('EmailController', () => {
    let controller: EmailController;
    let service: jest.Mocked<EmailService>;

    beforeEach(async () => {
        service = {
            listAddresses: jest.fn().mockResolvedValue([]),
            createAddress: jest.fn().mockResolvedValue({ id: 'addr-1' }),
            updateAddress: jest.fn().mockResolvedValue({ id: 'addr-1' }),
            deleteAddress: jest.fn().mockResolvedValue(undefined),
            triggerVerification: jest.fn().mockResolvedValue({ messageRef: 'ref' }),
            confirmVerification: jest.fn().mockResolvedValue({ verified: true }),
            listMessagesForAgent: jest.fn().mockResolvedValue([]),
        } as unknown as jest.Mocked<EmailService>;
        const facade = {
            parseInbound: jest.fn().mockResolvedValue({ providerMessageId: 'pmid-1' }),
        };
        const moduleRef: TestingModule = await Test.createTestingModule({
            controllers: [EmailController],
            providers: [
                { provide: EmailService, useValue: service },
                { provide: EmailFacadeService, useValue: facade },
            ],
        })
            .overrideGuard(AuthSessionGuard)
            .useValue({ canActivate: () => true })
            .compile();
        controller = moduleRef.get(EmailController);
    });

    it('listAddresses delegates to the service', async () => {
        const auth = { userId: 'user-1' } as any;
        await controller.listAddresses(auth);
        expect(service.listAddresses).toHaveBeenCalledWith('user-1', undefined);
    });

    it('createAddress delegates to the service', async () => {
        const auth = { userId: 'user-1' } as any;
        const body = {
            address: 'a@x.com',
            direction: 'outbound' as const,
            pluginId: 'postmark',
            providerSettings: {},
        };
        await controller.createAddress(auth, body);
        expect(service.createAddress).toHaveBeenCalledWith('user-1', body);
    });

    it('confirmVerification is publicly accessible and returns the service result', async () => {
        await expect(controller.confirmVerification('tok')).resolves.toEqual({ verified: true });
    });
});
