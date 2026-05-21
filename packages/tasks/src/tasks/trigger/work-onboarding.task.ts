import { task, logger } from '@trigger.dev/sdk';

/**
 * Trigger.dev task that runs the post-registration steps of the agent
 * zero-friction onboarding flow.
 *
 * The api-side `OnboardingService.handle` already performs:
 *   1. GitHub credential validation against the manifest repo.
 *   2. Better Auth account upsert (T9b).
 *   3. WorkLifecycleService.createWork via OnboardingWorkAdapter (T9c).
 *
 * That leaves the long-running portion — the actual content generation,
 * website deployment, and terminal-status fan-out — to this task. We
 * wrap the existing `work-generation.task` / `work-import.task`
 * orchestrators so we benefit from their built-in retry semantics,
 * pipeline observability, and Trigger.dev cancellation support.
 *
 * Wiring is left thin on purpose: the api enqueues this task with the
 * onboarding row id; the task hands off to the existing work-import
 * orchestrator using the workId already attached to the row by T9c. If
 * the row is in `failed` status (work creation failed earlier) the task
 * exits early without retry.
 *
 * Final step is the terminal-status fan-out via `OnboardingTerminalService`,
 * which signs and POSTs the webhook, writes `.works/state.json` to the
 * manifest repo, and marks the OnboardingRequest row as `deployed` /
 * `failed`.
 */

export type WorkOnboardingPayload = {
    onboardingId: string;
    workId: string;
};

export const workOnboardingTask = task({
    id: 'work-onboarding',
    maxDuration: 3600 * 2, // mirrors work-import: long generations are normal
    retry: {
        maxAttempts: 3,
        factor: 2,
        minTimeoutInMs: 30_000,
        maxTimeoutInMs: 5 * 60_000,
        randomize: true,
    },
    run: async (payload: WorkOnboardingPayload) => {
        logger.info('work-onboarding.start', { ...payload });

        // The integration handoff into the existing work-import orchestrator
        // happens here. Because the orchestrator boot is heavyweight and
        // tightly coupled to the api runtime context, the actual call is
        // performed by re-using the work-import task's `withWorkerContext`
        // pattern. Implementation lands in T9d completion alongside the
        // OnboardingTerminalService wiring.
        //
        // Until then this task acts as a no-op completion marker so the
        // OnboardingRequest can be transitioned to `deployed` by an
        // operator or a follow-up sweep — keeping the public contract
        // (status URL + signed webhook + state marker) stable.

        logger.warn(
            'work-onboarding.handoff_pending — final pipeline integration is not wired yet',
            {
                workId: payload.workId,
            },
        );

        return {
            onboardingId: payload.onboardingId,
            workId: payload.workId,
            status: 'handoff-pending',
        };
    },
});
