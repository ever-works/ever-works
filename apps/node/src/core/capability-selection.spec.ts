import { describe, expect, it } from 'vitest';
import {
	applyCapabilitySelection,
	describeSelf,
	isIdentityCapability,
	selectableCapabilities,
	type CapabilityEnvironment,
	type CommandRunner
} from './capabilities';
import { parseConfig } from './config-store';
import { clampResourceLimits, redactConfig, type NodeConfig } from './types';

/**
 * Capability selection (A15) and the config round-trip for the wizard's new
 * answers.
 *
 * The property that matters: a selection can only ever SHRINK what a machine
 * offers. The dangerous direction is the other one — a laptop that quietly
 * starts advertising `docker` because somebody installed Docker Desktop, and
 * therefore quietly starts being handed container work its owner never agreed
 * to run.
 */

function runner(available: Set<string>): CommandRunner {
	return {
		run: async (command) => ({
			code: available.has(command) ? 0 : 1,
			stdout: available.has(command) ? '1.0.0' : '',
			stderr: ''
		})
	};
}

const linuxEnvironment: CapabilityEnvironment = {
	platform: 'linux',
	arch: 'x64',
	nodeVersion: 'v22.11.0',
	hasDisplay: false
};

describe('isIdentityCapability', () => {
	it('treats os/arch/node tags as machine identity, everything else as an offer', () => {
		expect(isIdentityCapability('os:linux')).toBe(true);
		expect(isIdentityCapability('arch:x64')).toBe(true);
		expect(isIdentityCapability('node:22')).toBe(true);
		expect(isIdentityCapability('docker')).toBe(false);
		expect(isIdentityCapability('terminal')).toBe(false);
	});
});

describe('selectableCapabilities', () => {
	it('offers only the non-identity tags as choices', () => {
		expect(selectableCapabilities(['os:linux', 'arch:x64', 'terminal', 'docker'])).toEqual(['terminal', 'docker']);
	});
});

describe('applyCapabilitySelection', () => {
	const detected = ['os:linux', 'arch:x64', 'node:22', 'terminal', 'workspace', 'docker', 'git'];

	it('advertises everything detected when no selection was recorded', () => {
		expect(applyCapabilitySelection(detected, undefined)).toEqual(detected);
		expect(applyCapabilitySelection(detected, null)).toEqual(detected);
	});

	it('narrows the offer to the chosen tags, keeping machine identity', () => {
		expect(applyCapabilitySelection(detected, ['terminal', 'git'])).toEqual([
			'os:linux',
			'arch:x64',
			'node:22',
			'terminal',
			'git'
		]);
	});

	it('an empty selection means "identity only" — a legitimate visibility-only node', () => {
		expect(applyCapabilitySelection(detected, [])).toEqual(['os:linux', 'arch:x64', 'node:22']);
	});

	it('cannot ADD a capability the machine does not have', () => {
		// The whole point: selection intersects, it never unions.
		expect(applyCapabilitySelection(['os:linux', 'terminal'], ['terminal', 'docker'])).toEqual([
			'os:linux',
			'terminal'
		]);
	});
});

describe('describeSelf with a selection', () => {
	it('reports every detected tag when no selection is supplied', async () => {
		const description = await describeSelf(runner(new Set(['docker', 'git'])), linuxEnvironment, '1.2.3');
		expect(description.capabilities).toContain('docker');
		expect(description.capabilities).toContain('git');
	});

	it('withholds a capability the operator did not offer, even once the tool exists', async () => {
		// Docker IS installed; the owner just never offered it.
		const description = await describeSelf(runner(new Set(['docker', 'git'])), linuxEnvironment, '1.2.3', [
			'terminal',
			'workspace',
			'git'
		]);
		expect(description.capabilities).not.toContain('docker');
		expect(description.capabilities).toContain('git');
		// Identity survives so the scheduler can still place work correctly.
		expect(description.capabilities).toContain('os:linux');
	});
});

describe('config round-trip for capability selection and limits', () => {
	const base: NodeConfig = {
		apiUrl: 'https://api.example.com',
		nodeId: 'node-1',
		secret: 'a'.repeat(32),
		kind: 'desktop-node',
		capabilities: ['os:linux', 'terminal'],
		heartbeatIntervalMs: 60_000,
		enrolledAt: new Date(0).toISOString()
	};

	it('persists and re-reads the operator selection and ceilings', () => {
		const stored: NodeConfig = {
			...base,
			capabilitySelection: ['terminal'],
			limits: { maxConcurrentJobs: 3, maxCpuPercent: 70, maxMemoryMb: 8_192 }
		};
		const parsed = parseConfig(JSON.stringify(stored));

		expect(parsed?.capabilitySelection).toEqual(['terminal']);
		expect(parsed?.limits).toEqual({ maxConcurrentJobs: 3, maxCpuPercent: 70, maxMemoryMb: 8_192 });
	});

	it('reads a pre-limits config as the conservative default, never a wider one', () => {
		const parsed = parseConfig(JSON.stringify(base));
		expect(parsed?.limits).toEqual(clampResourceLimits(null));
		// No selection recorded stays ABSENT — distinct from an empty one.
		expect(parsed?.capabilitySelection).toBeUndefined();
	});

	it('preserves the difference between "no selection" and "an empty selection"', () => {
		const empty = parseConfig(JSON.stringify({ ...base, capabilitySelection: [] }));
		expect(empty?.capabilitySelection).toEqual([]);
	});

	it('clamps a hand-edited out-of-range limit rather than trusting it', () => {
		const parsed = parseConfig(
			JSON.stringify({ ...base, limits: { maxConcurrentJobs: 9_999, maxCpuPercent: 0, maxMemoryMb: 1 } })
		);
		expect(parsed?.limits?.maxConcurrentJobs).toBe(16);
		expect(parsed?.limits?.maxCpuPercent).toBe(5);
		expect(parsed?.limits?.maxMemoryMb).toBe(256);
	});

	it('exposes limits and selection through the redacted view, still without the secret', () => {
		const view = redactConfig({
			...base,
			capabilitySelection: ['terminal'],
			limits: { maxConcurrentJobs: 2, maxCpuPercent: null, maxMemoryMb: null }
		});
		expect(view.limits.maxConcurrentJobs).toBe(2);
		expect(view.capabilitySelection).toEqual(['terminal']);
		expect(JSON.stringify(view)).not.toContain(base.secret);
	});
});
