import type { AppRunInstructionFileRefusal } from './app-run-brief';

/**
 * APW-08 T18 — the port both run paths ask for an App Work run's brief: `AgentRunService` (cloud)
 * and the fleet planner's `composeInstructions`. Bound by the API's `@Global()` `AgentsModule` to
 * `AppRunBriefService`; unbound, every run is briefed exactly as before.
 *
 * 🛑 A leaf on purpose (a Symbol and type-only imports): `AgentRunService` reads the token in a
 * parameter decorator, so the token must exist when that class is defined — importing it from the
 * service file would pull the rules and App spec services into the agents module's require graph.
 */
export const APP_RUN_BRIEF_SOURCE = Symbol('APP_RUN_BRIEF_SOURCE');

export interface AppRunBrief {
    /** Platform text: the rules at the base commit, or the "could not be read" notice. */
    readonly rules: string;
    /** Untrusted repository content, fenced; `null` when no instruction file was included. */
    readonly instructions: string | null;
    readonly branch: string;
    readonly baseSha: string | null;
    readonly includedFiles: readonly string[];
    readonly truncatedFiles: readonly string[];
    readonly refusedFiles: ReadonlyArray<{ path: string; reason: AppRunInstructionFileRefusal }>;
}

export interface AppRunBriefSource {
    /** The brief for a run of `taskId`, or `null` when the Task is not on an App Work. */
    forTask(input: { taskId: string; baseRef?: string | null }): Promise<AppRunBrief | null>;
}
