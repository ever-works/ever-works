import { describe, it, expect } from 'vitest';
import { isRolloutComplete, mapDeploymentToStatus } from '../status.mapper';

describe('mapDeploymentToStatus', () => {
	it('returns pending when deployment is null/undefined or has no status', () => {
		expect(mapDeploymentToStatus(null)).toBe('pending');
		expect(mapDeploymentToStatus(undefined)).toBe('pending');
		expect(mapDeploymentToStatus({})).toBe('pending');
	});

	it('returns ready when Available=True', () => {
		expect(
			mapDeploymentToStatus({
				status: { conditions: [{ type: 'Available', status: 'True' }] },
			}),
		).toBe('ready');
	});

	it('returns error when ReplicaFailure=True', () => {
		expect(
			mapDeploymentToStatus({
				status: {
					conditions: [
						{ type: 'Available', status: 'False' },
						{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate' },
					],
				},
			}),
		).toBe('error');
	});

	it('returns deploying when Progressing=True without Available', () => {
		expect(
			mapDeploymentToStatus({
				status: {
					conditions: [{ type: 'Progressing', status: 'True', reason: 'NewReplicaSetCreated' }],
				},
			}),
		).toBe('deploying');
	});

	it('returns pending when no conditions and zero replicas', () => {
		expect(mapDeploymentToStatus({ status: { replicas: 0 } })).toBe('pending');
	});

	it('returns deploying when replicas > 0 but no conditions', () => {
		expect(mapDeploymentToStatus({ status: { replicas: 1 } })).toBe('deploying');
	});
});

describe('isRolloutComplete', () => {
	it('is false when no status', () => {
		expect(isRolloutComplete({})).toBe(false);
	});

	it('is false when observedGeneration < generation', () => {
		expect(
			isRolloutComplete({
				status: { observedGeneration: 1, generation: 2, replicas: 1, availableReplicas: 1 },
			}),
		).toBe(false);
	});

	it('is true when all desired replicas are available', () => {
		expect(
			isRolloutComplete({
				status: { observedGeneration: 2, generation: 2, replicas: 2, availableReplicas: 2 },
			}),
		).toBe(true);
	});

	it('is false when replicas is zero', () => {
		expect(
			isRolloutComplete({
				status: { observedGeneration: 2, generation: 2, replicas: 0, availableReplicas: 0 },
			}),
		).toBe(false);
	});
});
