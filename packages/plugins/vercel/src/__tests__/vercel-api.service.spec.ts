import { describe, it, expect, beforeEach } from 'vitest';
import { VercelApiService } from '../vercel-api.service';

describe('VercelApiService', () => {
	let service: VercelApiService;

	const mockSdkFailure = (message = 'Unauthorized') => {
		service.createSDK = async () =>
			({
				teams: {
					getTeams: async () => {
						throw new Error(message);
					}
				},
				projects: {
					getProjects: async () => {
						throw new Error(message);
					},
					getProjectDomains: async () => {
						throw new Error(message);
					}
				},
				deployments: {
					getDeployments: async () => {
						throw new Error(message);
					}
				},
				user: {
					getAuthUser: async () => {
						throw new Error(message);
					}
				}
			}) as any;
	};

	beforeEach(() => {
		service = new VercelApiService();
	});

	describe('service structure', () => {
		it('should be instantiable', () => {
			expect(service).toBeDefined();
			expect(service).toBeInstanceOf(VercelApiService);
		});

		it('should have validateToken method', () => {
			expect(typeof service.validateToken).toBe('function');
		});

		it('should have getTeams method', () => {
			expect(typeof service.getTeams).toBe('function');
		});

		it('should have getProjects method', () => {
			expect(typeof service.getProjects).toBe('function');
		});

		it('should have lookupProject method', () => {
			expect(typeof service.lookupProject).toBe('function');
		});

		it('should have lookupDeploymentAcrossScopes method', () => {
			expect(typeof service.lookupDeploymentAcrossScopes).toBe('function');
		});
	});

	describe('validateToken', () => {
		it('should return null for empty token', async () => {
			const result = await service.validateToken('');
			expect(result).toBeNull();
		});

		it('should return null for invalid token when the API rejects', async () => {
			mockSdkFailure();

			const result = await service.validateToken('invalid-token-123');
			expect(result).toBeNull();
		});
	});

	describe('getTeams', () => {
		it('should return empty array for invalid token', async () => {
			mockSdkFailure();

			const result = await service.getTeams('invalid-token');
			expect(result).toEqual([]);
		});
	});

	describe('getProjects', () => {
		it('should return empty array for invalid token', async () => {
			mockSdkFailure();

			const result = await service.getProjects('invalid-token', {});
			expect(result).toEqual([]);
		});

		it('should accept teamScope option', async () => {
			mockSdkFailure();

			const result = await service.getProjects('token', { teamScope: 'my-team' });
			expect(result).toEqual([]);
		});
	});

	describe('lookupProject', () => {
		it('should return not found for invalid token', async () => {
			mockSdkFailure();

			const result = await service.lookupProject('project-name', 'invalid-token');
			expect(result.found).toBe(false);
			expect(result.project).toBeUndefined();
		});

		it('should accept teamScope parameter', async () => {
			mockSdkFailure();

			const result = await service.lookupProject('project-name', 'token', 'team-scope');
			expect(result.found).toBe(false);
		});
	});

	describe('lookupDeploymentAcrossScopes', () => {
		it('should return not found for invalid token', async () => {
			mockSdkFailure();

			const result = await service.lookupDeploymentAcrossScopes(
				'project-name',
				'invalid-token',
				(p) => p.name === 'project-name'
			);
			expect(result.found).toBe(false);
		});
	});

	describe('domain management methods', () => {
		it('should have addProjectDomain method', () => {
			expect(typeof service.addProjectDomain).toBe('function');
		});

		it('should have removeProjectDomain method', () => {
			expect(typeof service.removeProjectDomain).toBe('function');
		});

		it('should have verifyProjectDomain method', () => {
			expect(typeof service.verifyProjectDomain).toBe('function');
		});

		it('should return empty array from getProjectDomains with empty token', async () => {
			const result = await service.getProjectDomains('project-id', '');
			expect(result).toEqual([]);
		});

		it('should throw from getProjectDomains with invalid token', async () => {
			mockSdkFailure();

			await expect(service.getProjectDomains('project-id', 'invalid-token')).rejects.toThrow();
		});
	});
});
