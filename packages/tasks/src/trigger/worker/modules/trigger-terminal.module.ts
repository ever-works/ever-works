import { Module } from '@nestjs/common';
import { TerminalStreamFacadeService } from '@ever-works/agent/facades';
import { TriggerInternalModule } from './trigger-internal.module';
import { TriggerPluginsModule } from './trigger-plugins.module';

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
 */
@Module({
    imports: [TriggerPluginsModule.forRoot(), TriggerInternalModule],
    providers: [TerminalStreamFacadeService],
    exports: [TerminalStreamFacadeService, TriggerInternalModule],
})
export class TriggerTerminalModule {}
