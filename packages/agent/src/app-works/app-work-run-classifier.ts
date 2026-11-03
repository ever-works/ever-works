import { Logger } from '@nestjs/common';
import { isAppWorkKind } from '@ever-works/contracts';

import { appWorkTaskToolPolicyApplies } from './app-work-task-tool-policy';

/**
 * APW-08 T47 (FR-69) — "is this run an App Work run?", answered from platform rows only.
 *
 * `AgentRunService` asks this once per run, before it resolves the run's tools, and hands the
 * answer to `AgentToolService` as run context (never as anything the model can set). The API
 * binds the token in its `@Global()` `AgentsModule` over the Task and Work repositories, so the
 * agent-side `@Optional()` injection resolves in production; unbound (a unit test, a runtime
 * without the Task tables), no run is classified and nothing changes.
 *
 * **Fail closed.** A row that cannot be read is not proof the run is NOT an App Work run, so a
 * read that throws, a Task id that resolves to nothing, or a Work id that resolves to nothing
 * answers `true`: the run then gets the App Work tool list, which can only be smaller.
 */
export const APP_WORK_RUN_CLASSIFIER = Symbol('APP_WORK_RUN_CLASSIFIER');

export interface AppWorkRunSubject {
    /** The Task the run executes (`AgentRunContext.taskId`), when it has one. */
    taskId?: string | null;
    /** The Agent's own scope Work (`agents.workId`), when it is Work-scoped. */
    agentWorkId?: string | null;
    /** The run replies to a Conversation message the Agent's owner sent (see `AgentRunService`). */
    ownerConversationTurn?: boolean;
}

export interface AppWorkRunClassifier {
    appliesTo(subject: AppWorkRunSubject): Promise<boolean>;
    /**
     * APW-08 T43 — the App Work the run works on (the Task's when that is one, else the Agent's
     * own), for telemetry; `null` when neither is one or a read fails. Never throws. Optional,
     * so a classifier double without it simply reports nothing.
     */
    appWorkIdOf?(subject: AppWorkRunSubject): Promise<string | null>;
}

/** The two reads the classifier needs — structural, so a spec passes plain doubles. */
export interface AppWorkRunClassifierReads {
    tasks: { findById(id: string): Promise<{ workId?: string | null } | null> };
    works: { findById(id: string): Promise<{ kind?: string | null } | null> };
}

export class AppWorkRunClassifierService implements AppWorkRunClassifier {
    private readonly logger = new Logger(AppWorkRunClassifierService.name);

    constructor(private readonly reads: AppWorkRunClassifierReads) {}

    async appliesTo(subject: AppWorkRunSubject): Promise<boolean> {
        try {
            let taskWorkKind: string | null = null;
            const taskId = subject.taskId?.trim();
            if (taskId) {
                const task = await this.reads.tasks.findById(taskId);
                if (!task) return this.failClosed(`Task ${taskId} could not be found`);
                if (task.workId) {
                    const work = await this.reads.works.findById(task.workId);
                    if (!work)
                        return this.failClosed(`the Work of Task ${taskId} could not be found`);
                    taskWorkKind = work.kind ?? null;
                }
            }
            let agentWorkKind: string | null = null;
            const agentWorkId = subject.agentWorkId?.trim();
            if (agentWorkId) {
                const work = await this.reads.works.findById(agentWorkId);
                if (!work)
                    return this.failClosed(`the Agent's Work ${agentWorkId} could not be found`);
                agentWorkKind = work.kind ?? null;
            }
            return appWorkTaskToolPolicyApplies({
                taskWorkKind,
                agentWorkKind,
                ownerConversationTurn: subject.ownerConversationTurn === true,
            });
        } catch (err) {
            return this.failClosed(err instanceof Error ? err.message : String(err));
        }
    }

    async appWorkIdOf(subject: AppWorkRunSubject): Promise<string | null> {
        try {
            const taskId = subject.taskId?.trim();
            if (taskId) {
                const task = await this.reads.tasks.findById(taskId);
                if (task?.workId) {
                    const work = await this.reads.works.findById(task.workId);
                    if (work && isAppWorkKind(work.kind)) return task.workId;
                }
            }
            const agentWorkId = subject.agentWorkId?.trim();
            if (agentWorkId) {
                const work = await this.reads.works.findById(agentWorkId);
                if (work && isAppWorkKind(work.kind)) return agentWorkId;
            }
            return null;
        } catch {
            return null;
        }
    }

    private failClosed(reason: string): true {
        this.logger.warn(
            `App Work run classification could not read its rows (${reason}) — applying the App Work Task tool policy (fail closed).`,
        );
        return true;
    }
}
