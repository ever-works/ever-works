import { Test } from '@nestjs/testing';
import { EmailFacadeService, EmailFacadeError } from '../email.facade';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { TenantEmailAddressRepository } from '../../database/repositories/tenant-email-address.repository';

/**
 * EW-668 / T11 — EmailFacadeService construction + resolution coverage.
 * Real send/parse behaviour is covered by per-provider plugin tests
 * (postmark, resend, …) and integration tests in apps/api/src/email.
 */
describe('EmailFacadeService', () => {
    let registry: jest.Mocked<PluginRegistryService>;
    let settings: jest.Mocked<PluginSettingsService>;
    let emailAddresses: { findByAddress: jest.Mock };
    let facade: EmailFacadeService;

    beforeEach(async () => {
        registry = {
            getByCapability: jest.fn().mockReturnValue([]),
        } as unknown as jest.Mocked<PluginRegistryService>;
        settings = {
            getResolvedSettings: jest.fn().mockResolvedValue({}),
            getSettings: jest.fn().mockResolvedValue({}),
        } as unknown as jest.Mocked<PluginSettingsService>;
        emailAddresses = { findByAddress: jest.fn().mockResolvedValue(null) };

        const moduleRef = await Test.createTestingModule({
            providers: [
                EmailFacadeService,
                { provide: PluginRegistryService, useValue: registry },
                { provide: PluginSettingsService, useValue: settings },
                { provide: TenantEmailAddressRepository, useValue: emailAddresses },
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

    describe('parseInbound recipient-owner scoping (EW-670 follow-up)', () => {
        function makeInboundPlugin() {
            return {
                id: 'postmark',
                name: 'Postmark',
                version: '1.0.0',
                category: 'email',
                capabilities: ['email-inbound'],
                extractInboundRecipients: jest.fn().mockReturnValue(['inbox@ever.works']),
                verifyWebhookSignature: jest.fn(),
                parseInboundWebhook: jest.fn().mockResolvedValue({
                    provider: 'postmark',
                    providerMessageId: 'pm-1',
                    from: 'sender@example.com',
                    to: ['inbox@ever.works'],
                    subject: 's',
                    bodyText: 't',
                    attachments: [],
                    receivedAt: new Date(),
                }),
            };
        }

        it('resolves the recipient owner and verifies with the owner-scoped secret', async () => {
            const plugin = makeInboundPlugin();
            registry.getByCapability.mockImplementation(((cap: string) =>
                cap === 'email-inbound' ? [{ plugin, state: 'loaded' }] : []) as never);
            (settings.getSettings as jest.Mock).mockResolvedValue({
                inboundWebhookSecret: 'owner-secret',
            });
            emailAddresses.findByAddress.mockResolvedValue({ userId: 'owner-9' });

            await facade.parseInbound('postmark', Buffer.from('{}'), {});

            expect(plugin.extractInboundRecipients).toHaveBeenCalled();
            expect(emailAddresses.findByAddress).toHaveBeenCalledWith('inbox@ever.works');
            // settings (and thus the secret) resolved at the OWNER's scope
            expect(settings.getSettings).toHaveBeenCalledWith(
                'postmark',
                expect.objectContaining({ userId: 'owner-9', includeSecrets: true }),
            );
            // verification ran with those owner-scoped settings
            expect(plugin.verifyWebhookSignature).toHaveBeenCalledWith(
                expect.any(Buffer),
                expect.anything(),
                expect.objectContaining({
                    userId: 'owner-9',
                    settings: { inboundWebhookSecret: 'owner-secret' },
                }),
            );
        });

        it('falls back to default scope when no owner matches the recipient', async () => {
            const plugin = makeInboundPlugin();
            registry.getByCapability.mockImplementation(((cap: string) =>
                cap === 'email-inbound' ? [{ plugin, state: 'loaded' }] : []) as never);
            emailAddresses.findByAddress.mockResolvedValue(null);

            await facade.parseInbound('postmark', Buffer.from('{}'), {});

            expect(emailAddresses.findByAddress).toHaveBeenCalledWith('inbox@ever.works');
            // No owner → settings resolved without a userId (admin/env scope)
            expect(settings.getSettings).toHaveBeenCalledWith(
                'postmark',
                expect.objectContaining({ userId: undefined }),
            );
            expect(plugin.verifyWebhookSignature).toHaveBeenCalled();
        });

        it('skips recipient resolution when the caller already supplies a userId', async () => {
            const plugin = makeInboundPlugin();
            registry.getByCapability.mockImplementation(((cap: string) =>
                cap === 'email-inbound' ? [{ plugin, state: 'loaded' }] : []) as never);

            await facade.parseInbound('postmark', Buffer.from('{}'), {}, { userId: 'caller-1' });

            expect(plugin.extractInboundRecipients).not.toHaveBeenCalled();
            expect(emailAddresses.findByAddress).not.toHaveBeenCalled();
            expect(settings.getSettings).toHaveBeenCalledWith(
                'postmark',
                expect.objectContaining({ userId: 'caller-1' }),
            );
        });
    });
});
