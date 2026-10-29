import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isAppWorkKind } from '@ever-works/contracts';
import { WorkRepository } from '../database/repositories/work.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { TASK_THREAD_POSTER, type TaskThreadPoster } from './task-thread-poster.port';
import { renderTaskThreadPost } from './task-thread-posts';
import type { TaskLifecyclePostInput, TaskLifecyclePoster } from './task-lifecycle-poster.port';

/**
 * APW-08 T26 / T54 (FR-43) — the run-side Task-thread posts of an App Work change (**Run
 * started.**, **Opened pull request #{number}.**, **Checks passed.** / **Checks failed:
 * {names}.**), bound to `TASK_LIFECYCLE_POSTER`. The hooks decide that an event happened
 * (`task-lifecycle-posts.ts`); this decides whether the Task gets a post and who speaks:
 *
 *  - **App Work Tasks only** — the Task's Work must be `kind: 'app'`. No Work, an unreadable
 *    Work or any other kind: nothing is posted, so no other Task's thread changes.
 *  - **Author** — the run's Agent (`agentId`, else the Agent of `runId`), else the Task's Agent,
 *    else `system` with no author id (thread-only, see `TaskChatService.post`). The same rule
 *    `TaskDeliveryService.postThread` applies to the chain's later posts.
 *  - **Keyed** — `messageKey` / `messageParams` for the reader's locale, the English in `body`.
 *  - **Best-effort** — every failure is logged and answered `false`; nothing is thrown.
 */
@Injectable()
export class TaskLifecyclePostsService implements TaskLifecyclePoster {
    private readonly logger = new Logger(TaskLifecyclePostsService.name);

    constructor(
        private readonly works: WorkRepository,
        private readonly runs: AgentRunRepository,
        // The ordinary chat service, bound to the token in `TasksDomainModule`. Absent = nothing
        // is posted (a reduced graph behaves exactly as before the lane).
        @Optional()
        @Inject(TASK_THREAD_POSTER)
        private readonly chat?: TaskThreadPoster,
    ) {}

    async post(input: TaskLifecyclePostInput): Promise<boolean> {
        if (!this.chat) return false;
        const { task, post } = input;
        try {
            if (!(await this.isAppWork(input))) return false;
            const agentId = await this.authorOf(input);
            await this.chat.post(task.userId, {
                taskId: task.id,
                authorType: agentId ? 'agent' : 'system',
                authorId: agentId,
                body: renderTaskThreadPost(post),
                messageKey: post.key,
                messageParams: post.params ?? null,
            });
            return true;
        } catch (error) {
            this.logger.warn(
                `Task ${task.id}: the ${post.key} thread post could not be written (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
            return false;
        }
    }

    private async isAppWork(input: TaskLifecyclePostInput): Promise<boolean> {
        if (input.workKind !== undefined) return isAppWorkKind(input.workKind);
        const workId = (input.task.workId ?? '').trim();
        if (!workId) return false;
        const work = await this.works.findById(workId);
        return Boolean(work) && isAppWorkKind(work?.kind ?? null);
    }

    /** The run's Agent, else the Task's Agent, else `null` (a `system` post). */
    private async authorOf(input: TaskLifecyclePostInput): Promise<string | null> {
        const explicit = (input.agentId ?? '').trim();
        if (explicit) return explicit;
        const runId = (input.runId ?? '').trim();
        if (runId) {
            const run = await this.runs.findById(runId).catch(() => null);
            const runAgent = (run?.agentId ?? '').trim();
            if (runAgent) return runAgent;
        }
        return (input.task.agentId ?? '').trim() || null;
    }
}
