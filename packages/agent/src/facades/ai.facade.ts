import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type {
    IAiFacade,
    AskJsonOptions,
    AskJsonResponse,
    IAiProviderPlugin,
    ChatCompletionOptions,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';

/**
 * AI Facade Error Base
 */
export class AiFacadeError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly provider?: string,
        public readonly cause?: Error,
    ) {
        super(message);
        this.name = 'AiFacadeError';
    }
}

/**
 * No AI provider configured error
 */
export class NoAiProviderError extends AiFacadeError {
    constructor() {
        super('No AI provider configured or available', 'getPlugin');
        this.name = 'NoAiProviderError';
    }
}

/**
 * AI provider not found error
 */
export class AiProviderNotFoundError extends AiFacadeError {
    constructor(providerId: string) {
        super(`AI provider not found: ${providerId}`, 'getPlugin', providerId);
        this.name = 'AiProviderNotFoundError';
    }
}

/**
 * Facade options for provider resolution
 */
export interface AiFacadeOptions {
    /** User ID for settings resolution */
    userId?: string;
    /** Directory ID for settings resolution */
    directoryId?: string;
    /** Override provider (plugin ID) */
    providerOverride?: string;
}

/**
 * AI Facade service for pipeline steps.
 *
 * Uses the plugin registry to dynamically resolve AI providers.
 * Supports 4-level settings resolution hierarchy:
 * 1. Directory settings
 * 2. User settings
 * 3. Admin settings
 * 4. Plugin defaults
 */
@Injectable()
export class AiFacadeService implements IAiFacade {
    private readonly logger = new Logger(AiFacadeService.name);
    private readonly CAPABILITY = 'ai-provider';

    constructor(
        private readonly registry: PluginRegistryService,
        private readonly settingsService: PluginSettingsService,
    ) {}

    /**
     * Send a prompt and get a structured JSON response.
     * Uses the plugin registry to resolve the AI provider.
     */
    async askJson<T>(
        promptTemplate: string,
        schema: z.ZodSchema<T>,
        options?: AskJsonOptions,
        facadeOptions?: AiFacadeOptions,
    ): Promise<AskJsonResponse<T>> {
        // Resolve which plugin to use
        const plugin = await this.resolvePlugin(
            options?.routing?.providerOverride,
            facadeOptions?.userId,
            facadeOptions?.directoryId,
        );

        // Get resolved settings for the plugin
        const settings = await this.settingsService.getSettings(plugin.id, {
            userId: facadeOptions?.userId,
            directoryId: facadeOptions?.directoryId,
            includeSecrets: true,
        });

        // Render template variables
        const prompt = this.renderTemplate(promptTemplate, options?.variables);

        // Build completion options with settings for plugin to use
        const completionOptions: ChatCompletionOptions = {
            messages: [{ role: 'user', content: prompt }],
            temperature: options?.temperature ?? 0.7,
            responseFormat: { type: 'json_object' },
            jsonSchema: this.zodToJsonSchema(schema),
            settings, // Pass resolved settings to plugin
        };

        // Call the AI provider plugin
        const response = await plugin.createChatCompletion(completionOptions);

        // Parse response
        const content = response.choices[0]?.message?.content;
        if (!content || typeof content !== 'string') {
            throw new AiFacadeError('No content in AI response', 'askJson', plugin.id);
        }

        // Parse and validate JSON response
        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch (e) {
            throw new AiFacadeError('Failed to parse AI response as JSON', 'askJson', plugin.id);
        }

        const validated = schema.safeParse(parsed);
        if (!validated.success) {
            throw new AiFacadeError(
                `AI response validation failed: ${validated.error.message}`,
                'askJson',
                plugin.id,
            );
        }

        return {
            result: validated.data,
            usage: response.usage
                ? {
                      inputTokens: response.usage.promptTokens,
                      outputTokens: response.usage.completionTokens,
                      totalTokens: response.usage.totalTokens,
                  }
                : null,
            cost: null, // TODO: Calculate cost based on model pricing
            provider: plugin.id,
            model: response.model,
        };
    }

    /**
     * Check if any AI provider plugin is configured and available.
     */
    isConfigured(): boolean {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.length > 0 && plugins.some((p) => p.state === 'enabled');
    }

    /**
     * Test the AI provider connection.
     */
    async testConnection(facadeOptions?: AiFacadeOptions): Promise<{
        success: boolean;
        provider: string;
        model: string;
        responseTime: number;
        error?: string;
    }> {
        const startTime = Date.now();

        try {
            const plugin = await this.resolvePlugin(
                facadeOptions?.providerOverride,
                facadeOptions?.userId,
                facadeOptions?.directoryId,
            );

            const isAvailable = await plugin.isAvailable();

            return {
                success: isAvailable,
                provider: plugin.id,
                model: plugin.providerName,
                responseTime: Date.now() - startTime,
                error: isAvailable ? undefined : 'Provider not available',
            };
        } catch (error) {
            return {
                success: false,
                provider: 'unknown',
                model: 'unknown',
                responseTime: Date.now() - startTime,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Get all available AI provider plugins.
     */
    getAvailableProviders(): Array<{
        id: string;
        name: string;
        enabled: boolean;
    }> {
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        return plugins.map((p) => ({
            id: p.plugin.id,
            name: (p.plugin as IAiProviderPlugin).providerName,
            enabled: p.state === 'enabled',
        }));
    }

    /**
     * Resolve which AI provider plugin to use.
     *
     * Resolution order:
     * 1. providerOverride (explicit request)
     * 2. Directory default provider (if directoryId provided)
     * 3. User default provider (if userId provided)
     * 4. First enabled AI provider
     */
    private async resolvePlugin(
        providerOverride?: string,
        userId?: string,
        directoryId?: string,
    ): Promise<IAiProviderPlugin> {
        // If explicit override, use it
        if (providerOverride) {
            const registered = this.registry.get(providerOverride);
            if (
                registered &&
                registered.manifest.capabilities.includes(this.CAPABILITY) &&
                registered.state === 'enabled'
            ) {
                return registered.plugin as IAiProviderPlugin;
            }
            throw new AiProviderNotFoundError(providerOverride);
        }

        // TODO: Check directory-level default provider from settings
        // TODO: Check user-level default provider from settings

        // Fall back to first enabled AI provider
        const plugins = this.registry.getByCapability(this.CAPABILITY);
        const enabled = plugins.find((p) => p.state === 'enabled');

        if (enabled) {
            return enabled.plugin as IAiProviderPlugin;
        }

        throw new NoAiProviderError();
    }

    /**
     * Render template with variables.
     */
    private renderTemplate(template: string, variables?: Record<string, string>): string {
        if (!variables) {
            return template;
        }
        return template.replace(/\{(\w+)\}/g, (match, key) => {
            const value = variables[key];
            return value !== undefined ? value : match;
        });
    }

    /**
     * Convert Zod schema to JSON Schema for structured output.
     */
    private zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
        // Use zod-to-json-schema or manual conversion
        // For now, return a simplified version
        try {
            // Try to use zod's built-in JSON schema generation
            const zodToJsonSchema = require('zod-to-json-schema').zodToJsonSchema;
            return zodToJsonSchema(schema);
        } catch {
            // Fallback: return empty schema
            return { type: 'object' };
        }
    }
}
