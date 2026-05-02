import type { ResolvedWorksConfig } from './services/works-config.service';

export function mergeWorksConfigIntoDataConfig(
    config: Record<string, unknown>,
    workName: string,
    worksConfig?: ResolvedWorksConfig | null,
): Record<string, unknown> {
    if (!worksConfig) {
        return config;
    }

    const metadata =
        config.metadata && typeof config.metadata === 'object' && !Array.isArray(config.metadata)
            ? { ...(config.metadata as Record<string, unknown>) }
            : {};

    if (worksConfig.initialPrompt && !metadata.initial_prompt) {
        metadata.initial_prompt = worksConfig.initialPrompt;
    }

    if (!metadata.last_request_data && worksConfig.initialPrompt) {
        metadata.last_request_data = {
            name: worksConfig.name || workName,
            prompt: worksConfig.initialPrompt,
            model: worksConfig.model,
            providers: worksConfig.providers,
            pluginConfig: {},
        };
    }

    return {
        ...config,
        metadata,
    };
}
