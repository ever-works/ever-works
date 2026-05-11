import { Injectable } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import type {
    OnboardingCatalogResponse,
    OnboardingCard,
    OnboardingAiChoice,
    OnboardingStorageChoice,
    OnboardingDeployChoice,
    OnboardingPluginCard,
} from '@ever-works/contracts/api';

/**
 * Builds the catalog payload the web wizard renders:
 *
 *  - AI choice cards (Ever Works AI default + 5 BYOK options)
 *  - Storage choice cards (Ever Works Git default + Your GitHub + 2 Planned)
 *  - Deploy choice cards (Ever Works default + Vercel + Kubernetes)
 *  - "Plugins & Integrations" plugin list (driven by manifest
 *    `uiHints.includeInOnboarding` minus the plugins already used in
 *    the AI/Storage/Deploy steps).
 *
 * `available` flips false when the corresponding env flag is off so the
 * client renders an Ever Works default as "Planned" instead of hard-wiring
 * UI to backend state.
 */
@Injectable()
export class OnboardingCatalogService {
    constructor(private readonly registry: PluginRegistryService) {}

    getCatalog(): OnboardingCatalogResponse {
        const everWorksGitEnabled = config.everWorks.git.isEnabled();
        const everWorksDeployEnabled = config.everWorks.deploy.isEnabled();

        const ai: ReadonlyArray<OnboardingCard<OnboardingAiChoice>> = [
            {
                choice: 'ever-works',
                title: 'Ever Works AI',
                description: 'Use the AI provider configured by Ever Works. No setup needed.',
                default: true,
                available: true,
                badges: ['default'],
            },
            {
                choice: 'openrouter',
                title: 'OpenRouter',
                description: 'Route AI calls through OpenRouter with your own API key.',
                default: false,
                available: true,
                badges: ['byok'],
                pluginId: 'openrouter',
            },
            {
                choice: 'claude-code',
                title: 'Claude Code',
                description:
                    'Use Anthropic Claude via the Claude Code CLI. OAuth Token taps your Pro/Max subscription with no per-token cost.',
                default: false,
                available: true,
                badges: ['byok'],
                pluginId: 'claude-code',
            },
            {
                choice: 'codex',
                title: 'Codex',
                description: 'OpenAI Codex CLI via device-auth flow.',
                default: false,
                available: true,
                badges: ['byok'],
                pluginId: 'codex',
            },
            {
                choice: 'gemini',
                title: 'Gemini',
                description: 'Google Gemini via your AI Studio API key.',
                default: false,
                available: true,
                badges: ['byok'],
                pluginId: 'gemini',
            },
            {
                choice: 'grok',
                title: 'Grok (xAI)',
                description: 'xAI Grok via your xAI API key.',
                default: false,
                available: true,
                badges: ['byok'],
                pluginId: 'grok',
            },
        ];

        const storage: ReadonlyArray<OnboardingCard<OnboardingStorageChoice>> = [
            {
                choice: 'ever-works-git',
                title: 'Ever Works Git',
                description: everWorksGitEnabled
                    ? 'Push your work repos to a managed Ever Works GitHub org.'
                    : 'Coming soon — a managed Ever Works GitHub org for your work repos.',
                default: true,
                available: everWorksGitEnabled,
                badges: everWorksGitEnabled ? ['default'] : ['default', 'planned'],
            },
            {
                choice: 'user-github',
                title: 'Your GitHub',
                description: 'Push work repos to your own GitHub account or org.',
                default: false,
                available: true,
                badges: [],
                pluginId: 'github',
            },
            {
                choice: 'user-gitlab',
                title: 'Your GitLab',
                description: 'Coming soon — bring your own GitLab.',
                default: false,
                available: false,
                badges: ['planned'],
            },
            {
                choice: 'user-git',
                title: 'Your Git',
                description: 'Coming soon — use a self-hosted Git server.',
                default: false,
                available: false,
                badges: ['planned'],
            },
        ];

        const deploy: ReadonlyArray<OnboardingCard<OnboardingDeployChoice>> = [
            {
                choice: 'ever-works',
                title: 'Ever Works',
                description: everWorksDeployEnabled
                    ? `Deploy to the Ever Works tenant cluster (up to ${config.everWorks.deploy.getMaxWorksPerUser()} active works per account).`
                    : 'Coming soon — managed deploys on the Ever Works tenant cluster.',
                default: true,
                available: everWorksDeployEnabled,
                badges: everWorksDeployEnabled ? ['default'] : ['default', 'planned'],
            },
            {
                choice: 'vercel',
                title: 'Vercel',
                description: 'Deploy to your own Vercel team using your API token.',
                default: false,
                available: true,
                badges: [],
                pluginId: 'vercel',
            },
            {
                choice: 'k8s',
                title: 'Kubernetes',
                description: 'Deploy to your own Kubernetes cluster — paste a kubeconfig.',
                default: false,
                available: true,
                badges: [],
                pluginId: 'k8s',
            },
        ];

        const reservedPluginIds = new Set<string>(
            [
                ...ai.map((c) => c.pluginId),
                ...storage.map((c) => c.pluginId),
                ...deploy.map((c) => c.pluginId),
            ].filter((id): id is string => Boolean(id)),
        );

        const plugins = this.collectPluginsStepCards(reservedPluginIds);

        return { ai, storage, deploy, plugins };
    }

    private collectPluginsStepCards(reservedPluginIds: Set<string>): OnboardingPluginCard[] {
        const all = this.registry.getAll();
        return all
            .filter((entry) => entry.manifest.uiHints?.includeInOnboarding === true)
            .filter((entry) => !reservedPluginIds.has(entry.manifest.id))
            .map(
                (entry): OnboardingPluginCard => ({
                    pluginId: entry.manifest.id,
                    name: entry.manifest.name,
                    category: entry.manifest.category,
                    description: entry.manifest.description ?? '',
                    onboardingPriority:
                        entry.manifest.uiHints?.onboardingPriority ?? Number.MAX_SAFE_INTEGER,
                }),
            )
            .sort((a, b) => a.onboardingPriority - b.onboardingPriority);
    }
}
