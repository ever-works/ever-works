import { Injectable, Logger } from '@nestjs/common';
import {
    PLUGIN_CAPABILITIES,
    isCodeEditPlugin,
    type ICodeEditPlugin,
    type CodeEditRequest,
    type CodeEditOptions,
    type CodeEditResult,
    type PluginIcon,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { AiFacadeService } from './ai.facade';

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
export class CodeEditFacadeService {
    private readonly logger = new Logger(CodeEditFacadeService.name);
    private readonly CAPABILITY = PLUGIN_CAPABILITIES.CODE_EDIT;

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly pluginSettings: PluginSettingsService,
        private readonly aiFacade: AiFacadeService,
    ) {}

    listProviders(): CodeEditProviderInfo[] {
        return this.registry.getByCapability(this.CAPABILITY).map((p) => ({
            id: p.plugin.id,
            name: p.manifest.name ?? p.plugin.id,
            description: p.manifest.description,
            icon: p.manifest.icon,
            providerName: (p.plugin as ICodeEditPlugin).providerName,
            enabled: p.state === 'loaded',
            isDefault: p.manifest.defaultForCapabilities?.includes(this.CAPABILITY) || false,
        }));
    }

    async resolveProvider(opts: CodeEditFacadeOptions): Promise<ICodeEditPlugin> {
        if (opts.providerId) {
            const registered = this.registry.get(opts.providerId);
            if (!registered || registered.state !== 'loaded') {
                throw new Error(`Code-edit provider not loaded: ${opts.providerId}`);
            }
            if (!isCodeEditPlugin(registered.plugin)) {
                throw new Error(
                    `Provider ${opts.providerId} does not implement the code-edit capability`,
                );
            }
            return registered.plugin;
        }

        const loaded = this.registry
            .getByCapability(this.CAPABILITY)
            .filter((p) => p.state === 'loaded');
        if (loaded.length === 0) {
            throw new Error(
                'No code-edit provider available — install claude-code, codex, gemini, or opencode',
            );
        }
        const plugin = loaded[0].plugin;
        if (!isCodeEditPlugin(plugin)) {
            throw new Error(
                `Default plugin ${plugin.id} does not implement the code-edit capability`,
            );
        }
        return plugin;
    }

    async execute(
        request: CodeEditRequest,
        opts: CodeEditFacadeOptions,
        options?: Omit<CodeEditOptions, 'execContext'>,
    ): Promise<CodeEditResult> {
        const plugin = await this.resolveProvider(opts);
        const settings = await this.pluginSettings.getSettings(plugin.id, {
            userId: opts.userId,
            workId: opts.workId,
            includeSecrets: true,
        });

        this.logger.log(
            `Running code-edit via ${plugin.id} for user=${opts.userId} workspace=${request.workspaceDir}`,
        );

        // aiFacade is forwarded so plugins that proxy to an AI provider (e.g.
        // opencode) can resolve provider/model via the user's AI settings.
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
