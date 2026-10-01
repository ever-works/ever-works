import { Injectable, Optional } from '@nestjs/common';
import { APP_BUILD_DEPLOYABLE_TRIGGERS } from '@ever-works/contracts';

import { AppBuildRepository } from '../database/repositories/app-build.repository';
import type { WorkBuild } from '../entities/work-build.entity';
import type {
    AppDeployBuildSnapshot,
    AppDeployBuildSource,
} from './app-deploy-preconditions.service';

/**
 * APW-06 §5.1 — `APP_DEPLOY_BUILD_SOURCE`, over APW-05's Build rows.
 *
 * Two reads, both narrow: the Build a Deployment names, and the Work's green
 * **deployable** Builds newest first. Unbound, §5.1 answered `no_green_build`
 * for every App Work whether or not it had one, so a Build that succeeded could
 * never be deployed.
 *
 * ## "Deployable" is APW-05's word, and it is asked TWICE
 *
 * Two independent conditions, and both are applied because they answer
 * different questions:
 *
 *   - `APP_BUILD_DEPLOYABLE_TRIGGERS` is `['push', 'manual']`
 *     (`packages/contracts/src/apps/builds.ts:55`) — which KINDS of Build may
 *     ever deploy. A `pull_request` or `verification` Build succeeded at some
 *     commit, and running it would be a preview, not a Deployment;
 *   - `WorkBuild.deployable` is APW-05's own verdict, recomputed at completion
 *     by `deployable-verdict.ts` (§5.1). It folds in the things a trigger cannot
 *     see: a confirmed digest, the secret check, the env fingerprints.
 *
 * Asking only the trigger would offer a Build whose digest was never confirmed;
 * asking only the verdict would trust a boolean recomputed by another epic on a
 * row this one does not own. Neither alone is the answer, so both are applied.
 *
 * `getBuild` applies NEITHER. It answers the Build the caller named, whatever
 * its trigger and verdict, because §5.1 has its own refusal for a Build that is
 * not applicable (`build_not_applicable`) and it has to be able to SEE the Build
 * to say so. A source that hid it would turn "you cannot deploy a PR build" into
 * "that build does not exist".
 *
 * ## `imageReference` is composed, because it is not a column
 *
 * APW-05 stores `imageRepository` and `imageDigest` separately, plus
 * `digestConfirmed`. The reference this file answers is the **digest-pinned**
 * one, `<repository>@sha256:<64 hex>`, and only when the digest was read back
 * from the registry — the entity says so at the column: *"only a confirmed
 * digest is ever deployable"*. An unconfirmed digest answers `null`, which §5.1
 * reports as `build_image_missing`: a tag can move, a digest cannot, and
 * deploying a reference nobody verified is how a Deployment runs an image its
 * Build never produced.
 *
 * ## Why a page and not an unbounded list
 *
 * `listDeployableBuilds` is read to answer two questions — "is there a green
 * Build at all?" and "is the newest one at the Work's head?" — and both are
 * decided by the first few rows. {@link DEPLOYABLE_PAGE_SIZE} bounds the read so
 * an App Work with a thousand Builds costs the same as one with five.
 *
 * ## `null` is "could not read", `[]` is "none"
 *
 * The port's own distinction, kept: no repository bound answers `null` and §5.1
 * reports that it could not tell. An empty array is a definite answer — this
 * Work has no green deployable Build — and refuses for that stated reason.
 */

/**
 * How many recent Builds the deployable read looks at.
 *
 * Twenty, because both questions it answers are decided by the newest rows and
 * a Work that has pushed twenty Builds since its last green one has a bigger
 * problem than this page size.
 */
export const DEPLOYABLE_PAGE_SIZE = 20;

/** APW-05's green status, as §5.1 compares it. */
const GREEN = 'succeeded';

@Injectable()
export class AppDeployBuildSourceAdapter implements AppDeployBuildSource {
    constructor(
        // `@Optional()` like every collaborator on this path: the module graph
        // must compile where there is no DataSource, and an absent repository is
        // a `null` the preconditions name rather than a boot failure.
        @Optional() private readonly builds?: AppBuildRepository,
    ) {}

    /** The Build the Deployment names — whatever its trigger. See the class docstring. */
    async getBuild(workId: string, buildId: string): Promise<AppDeployBuildSnapshot | null> {
        if (!this.builds) return null;

        const row = await this.builds.findByIdForWork(workId, buildId);
        return row ? toSnapshot(row) : null;
    }

    /** The Work's green, deployable Builds, newest first. */
    async listDeployableBuilds(workId: string): Promise<readonly AppDeployBuildSnapshot[] | null> {
        if (!this.builds) return null;

        const page = await this.builds.findPage(
            workId,
            { status: [GREEN], trigger: [...APP_BUILD_DEPLOYABLE_TRIGGERS] },
            1,
            DEPLOYABLE_PAGE_SIZE,
        );
        // APW-05's own verdict, on top of the trigger filter the query applied.
        // It is not a `findPage` filter, so it is applied here rather than by
        // widening a repository other callers share.
        return page.rows.filter((row) => row.deployable === true).map(toSnapshot);
    }
}

/**
 * One row, narrowed to the five fields §5.1 reads.
 *
 * Narrowed deliberately: handing the preconditions the whole `WorkBuild` would
 * let a later change start reading the provider run, the billing minutes or the
 * verification plan off a row it holds only to answer "is this green, and what
 * image did it push?".
 */
function toSnapshot(row: WorkBuild): AppDeployBuildSnapshot {
    return {
        id: row.id,
        commitSha: row.commitSha ?? '',
        status: row.status ?? '',
        trigger: row.trigger ?? null,
        imageReference: imageReferenceOf(row),
    };
}

/**
 * The digest-pinned image reference, or `null`.
 *
 * `null` for a missing repository, a missing digest, **or an unconfirmed one** —
 * see the class docstring on why the third is not an oversight.
 */
export function imageReferenceOf(row: {
    imageRepository?: string | null;
    imageDigest?: string | null;
    digestConfirmed?: boolean;
}): string | null {
    if (!row.imageRepository || !row.imageDigest) return null;
    if (row.digestConfirmed !== true) return null;
    return `${row.imageRepository}@${row.imageDigest}`;
}
