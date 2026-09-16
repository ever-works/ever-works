import 'reflect-metadata';

/**
 * `@ever-works/agent/services` reaches the ESM-only `p-map` through the
 * generators barrel, which Jest's CJS transformer cannot load; the terminal
 * module drags it in through the auth barrel. Nothing in it participates in
 * the question this spec asks, so it is stubbed at module scope — the same
 * posture `tasks.module.di-contract.spec.ts` uses.
 */
jest.mock('@ever-works/agent/services', () => ({
    KnowledgeBaseModule: class KnowledgeBaseModule {},
}));
jest.mock('@ever-works/trigger-tasks', () => ({}));
// The auth barrel boots the ESM-only auth runtime; the terminal module only
// needs its `@Public()` decorator, which marks a route and injects nothing.
jest.mock('../auth', () => ({ Public: () => () => undefined }));

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ENTITIES } from '@ever-works/agent/database';
import { ComputerControlArbiter, ComputerSessionService } from '@ever-works/agent/computer';
import {
    PluginRegistryService,
    PluginSettingsService,
    WorkPluginRepository,
} from '@ever-works/agent/plugins';
import { PluginUsageService } from '@ever-works/agent/usage';
import { BudgetGuardService } from '@ever-works/agent/budgets';
import { ScopeContextService } from '../scope';
import { FleetController } from '../fleet/fleet.controller';
import { ComputerControlListener } from './computer-control.listener';
import { ComputerController } from './computer.controller';
import { ComputerInternalController } from './computer-internal.controller';
import { ComputerApiModule } from './computer.module';
import { ComputerRelayRegistry } from './computer-relay.registry';
import { ComputerWsService } from './computer-ws.service';

/**
 * `ComputerApiModule` against a REAL Nest container, the way
 * `fleet.module.spec.ts` checks the fleet: unit specs construct every class
 * by hand and cannot tell whether the API would boot, or whether an
 * `@Optional()` injection silently resolved to nothing.
 *
 * The two optional injections this module exists to satisfy are asserted by
 * reading what Nest actually injected:
 *   - the agent-side session service's dispatcher (without it every open
 *     answers "no fleet runtime" on a fully wired install);
 *   - the fleet heartbeat's pending live-view lookup (without it an
 *     attended machine is never told a view is waiting).
 *
 * The `@Global()` stub stands in for what the running API supplies from its
 * root module; nothing the live view depends on is stubbed.
 */
const APP_ROOT_PROVIDERS = [
    PluginRegistryService,
    PluginSettingsService,
    WorkPluginRepository,
    PluginUsageService,
    BudgetGuardService,
    ScopeContextService,
];

@Global()
@Module({
    providers: APP_ROOT_PROVIDERS.map((token) => ({ provide: token, useValue: {} })),
    exports: APP_ROOT_PROVIDERS,
})
class AppRootStubModule {}

describe('ComputerApiModule — dependency injection', () => {
    async function compile() {
        return Test.createTestingModule({
            imports: [
                AppRootStubModule,
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                ComputerApiModule,
            ],
        }).compile();
    }

    it('resolves both controllers and ONE relay', async () => {
        const moduleRef = await compile();
        expect(moduleRef.get(ComputerController, { strict: false })).toBeInstanceOf(
            ComputerController,
        );
        expect(moduleRef.get(ComputerInternalController, { strict: false })).toBeInstanceOf(
            ComputerInternalController,
        );
        expect(moduleRef.get(ComputerRelayRegistry, { strict: false })).toBeInstanceOf(
            ComputerRelayRegistry,
        );
        await moduleRef.close();
    });

    it('hands the session service a dispatcher, and the fleet heartbeat its pending lookup', async () => {
        const moduleRef = await compile();

        const sessions = moduleRef.get(ComputerSessionService, { strict: false });
        const dispatcher = (sessions as unknown as { dispatcher?: { enqueue?: unknown } })
            .dispatcher;
        expect(typeof dispatcher?.enqueue).toBe('function');

        const fleet = moduleRef.get(FleetController, { strict: false });
        const pending = (fleet as unknown as { pendingComputerSessions?: unknown })
            .pendingComputerSessions;
        expect(pending).toBe(sessions);

        await moduleRef.close();
    });
});

describe('ComputerApiModule — taking control is wired', () => {
    it('hands the controller and the gateway the ONE control arbiter, and gates the relay on it', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                AppRootStubModule,
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                ComputerApiModule,
            ],
        }).compile();

        const arbiter = moduleRef.get(ComputerControlArbiter, { strict: false });
        expect(arbiter).toBeInstanceOf(ComputerControlArbiter);
        const controller = moduleRef.get(ComputerController, { strict: false });
        expect((controller as unknown as { control?: unknown }).control).toBe(arbiter);
        const gateway = moduleRef.get(ComputerWsService, { strict: false });
        expect((gateway as unknown as { control?: unknown }).control).toBe(arbiter);
        const relay = moduleRef.get(ComputerRelayRegistry, { strict: false });
        expect((relay as unknown as { requiresControl?: boolean }).requiresControl).toBe(true);
        const listener = moduleRef.get(ComputerControlListener, { strict: false });
        expect((listener as unknown as { activityLog?: unknown }).activityLog).toBeDefined();

        await moduleRef.close();
    });
});
