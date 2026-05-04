import type { OnboardingStatus } from './onboarding-status.js';

export type RegisterWorkStatus = OnboardingStatus;

export interface RegisterWorkResponse {
	onboardingId: string;
	workId: string;
	status: RegisterWorkStatus;
	statusUrl: string;
	subdomain: string;
	deploymentUrl?: string;
	warnings?: ReadonlyArray<string>;
}

export type RegisterWorkErrorCode =
	| 'validation_error'
	| 'gh_repo_access_denied'
	| 'gh_credential_invalid'
	| 'gh_insufficient_scope_for_repo_creation'
	| 'manifest_missing'
	| 'manifest_invalid'
	| 'unsupported_capability'
	| 'repo_already_owned'
	| 'subdomain_taken'
	| 'rate_limited'
	| 'internal_error';

export interface ManifestValidationError {
	path: string;
	message: string;
	subcode?: string;
}

export interface RegisterWorkErrorBody {
	statusCode: number;
	code: RegisterWorkErrorCode;
	message: string;
	errors?: ReadonlyArray<ManifestValidationError>;
}
