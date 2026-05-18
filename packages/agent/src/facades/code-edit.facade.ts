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
}

export interface CodeEditProviderInfo {
    id: string;
    name: string;
    description?: string;
    icon?: PluginIcon;
    providerName?: string;
    enabled: boolean;
    isDefault?: boolean;
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
        const registered = this.registry.get(providerId);
        if (
            !registered ||
            registered.state !== 'loaded' ||
            !registered.manifest.capabilities.includes(this.CAPABILITY) ||
            registered.manifest.supplementary
        ) {
            return false;
        }
        return this.registry.isPluginEnabledForScope(providerId, workId, userId);
    }

    async listProviders(userId: string, workId?: string): Promise<CodeEditProviderInfo[]> {
        const enabled = await this.getEnabledPlugins(workId as string, userId);
        return enabled
            .filter((p) => !p.manifest.supplementary)
            .map((p) => ({
                id: p.plugin.id,
                name: p.manifest.name ?? p.plugin.id,
                description: p.manifest.description,
                icon: p.manifest.icon,
                providerName: (p.plugin as ICodeEditPlugin).providerName,
                enabled: true,
                isDefault: p.manifest.defaultForCapabilities?.includes(this.CAPABILITY) || false,
            }));
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
            },
        });
    }
}
