import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { McpToolSource } from '../mcp-tool-source';
import { McpClientService } from '../mcp-client.service';
import { McpConnectionsService } from '../mcp-connections.service';
import { MCP_STDIO_LAUNCHER, type McpStdioLauncher } from '../mcp-stdio-launcher';

/**
 * DI wiring for the AP-14 seam.
 *
 * This repo has already shipped a seam that looked wired because the provider
 * existed SOMEWHERE in the application while being absent from the consumer's
 * own injector — an `@Optional()` dependency then arrives `undefined` and the
 * feature is silently inert, with every unit test still green because they
 * construct the class directly. So this asserts on the resolved INSTANCE
 * FIELD rather than on a module's metadata: what matters is that the object
 * Nest hands out actually has its launcher.
 *
 * The real `McpModule` is not built here (it would drag TypeORM and a
 * database in). Instead the two module shapes are reproduced — with the
 * binding, and without it — which is exactly the pair the production wiring
 * has to get right.
 */
const launcher = { launch: jest.fn() } as unknown as McpStdioLauncher;

const stubs = [
    { provide: McpClientService, useValue: {} },
    { provide: McpConnectionsService, useValue: {} },
];

@Module({
    providers: [{ provide: MCP_STDIO_LAUNCHER, useValue: launcher }],
    exports: [MCP_STDIO_LAUNCHER],
})
class BindingModule {}

/** The wiring as it ships: the consumer's module imports the binding. */
@Module({
    imports: [BindingModule],
    providers: [McpToolSource, ...stubs],
    exports: [McpToolSource],
})
class WiredModule {}

/** The failure mode: the binding exists in the app, but not for the consumer. */
@Module({
    providers: [McpToolSource, ...stubs],
    exports: [McpToolSource],
})
class UnwiredModule {}

function launcherOf(source: McpToolSource): unknown {
    return (source as unknown as { stdioLauncher?: unknown }).stdioLauncher;
}

describe('MCP_STDIO_LAUNCHER wiring', () => {
    it('reaches McpToolSource when its module imports the binding', async () => {
        const moduleRef = await Test.createTestingModule({ imports: [WiredModule] }).compile();

        expect(launcherOf(moduleRef.get(McpToolSource))).toBe(launcher);
        await moduleRef.close();
    });

    it('is undefined — not an error — when nothing binds it, so a runtime without Agent Plugins still boots', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [UnwiredModule, BindingModule],
        }).compile();

        // BindingModule provides the token, but UnwiredModule does not import
        // it: the app has the provider and the consumer still gets nothing.
        expect(launcherOf(moduleRef.get(McpToolSource))).toBeUndefined();
        await moduleRef.close();
    });

    it('the production McpModule lists AgentPluginsModule among its imports', async () => {
        // Belt to the braces above: the instance test proves the SHAPE works,
        // this proves the shipped module actually has it. Read off the Nest
        // metadata rather than the file, so a re-ordering does not break it.
        const { McpModule } = await import('../mcp.module');
        const { AgentPluginsModule } = await import('../../agent-plugins/agent-plugins.module');
        const imports = Reflect.getMetadata('imports', McpModule) as unknown[];

        expect(imports).toContain(AgentPluginsModule);
    });
});
