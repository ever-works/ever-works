/**
 * AW-20 — the first-hour vocabulary: what a new owner still has to do,
 * and what happened the last time we set their agents up.
 *
 * The milestone enum lands with P1 because the provisioning record it
 * sits beside is written by P1's roster run; the checklist surfaces that
 * read these milestones are P2. Nothing here is persisted twice: the
 * provisioning record is one JSON column on the checklist row.
 */

import type { RosterBlueprintSlug, RosterLaneKey } from './roster.js';

/**
 * The five first-hour milestones, in the order they are shown (FR-34).
 * Order is part of the contract — the card renders this array.
 */
export const ONBOARDING_MILESTONES = [
	'connectProvider',
	'meetAgents',
	'shipTask',
	'resolveDecision',
	'scheduleJob'
] as const;

export type OnboardingMilestoneKey = (typeof ONBOARDING_MILESTONES)[number];

/** `pending → done` is one-way; `pending ⇄ skipped` is reversible (FR-35, FR-40). */
export const MILESTONE_STATUSES = ['pending', 'done', 'skipped'] as const;

export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/**
 * One milestone's state. A milestone is never marked done on the
 * client's word (FR-36): `evidenceKind` / `evidenceId` record which
 * platform fact satisfied it, so "how do I know this is true?" has an
 * answer that is not "the browser said so".
 */
export interface MilestoneRecord {
	readonly status: MilestoneStatus;
	readonly completedAt?: string | null;
	/** What satisfied it: 'connection' | 'roster' | 'run' | 'approval' | 'escalation' | 'schedule'. */
	readonly evidenceKind?: string | null;
	/** Opaque id of the satisfying object. Never rendered; used for the "what completed it" line. */
	readonly evidenceId?: string | null;
	/**
	 * FR-59 degradation flag. True when this milestone's completion fact
	 * could not be read on the last evaluation. The milestone stays
	 * `pending` and the row renders a quiet "couldn't check" marker —
	 * an unreadable fact must never be allowed to look like a done one,
	 * and must never fail the whole checklist.
	 */
	readonly unknown?: boolean;
}

/**
 * Provisioning run states (FR-10). There is no other state: a record
 * that is not one of these is a bug, not a new case to handle.
 */
export const ROSTER_PROVISION_STATES = ['idle', 'queued', 'creating', 'binding', 'ready', 'partial', 'failed'] as const;

export type RosterProvisionState = (typeof ROSTER_PROVISION_STATES)[number];

/**
 * What happened to one lane (FR-11). `reused` is a success: the point of
 * idempotent provisioning is that a second run fills gaps rather than
 * creating a second "Research".
 */
export const LANE_OUTCOMES = ['pending', 'created', 'reused', 'skippedNoSeat', 'failed'] as const;

export type LaneOutcome = (typeof LANE_OUTCOMES)[number];

/** Why one lane failed. Closed vocabulary — the UI maps each to its own copy. */
export const LANE_FAILURE_REASONS = ['nameUnavailable', 'noSeat', 'permissionDenied', 'timedOut', 'unknown'] as const;

export type LaneFailureReason = (typeof LANE_FAILURE_REASONS)[number];

/** One lane's outcome inside a provisioning run. */
export interface RosterLaneResult {
	readonly laneKey: RosterLaneKey;
	readonly templateSlug: string;
	readonly requestedName: string;
	readonly outcome: LaneOutcome;
	readonly agentId?: string | null;
	/** Set when a numeric suffix was needed to find a free name (FR-18). */
	readonly finalName?: string | null;
	readonly failureReason?: LaneFailureReason | null;
	/** Skills that could not be attached (FR-23). A warning, never a failure. */
	readonly skillWarnings?: readonly string[];
}

/**
 * The current or last roster provisioning attempt. Persisted as one JSON
 * object on the checklist row rather than its own table: it is bounded,
 * one-to-one with a row that already exists, written only by
 * provisioning and read only in the moments around it.
 */
export interface RosterProvisionRecord {
	readonly runId: string;
	readonly blueprintSlug: RosterBlueprintSlug;
	readonly state: RosterProvisionState;
	readonly startedAt: string;
	readonly finishedAt?: string | null;
	readonly lanes: readonly RosterLaneResult[];
}
