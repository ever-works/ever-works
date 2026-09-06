import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentPluginPackage } from '../entities/agent-plugin-package.entity';
import { AgentPluginPackageAllowlist } from '../entities/agent-plugin-package-allowlist.entity';
import { McpServerConnection } from '../entities/mcp-server-connection.entity';
import { McpServerConnectionRepository } from '../database/repositories/mcp-server-connection.repository';
import { DatabaseModule } from '../database/database.module';
import { AgentPluginPackageCatalogService } from './package-catalog.service';
import { AgentPluginAllowlistService } from './allowlist.service';
import { AgentPluginGitSource } from './git-source';
import { AgentPluginNpmSource } from './npm-source';
import { AgentPluginRemoteAcquireService } from './remote-acquire.service';
import { AgentPluginPackageRepository } from './package.repository';
import { AgentPluginPackageBootstrapService } from './package-bootstrap.service';
import { AgentPluginUpdateService } from './update.service';
import { AgentPluginInstallService } from './install.service';
import { McpServerConfigService } from './mcp-server-config.service';
import { PackageMcpReconcilerService } from './package-mcp-reconciler.service';
import { AgentPluginPackageDataDirService } from './package-data-dir.service';
import { AgentPluginStdioServerService } from './stdio-server.service';
import { AgentPluginStdioLauncherService } from './stdio-launcher.service';
import { MCP_STDIO_LAUNCHER } from '../mcp/mcp-stdio-launcher';
import { AgentPluginExportService } from './export.service';
import { AGENT_PLUGIN_SKILL_SOURCE } from './skill-source.token';

/**
 * Agent Plugins standard interop — the agent-side module.
 *
 * A **leaf** module on purpose. `FacadesModule` imports it to obtain the
 * `AGENT_PLUGIN_SKILL_SOURCE` binding, and that only works without a cycle
 * because this module imports nothing that imports facades.
 *
 * Binding through a token rather than adding the service to the `FACADES`
 * provider array is also not stylistic: `facades.module.spec.ts` asserts that
 * array's length exactly, so a provider appended there turns it red. A
 * module added to `imports` is asserted by containment instead.
 *
 * The entities are registered here for `forFeature`, and separately in
 * `_entities-inventory.ts` — registering only here compiles, boots, and then
 * throws `EntityMetadataNotFoundError` on the first query, because there is
 * no `autoLoadEntities`.
 */
@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([
            AgentPluginPackage,
            AgentPluginPackageAllowlist,
            McpServerConnection,
        ]),
    ],
    providers: [
        AgentPluginPackageCatalogService,
        AgentPluginAllowlistService,
        AgentPluginGitSource,
        AgentPluginNpmSource,
        AgentPluginRemoteAcquireService,
        AgentPluginPackageRepository,
        AgentPluginPackageBootstrapService,
        AgentPluginUpdateService,
        AgentPluginInstallService,
        McpServerConfigService,
        PackageMcpReconcilerService,
        AgentPluginPackageDataDirService,
        AgentPluginStdioServerService,
        AgentPluginStdioLauncherService,
        AgentPluginExportService,
        // Provided locally rather than by importing `McpModule`, which would
        // pull ActivityLogModule and its transitive imports into what the
        // docstring above promises is a LEAF module. `McpModule` provides this
        // same repository from its own `forFeature` for the same reason, so
        // this follows the established pattern rather than inventing one. A
        // second instance is harmless: the repository is a stateless wrapper
        // over a TypeORM Repository, with no lifecycle and no cache.
        McpServerConnectionRepository,
        {
            // The facade consumes this @Optional(), so a deployment that never
            // imports this module keeps behaving exactly as it did before the
            // seam existed.
            provide: AGENT_PLUGIN_SKILL_SOURCE,
            useExisting: AgentPluginPackageCatalogService,
        },
        {
            // AP-14. `McpToolSource` consumes this @Optional(), so a runtime
            // that never imports this module keeps behaving exactly as it did
            // — stdio connections simply contribute no tools. Only the TOKEN
            // and the pointer helpers come from `mcp/`; no Nest module is
            // imported, so this stays the leaf module its docstring promises.
            provide: MCP_STDIO_LAUNCHER,
            useExisting: AgentPluginStdioLauncherService,
        },
    ],
    exports: [
        AgentPluginPackageCatalogService,
        AgentPluginAllowlistService,
        AgentPluginGitSource,
        AgentPluginNpmSource,
        AgentPluginRemoteAcquireService,
        AgentPluginPackageRepository,
        AgentPluginPackageBootstrapService,
        AgentPluginUpdateService,
        AgentPluginInstallService,
        McpServerConfigService,
        PackageMcpReconcilerService,
        AgentPluginPackageDataDirService,
        AgentPluginStdioServerService,
        AgentPluginStdioLauncherService,
        AgentPluginExportService,
        AGENT_PLUGIN_SKILL_SOURCE,
        MCP_STDIO_LAUNCHER,
    ],
})
export class AgentPluginsModule {}
