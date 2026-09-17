import type { Skill } from '@ever-works/agent/skills';
import type {
    SkillCardState,
    SkillProvenance,
    SkillReadinessDetail,
    SkillReadinessState,
} from '@ever-works/contracts';

/**
 * Skills shelf — one row of `GET /api/skills`. Every pre-existing Skill field
 * is kept exactly as it was; the shelf fields are added beside them.
 */
export type SkillShelfRowDto = Skill & {
    /** Normalised tags, alphabetical. */
    tags: string[];
    /** The one badge the card shows: the stored verdict widened by the two switches. */
    cardState: SkillCardState;
    provenance: SkillProvenance;
    /** Bindings the Skill has (any target, muted or not). */
    boundTargetCount: number;
};

/** `GET /api/skills/tags`. */
export interface SkillTagFacetsDto {
    tags: Array<{ tag: string; count: number }>;
    /** Distinct tags before the cap. */
    total: number;
}

/** `GET /api/skills/:id/readiness` and `POST /api/skills/:id/readiness/refresh`. */
export interface SkillReadinessDto {
    id: string;
    readiness: SkillReadinessState;
    readinessDetail: SkillReadinessDetail | null;
    readinessCheckedAt: Date | null;
    cardState: SkillCardState;
    /**
     * `true` when a re-check did not finish inside its budget: the previous
     * verdict is returned and the card reads "Couldn't check" until the
     * re-check (which keeps running) lands.
     */
    stale?: boolean;
}

/** `POST /api/skills/:id/enable` and `POST /api/skills/:id/disable`. */
export interface SkillSwitchDto {
    id: string;
    cardState: SkillCardState;
    readiness: SkillReadinessState;
    disabledAt: Date | null;
    /** False when the Skill was already in the requested state. */
    changed: boolean;
}
