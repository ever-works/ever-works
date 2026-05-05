import type { DeploymentStatus } from '@ever-works/plugin';

/**
 * Minimal subset of `V1Deployment.status` we need to map rollout state
 * onto our DeploymentStatus union without depending on full client-node
 * types in callers.
 */
export interface DeploymentStatusInput {
	conditions?: Array<{ type?: string; status?: string; reason?: string }>;
	replicas?: number;
	readyReplicas?: number;
	updatedReplicas?: number;
	availableReplicas?: number;
	observedGeneration?: number;
	generation?: number;
}

/**
 * Map a Deployment's status to our generic DeploymentStatus.
 *
 * Mapping table:
 * - `Available=True`                      → 'ready'
 * - `Progressing=True, ReplicaFailure≠True` → 'deploying'
 * - `ReplicaFailure=True`                  → 'error'
 * - everything else                       → 'pending'
 */
export function mapDeploymentToStatus(
	deployment: { status?: DeploymentStatusInput } | null | undefined
): DeploymentStatus {
	const status = deployment?.status;
	if (!status) return 'pending';

	const conditions = status.conditions ?? [];
	const cond = (type: string) => conditions.find((c) => c.type === type)?.status?.toLowerCase();

	if (cond('Available') === 'true') return 'ready';
	if (cond('ReplicaFailure') === 'true') return 'error';
	if (cond('Progressing') === 'true') return 'deploying';

	if ((status.replicas ?? 0) === 0) return 'pending';
	return 'deploying';
}

/**
 * True if the rollout is complete and all desired pods are available.
 */
export function isRolloutComplete(deployment: { status?: DeploymentStatusInput }): boolean {
	const s = deployment.status;
	if (!s) return false;
	if ((s.observedGeneration ?? 0) < (s.generation ?? 0)) return false;
	return (s.availableReplicas ?? 0) >= (s.replicas ?? 0) && (s.replicas ?? 0) > 0;
}
