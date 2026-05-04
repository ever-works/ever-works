import type { OnboardingStatus } from './onboarding-status.js';

export type WebhookEvent =
	| WebhookEventTerminal
	| WebhookEventManifestChanged
	| WebhookEventDeployFailed;

export interface WebhookEventTerminal {
	event: 'onboarding.terminal';
	deliveryId: string;
	occurredAt: string;
	onboardingId: string;
	workId: string;
	status: Extract<OnboardingStatus, 'deployed' | 'failed' | 'rejected'>;
	subdomain: string;
	deploymentUrl?: string;
	failureCode?: string;
	failureMessage?: string;
}

export interface WebhookEventManifestChanged {
	event: 'work.regenerated';
	deliveryId: string;
	occurredAt: string;
	workId: string;
	commitSha: string;
}

export interface WebhookEventDeployFailed {
	event: 'work.deploy_failed';
	deliveryId: string;
	occurredAt: string;
	workId: string;
	failureCode: string;
	failureMessage: string;
}
