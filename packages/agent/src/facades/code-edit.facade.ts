import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    PLUGIN_CAPABILITIES,
    type ICodeEditPlugin,
    type CodeEditRequest,
    type CodeEditOptions,
    type CodeEditResult,
    type PluginIcon,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { AiFacadeService } from './ai.facade';
import { BaseFacadeService, ProviderNotFoundError } from './base.facade';

export interface CodeEditFacadeOptions {
    userId: string;
    workId?: string;
    providerId?: string;
    // Forwarded to plugins that proxy to an AI provider (e.g. opencode). Plugins
    // that bring their own model (claude-code, codex, gemini) ignore this.
    aiProviderId?: string;
}

export interface CodeEditProviderInfo {
    id: string;
    name: string;
    description?: string;
    icon?: PluginIcon;
    providerName?: string;
    enabled: boolean;
    isDefault: boolean;
    selectableProviderCategories: readonly string[];
}

@Injectable()
export class CodeEditFacadeService extends BaseFacadeService {
    protected readonly logger = new Logger(CodeEditFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.CODE_EDIT;

    constructor(
        registry: PluginRegistryService,
        private readonly pluginSettings: PluginSettingsService,
        private readonly aiFacade: AiFacadeService,
        @Optional() workPluginRepository?: WorkPluginRepository,
    ) {
        super(registry, pluginSettings, workPluginRepository);
    }

    async isProviderAvailable(
        providerId: string,
        userId: string,
        workId?: string,
    ): Promise<boolean> {
        return (await this.getProviderForUser(providerId, userId, workId)) !== null;
    }

    async getProviderForUser(
        providerId: string,
        userId: string,
        workId?: string,
    ): Promise<CodeEditProviderInfo | null> {
        const registered = this.registry.get(providerId);
        if (
            !registered ||
            registered.state !== 'loaded' ||
            !registered.manifest.capabilities.includes(this.CAPABILITY) ||
            registered.manifest.supplementary
        ) {
            return null;
        }
        const enabled = await this.registry.isPluginEnabledForScope(providerId, workId, userId);
        if (!enabled) return null;
        return {
            id: registered.plugin.id,
            name: registered.manifest.name ?? registered.plugin.id,
            description: registered.manifest.description,
            icon: registered.manifest.icon,
            providerName: this.getProviderName(registered.plugin),
            enabled: true,
            isDefault:
                registered.manifest.defaultForCapabilities?.includes(this.CAPABILITY) ?? false,
            selectableProviderCategories: registered.manifest.selectableProviderCategories ?? [],
        };
    }

    listProviders(userId: string, workId?: string): Promise<CodeEditProviderInfo[]> {
        return this.getAvailableProvidersForUser(userId, workId);
    }

    async execute(
        request: CodeEditRequest,
        opts: CodeEditFacadeOptions,
        options?: Omit<CodeEditOptions, 'execContext'>,
    ): Promise<CodeEditResult> {
        const plugin = await this.resolvePlugin<ICodeEditPlugin>(
            opts.providerId,
            opts.userId,
            opts.workId,
        );
        if (this.registry.get(plugin.id)?.manifest.supplementary) {
            throw new ProviderNotFoundError(plugin.id, this.CAPABILITY);
        }
        const settings = await this.pluginSettings.getSettings(plugin.id, {
            userId: opts.userId,
            workId: opts.workId,
            includeSecrets: true,
        });

        this.logger.log(
            `Running code-edit via ${plugin.id} for user=${opts.userId} workspace=${request.workspaceDir}`,
        );

        return plugin.executeCodeEdit(request, {
            ...options,
            execContext: {
                settings,
                aiFacade: this.aiFacade,
                userId: opts.userId,
                workId: opts.workId,
                aiProviderId: opts.aiProviderId,
            },
        });
    }
}
