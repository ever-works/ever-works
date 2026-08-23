import type { GenerateStatusType } from './generate-status.enum.js';

export type WorkCurrentState = 'running' | 'paused' | 'idle';

export type WorkDeploymentReadiness = 'ready' | 'pending' | 'unknown' | 'not_deployed';

export type WorkDeploymentHealthSource = 'deployment_projection' | 'none';

export interface WorkLastGenerationRunDto {
	status: GenerateStatusType;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface WorkLastDeploymentRunDto {
	status: string;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface WorkLastRunDto {
	generation: WorkLastGenerationRunDto | null;
	deployment: WorkLastDeploymentRunDto | null;
}

export interface WorkCurrentDeploymentHealthDto {
	readiness: WorkDeploymentReadiness;
	source: WorkDeploymentHealthSource;
	/** Null for legacy projections because they pre-date persisted probe timestamps. */
	observedAt: string | null;
}

export interface WorkCurrentHealthDto {
	state: WorkCurrentState;
	deployment: WorkCurrentDeploymentHealthDto;
}

export interface WorkStatusProjectionDto {
	lastRun: WorkLastRunDto;
	currentHealth: WorkCurrentHealthDto;
}
