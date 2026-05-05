import type {
	GitHubRegistryConfig,
	RegistryConfig,
	RegistryDeployContext,
	RegistryWorkflowLogin,
	ResolvedImageVisibility
} from '../types.js';
import { K8sPluginError } from '../errors.js';
import type { RegistryProvider } from './provider.js';

const GHCR_HOST = 'ghcr.io';

export class GitHubRegistryProvider implements RegistryProvider {
	readonly kind = 'github' as const;

	imageBase(config: RegistryConfig, ctx: RegistryDeployContext): string {
		const ghCfg = this.expect(config);
		const owner = ghCfg.owner?.trim() || ctx.githubOwner?.trim();
		if (!owner) {
			throw new K8sPluginError(
				'GITHUB_NOT_CONNECTED',
				'No GitHub owner is available — connect GitHub or set the registry owner explicitly.'
			);
		}
		return `${GHCR_HOST}/${owner.toLowerCase()}`;
	}

	resolveVisibility(config: RegistryConfig, ctx: RegistryDeployContext): ResolvedImageVisibility {
		const ghCfg = this.expect(config);
		const explicit = ghCfg.visibility;
		if (explicit === 'public' || explicit === 'private') {
			return explicit;
		}
		// 'auto' (default) → mirror website repo visibility
		if (ctx.websiteRepoIsPrivate === true) return 'private';
		if (ctx.websiteRepoIsPrivate === false) return 'public';
		// Unknown (no GitHub plugin context yet): err on the safe side.
		return 'private';
	}

	workflowLogin(_config: RegistryConfig): RegistryWorkflowLogin {
		// In GitHub Actions, the workflow uses GITHUB_TOKEN automatically and
		// $GITHUB_ACTOR as the username. The deploy template wires this up.
		return {
			registry: GHCR_HOST,
			username: '${{ github.actor }}',
			passwordEnv: 'GITHUB_TOKEN'
		};
	}

	pullSecretCredentials(
		config: RegistryConfig,
		ctx: RegistryDeployContext,
		visibility: ResolvedImageVisibility
	): { server: string; username: string; password: string } | null {
		if (visibility === 'public') {
			return null;
		}
		const ghCfg = this.expect(config);
		const owner = ghCfg.owner?.trim() || ctx.githubOwner?.trim() || '';
		// The actual `password` (a fine-grained read:packages PAT) must be
		// injected by the caller — see `KubernetesPlugin.deploy()`. We return
		// a placeholder shape so the manifest renderer has a stable surface.
		return {
			server: GHCR_HOST,
			username: owner,
			password: ''
		};
	}

	private expect(config: RegistryConfig): GitHubRegistryConfig {
		if (config.kind !== 'github') {
			throw new K8sPluginError('UNKNOWN', `GitHubRegistryProvider received non-github config: ${config.kind}`);
		}
		return config;
	}
}
