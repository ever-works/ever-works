import { describe, it, expect } from 'vitest';
import { GitHubRegistryProvider } from '../registries/github.provider';
import { DockerHubRegistryProvider } from '../registries/dockerhub.provider';
import { GenericRegistryProvider } from '../registries/generic.provider';
import { RegistryProviderRegistry } from '../registries/provider.registry';
import { K8sPluginError } from '../errors';
import type { RegistryConfig, RegistryDeployContext } from '../types';

const ctx = (overrides: Partial<RegistryDeployContext> = {}): RegistryDeployContext => ({
	workSlug: 'my-site',
	githubOwner: 'acme',
	...overrides,
});

describe('GitHubRegistryProvider', () => {
	const p = new GitHubRegistryProvider();

	it('builds image base from explicit owner', () => {
		expect(
			p.imageBase({ kind: 'github', owner: 'Acme-Corp' }, ctx({ githubOwner: 'fallback' })),
		).toBe('ghcr.io/acme-corp');
	});

	it('falls back to ctx.githubOwner when owner is empty', () => {
		expect(p.imageBase({ kind: 'github' }, ctx({ githubOwner: 'fallback' }))).toBe('ghcr.io/fallback');
	});

	it('throws GITHUB_NOT_CONNECTED when no owner is available', () => {
		try {
			p.imageBase({ kind: 'github' }, ctx({ githubOwner: undefined }));
			throw new Error('expected throw');
		} catch (err) {
			expect((err as K8sPluginError).code).toBe('GITHUB_NOT_CONNECTED');
		}
	});

	describe('resolveVisibility', () => {
		it('mirrors public website repo (auto)', () => {
			expect(
				p.resolveVisibility({ kind: 'github', visibility: 'auto' }, ctx({ websiteRepoIsPrivate: false })),
			).toBe('public');
		});

		it('mirrors private website repo (auto)', () => {
			expect(
				p.resolveVisibility({ kind: 'github', visibility: 'auto' }, ctx({ websiteRepoIsPrivate: true })),
			).toBe('private');
		});

		it('honours explicit visibility override even when website is opposite', () => {
			expect(
				p.resolveVisibility({ kind: 'github', visibility: 'private' }, ctx({ websiteRepoIsPrivate: false })),
			).toBe('private');
			expect(
				p.resolveVisibility({ kind: 'github', visibility: 'public' }, ctx({ websiteRepoIsPrivate: true })),
			).toBe('public');
		});

		it('defaults to private when website repo visibility is unknown (safer)', () => {
			expect(p.resolveVisibility({ kind: 'github' }, ctx({ websiteRepoIsPrivate: undefined }))).toBe(
				'private',
			);
		});
	});

	describe('pullSecretCredentials', () => {
		it('returns null when visibility is public (no pull secret needed)', () => {
			expect(p.pullSecretCredentials({ kind: 'github' }, ctx(), 'public')).toBeNull();
		});

		it('returns server/username placeholder when private', () => {
			const creds = p.pullSecretCredentials({ kind: 'github', owner: 'acme' }, ctx(), 'private');
			expect(creds).toEqual({ server: 'ghcr.io', username: 'acme', password: '' });
		});
	});

	it('workflowLogin uses GITHUB_TOKEN', () => {
		expect(p.workflowLogin({ kind: 'github' })).toEqual({
			registry: 'ghcr.io',
			username: '${{ github.actor }}',
			passwordEnv: 'GITHUB_TOKEN',
		});
	});
});

describe('DockerHubRegistryProvider', () => {
	const p = new DockerHubRegistryProvider();
	const config: RegistryConfig = { kind: 'dockerhub', username: 'acme', password: 'tok' };

	it('builds image base under docker.io', () => {
		expect(p.imageBase(config, ctx())).toBe('docker.io/acme');
	});

	it('always resolves to private (auth always supplied)', () => {
		expect(p.resolveVisibility(config, ctx())).toBe('private');
	});

	it('returns pull-secret credentials with the supplied password', () => {
		expect(p.pullSecretCredentials(config, ctx(), 'private')).toEqual({
			server: 'docker.io',
			username: 'acme',
			password: 'tok',
		});
	});

	it('returns null pull-secret when visibility is public', () => {
		expect(p.pullSecretCredentials(config, ctx(), 'public')).toBeNull();
	});
});

describe('GenericRegistryProvider', () => {
	const p = new GenericRegistryProvider();
	const config: RegistryConfig = {
		kind: 'generic',
		server: 'https://registry.example.com/',
		username: 'acme',
		password: 'tok',
	};

	it('strips protocol and trailing slashes from the server URL', () => {
		expect(p.imageBase(config, ctx())).toBe('registry.example.com/acme');
		expect(p.workflowLogin(config).registry).toBe('registry.example.com');
	});
});

describe('RegistryProviderRegistry', () => {
	it('ships with github/dockerhub/generic registered', () => {
		const r = new RegistryProviderRegistry();
		expect(r.knownKinds()).toEqual(expect.arrayContaining(['github', 'dockerhub', 'generic']));
	});

	it('throws on unknown kind', () => {
		const r = new RegistryProviderRegistry();
		try {
			r.resolve('does-not-exist' as never);
			throw new Error('expected throw');
		} catch (err) {
			expect((err as K8sPluginError).code).toBe('UNKNOWN');
		}
	});

	it('lets callers register additional kinds', () => {
		const r = new RegistryProviderRegistry();
		const fake = {
			kind: 'fake' as never,
			imageBase: () => 'fake.io/x',
			resolveVisibility: () => 'private' as const,
			workflowLogin: () => ({ registry: 'fake.io', username: 'u', passwordEnv: 'P' }),
			pullSecretCredentials: () => ({ server: 'fake.io', username: 'u', password: 'p' }),
		};
		r.register(fake as never);
		expect(r.resolve('fake' as never)).toBe(fake);
	});
});
