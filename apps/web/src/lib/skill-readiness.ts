import type {
    SkillCardState,
    SkillReadinessDetail,
    SkillRequirement,
    SkillRequirementKind,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';

/**
 * Skills shelf — the pure presentation rules shared by the shelf card, the
 * readiness badge and the detail panel, so the three can never disagree about
 * what a verdict is called or where its fix lives. Client-safe (no I/O).
 */

/** Translation key (under `dashboard.skillsPage.readiness`) for each card state's title. */
export const SKILL_CARD_STATE_TITLE_KEYS = {
    ready: 'readyTitle',
    needs_setup: 'needsSetupTitle',
    missing_requirements: 'missingTitle',
    blocked_by_access: 'blockedTitle',
    unknown: 'unknownTitle',
    disabled: 'disabledTitle',
    needs_review: 'reviewTitle',
} as const satisfies Record<SkillCardState, string>;

/** Translation key for each card state's one-line explanation. */
export const SKILL_CARD_STATE_BODY_KEYS = {
    ready: 'readyBody',
    needs_setup: 'needsSetupBody',
    missing_requirements: 'missingBody',
    blocked_by_access: 'blockedBody',
    unknown: 'unknownBody',
    disabled: 'disabledBody',
    needs_review: 'reviewBody',
} as const satisfies Record<SkillCardState, string>;

export const SKILL_REQUIREMENT_KIND_KEYS = {
    tool: 'kindTool',
    credential: 'kindCredential',
    connection: 'kindConnection',
    pluginSetting: 'kindPluginSetting',
} as const satisfies Record<SkillRequirementKind, string>;

/** Status copy keys under `dashboard.skillsPage.readiness`. */
export type SkillRequirementStatusKey =
    | 'statusMet'
    | 'statusMissing'
    | 'statusNotSet'
    | 'statusNotConnected'
    | 'statusDisabled'
    | 'statusRefused'
    | 'statusUnknown';

/** Translation key for a requirement's status: the specific reason when there is one. */
export function skillRequirementStatusKey(
    requirement: SkillRequirement,
): SkillRequirementStatusKey {
    switch (requirement.reason) {
        case 'notSet':
        case 'settingMissing':
            return 'statusNotSet';
        case 'notConnected':
        case 'pluginNotEnabled':
            return 'statusNotConnected';
        case 'disabled':
            return 'statusDisabled';
        case 'refusedByGrants':
            return 'statusRefused';
        case 'checkFailed':
            return 'statusUnknown';
        default:
            break;
    }
    switch (requirement.status) {
        case 'met':
            return 'statusMet';
        case 'refused':
            return 'statusRefused';
        case 'unknown':
            return 'statusUnknown';
        default:
            return 'statusMissing';
    }
}

/** Requirements that ask something of a person (everything but `met`). */
export function unmetSkillRequirements(
    detail: SkillReadinessDetail | null | undefined,
): SkillRequirement[] {
    return (detail?.requirements ?? []).filter((requirement) => requirement.status !== 'met');
}

/**
 * Where a person fixes a requirement, as an in-app route — or null when there
 * is no screen for it (credentials are set by an operator). Built from the
 * requirement's identifier only; never a URL a plugin supplied.
 */
export function skillRequirementFixHref(requirement: SkillRequirement): string | null {
    const target = requirement.fixTarget;
    if (!target) return null;
    switch (target.surface) {
        case 'connections':
            return ROUTES.DASHBOARD_SETTINGS_CONNECTIONS;
        case 'access':
            return target.ref ? ROUTES.DASHBOARD_AGENT_CAPABILITIES(target.ref) : null;
        case 'plugins':
            return target.ref ? ROUTES.DASHBOARD_PLUGIN_DETAIL(target.ref) : null;
        default:
            return null;
    }
}

/** Translation key for the fix link's label. */
export function skillRequirementFixLabelKey(
    requirement: SkillRequirement,
): 'fixReviewAccess' | 'fixConnect' {
    return requirement.fixTarget?.surface === 'access' ? 'fixReviewAccess' : 'fixConnect';
}
