import { Global, Inject, Injectable, Module, Optional } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';

// AuthModule drags the whole api service graph (and its `@src/*` aliases)
// into this unit test; only the inbox module's own metadata is under
// test. Same posture as `agents/agents.module.spec.ts`.
jest.mock('../../auth/auth.module', () => ({
    AuthModule: class AuthModule {},
}));

import { INBOX_PRODUCER, InboxService, type InboxProducer } from '@ever-works/agent/inbox';
import { InboxApiModule } from '../inbox.module';

/**
 * `INBOX_PRODUCER` binding — the boot-or-hang seam.
 *
 * `InboxService` injects `AgentApprovalsService` + `AgentEscalationService`
 * (reply routing), and both of those inject
 * `@Optional() @Inject(INBOX_PRODUCER)` (the create-time mirror). That is a
 * real provider cycle. Bound as `{ provide: INBOX_PRODUCER, useExisting:
 * InboxService }` Nest's instance loader deadlocks: the token needs a fully
 * constructed InboxService, InboxService needs the token, and
 * `ApplicationContext.init()` never settles — `apps/api` hangs BEFORE it
 * listens, with no exception and no log line. `@Optional()` covers a
 * missing provider, never a pending one.
 *
 * Two things are pinned here:
 *   1. the real binding stays a LAZY factory over `ModuleRef` (structure),
 *   2. that shape actually boots, on a faithful reduction of the graph —
 *      this test TIMES OUT against the `useExisting` wiring (behaviour).
 */
describe('InboxApiModule — INBOX_PRODUCER binding', () => {
    function producerProvider() {
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, InboxApiModule) as Array<
            Record<string, unknown>
        >;
        const provider = providers.find((entry) => entry?.provide === INBOX_PRODUCER);
        expect(provider).toBeDefined();
        return provider!;
    }

    it('is NOT an eager alias of InboxService', () => {
        const provider = producerProvider();
        expect(provider.useExisting).toBeUndefined();
        expect(provider.useClass).toBeUndefined();
        expect(typeof provider.useFactory).toBe('function');
        expect(provider.inject).toEqual([ModuleRef]);
    });

    it('delegates every port method to the InboxService resolved at CALL time', async () => {
        const provider = producerProvider();
        const inbox = {
            escalationRaised: jest.fn(async () => undefined),
            proposalPending: jest.fn(async () => undefined),
            notice: jest.fn(async () => undefined),
            questionRaised: jest.fn(async () => undefined),
        };
        const get = jest.fn(() => inbox);
        const factory = provider.useFactory as (ref: unknown) => InboxProducer;

        const producer = factory({ get });
        // Building the provider must touch nothing: the whole point is that
        // InboxService is not resolved while the container is still loading.
        expect(get).not.toHaveBeenCalled();

        await producer.escalationRaised({
            userId: 'u1',
            escalationId: 'e1',
            summary: 's',
            decisionNeeded: 'd',
        });
        await producer.proposalPending({
            userId: 'u1',
            proposalId: 'p1',
            title: 't',
            actionType: 'send_message',
        });
        await producer.notice('u1', { title: 't', body: 'b' });
        // Self-build slice Q — the fleet reconciler's question path rides
        // the same lazy pass-through.
        await producer.questionRaised({
            userId: 'u1',
            agentRunId: 'r1',
            question: 'Use Postgres?',
        });

        expect(get).toHaveBeenCalledWith(InboxService, { strict: false });
        expect(inbox.escalationRaised).toHaveBeenCalledWith(
            expect.objectContaining({ escalationId: 'e1' }),
        );
        expect(inbox.proposalPending).toHaveBeenCalledWith(
            expect.objectContaining({ proposalId: 'p1' }),
        );
        expect(inbox.notice).toHaveBeenCalledWith('u1', expect.objectContaining({ title: 't' }));
        expect(inbox.questionRaised).toHaveBeenCalledWith(
            expect.objectContaining({ agentRunId: 'r1' }),
        );
    });

    it('the cyclic graph shape boots (this hangs with useExisting)', async () => {
        const TOKEN = 'PROBE_INBOX_PRODUCER';

        @Injectable()
        class ProbeApprovalsService {
            constructor(@Optional() @Inject(TOKEN) readonly inbox?: { ping(): Promise<string> }) {}
        }

        @Module({ providers: [ProbeApprovalsService], exports: [ProbeApprovalsService] })
        class ProbeApprovalsModule {}

        @Injectable()
        class ProbeInboxService {
            constructor(@Optional() readonly approvals?: ProbeApprovalsService) {}
            async ping() {
                return 'pong';
            }
        }

        @Module({
            imports: [ProbeApprovalsModule],
            providers: [ProbeInboxService],
            exports: [ProbeInboxService],
        })
        class ProbeAgentInboxModule {}

        @Global()
        @Module({
            imports: [ProbeAgentInboxModule],
            providers: [
                {
                    provide: TOKEN,
                    inject: [ModuleRef],
                    useFactory: (moduleRef: ModuleRef) => ({
                        ping: () => moduleRef.get(ProbeInboxService, { strict: false }).ping(),
                    }),
                },
            ],
            exports: [TOKEN],
        })
        class ProbeInboxApiModule {}

        const moduleRef = await Test.createTestingModule({
            imports: [ProbeInboxApiModule, ProbeApprovalsModule],
        }).compile();
        await moduleRef.init();

        const approvals = moduleRef.get(ProbeApprovalsService, { strict: false });
        expect(approvals.inbox).toBeDefined();
        await expect(approvals.inbox!.ping()).resolves.toBe('pong');
    }, 20_000);
});
