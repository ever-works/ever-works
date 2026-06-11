import { Injectable, Logger } from '@nestjs/common';
import type { IPromptFacade, FacadeOptions, IPromptProviderPlugin } from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { sanitizePrompt } from '../utils/sanitize.util';
import { assertNoInjectionTokens } from '../utils/content-policy';

/**
 * Normalize Langfuse-style `{{var}}` placeholders to `{var}` so they
 * are compatible with the variable substitution used by `askJson`.
 */
function normalizeTemplate(template: string): string {
    return template.replace(/\{\{(\w+)\}\}/g, '{$1}');
}

/**
 * Facade service for resolving prompts from external prompt providers (e.g., Langfuse).
 *
 * Unlike other facades, this service never throws — it always returns a usable
 * prompt string. When no prompt provider is configured, or the requested key
 * is not found, the provided default prompt is returned unchanged.
 */
@Injectable()
export class PromptFacadeService implements IPromptFacade {
    private readonly logger = new Logger(PromptFacadeService.name);

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
    ) {}

    async getPrompt(
        key: string,
        defaultPrompt: string,
        facadeOptions?: FacadeOptions,
    ): Promise<string> {
        const plugin = this.findPromptProvider();
        if (!plugin) {
            return defaultPrompt;
        }

        try {
            const settings = facadeOptions
                ? await this.settingsService.getSettings(plugin.id, {
                      userId: facadeOptions.userId,
                      workId: facadeOptions.workId,
                      includeSecrets: true,
                  })
                : {};

            if (!plugin.isAvailable(settings)) {
                return defaultPrompt;
            }

            const result = await plugin.getPrompt(key, { settings });
            if (!result) {
                return defaultPrompt;
            }

            // Security (prompt-injection): hard-reject at the fetch boundary if
            // the external template smuggles chat-template CONTROL TOKENS
            // (e.g. <|im_start|>, [INST]). These are model turn-structure
            // delimiters that can forge a system turn and hijack the agent's
            // prompt — sanitizePrompt only strips C0 control chars, not these
            // markers. This mirrors the import-path gate in `content-policy`.
            // The throw is caught below and degrades to `defaultPrompt`, so the
            // facade's never-throw contract and existing return surface hold.
            assertNoInjectionTokens(result.template, 'external prompt provider template');

            this.logger.debug(
                `Resolved prompt "${key}" from provider (version: ${result.version ?? 'unknown'})`,
            );
            // Security (prompt-injection): the template comes from an external,
            // mutable prompt store (e.g. Langfuse) and is injected verbatim into
            // LLM system/user prompts. Treat it as untrusted data — strip control
            // characters (which could smuggle hidden directives or break logs/UI)
            // and bound the length so an oversized injected blob cannot flood the
            // model context. Newlines/whitespace are preserved so legitimate
            // multi-line prompt formatting is unchanged.
            return normalizeTemplate(sanitizePrompt(result.template));
        } catch (error) {
            this.logger.warn(
                `Failed to resolve prompt "${key}" from provider: ${error instanceof Error ? error.message : String(error)}`,
            );
            return defaultPrompt;
        }
    }

    isConfigured(): boolean {
        return this.findPromptProvider() !== null;
    }

    private findPromptProvider(): IPromptProviderPlugin | null {
        const plugins = this.registry.getByCapability(PLUGIN_CAPABILITIES.PROMPT_PROVIDER);
        const loaded = plugins.find((p) => p.state === 'loaded');
        return (loaded?.plugin as IPromptProviderPlugin) ?? null;
    }
}
