import {
	DEFAULT_FAN_OUT_CONCURRENCY,
	DEFAULT_MAX_POLL_ATTEMPTS,
	DEFAULT_POLL_INTERVAL_MS,
	type ManagedSessionPromptInput,
	type ManagedSessionRunResult,
	type RunManagedSessionsOptions
} from '../types.js';
import { AnthropicManagedAgentsClient } from './managed-agents-client.js';
import { extractAgentTranscript } from './result-parser.js';
import { toManagedSessionTokenUsage } from './usage-metrics.js';

const NOOP_LOGGER = { warn: () => undefined };

/**
 * Fan out N Claude Managed Agent sessions against one agent + environment
 * with bounded concurrency.
 *
 * Guarantees:
 * - at most `concurrency` sessions run at once (simple worker pool, no deps);
 * - each session gets its own create-only `budget` cap when
 *   `perSessionBudgetUsd` is set;
 * - one session failing (create error, timeout, budget stop, parse-less
 *   transcript) NEVER aborts its siblings — failures are collected per id;
 * - every created session is archived best-effort when it finishes
 *   (`archiveSessions` defaults to true);
 * - results come back in the same order as `prompts`.
 */
export async function runManagedSessions(
	client: AnthropicManagedAgentsClient,
	options: RunManagedSessionsOptions
): Promise<ManagedSessionRunResult[]> {
	const prompts = options.prompts;
	if (prompts.length === 0) {
		return [];
	}

	const concurrency = clampInt(options.concurrency, 1, 50, DEFAULT_FAN_OUT_CONCURRENCY);
	const pollIntervalMs = clampInt(options.pollIntervalMs, 250, 60000, DEFAULT_POLL_INTERVAL_MS);
	const maxPollAttempts = resolveMaxPollAttempts(options, pollIntervalMs);
	const logger = options.logger ?? NOOP_LOGGER;

	const results: ManagedSessionRunResult[] = new Array(prompts.length);
	let nextIndex = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = nextIndex;
			nextIndex += 1;
			if (index >= prompts.length) {
				return;
			}

			results[index] = await runOneSession(client, prompts[index], {
				...options,
				pollIntervalMs,
				maxPollAttempts,
				logger
			});
		}
	};

	const workers = Array.from({ length: Math.min(concurrency, prompts.length) }, () => worker());
	await Promise.all(workers);

	return results;
}

async function runOneSession(
	client: AnthropicManagedAgentsClient,
	prompt: ManagedSessionPromptInput,
	options: RunManagedSessionsOptions & {
		pollIntervalMs: number;
		maxPollAttempts: number;
		logger: { warn(message: string): void };
	}
): Promise<ManagedSessionRunResult> {
	if (options.signal?.aborted) {
		return { id: prompt.id, status: 'cancelled', error: 'Cancelled before session start' };
	}

	let sessionId: string | undefined;

	try {
		const session = await client.createSession({
			agentId: options.agentId,
			environmentId: options.environmentId,
			title: prompt.title ?? `Ever Works fan-out: ${prompt.id}`,
			resources: options.resources,
			budgetUsd: options.perSessionBudgetUsd,
			initialMessages: [prompt.prompt],
			agentOverrides: options.agentOverrides
		});
		sessionId = session.id;

		const finalSession = await client.waitForSessionIdle(session.id, {
			maxPollAttempts: options.maxPollAttempts,
			pollIntervalMs: options.pollIntervalMs,
			signal: options.signal
		});

		const events = await client.listAllEvents(session.id);
		const output = extractAgentTranscript(events);

		return {
			id: prompt.id,
			status: 'completed',
			output,
			sessionId: session.id,
			tokens: toManagedSessionTokenUsage(finalSession.usage),
			costUsd: finalSession.usage?.list_cost_usd
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const cancelled = options.signal?.aborted === true;
		return {
			id: prompt.id,
			status: cancelled ? 'cancelled' : 'failed',
			sessionId,
			error: message
		};
	} finally {
		if (sessionId && options.archiveSessions !== false) {
			try {
				await client.archiveSession(sessionId);
			} catch (archiveError) {
				options.logger.warn(
					`claude-managed-agent fan-out: could not archive session ${sessionId}: ${
						archiveError instanceof Error ? archiveError.message : String(archiveError)
					}`
				);
			}
		}
	}
}

function resolveMaxPollAttempts(
	options: Pick<RunManagedSessionsOptions, 'timeoutMs' | 'maxPollAttempts'>,
	pollIntervalMs: number
): number {
	if (typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
		return Math.max(1, Math.ceil(options.timeoutMs / pollIntervalMs));
	}

	return clampInt(options.maxPollAttempts, 1, 100000, DEFAULT_MAX_POLL_ATTEMPTS);
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}

	return Math.max(min, Math.min(max, Math.floor(value)));
}
