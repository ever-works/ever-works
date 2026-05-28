import { Test } from '@nestjs/testing';
import { EmailFacadeService, EmailFacadeError } from '../email.facade';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';

/**
 * EW-668 / T11 — EmailFacadeService construction + resolution coverage.
 * Real send/parse behaviour is covered by per-provider plugin tests
 * (postmark, resend, …) and integration tests in apps/api/src/email.
 */
describe('EmailFacadeService', () => {
    let registry: jest.Mocked<PluginRegistryService>;
    let settings: jest.Mocked<PluginSettingsService>;
    let facade: EmailFacadeService;

    beforeEach(async () => {
        registry = {
            getByCapability: jest.fn().mockReturnValue([]),
        } as unknown as jest.Mocked<PluginRegistryService>;
        settings = {
            getResolvedSettings: jest.fn().mockResolvedValue({}),
        } as unknown as jest.Mocked<PluginSettingsService>;

        const moduleRef = await Test.createTestingModule({
            providers: [
                EmailFacadeService,
                { provide: PluginRegistryService, useValue: registry },
                { provide: PluginSettingsService, useValue: settings },
            ],
        }).compile();

        facade = moduleRef.get(EmailFacadeService);
    });

    it('constructs with required deps only', () => {
        expect(facade).toBeInstanceOf(EmailFacadeService);
    });

    it('reports unconfigured when no outbound providers are registered', () => {
        expect(facade.isConfigured()).toBe(false);
        expect(registry.getByCapability).toHaveBeenCalledWith('email-outbound');
    });

    it('throws NoProviderError on send when no plugin is loaded', async () => {
        await expect(
            facade.send(
                {
                    from: 'a@example.com',
                    to: ['b@example.com'],
                    subject: 'hi',
                    bodyText: 'hi',
                    messageRef: 'ref-1',
                },
                { userId: 'user-1' },
            ),
        ).rejects.toThrow(/No email-outbound provider/);
    });

    it('throws EmailFacadeError on parseInbound when plugin missing', async () => {
        await expect(
            facade.parseInbound('postmark', Buffer.from(''), {}, { userId: 'user-1' }),
        ).rejects.toBeInstanceOf(EmailFacadeError);
    });
});
