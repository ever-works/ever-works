import { describe, expect, it } from 'vitest';

import * as fleet from '../index.js';
import {
	asFleetBlastRadius,
	FLEET_BLAST_RADIUS_KINDS,
	FLEET_CONFIRMATION_CLASSES,
	fleetBlastRadiusSentence,
	fleetEffectiveConfirmationClass,
	fleetMissingConfirmation
} from '../fleet-machine-actions.types.js';
import {
	FLEET_PROCESS_LIST_MAX,
	FLEET_PROCESS_SIGNALS,
	fleetProcessMatchesFind,
	isFleetProcessPid,
	parseFleetProcessPid
} from '../fleet-processes.types.js';
import {
	compareFleetServices,
	FLEET_SERVICE_ACTIONS,
	FLEET_SERVICE_ACTIONS_WITH_BLAST_RADIUS,
	fleetServiceMatchesFind,
	isFleetServiceName
} from '../fleet-services.types.js';

/**
 * FL-09 (services, Docker, Compose, processes) — the shared machine-action
 * vocabulary, the service-name pattern every act goes through (FR-36), and
 * the CONTRACTS §2.2 confirmation rule every caller satisfies the same way.
 */

describe('fleet machine-action exports', () => {
	it('reaches every FL-09 runtime symbol through the fleet barrel', () => {
		for (const name of [
			'FLEET_CONFIRMATION_CLASSES',
			'FLEET_BLAST_RADIUS_KINDS',
			'fleetMissingConfirmation',
			'fleetEffectiveConfirmationClass',
			'fleetBlastRadiusSentence',
			'asFleetBlastRadius',
			'FLEET_SERVICES_CAPABILITY',
			'FLEET_SERVICE_ACTIONS',
			'FLEET_SERVICE_NAME_PATTERN',
			'isFleetServiceName',
			'compareFleetServices',
			'FLEET_PROCESSES_CAPABILITY',
			'FLEET_PROCESS_LIST_MAX',
			'parseFleetProcessPid'
		]) {
			expect(fleet).toHaveProperty(name);
		}
	});

	it('names the four classes and five blast-radius kinds of CONTRACTS §2.2', () => {
		expect([...FLEET_CONFIRMATION_CLASSES]).toEqual(['plain', 'confirm', 'confirm-destructive', 'blast-radius']);
		expect([...FLEET_BLAST_RADIUS_KINDS]).toEqual(['network', 'ssh', 'vpn', 'docker', 'node']);
	});
});

describe('isFleetServiceName (FR-36)', () => {
	it.each([
		'nginx',
		'postgresql@16-main.service',
		'wg-quick@wg0',
		'com.openssh.sshd',
		'homebrew.mxcl.postgresql@16',
		'W3SVC',
		'MSSQL$SQLEXPRESS',
		'user@1000.service'
	])('accepts %s', (name) => {
		expect(isFleetServiceName(name)).toBe(true);
	});

	it.each([
		'nginx; rm -rf /',
		'a|b',
		'$(whoami)',
		'`id`',
		'a\nb',
		'-r',
		'--now',
		'',
		'with space',
		"quote'd",
		'a/b',
		'..',
		'a'.repeat(129)
	])('refuses %j', (name) => {
		expect(isFleetServiceName(name)).toBe(false);
	});
});

describe('fleetMissingConfirmation (CONTRACTS §2.2)', () => {
	const warning = { kind: 'network' as const, sentence: 'This stops the network.' };

	it('needs nothing for plain', () => {
		expect(fleetMissingConfirmation({ class: 'plain', target: 'x' })).toBeNull();
	});

	it('needs confirm: true for confirm', () => {
		expect(fleetMissingConfirmation({ class: 'confirm', target: 'nginx' })).toBe('confirm');
		expect(fleetMissingConfirmation({ class: 'confirm', target: 'nginx', fields: { confirm: true } })).toBeNull();
	});

	it('raises confirm to blast-radius when the node warned, and needs both fields', () => {
		expect(
			fleetMissingConfirmation({
				class: 'confirm',
				target: 'NetworkManager',
				blastRadius: warning,
				fields: { confirm: true }
			})
		).toBe('blast-radius');
		expect(
			fleetMissingConfirmation({
				class: 'confirm',
				target: 'NetworkManager',
				blastRadius: warning,
				fields: { confirm: true, acknowledgeBlastRadius: true }
			})
		).toBeNull();
	});

	it('needs the exact typed name for confirm-destructive', () => {
		expect(
			fleetMissingConfirmation({ class: 'confirm-destructive', target: 'acme-api', fields: { confirm: true } })
		).toBe('confirm-destructive');
		expect(
			fleetMissingConfirmation({
				class: 'confirm-destructive',
				target: 'acme-api',
				fields: { confirmName: 'acme-ap' }
			})
		).toBe('confirm-destructive');
		expect(
			fleetMissingConfirmation({
				class: 'confirm-destructive',
				target: 'acme-api',
				fields: { confirmName: 'acme-api' }
			})
		).toBeNull();
	});

	it('adds the acknowledgement on top of a typed name when the node warned', () => {
		expect(
			fleetMissingConfirmation({
				class: 'confirm-destructive',
				target: 'acme-api',
				blastRadius: warning,
				fields: { confirmName: 'acme-api' }
			})
		).toBe('blast-radius');
	});

	it('treats a truthy non-boolean as not confirmed', () => {
		expect(
			fleetMissingConfirmation({
				class: 'confirm',
				target: 'nginx',
				fields: { confirm: 'yes' as unknown as boolean }
			})
		).toBe('confirm');
	});

	it('keeps confirm-destructive as the effective class and raises confirm to blast-radius', () => {
		expect(fleetEffectiveConfirmationClass('confirm', warning)).toBe('blast-radius');
		expect(fleetEffectiveConfirmationClass('confirm', null)).toBe('confirm');
		expect(fleetEffectiveConfirmationClass('confirm-destructive', warning)).toBe('confirm-destructive');
	});
});

describe('blast radius', () => {
	it('words every kind with the machine name', () => {
		for (const kind of FLEET_BLAST_RADIUS_KINDS) {
			expect(fleetBlastRadiusSentence(kind, 'build-01')).toContain('build-01');
		}
		expect(fleetBlastRadiusSentence('network', 'build-01')).toBe(
			'This stops the network service build-01 connects to Ever Works through. You would need to be at the machine to bring it back.'
		);
	});

	it('reads one off the wire and refuses anything else', () => {
		expect(asFleetBlastRadius({ kind: 'ssh', sentence: ' Stops ssh. ' })).toEqual({
			kind: 'ssh',
			sentence: 'Stops ssh.'
		});
		expect(asFleetBlastRadius({ kind: 'printer', sentence: 'x' })).toBeNull();
		expect(asFleetBlastRadius({ kind: 'ssh', sentence: '' })).toBeNull();
		expect(asFleetBlastRadius('ssh')).toBeNull();
	});
});

describe('services ordering and find (FR-2)', () => {
	it('puts failed first, then running, then the rest, each by name', () => {
		const rows = [
			{ name: 'ssh', state: 'inactive' as const, scope: 'user' as const },
			{ name: 'nginx', state: 'running' as const, scope: 'system' as const },
			{ name: 'postgresql', state: 'failed' as const, scope: 'system' as const },
			{ name: 'docker', state: 'running' as const, scope: 'system' as const }
		];
		expect([...rows].sort(compareFleetServices).map((row) => row.name)).toEqual([
			'postgresql',
			'docker',
			'nginx',
			'ssh'
		]);
	});

	it('finds by name or description', () => {
		expect(fleetServiceMatchesFind({ name: 'nginx', description: 'A high performance web server' }, 'WEB')).toBe(
			true
		);
		expect(fleetServiceMatchesFind({ name: 'nginx', description: null }, 'postgres')).toBe(false);
		expect(fleetServiceMatchesFind({ name: 'nginx', description: null }, '  ')).toBe(true);
	});

	it('computes a blast radius only before acts that take a service away', () => {
		expect([...FLEET_SERVICE_ACTIONS]).toEqual(['start', 'stop', 'restart', 'enable', 'disable']);
		expect([...FLEET_SERVICE_ACTIONS_WITH_BLAST_RADIUS]).toEqual(['stop', 'restart', 'disable']);
	});
});

describe('processes (FR-9, FR-11)', () => {
	it('caps the list at the CONTRACTS §10 value and names two signals', () => {
		expect(FLEET_PROCESS_LIST_MAX).toBe(300);
		expect([...FLEET_PROCESS_SIGNALS]).toEqual(['TERM', 'KILL']);
	});

	it('accepts only positive integer pids', () => {
		expect(isFleetProcessPid(4812)).toBe(true);
		expect(isFleetProcessPid(0)).toBe(false);
		expect(isFleetProcessPid(-1)).toBe(false);
		expect(isFleetProcessPid(1.5)).toBe(false);
		expect(parseFleetProcessPid('4812')).toBe(4812);
		expect(parseFleetProcessPid('04812')).toBeNull();
		expect(parseFleetProcessPid('1; kill 1')).toBeNull();
		expect(parseFleetProcessPid('99999999')).toBeNull();
	});

	it('finds by name, command, owner or exact pid', () => {
		const row = { pid: 4812, name: 'node', command: 'node ./dist/worker.js', owner: 'ops' };
		expect(fleetProcessMatchesFind(row, 'worker')).toBe(true);
		expect(fleetProcessMatchesFind(row, 'OPS')).toBe(true);
		expect(fleetProcessMatchesFind(row, '4812')).toBe(true);
		expect(fleetProcessMatchesFind(row, '481')).toBe(false);
	});
});
