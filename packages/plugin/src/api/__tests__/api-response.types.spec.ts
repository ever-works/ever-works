import { describe, it, expect } from 'vitest';
import { toPluginSettingsSchemaProperty } from '../api-response.types.js';
import type { JsonSchema } from '../../settings/json-schema.types.js';

describe('toPluginSettingsSchemaProperty', () => {
	it('preserves a oneOf discriminated union so the UI can render branch choosers', () => {
		const schema: JsonSchema = {
			type: 'object',
			title: 'Container registry',
			default: { kind: 'github' },
			oneOf: [
				{
					type: 'object',
					title: 'GitHub Container Registry (default)',
					properties: {
						kind: { type: 'string', const: 'github' },
						owner: { type: 'string', title: 'GitHub owner' }
					},
					required: ['kind']
				},
				{
					type: 'object',
					title: 'Docker Hub',
					properties: {
						kind: { type: 'string', const: 'dockerhub' },
						username: { type: 'string', title: 'Username' },
						password: {
							type: 'string',
							title: 'Access token',
							'x-secret': true,
							'x-scope': 'user'
						}
					},
					required: ['kind', 'username', 'password']
				}
			]
		};

		const out = toPluginSettingsSchemaProperty(schema);

		// Discriminator survives.
		expect(out.oneOf).toBeDefined();
		expect(out.oneOf).toHaveLength(2);

		const [githubBranch, dockerhubBranch] = out.oneOf!;
		expect(githubBranch.title).toBe('GitHub Container Registry (default)');
		expect(githubBranch.properties?.kind?.const).toBe('github');
		expect(githubBranch.properties?.owner?.title).toBe('GitHub owner');

		// x-* prefixes inside branches are flattened recursively.
		expect(dockerhubBranch.properties?.password?.secret).toBe(true);
		expect(dockerhubBranch.properties?.password?.scope).toBe('user');

		// Top-level default is also preserved so the form can pick a starting branch.
		expect(out.default).toEqual({ kind: 'github' });
	});

	it('returns oneOf undefined when no branches are declared', () => {
		const schema: JsonSchema = {
			type: 'string',
			title: 'Plain field'
		};
		const out = toPluginSettingsSchemaProperty(schema);
		expect(out.oneOf).toBeUndefined();
	});
});
