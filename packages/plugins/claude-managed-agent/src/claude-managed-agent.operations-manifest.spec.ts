import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeManagedAgentPlugin } from './claude-managed-agent.plugin.js';

/**
 * EW-693 T26 (owner decision 2026-09-25) — `runSandboxSession` is the
 * platform's first LONG-RUNNING plugin operation: the execution router may
 * call it by name, in-process or in the `run-plugin-operation` worker task.
 *
 * The router refuses any operation `everworks.plugin.operations` does not
 * declare, and the worker resolves a declared one on the loaded plugin, so a
 * declaration with no method behind it would fail only at run time. Pinned
 * here, next to the class: every declared operation is a method of the plugin.
 */
describe('claude-managed-agent — declared operations (EW-693 T26)', () => {
	const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
		everworks: {
			plugin: { operations?: { name: string; executionProfile?: string }[] };
		};
	};
	const operations = pkg.everworks.plugin.operations ?? [];

	it('declares runSandboxSession as its one long-running operation', () => {
		expect(operations).toEqual([{ name: 'runSandboxSession', executionProfile: 'long-running' }]);
	});

	it.each(operations.map((operation) => [operation.name]))(
		'implements the declared operation %s as a method',
		(name) => {
			const method = (ClaudeManagedAgentPlugin.prototype as unknown as Record<string, unknown>)[name];
			expect(typeof method).toBe('function');
		}
	);
});
