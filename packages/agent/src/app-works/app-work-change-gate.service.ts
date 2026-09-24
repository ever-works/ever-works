import { Injectable, Logger } from '@nestjs/common';
import type { AppSpec } from '@ever-works/contracts';
import type { GitDiffResult } from '@ever-works/plugin';

import { AppSpecService } from '../app-spec/app-spec.service';
import { GitFacadeService } from '../facades/git.facade';
import type {
    AppWorkChangeGate,
    AppWorkChangeGateInput,
    AppWorkChangeGateVerdict,
} from '../tasks-domain/app-work-change-gate.port';
import { APP_SPEC_PATH, AppChangeGuard, MAX_FILES } from './app-change-guard';
import { AppWorkRulesService } from './app-work-rules.service';

/**
 * APW-08 T17 — the change gate the shared finalize path asks through
 * `APP_WORK_CHANGE_GATE`.
 *
 * It assembles the guard's inputs and answers a verdict; the guard itself
 * (`app-change-guard.ts`) stays pure. What lives here is every read the guard
 * needs, and the decision about what each read failing MEANS.
 *
 * ## The rules commit is resolved here, server-side
 *
 * `AppWorkRulesService.resolve(work, sha)` reads the App spec at a base commit,
 * and that commit is the security property: the rules an agent is judged by
 * must be ones it did not write. This service resolves it as the tip of
 * `baseRef` at the moment of judging, through the platform's own git facade.
 *
 * It is NOT taken from the finalize input. On the fleet path that value is
 * `result.git.baseSha`, reported by the fleet node — the machine the agent ran
 * on — so a run could name a commit whose spec it had loosened and be judged by
 * it. The port has no field for a caller to supply one.
 *
 * Rules at the base tip are also the rules the pull request would merge into,
 * which is the question a member is actually asking.
 *
 * ## Never throws
 *
 * Every read is inside one `try`, and anything that throws becomes a refusal
 * that says the rules could not be read. A run whose protected paths are
 * unknown is a run with no protected paths, so failing CLOSED is the only safe
 * answer — and failing by exception would escape the finalize path after the
 * branch was pushed, leaving a Task with no pull request, no message and no
 * transition.
 *
 * ## Reading the branch's `.works/works.yml`, three ways
 *
 *   - **not in the diff** → not read, and the guard's rule 4 does not apply
 *     (`headSpec` stays `undefined`, which the guard reads as "not read");
 *   - **deleted or renamed away** → `headSpec: null`, which rule 4 refuses: a
 *     Work that can no longer describe itself must not become a pull request;
 *   - **in the diff but unreadable** → a REFUSAL that says so. The first wiring
 *     treated every `null` read as "deleted", but `getFileContent` answers
 *     `null` for a provider that cannot read the file as well as for one that
 *     found nothing, and calling that "your change deleted the spec" would send
 *     the member looking for a deletion that never happened.
 *
 * The parse goes through `AppSpecService.parseDraft`, whose `spec` is non-null
 * only for a document with zero errors — so a head spec with errors reaches the
 * guard as `null` and is refused by rule 4, which is the contract both epics
 * already agree on.
 */
@Injectable()
export class AppWorkChangeGateService implements AppWorkChangeGate {
    private readonly logger = new Logger(AppWorkChangeGateService.name);

    constructor(
        private readonly rules: AppWorkRulesService,
        private readonly guard: AppChangeGuard,
        private readonly specs: AppSpecService,
        private readonly git: GitFacadeService,
    ) {}

    async evaluate(input: AppWorkChangeGateInput): Promise<AppWorkChangeGateVerdict> {
        try {
            const baseSha = await this.baseTip(input);
            if (!baseSha) {
                return refusal(
                    `The base commit on \`${input.baseRef}\` could not be read, so this Work's ` +
                        'protected paths are unknown.',
                );
            }

            const rules = await this.rules.resolve(input.work, baseSha);
            const diff = await this.git.getCompareDiff(
                input.owner,
                input.repo,
                input.baseRef,
                input.branch,
                { maxFiles: MAX_FILES },
                input.gitOptions,
            );

            const verdict = this.guard.evaluate({
                rules,
                diff,
                ...(await this.guardedSpecs(input, baseSha, diff)),
                labels: input.taskLabels,
            });

            if (verdict.allowed) return { allowed: true, note: verdict.note };
            return {
                allowed: false,
                message: verdict.message ?? 'This change was refused by the Work’s rules.',
                paths: verdict.paths,
            };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `App change gate for Work ${input.work.id} on ${input.branch} could not decide: ${reason}`,
            );
            return refusal(
                "This Work's rules could not be read, so the change was not checked against its " +
                    'protected paths.',
            );
        }
    }

    /**
     * The tip of `baseRef`, read by the platform. `null` when the provider
     * answers nothing — the caller turns that into the refusal it is.
     */
    private async baseTip(input: AppWorkChangeGateInput): Promise<string | null> {
        const commit = await this.git.getLatestCommit(
            input.owner,
            input.repo,
            input.baseRef,
            input.gitOptions,
        );
        const sha = typeof commit?.sha === 'string' ? commit.sha.trim() : '';
        return sha.length > 0 ? sha : null;
    }

    /** Rule 4's two documents — see the class docstring for the three cases. */
    private async guardedSpecs(
        input: AppWorkChangeGateInput,
        baseSha: string,
        diff: GitDiffResult,
    ): Promise<{ baseSpec?: AppSpec | null; headSpec?: AppSpec | null }> {
        const entry = diff.files.find(
            (file) => file.path === APP_SPEC_PATH || file.previousPath === APP_SPEC_PATH,
        );
        if (!entry) return {};

        const base = await this.specs.getEffectiveSpec(input.work.id, baseSha);
        const baseSpec = base?.spec ?? null;

        const removed =
            entry.status === 'removed' ||
            (entry.previousPath === APP_SPEC_PATH && entry.path !== APP_SPEC_PATH);
        if (removed) return { baseSpec, headSpec: null };

        const file = await this.git.getFileContent(
            input.owner,
            input.repo,
            APP_SPEC_PATH,
            input.gitOptions,
            input.branch,
        );
        if (!file || typeof file.content !== 'string' || file.content.length === 0) {
            // In the diff, not deleted, and still unreadable: say so. Caught by
            // `evaluate` and answered as "the rules could not be read".
            throw new Error(`${APP_SPEC_PATH} on ${input.branch} could not be read`);
        }

        const head = await this.specs.parseDraft(input.work.id, file.content);
        return { baseSpec, headSpec: head.spec };
    }
}

function refusal(message: string): AppWorkChangeGateVerdict {
    return { allowed: false, message, paths: [] };
}
