import type {
    SkillCardState,
    SkillReadinessDetail,
    SkillReadinessState,
} from '@ever-works/contracts';
import { browserApiFetch } from '@/lib/api/browser-api';

/**
 * Skills shelf — browser calls for the two interactions that must feel
 * instant (the on/off toggle and Re-check). They go through the thin BFF
 * routes under `/api/skills/:id/…`, which carry the session and workspace
 * scope; the per-tab selector is added by `browserApiFetch`.
 */

export interface SkillSwitchResponse {
    id: string;
    cardState: SkillCardState;
    readiness: SkillReadinessState;
    disabledAt: string | null;
    changed: boolean;
}

export interface SkillReadinessResponse {
    id: string;
    readiness: SkillReadinessState;
    readinessDetail: SkillReadinessDetail | null;
    readinessCheckedAt: string | null;
    cardState: SkillCardState;
    stale?: boolean;
}

async function post<T>(url: string): Promise<T> {
    const response = await browserApiFetch(url, { method: 'POST' });
    if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
    }
    return (await response.json()) as T;
}

/** Switch a Skill on or off. Idempotent server-side. */
export function setSkillEnabled(id: string, on: boolean): Promise<SkillSwitchResponse> {
    return post<SkillSwitchResponse>(
        `/api/skills/${encodeURIComponent(id)}/${on ? 'enable' : 'disable'}`,
    );
}

/** Re-check a Skill's readiness now. */
export function refreshSkillReadiness(id: string): Promise<SkillReadinessResponse> {
    return post<SkillReadinessResponse>(`/api/skills/${encodeURIComponent(id)}/readiness`);
}
