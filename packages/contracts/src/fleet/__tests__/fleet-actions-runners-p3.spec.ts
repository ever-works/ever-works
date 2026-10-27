import { describe, expect, it } from 'vitest';
import {
	compareFleetActionsRunnerVersions,
	FLEET_ACTIONS_RUNNER_DOCKER_CAPABILITY,
	FLEET_ACTIONS_RUNNER_SHARE_DOCKER_LABEL,
	fleetActionsRunnerModesFor,
	fleetActionsRunnerUpdateAvailable
} from '../fleet-actions-runners.types.js';

/** Actions runners on computers (FL-18 P3, T-27, T-28) — versions, the Docker mode rule, the labelled opt-in. */

describe('runner versions (FR-28)', () => {
	it('compares numerically, a non-version first', () => {
		expect(compareFleetActionsRunnerVersions('2.321.0', '2.320.9')).toBe(1);
		expect(compareFleetActionsRunnerVersions('2.9.0', '2.10.0')).toBe(-1);
		expect(compareFleetActionsRunnerVersions('2.321.0', '2.321.0')).toBe(0);
		expect(compareFleetActionsRunnerVersions(null, '2.0.0')).toBe(-1);
		expect(compareFleetActionsRunnerVersions('latest', null)).toBe(0);
	});

	it('names an update only when GitHub publishes a newer build (never a downgrade)', () => {
		expect(fleetActionsRunnerUpdateAvailable('2.320.0', '2.321.0')).toBe('2.321.0');
		expect(fleetActionsRunnerUpdateAvailable('2.321.0', '2.321.0')).toBeNull();
		expect(fleetActionsRunnerUpdateAvailable('2.322.0', '2.321.0')).toBeNull();
		expect(fleetActionsRunnerUpdateAvailable(null, '2.321.0')).toBeNull();
	});
});

describe('Docker-isolated mode (FR-27)', () => {
	it('is offered on Linux with the container capability only, never on Windows', () => {
		expect(FLEET_ACTIONS_RUNNER_DOCKER_CAPABILITY).toBe('actions-runner-docker');
		expect(
			fleetActionsRunnerModesFor({ os: 'linux', hasServiceManager: true, hasDocker: true, dockerShipped: true })
		).toEqual(['service', 'docker']);
		expect(
			fleetActionsRunnerModesFor({ os: 'win32', hasServiceManager: true, hasDocker: true, dockerShipped: true })
		).toEqual(['service']);
		expect(
			fleetActionsRunnerModesFor({ os: 'linux', hasServiceManager: true, hasDocker: false, dockerShipped: true })
		).toEqual(['service']);
	});

	it('labels the Docker daemon opt-in as what it is', () => {
		expect(FLEET_ACTIONS_RUNNER_SHARE_DOCKER_LABEL).toBe('Share the Docker daemon (runs as root)');
	});
});
