import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { TerminalStreamFacadeService } from '@ever-works/agent/facades';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import { TriggerTerminalModule } from '../trigger-terminal.module';

/**
 * Does the `terminal-session` worker context actually BOOT?
 *
 * Nothing answered that before this spec. `TriggerTerminalModule` imported
 * `TriggerPluginsModule.forRoot()` WITHOUT `TriggerRemoteCacheModule.forRoot()`,
 * and `PluginContextFactoryService` (inside the plugins module) injects
 * `CACHE_MANAGER` non-optionally — so the context failed to construct
 * ("Nest can't resolve dependencies of the PluginContextFactoryService …
 * CACHE_MANAGER"), and `terminal-session.task.ts` boots it with Nest's default
 * `abortOnError`, which exits the process. The same failure the workflow-run
 * module's first draft shipped with (see its spec).
 *
 * Booted for real against a loopback stub API, which must receive zero
 * requests, like every worker module.
 */
describe('TriggerTerminalModule — the terminal-session worker context', () => {
    let context: INestApplicationContext | undefined;
    let bootError: unknown;
    let stubApi: Server;
    let stubRequests = 0;

    beforeAll(async () => {
        stubApi = createServer((_request, response) => {
            stubRequests += 1;
            response.writeHead(501, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'the stub answers nothing' }));
        });
        await new Promise<void>((resolve) => stubApi.listen(0, '127.0.0.1', () => resolve()));
        const port = (stubApi.address() as { port: number }).port;
        process.env.TRIGGER_INTERNAL_API_URL = `http://127.0.0.1:${port}`;
        process.env.TRIGGER_INTERNAL_SECRET = 'terminal-spec-secret';

        try {
            context = await NestFactory.createApplicationContext(TriggerTerminalModule, {
                abortOnError: false,
                logger: false,
            });
        } catch (error) {
            bootError = error;
        }
    }, 180_000);

    afterAll(async () => {
        await context?.close();
        await new Promise<void>((resolve) => stubApi?.close(() => resolve()));
    });

    it('boots — every non-optional dependency resolves (CACHE_MANAGER included)', () => {
        expect(bootError).toBeUndefined();
        expect(context).toBeDefined();
    });

    it('dials nothing while booting', () => {
        expect(stubRequests).toBe(0);
    });

    it('provides the terminal stream facade and the plugin registry the task resolves', () => {
        expect(context?.get(TerminalStreamFacadeService, { strict: false })).toBeInstanceOf(
            TerminalStreamFacadeService,
        );
        expect(context?.get(PluginRegistryService, { strict: false })).toBeInstanceOf(
            PluginRegistryService,
        );
    });
});
