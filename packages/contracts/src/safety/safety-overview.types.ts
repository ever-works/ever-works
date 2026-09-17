import type { ResolvedLadder } from './autonomy-grant.types.js';
import type { RailRefusalCountsDto } from './rail-refusal.types.js';
import type { WorkspacePauseState } from './workspace-pause.types.js';

/**
 * Safety rails (AW-24) — what one read of the Safety screen returns.
 *
 * The screen has four panels and each must load and fail INDEPENDENTLY
 * (FR-73): a failed refusal query may not blank the ladder, and a ladder that
 * could not be read may not hide the pause control. This DTO is therefore
 * assembled from settled reads, and every panel carries its own `error` flag
 * rather than the whole response failing.
 *
 * The five guarantees are not in here on purpose. They are copy, they are the
 * same five for every workspace, and they belong in the message catalogue
 * where they can be translated — not in a payload the server has to version.
 */

/** A panel that was read, or the reason it was not. */
export interface SafetyPanel<T> {
	/** `null` when `error` is true. */
	data: T | null;
	error: boolean;
}

/** One read of `/api/safety/overview`. */
export interface SafetyOverviewDto {
	pause: SafetyPanel<WorkspacePauseState>;
	ladder: SafetyPanel<ResolvedLadder>;
	refusalCounts: SafetyPanel<RailRefusalCountsDto>;
	/**
	 * True when the rungs could not be read and every laddered category is
	 * being treated as **Ask** (FR-18). Drives the safe-mode banner.
	 */
	safeMode: boolean;
	/** Whether the caller may change anything here (FR-39, FR-77). */
	canEdit: boolean;
}
