import { BadRequestException } from '@nestjs/common';
import { isAppWorkKind } from '@ever-works/contracts';

import type { WorkKindSubject } from './repository-work-guard';

/**
 * APW-01 T9 (lane aw-safety, 2026-10-26) — the App Work guard, the sibling of
 * `assertNotRepositoryWork` (`repository-work-guard.ts`, which this file leaves untouched).
 *
 * An App Work's repository is application code — a fork, a private copy, or a repository the
 * member linked — never a directory the platform generates. Every content pipeline that clones the
 * Work's data repository and commits into it (item submission and health checks, generation,
 * scheduled updates, comparisons, community pull-request intake, the data-repository sync) has
 * nothing to act on for the kind, and acting anyway would derive a `<slug>-data` name that belongs
 * to nobody, or write generated content into the member's own code. The web hides those surfaces
 * (`WORK_KIND_CAPABILITIES.app`); this is the API boundary catching a direct call, an MCP tool, a
 * schedule or an internal caller.
 *
 * Same message shape as the repository guard, so callers and specs match on one prefix.
 */

/** Stable prefix every refusal starts with (APW-01 T9). */
export const APP_WORK_REFUSAL = 'is an App Work';

function describeWork(work: WorkKindSubject): string {
    const label = work.name || work.slug;
    return label ? `Work "${label}"` : 'This Work';
}

/** True when the Work is an App Work (`kind: 'app'`). */
export function isAppWork(work: WorkKindSubject | null | undefined): boolean {
    return isAppWorkKind(work?.kind);
}

/**
 * Refuse a content-pipeline operation on an App Work. `action` names what was attempted ("item
 * submission", "comparison generation", …) so the 400 says what was refused and why.
 */
export function assertNotAppWork(work: WorkKindSubject, action: string): void {
    if (!isAppWork(work)) {
        return;
    }
    throw new BadRequestException(
        `${describeWork(work)} ${APP_WORK_REFUSAL} — ${action} is not available for it: ` +
            'its repository is application code, not a generated directory, and nothing is generated into it',
    );
}
