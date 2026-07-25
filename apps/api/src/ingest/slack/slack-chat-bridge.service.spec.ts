jest.mock('@ever-works/agent/ingest', () => ({
    EventIngestService: class {},
    IngestInstallBindingRepository: class {},
}));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginRegistryService: class {},
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));
jest.mock('../../ai-conversation/openai-compat.service', () => ({
    OpenAiCompatService: class {},
}));

import { SlackChatBridgeService, extractSlackWorkspaceRef } from './slack-chat-bridge.service';

/** Flush the fire-and-forget bridge promise chain. */
function flush(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

const BINDING = {
    userId: 'user-1',
    signingSecret: 'sec',
    settings: { botToken: 'xoxb-test' },
    matchedBy: 'binding' as const,
};

function mentionBody(overrides: Record<string, unknown> = {}) {
    return {
        type: 'event_callback',
        event_id: 'Ev1',
        team_id: 'T1',
        event: {
            type: 'app_mention',
            user: 'U7',
            text: '<@UBOT> what shipped today?',
            channel: 'C1',
            ts: '1700000000.000100',
            ...overrides,
        },
    };
}

describe('SlackChatBridgeService', () => {
    function createService() {
        const userPluginRepository = { findByPlugin: jest.fn().mockResolvedValue([]) };
        const pluginSettingsService = { getSettings: jest.fn().mockResolvedValue({}) };
        const slackPlugin = {
            id: 'slack-connector',
            capabilities: ['connector', 'connector-slack', 'event-source'],
            reply: jest.fn().mockResolvedValue({ provider: 'slack-connector' }),
            send: jest.fn().mockResolvedValue({ provider: 'slack-connector' }),
        };
        const pluginRegistry = {
            getByCapability: jest.fn().mockReturnValue([{ plugin: slackPlugin, state: 'loaded' }]),
        };
        const eventIngestService = {
            ingest: jest.fn().mockResolvedValue({ inserted: 1, duplicates: 0, rejected: 0 }),
        };
        const openAiCompatService = {
            handleCompletion: jest.fn().mockResolvedValue({
                choices: [{ index: 0, message: { role: 'assistant', content: 'All green.' } }],
            }),
        };
        const installBindings = {
            findByWorkspace: jest.fn().mockResolvedValue(null),
            record: jest.fn().mockResolvedValue(null),
        };
        const service = new SlackChatBridgeService(
            userPluginRepository as any,
            pluginSettingsService as any,
            pluginRegistry as any,
            eventIngestService as any,
            openAiCompatService as any,
            installBindings as any,
        );
        return {
            service,
            userPluginRepository,
            pluginSettingsService,
            pluginRegistry,
            eventIngestService,
            openAiCompatService,
            installBindings,
            slackPlugin,
        };
    }

    /**
     * Per-workspace binding.
     *
     * The receiver used to resolve "the oldest enabled install
     * platform-wide" and attribute EVERY inbound event to that one
     * platform user — a multi-tenant data-isolation defect. These cases
     * pin the replacement: exact binding → single-install fallback →
     * signature proof → refuse, and NEVER a fallback to another tenant.
     */
    describe('resolveBinding', () => {
        /** Two configured installs with distinct owners. */
        function twoInstalls(overrides: { sharedSecret?: boolean } = {}) {
            const ctx = createService();
            ctx.userPluginRepository.findByPlugin.mockResolvedValue([
                { userId: 'u-a', enabled: true, createdAt: new Date('2026-01-15') },
                { userId: 'u-disabled', enabled: false, createdAt: new Date('2026-01-01') },
                { userId: 'u-b', enabled: true, createdAt: new Date('2026-02-01') },
            ]);
            ctx.pluginSettingsService.getSettings.mockImplementation(
                async (_pluginId: string, options: { userId: string }) => ({
                    botToken: `xoxb-${options.userId}`,
                    signingSecret: overrides.sharedSecret ? 'app-secret' : `sec-${options.userId}`,
                }),
            );
            return ctx;
        }

        it('routes each workspace to its OWN owner when two installs exist', async () => {
            const { service, installBindings } = twoInstalls();
            installBindings.findByWorkspace.mockImplementation(
                async (_provider: string, teamId: string) =>
                    teamId === 'T-AAA'
                        ? { userId: 'u-a', externalEnterpriseId: null }
                        : teamId === 'T-BBB'
                          ? { userId: 'u-b', externalEnterpriseId: null }
                          : null,
            );

            const a = await service.resolveBinding({ workspace: { teamId: 'T-AAA' } });
            expect(a).toMatchObject({
                status: 'resolved',
                binding: { userId: 'u-a', signingSecret: 'sec-u-a', matchedBy: 'binding' },
            });

            const b = await service.resolveBinding({ workspace: { teamId: 'T-BBB' } });
            expect(b).toMatchObject({
                status: 'resolved',
                binding: { userId: 'u-b', signingSecret: 'sec-u-b', matchedBy: 'binding' },
            });
        });

        it('REFUSES an unknown workspace instead of guessing an owner', async () => {
            const { service } = twoInstalls({ sharedSecret: true });

            const result = await service.resolveBinding({
                workspace: { teamId: 'T-STRANGER' },
                // Both installs share the app-level signing secret, so the
                // signature cannot disambiguate them either.
                verifySignature: () => true,
            });

            expect(result).toEqual({ status: 'unresolved', reason: 'ambiguous-install' });
        });

        it('REFUSES when nothing is bound and no signature proof is available', async () => {
            const { service } = twoInstalls();
            const result = await service.resolveBinding({ workspace: { teamId: 'T-STRANGER' } });
            expect(result).toEqual({ status: 'unresolved', reason: 'unknown-workspace' });
        });

        it('REFUSES when the bound install is disabled — never re-points at another tenant', async () => {
            const { service, installBindings } = twoInstalls();
            installBindings.findByWorkspace.mockResolvedValue({
                userId: 'u-disabled',
                externalEnterpriseId: null,
            });

            const result = await service.resolveBinding({ workspace: { teamId: 'T-AAA' } });
            expect(result).toEqual({ status: 'unresolved', reason: 'bound-install-unavailable' });
        });

        it('REFUSES when the binding names a different Slack enterprise', async () => {
            const { service, installBindings } = twoInstalls();
            installBindings.findByWorkspace.mockResolvedValue({
                userId: 'u-a',
                externalEnterpriseId: 'E-ONE',
            });

            const result = await service.resolveBinding({
                workspace: { teamId: 'T-AAA', enterpriseId: 'E-TWO' },
            });
            expect(result).toEqual({ status: 'unresolved', reason: 'enterprise-mismatch' });
        });

        it('resolves by unique signature proof when the installs use different secrets', async () => {
            const { service } = twoInstalls();
            const result = await service.resolveBinding({
                workspace: { teamId: 'T-STRANGER' },
                verifySignature: (secret) => secret === 'sec-u-b',
            });
            expect(result).toMatchObject({
                status: 'resolved',
                binding: { userId: 'u-b', matchedBy: 'signature' },
            });
        });

        it('legacy single-install path still works (and is flagged as the fallback)', async () => {
            const { service, userPluginRepository, pluginSettingsService } = createService();
            userPluginRepository.findByPlugin.mockResolvedValue([
                { userId: 'u-disabled', enabled: false, createdAt: new Date('2026-01-01') },
                { userId: 'u-only', enabled: true, createdAt: new Date('2026-01-15') },
            ]);
            pluginSettingsService.getSettings.mockImplementation(
                async (_pluginId: string, options: { userId: string }) =>
                    options.userId === 'u-only'
                        ? { signingSecret: 'shhh', botToken: 'xoxb' }
                        : { botToken: 'xoxb' },
            );

            const result = await service.resolveBinding({ workspace: { teamId: 'T-AAA' } });
            expect(result).toMatchObject({
                status: 'resolved',
                binding: {
                    userId: 'u-only',
                    signingSecret: 'shhh',
                    matchedBy: 'single-install',
                    workspace: { teamId: 'T-AAA' },
                },
            });
            // Disabled installs are never consulted.
            const consulted = pluginSettingsService.getSettings.mock.calls.map(
                (c: any[]) => c[1].userId,
            );
            expect(consulted).not.toContain('u-disabled');
            // Secrets must be requested for verification/replies to work.
            expect(pluginSettingsService.getSettings).toHaveBeenCalledWith(
                'slack-connector',
                expect.objectContaining({ includeSecrets: true }),
            );
        });

        it('reports not-configured (fail-closed 401 upstream) when no install has a signing secret', async () => {
            const { service, userPluginRepository } = createService();
            userPluginRepository.findByPlugin.mockResolvedValue([
                { userId: 'u1', enabled: true, createdAt: new Date('2026-01-01') },
            ]);
            expect(await service.resolveBinding()).toEqual({ status: 'not-configured' });
        });
    });

    describe('recordBinding', () => {
        it('persists the workspace→user binding after a fallback match', async () => {
            const { service, installBindings } = createService();
            await service.recordBinding({
                userId: 'u-only',
                signingSecret: 's',
                settings: {},
                matchedBy: 'single-install',
                workspace: { teamId: 'T-AAA', enterpriseId: 'E-ONE' },
            });
            expect(installBindings.record).toHaveBeenCalledWith({
                provider: 'slack',
                externalWorkspaceId: 'T-AAA',
                externalEnterpriseId: 'E-ONE',
                userId: 'u-only',
                pluginId: 'slack-connector',
            });
        });

        it('is a no-op when the binding already came from the table, or carries no workspace', async () => {
            const { service, installBindings } = createService();
            await service.recordBinding({
                userId: 'u-a',
                signingSecret: 's',
                settings: {},
                matchedBy: 'binding',
                workspace: { teamId: 'T-AAA' },
            });
            await service.recordBinding({
                userId: 'u-a',
                signingSecret: 's',
                settings: {},
                matchedBy: 'single-install',
            });
            expect(installBindings.record).not.toHaveBeenCalled();
        });

        it('swallows a repository failure (a verified webhook must not 500)', async () => {
            const { service, installBindings } = createService();
            installBindings.record.mockRejectedValue(new Error('db down'));
            await expect(
                service.recordBinding({
                    userId: 'u-a',
                    signingSecret: 's',
                    settings: {},
                    matchedBy: 'single-install',
                    workspace: { teamId: 'T-AAA' },
                }),
            ).resolves.toBeUndefined();
        });
    });

    describe('extractSlackWorkspaceRef', () => {
        it('reads team_id and enterprise_id off the delivery', () => {
            expect(extractSlackWorkspaceRef({ team_id: 'T1', enterprise_id: 'E1' } as any)).toEqual(
                { teamId: 'T1', enterpriseId: 'E1' },
            );
        });

        it('falls back to the authorizations entry (Enterprise Grid deliveries)', () => {
            expect(
                extractSlackWorkspaceRef({
                    authorizations: [{ team_id: 'T2', enterprise_id: 'E2' }],
                } as any),
            ).toEqual({ teamId: 'T2', enterpriseId: 'E2' });
        });

        it('returns undefined when the delivery names no workspace (e.g. the handshake)', () => {
            expect(extractSlackWorkspaceRef({ type: 'url_verification' } as any)).toBeUndefined();
            expect(extractSlackWorkspaceRef(undefined)).toBeUndefined();
        });
    });

    describe('toEnvelope', () => {
        it('normalizes an app_mention into a slack.mention envelope with channel:ts identity', () => {
            const { service } = createService();
            const envelope = service.toEnvelope(mentionBody() as any);
            expect(envelope).toMatchObject({
                source: 'slack-connector',
                sourceEventId: 'C1:1700000000.000100',
                kind: 'slack.mention',
                subject: { type: 'channel', externalId: 'C1' },
                actor: { externalId: 'U7' },
            });
            expect(envelope!.occurredAt).toBe(
                new Date(Number('1700000000.000100') * 1000).toISOString(),
            );
            expect(envelope!.payload).toMatchObject({
                channel: 'C1',
                ts: '1700000000.000100',
                teamId: 'T1',
                providerEventId: 'Ev1',
            });
        });

        it('skips bot-authored messages and non-message payloads', () => {
            const { service } = createService();
            expect(service.toEnvelope(mentionBody({ bot_id: 'B9' }) as any)).toBeNull();
            expect(service.toEnvelope(mentionBody({ subtype: 'channel_join' }) as any)).toBeNull();
            expect(
                service.toEnvelope({
                    type: 'event_callback',
                    event: { type: 'reaction_added' },
                } as any),
            ).toBeNull();
            expect(service.toEnvelope({ type: 'url_verification' } as any)).toBeNull();
        });
    });

    describe('handleEventCallback', () => {
        it('ingests a first-seen mention and bridges it into platform chat + thread reply', async () => {
            const { service, eventIngestService, openAiCompatService, slackPlugin } =
                createService();
            const result = await service.handleEventCallback(BINDING, mentionBody() as any);
            await flush();

            expect(result.ingested).toMatchObject({ inserted: 1 });
            expect(eventIngestService.ingest).toHaveBeenCalledWith('user-1', [
                expect.objectContaining({ kind: 'slack.mention' }),
            ]);
            // Chat runs as the bound user with mention tokens stripped.
            expect(openAiCompatService.handleCompletion).toHaveBeenCalledWith(
                expect.objectContaining({
                    messages: [{ role: 'user', content: 'what shipped today?' }],
                }),
                { userId: 'user-1' },
            );
            // Reply lands in the mention's thread via the connector plugin.
            expect(slackPlugin.reply).toHaveBeenCalledWith(
                expect.objectContaining({
                    externalConversationId: 'C1:1700000000.000100',
                    text: 'All green.',
                }),
                expect.objectContaining({
                    userId: 'user-1',
                    target: { botToken: 'xoxb-test' },
                }),
            );
        });

        it('does NOT bridge a duplicate delivery (retry) — dedupe gates the chat leg', async () => {
            const { service, eventIngestService, openAiCompatService, slackPlugin } =
                createService();
            eventIngestService.ingest.mockResolvedValue({
                inserted: 0,
                duplicates: 1,
                rejected: 0,
            });
            await service.handleEventCallback(BINDING, mentionBody() as any);
            await flush();
            expect(openAiCompatService.handleCompletion).not.toHaveBeenCalled();
            expect(slackPlugin.reply).not.toHaveBeenCalled();
        });

        it('ingests plain channel messages without invoking the chat bridge', async () => {
            const { service, eventIngestService, openAiCompatService } = createService();
            await service.handleEventCallback(
                BINDING,
                mentionBody({ type: 'message', text: 'no bot mention here' }) as any,
            );
            await flush();
            expect(eventIngestService.ingest).toHaveBeenCalledWith('user-1', [
                expect.objectContaining({ kind: 'slack.message' }),
            ]);
            expect(openAiCompatService.handleCompletion).not.toHaveBeenCalled();
        });

        it('skips ingest entirely for bot-authored events', async () => {
            const { service, eventIngestService } = createService();
            const result = await service.handleEventCallback(
                BINDING,
                mentionBody({ bot_id: 'B1' }) as any,
            );
            expect(result.ingested).toBeNull();
            expect(eventIngestService.ingest).not.toHaveBeenCalled();
        });
    });

    describe('bridgeMentionToChat (best-effort)', () => {
        it('swallows reply failures — logs, never throws', async () => {
            const { service, slackPlugin } = createService();
            slackPlugin.reply.mockRejectedValue(new Error('slack down'));
            await expect(
                service.bridgeMentionToChat(BINDING, mentionBody() as any),
            ).resolves.toBeUndefined();
        });

        it('swallows chat-engine failures — logs, never throws, never posts', async () => {
            const { service, openAiCompatService, slackPlugin } = createService();
            openAiCompatService.handleCompletion.mockRejectedValue(new Error('no provider'));
            await expect(
                service.bridgeMentionToChat(BINDING, mentionBody() as any),
            ).resolves.toBeUndefined();
            expect(slackPlugin.reply).not.toHaveBeenCalled();
        });

        it('does not attempt a reply when the binding has no botToken', async () => {
            const { service, slackPlugin } = createService();
            await service.bridgeMentionToChat({ ...BINDING, settings: {} }, mentionBody() as any);
            expect(slackPlugin.reply).not.toHaveBeenCalled();
            expect(slackPlugin.send).not.toHaveBeenCalled();
        });

        it('falls back to send() with a threadTs target when the plugin has no reply()', async () => {
            const { service, slackPlugin } = createService();
            (slackPlugin as any).reply = undefined;
            await service.bridgeMentionToChat(BINDING, mentionBody() as any);
            expect(slackPlugin.send).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: 'All green.',
                    target: expect.objectContaining({
                        channelId: 'C1',
                        threadTs: '1700000000.000100',
                    }),
                }),
                expect.anything(),
            );
        });
    });
});
