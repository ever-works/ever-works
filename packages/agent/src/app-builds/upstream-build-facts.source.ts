import { Injectable, Logger } from '@nestjs/common';

import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import type { BuildRepositoryFactsSource } from './build-facade.service';

/**
 * APW-05 T16 — the repository facts `BuildFacadeService` cannot guess.
 *
 * Two facts decide real things about a Build, and neither is a `Work` column:
 *
 *  - **`createdByAppWork`** decides whether a workflow change may be pushed
 *    straight to the branch or has to go through a pull request (R-4, plan §4.6
 *    step 7). The truth is APW-02's `WorkUpstreamState.relation`: `fork` and
 *    `private-copy` are repositories the App Work created, `link` is one it did
 *    not, and a linked repository is not ours to write into whatever its branch
 *    protection says.
 *  - **`visibility`** selects the runner class and decides whether a pull token
 *    is needed (plan §4.4, §4.12).
 *
 * ## `visibility` is `private` here, always, and that is not a placeholder
 *
 * `WorkUpstreamState` records the App Work's upstream and fork coordinates; it
 * records no repository visibility, and neither does `Work`. Rather than infer
 * one from the relation — `private-copy` sounds private and need not be; a fork
 * of a public repository is public but may later be made private — this source
 * reports the SAFE answer and says so.
 *
 * Safe means `private`: a private repository routed to a public runner is the
 * failure that matters, and a public one routed to the private runner is only
 * slower. When APW-02 records the provider's visibility (or a caller passes it
 * through `checkImageAccess`), this is the one method that changes.
 *
 * ## A Work with no upstream row gets the safe answer too
 *
 * `null` from the repository means the App Work has no upstream state yet —
 * during creation, or for a Work that was never an App Work. Reporting
 * `createdByAppWork: true` there would let a Build push a workflow commit into a
 * repository whose provenance nobody has recorded.
 */
@Injectable()
export class UpstreamBuildFactsSource implements BuildRepositoryFactsSource {
    private readonly logger = new Logger(UpstreamBuildFactsSource.name);

    constructor(private readonly upstreamStates: WorkUpstreamStateRepository) {}

    async getBuildRepositoryFacts(input: { readonly workId: string }): Promise<{
        readonly visibility: 'public' | 'private';
        readonly createdByAppWork: boolean;
    } | null> {
        try {
            const state = await this.upstreamStates.findByWorkId(input.workId);
            if (!state) {
                this.logger.debug(
                    `Build repository facts for work ${input.workId}: no upstream state row yet; taking the safe answer.`,
                );
                return { visibility: 'private', createdByAppWork: false };
            }

            return {
                // See the class docstring: no column records this yet, and the
                // safe answer is the private runner.
                visibility: 'private',
                // `fork` and `private-copy` were created BY the App Work; `link`
                // was not (APW-02 `APP_REPOSITORY_MODES`).
                createdByAppWork: state.relation === 'fork' || state.relation === 'private-copy',
            };
        } catch (error) {
            this.logger.warn(
                `Build repository facts for work ${input.workId}: the upstream state read failed (${
                    error instanceof Error ? error.message : String(error)
                }); taking the safe answer.`,
            );
            return { visibility: 'private', createdByAppWork: false };
        }
    }
}
