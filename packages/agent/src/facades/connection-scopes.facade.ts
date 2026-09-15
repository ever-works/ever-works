import { Injectable, Logger } from '@nestjs/common';
import {
    connectionScopePresetCoversTool,
    normalizeConnectionScopePresets,
    type ConnectionScopePresetDeclaration,
    type ConnectionScopePresetId,
    type ConnectionScopePresetProviderDto,
} from '@ever-works/contracts';
import { PLUGIN_CAPABILITIES, isConnectionScopesPlugin } from '@ever-works/plugin';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';

/**
 * Connection scope presets (AW-15) — capability lookup for the
 * `connection-scopes` plugin capability.
 *
 * Answers "which access levels does this provider offer, and what does each
 * one unlock?" from the plugin registry and nowhere else, so no provider id,
 * provider scope string or provider tool name lives in platform code. A
 * provider that does not declare the capability — or whose declaration is
 * malformed, or whose plugin fails to load — simply has no presets (`[]`)
 * and keeps "Standard access".
 *
 * Deliberately does NOT write anything. Mapping a chosen level onto a
 * scope's tool-grant row is `ToolGrantPresetService` (policy), which takes
 * the declarations this facade returns as input — that keeps the policy
 * module a leaf and gives each class one job.
 */
@Injectable()
export class ConnectionScopesFacadeService {
    private readonly logger = new Logger(ConnectionScopesFacadeService.name);
    private readonly CAPABILITY = PLUGIN_CAPABILITIES.CONNECTION_SCOPES;

    constructor(private readonly registry: PluginRegistryService) {}

    /** Every loaded provider that declares at least one level. */
    async listProviders(): Promise<ConnectionScopePresetProviderDto[]> {
        // Each declaration is independent and `readPresets` absorbs its own
        // failure, so one slow plugin never delays the others.
        const entries = this.declaringPlugins();
        const declared = await Promise.all(entries.map((entry) => this.readPresets(entry)));
        const out: ConnectionScopePresetProviderDto[] = [];
        for (const [index, entry] of entries.entries()) {
            const presets = declared[index];
            if (presets.length === 0) continue;
            out.push({
                providerId: entry.plugin.id,
                providerName: entry.plugin.name,
                presets: presets.map((preset) => ({
                    id: preset.id,
                    toolPatterns: [...preset.toolPatterns],
                })),
            });
        }
        return out.sort((a, b) => a.providerName.localeCompare(b.providerName));
    }

    /** The declared levels for one provider, least → most access. `[]` when undeclared. */
    async getPresets(providerId: string): Promise<ConnectionScopePresetDeclaration[]> {
        const entry = this.registry.get(providerId);
        if (!entry || entry.state !== 'loaded') return [];
        if (!this.declares(entry)) return [];
        return this.readPresets(entry);
    }

    /** Does `preset` on `providerId` unlock this tool? Same matcher as the tool-grant matrix. */
    async coversTool(
        providerId: string,
        preset: ConnectionScopePresetId,
        toolName: string,
    ): Promise<boolean> {
        const presets = await this.getPresets(providerId);
        return connectionScopePresetCoversTool(presets, preset, toolName);
    }

    /** Provider permissions a level needs from the connected account. `[]` when undeclared. */
    async providerScopesFor(
        providerId: string,
        preset: ConnectionScopePresetId,
    ): Promise<readonly string[]> {
        const presets = await this.getPresets(providerId);
        return presets.find((candidate) => candidate.id === preset)?.providerScopes ?? [];
    }

    // ── internals ─────────────────────────────────────────────────────

    private declaringPlugins(): RegisteredPlugin[] {
        return this.registry
            .getByCapability(this.CAPABILITY)
            .filter((entry) => entry.state === 'loaded' && this.declares(entry));
    }

    private declares(entry: RegisteredPlugin): boolean {
        return isConnectionScopesPlugin(entry.plugin);
    }

    /**
     * `await` covers both a real plugin (sync array) and a lazy registry
     * proxy (whose every method returns a promise). A throwing or malformed
     * declaration degrades to "no presets" — it must never take a settings
     * page down.
     */
    private async readPresets(
        entry: RegisteredPlugin,
    ): Promise<ConnectionScopePresetDeclaration[]> {
        if (!isConnectionScopesPlugin(entry.plugin)) return [];
        try {
            const raw: unknown = await entry.plugin.getConnectionScopePresets();
            return normalizeConnectionScopePresets(raw);
        } catch (error) {
            this.logger.warn(
                `Plugin ${entry.plugin.id} failed to declare connection scope presets: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return [];
        }
    }
}
