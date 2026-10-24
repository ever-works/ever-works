import { describe, expect, it } from 'vitest';

import { FLEET_JOB_KINDS, FLEET_KVM_CAPABILITY, isFleetJobKind } from '../fleet-jobs.types.js';
import {
	FLEET_VIRTUAL_ACTION_CLASS,
	FLEET_VIRTUAL_HOST_CAPABILITY,
	FLEET_VIRTUAL_MAX_PER_HOST,
	FLEET_VIRTUAL_SYSTEMS,
	FLEET_VIRTUAL_VM_SYSTEMS_SHIPPED,
	fleetVirtualContainerName,
	fleetVirtualCreateSummary,
	fleetVirtualOfferedSystems,
	fleetVirtualPhasesFor,
	fleetVirtualStopGraceSec,
	fleetVirtualSystem,
	isFleetNodeOrigin,
	isFleetVirtualCpus,
	isFleetVirtualMemoryGiB,
	isFleetVirtualName,
	isFleetVirtualSystemId
} from '../fleet-virtual.types.js';

/** Virtual computers (FL-16) — the shared vocabulary, pinned by literal. */
describe('the virtual-computer system catalogue', () => {
	it('gives every system a kind and at least one architecture', () => {
		for (const system of FLEET_VIRTUAL_SYSTEMS) {
			expect(['vm', 'container']).toContain(system.kind);
			expect(system.arch.length).toBeGreaterThan(0);
		}
	});

	it('only Windows systems are VMs, and each names its edition', () => {
		for (const system of FLEET_VIRTUAL_SYSTEMS) {
			expect(system.kind === 'vm').toBe(system.family === 'windows');
			if (system.kind === 'vm') expect(system.windowsEdition).toBeTruthy();
		}
	});

	it('offers Arch Linux on x86-64 only and every other Container on both architectures (FR-6)', () => {
		expect(fleetVirtualSystem('arch')?.arch).toEqual(['x64']);
		for (const system of FLEET_VIRTUAL_SYSTEMS.filter((entry) => entry.kind === 'container' && entry.id !== 'arch')) {
			expect([...system.arch].sort()).toEqual(['arm64', 'x64']);
		}
	});

	it('lists the ten systems of FR-3', () => {
		expect(FLEET_VIRTUAL_SYSTEMS.map((system) => system.id)).toEqual([
			'windows-11',
			'windows-10',
			'windows-server-2025',
			'windows-server-2022',
			'ubuntu-26.04',
			'ubuntu-24.04',
			'debian-13',
			'fedora',
			'alpine',
			'arch'
		]);
		expect(isFleetVirtualSystemId('ubuntu-26.04')).toBe(true);
		expect(isFleetVirtualSystemId('macos')).toBe(false);
	});

	it('offers the Windows systems once phase 2 shipped them (hidden before)', () => {
		expect(FLEET_VIRTUAL_VM_SYSTEMS_SHIPPED).toBe(true);
		expect(fleetVirtualOfferedSystems()).toHaveLength(FLEET_VIRTUAL_SYSTEMS.length);
		expect(fleetVirtualOfferedSystems(false).every((system) => system.kind === 'container')).toBe(true);
	});
});

describe('names, sizes and limits', () => {
	it('accepts ubuntu-nina and refuses Ubuntu_1 (FR-8)', () => {
		expect(isFleetVirtualName('ubuntu-nina')).toBe(true);
		expect(isFleetVirtualName('Ubuntu_1')).toBe(false);
		expect(isFleetVirtualName('a')).toBe(false);
		expect(isFleetVirtualName('-leading')).toBe(false);
		expect(isFleetVirtualName('x'.repeat(40))).toBe(false);
		expect(isFleetVirtualName('x'.repeat(39))).toBe(true);
		expect(isFleetVirtualName('a b')).toBe(false);
		expect(isFleetVirtualName('a;rm')).toBe(false);
	});

	it('offers 2 / 4 / 8 CPUs and 4 / 8 / 16 GB only', () => {
		expect([2, 4, 8].every(isFleetVirtualCpus)).toBe(true);
		expect(isFleetVirtualCpus(3)).toBe(false);
		expect([4, 8, 16].every(isFleetVirtualMemoryGiB)).toBe(true);
		expect(isFleetVirtualMemoryGiB('8')).toBe(false);
	});

	it('pins the limit, the stop graces and the container name', () => {
		expect(FLEET_VIRTUAL_MAX_PER_HOST).toBe(4);
		expect(fleetVirtualStopGraceSec('vm')).toBe(120);
		expect(fleetVirtualStopGraceSec('container')).toBe(10);
		expect(fleetVirtualContainerName('abc')).toBe('ew-virtual-abc');
	});

	it('names the classes of spec §4.1', () => {
		expect(FLEET_VIRTUAL_ACTION_CLASS).toEqual({
			create: 'confirm',
			start: 'plain',
			stop: 'confirm',
			destroy: 'confirm-destructive',
			reveal: 'confirm',
			resize: 'confirm',
			rebuild: 'confirm'
		});
	});
});

describe('the create summary (FR-12, FR-36)', () => {
	it('states the host, CPUs, memory, disk and that no credits are spent', () => {
		const summary = fleetVirtualCreateSummary({
			system: fleetVirtualSystem('ubuntu-26.04')!,
			hostName: 'build-01',
			cpus: 2,
			memoryGiB: 4
		});
		expect(summary).toBe(
			'Creates a Container on build-01 using 2 CPUs, 4 GB of memory and about 3 GB of disk. No credits are spent.'
		);
	});

	it('calls a Windows machine a VM and uses its chosen disk', () => {
		const summary = fleetVirtualCreateSummary({
			system: fleetVirtualSystem('windows-11')!,
			hostName: 'build-01',
			cpus: 4,
			memoryGiB: 8,
			diskGiB: 128
		});
		expect(summary).toContain('a VM on build-01');
		expect(summary).toContain('about 128 GB of disk');
		expect(summary).toContain('No credits are spent');
	});
});

describe('phases, jobs and tags', () => {
	it('passes the Container phases of FR-13 in order', () => {
		expect(fleetVirtualPhasesFor('container')).toEqual([
			'pulling-image',
			'starting',
			'installing-runtime',
			'enrolling',
			'online'
		]);
		expect(fleetVirtualPhasesFor('vm')).toContain('downloading-windows');
	});

	it('adds vm-create and vm-control to the job kinds', () => {
		expect(FLEET_JOB_KINDS).toContain('vm-create');
		expect(isFleetJobKind('vm-create')).toBe(true);
		expect(isFleetJobKind('vm-control')).toBe(true);
	});

	it('names the two capability tags', () => {
		expect(FLEET_KVM_CAPABILITY).toBe('kvm');
		expect(FLEET_VIRTUAL_HOST_CAPABILITY).toBe('virtual-host');
	});

	it('knows the three origins', () => {
		expect(['enrolled', 'virtual', 'cloud'].every(isFleetNodeOrigin)).toBe(true);
		expect(isFleetNodeOrigin('imported')).toBe(false);
	});
});
