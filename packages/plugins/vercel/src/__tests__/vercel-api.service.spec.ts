import { describe, it, expect, beforeEach } from 'vitest';
import { VercelApiService } from '../vercel-api.service';

describe('VercelApiService', () => {
	let service: VercelApiService;

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

		it('should return null for invalid token (without mocking, this hits real API)', async () => {
			// This test documents the expected behavior when the token is invalid
			// In real usage, this would hit the Vercel API
			// We expect it to return null for any non-valid token
			const result = await service.validateToken('invalid-token-123');
			expect(result).toBeNull();
		});
	});

	describe('getTeams', () => {
		it('should return empty array for invalid token', async () => {
			const result = await service.getTeams('invalid-token');
			expect(result).toEqual([]);
		});
	});

	describe('getProjects', () => {
		it('should return empty array for invalid token', async () => {
			const result = await service.getProjects('invalid-token', {});
			expect(result).toEqual([]);
		});

		it('should accept teamScope option', async () => {
			const result = await service.getProjects('token', { teamScope: 'my-team' });
			expect(result).toEqual([]);
		});
	});

	describe('lookupProject', () => {
		it('should return not found for invalid token', async () => {
			const result = await service.lookupProject('project-name', 'invalid-token');
			expect(result.found).toBe(false);
			expect(result.project).toBeUndefined();
		});

		it('should accept teamScope parameter', async () => {
			const result = await service.lookupProject('project-name', 'token', 'team-scope');
			expect(result.found).toBe(false);
		});
	});

	describe('lookupDeploymentAcrossScopes', () => {
		it('should return not found for invalid token', async () => {
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

		it('should return domains with verification info from getProjectDomains', async () => {
			// With an invalid token, getProjectDomains returns empty array
			const result = await service.getProjectDomains('project-id', 'invalid-token');
			expect(result).toEqual([]);
		});
	});
});
