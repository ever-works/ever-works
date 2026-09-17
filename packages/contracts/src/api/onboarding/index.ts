export type {
	RegisterWorkRequest,
	OnboardingRequestSource,
	OnboardingRequestSourceAwesomeReadme,
	OnboardingRequestSourceWebSearch,
	OnboardingRequestSourceDataRepo,
	OnboardingRequestSourceInline
} from './register-work.request.js';
export type {
	RegisterWorkResponse,
	RegisterWorkStatus,
	RegisterWorkErrorCode,
	RegisterWorkErrorBody,
	ManifestValidationError
} from './register-work.response.js';
export type { OnboardingStatus } from './onboarding-status.js';
export { ONBOARDING_TERMINAL_STATUSES, isTerminalOnboardingStatus } from './onboarding-status.js';
export type {
	WebhookEvent,
	WebhookEventTerminal,
	WebhookEventManifestChanged,
	WebhookEventDeployFailed
} from './webhook-event.js';
export type {
	WorksManifestV1,
	WorksManifestMetadata,
	WorksManifestSpec,
	WorksManifestOutput
} from './manifest.types.js';
export type {
	OnboardingAiChoice,
	OnboardingStorageChoice,
	OnboardingDbChoice,
	OnboardingDeployChoice,
	OnboardingDesktopChoice,
	OnboardingWizardStateV2,
	OnboardingStateResponse,
	OnboardingStatePatchRequest,
	OnboardingCatalogResponse,
	OnboardingCard,
	OnboardingCardBadge,
	OnboardingPluginCard,
	OnboardingProfile,
	OnboardingProfileOption,
	OnboardingRoleId,
	OnboardingTeamSizeId,
	OnboardingDesktopNextStep
} from './wizard-state.js';
export {
	ONBOARDING_DEFAULT_STATE,
	ROLE_OPTIONS,
	TEAM_SIZE_OPTIONS,
	ONBOARDING_DESKTOP_NEXT_STEPS,
	desktopNextStep
} from './wizard-state.js';
// AW-20 P1 — roster vocabulary (lane keys, blueprint slugs, the two caps).
export type { RosterLaneKey, RosterBlueprintSlug } from './roster.js';
export { ROSTER_LANE_KEYS, ROSTER_BLUEPRINT_SLUGS, ROSTER_MAX_LANES, ROSTER_NAME_MAX } from './roster.js';
// AW-20 — first-hour vocabulary. The milestone enum lands with P1
// because the provisioning record beside it is written by P1's roster
// run; the checklist surfaces that read the milestones are P2.
export type {
	OnboardingMilestoneKey,
	MilestoneStatus,
	MilestoneRecord,
	RosterProvisionState,
	LaneOutcome,
	LaneFailureReason,
	RosterLaneResult,
	RosterProvisionRecord
} from './first-hour.js';
export {
	ONBOARDING_MILESTONES,
	MILESTONE_STATUSES,
	ROSTER_PROVISION_STATES,
	LANE_OUTCOMES,
	LANE_FAILURE_REASONS
} from './first-hour.js';
export type {
	OnboardingSeedAgentSuggestion,
	OnboardingSeedSkillSuggestion,
	OnboardingSeedSuggestionsResponse,
	OnboardingSeedRequest,
	OnboardingSeedOutcome,
	OnboardingSeedResultEntry,
	OnboardingSeedResponse
} from './role-seeding.js';
