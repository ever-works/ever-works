import { Test } from '@nestjs/testing';
import { EmailFacadeService, EmailFacadeError } from '../email.facade';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../../plugins/services/plugin-settings.service';
import { TenantEmailAddressRepository } from '../../database/repositories/tenant-email-address.repository';
import { EmailMessageRepository } from '../../database/repositories/email-message.repository';

/**
 * EW-668 / T11 — EmailFacadeService construction + resolution coverage.
 * Real send/parse behaviour is covered by per-provider plugin tests
 * (postmark, resend, …) and integration tests in apps/api/src/email.
 */
describe('EmailFacadeService', () => {
    let registry: jest.Mocked<PluginRegistryService>;
    let settings: jest.Mocked<PluginSettingsService>;
    let emailAddresses: { findByAddress: jest.Mock };
    let emailMessages: { findByProviderMessageId: jest.Mock; updateDeliveryStatus: jest.Mock };
    let facade: EmailFacadeService;

    beforeEach(async () => {
        registry = {
            getByCapability: jest.fn().mockReturnValue([]),
            // Lazy-mode shim — tests register plugins via getByCapability
            // with eager `state: 'loaded'`, so ensureLoaded just looks
            // up by id in the most recent getByCapability return value.
            isLazy: jest.fn(() => false),
            ensureLoaded: jest.fn(async (id: string) => {
                const calls = (registry.getByCapability as jest.Mock).mock.results;
                for (const r of calls) {
                    const arr = (r.value as Array<{ plugin: { id: string } }>) || [];
                    const found = arr.find((p) => p.plugin?.id === id);
                    if (found) return (found as any).plugin;
                }
                return undefined as never;
            }),
        } as unknown as jest.Mocked<PluginRegistryService>;
        settings = {
            getResolvedSettings: jest.fn().mockResolvedValue({}),
            getSettings: jest.fn().mockResolvedValue({}),
        } as unknown as jest.Mocked<PluginSettingsService>;
        emailAddresses = { findByAddress: jest.fn().mockResolvedValue(null) };
        emailMessages = {
            findByProviderMessageId: jest.fn().mockResolvedValue(null),
            updateDeliveryStatus: jest.fn().mockResolvedValue(undefined),
        };

        const moduleRef = await Test.createTestingModule({
            providers: [
                EmailFacadeService,
                { provide: PluginRegistryService, useValue: registry },
                { provide: PluginSettingsService, useValue: settings },
                { provide: TenantEmailAddressRepository, useValue: emailAddresses },
                { provide: EmailMessageRepository, useValue: emailMessages },
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
                cap === 'email-inbound' ? [{ plugin, state: 'loaded', manifest: { id: plugin.id, name: plugin.id, capabilities: ['email-inbound'] } }] : []) as never);
            (settings.getSettings as jest.Mock).mockResolvedValue({
                inboundWebhookSecret: 'owner-secret',
            });
            emailAddresses.findByAddress.mockResolvedValue({
                userId: 'owner-9',
                pluginId: 'postmark',
            });

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
                cap === 'email-inbound' ? [{ plugin, state: 'loaded', manifest: { id: plugin.id, name: plugin.id, capabilities: ['email-inbound'] } }] : []) as never);
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

        it('falls back to default scope when the matched address belongs to a different plugin', async () => {
            const plugin = makeInboundPlugin();
            registry.getByCapability.mockImplementation(((cap: string) =>
                cap === 'email-inbound' ? [{ plugin, state: 'loaded', manifest: { id: plugin.id, name: plugin.id, capabilities: ['email-inbound'] } }] : []) as never);
            // Address is registered to mailgun, not the postmark webhook in flight.
            emailAddresses.findByAddress.mockResolvedValue({
                userId: 'owner-9',
                pluginId: 'mailgun',
            });

            await facade.parseInbound('postmark', Buffer.from('{}'), {});

            expect(settings.getSettings).toHaveBeenCalledWith(
                'postmark',
                expect.objectContaining({ userId: undefined }),
            );
        });

        it('skips recipient resolution when the caller already supplies a userId', async () => {
            const plugin = makeInboundPlugin();
            registry.getByCapability.mockImplementation(((cap: string) =>
                cap === 'email-inbound' ? [{ plugin, state: 'loaded', manifest: { id: plugin.id, name: plugin.id, capabilities: ['email-inbound'] } }] : []) as never);

            await facade.parseInbound('postmark', Buffer.from('{}'), {}, { userId: 'caller-1' });

            expect(plugin.extractInboundRecipients).not.toHaveBeenCalled();
            expect(emailAddresses.findByAddress).not.toHaveBeenCalled();
            expect(settings.getSettings).toHaveBeenCalledWith(
                'postmark',
                expect.objectContaining({ userId: 'caller-1' }),
            );
        });
    });

    describe('delivery-event webhook (parseEventWebhook + recordDeliveryEvents)', () => {
        function makeInboundPlugin(overrides: Record<string, unknown> = {}) {
            return {
                id: 'postmark',
                capabilities: ['email-inbound'],
                verifyWebhookSignature: jest.fn(),
                parseInboundWebhook: jest.fn(),
                parseEventWebhook: jest.fn(),
                ...overrides,
            };
        }

        it('verifies then decodes events via the plugin', async () => {
            const plugin = makeInboundPlugin();
            (plugin.parseEventWebhook as jest.Mock).mockResolvedValue([
                {
                    provider: 'postmark',
                    providerMessageId: 'pm-1',
                    type: 'delivered',
                    occurredAt: new Date(),
                },
            ]);
            registry.getByCapability.mockImplementation(((cap: string) =>
                cap === 'email-inbound' ? [{ plugin, state: 'loaded', manifest: { id: plugin.id, name: plugin.id, capabilities: ['email-inbound'] } }] : []) as never);

            const events = await facade.parseEventWebhook('postmark', Buffer.from('{}'), {});
            expect(plugin.verifyWebhookSignature).toHaveBeenCalled();
            expect(events).toHaveLength(1);
        });

        it('returns [] when the plugin does not publish delivery events', async () => {
            const plugin = makeInboundPlugin({ parseEventWebhook: undefined });
            registry.getByCapability.mockImplementation(((cap: string) =>
                cap === 'email-inbound' ? [{ plugin, state: 'loaded', manifest: { id: plugin.id, name: plugin.id, capabilities: ['email-inbound'] } }] : []) as never);
            await expect(
                facade.parseEventWebhook('postmark', Buffer.from('{}'), {}),
            ).resolves.toEqual([]);
        });

        it('records each event onto the matching message (latest-status-wins) and counts updates', async () => {
            emailMessages.findByProviderMessageId
                .mockResolvedValueOnce({ id: 'msg-1' })
                .mockResolvedValueOnce(null); // second event has no matching row
            const recorded = await facade.recordDeliveryEvents('postmark', [
                {
                    provider: 'postmark',
                    providerMessageId: 'pm-1',
                    type: 'bounced',
                    occurredAt: new Date(),
                },
                {
                    provider: 'postmark',
                    providerMessageId: 'pm-unknown',
                    type: 'opened',
                    occurredAt: new Date(),
                },
            ] as never);
            expect(recorded).toBe(1);
            expect(emailMessages.updateDeliveryStatus).toHaveBeenCalledWith('msg-1', 'bounced');
        });

        it('swallows a per-event update failure and continues the batch', async () => {
            emailMessages.findByProviderMessageId.mockResolvedValue({ id: 'msg-1' });
            emailMessages.updateDeliveryStatus
                .mockRejectedValueOnce(new Error('db hiccup'))
                .mockResolvedValueOnce(undefined);
            const recorded = await facade.recordDeliveryEvents('postmark', [
                {
                    provider: 'postmark',
                    providerMessageId: 'pm-1',
                    type: 'bounced',
                    occurredAt: new Date(),
                },
                {
                    provider: 'postmark',
                    providerMessageId: 'pm-2',
                    type: 'delivered',
                    occurredAt: new Date(),
                },
            ] as never);
            expect(recorded).toBe(1);
        });
    });
});
