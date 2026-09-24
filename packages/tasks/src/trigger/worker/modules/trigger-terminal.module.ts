import { Module } from '@nestjs/common';
import { TerminalStreamFacadeService } from '@ever-works/agent/facades';
import { TriggerInternalModule } from './trigger-internal.module';
import { TriggerPluginsModule } from './trigger-plugins.module';
import { TriggerRemoteCacheModule } from './trigger-remote-cache.module';

/**
 * Worker scope for the `terminal-session` task.
 *
 * The task used to bootstrap `TriggerInternalModule` alone and construct
 * ONE hardcoded provider, which is why `TerminalStreamFacadeService` had
 * zero non-test consumers. Binding the facade here is what turns the
 * capability seam on for the live session path: the registry (from the
 * @Global `TriggerPluginsModule`) answers WHICH `terminal-stream`
 * provider applies for the scope, and the task spawns through the
 * facade rather than through an import.
 *
 * Same shape as `TriggerFacadesModule`: the facade itself is a LOCAL
 * provider (it must run in the process that hosts the PTY), while every
 * repository underneath it is a remote proxy to the API. Its three
 * dependencies — `PluginRegistryService`, `PluginSettingsService` and
 * the `@Optional() WorkPluginRepository` — all come from the @Global
 * plugins module, so no extra provider is needed here.
 *
 * `TriggerInternalModule` is imported (and re-exported) because the task
 * also resolves `AgentRunRepository` from this context for its ownership
 * guard.
 *
 * `TriggerRemoteCacheModule.forRoot()` provides `CACHE_MANAGER`, a
 * NON-optional dependency of `PluginContextFactoryService` inside the plugins
 * module. Without it this context could not boot at all ("Nest can't resolve
 * dependencies of the PluginContextFactoryService … CACHE_MANAGER") — and the
 * task boots it with Nest's default `abortOnError`, which exits the process.
 * The same pairing every other plugin-using worker module has
 * (`TriggerWorkflowRunModule`, `TriggerAppRuntimeModule`,
 * `TriggerRunPluginOperationModule`); `__tests__/trigger-terminal.module.spec.ts`
 * boots it for real.
 */
@Module({
    imports: [
        TriggerPluginsModule.forRoot(),
        TriggerRemoteCacheModule.forRoot(),
        TriggerInternalModule,
    ],
    providers: [TerminalStreamFacadeService],
    exports: [TerminalStreamFacadeService, TriggerInternalModule],
})
export class TriggerTerminalModule {}
