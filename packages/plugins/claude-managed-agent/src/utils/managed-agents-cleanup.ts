import type { ManagedAgentRunResources } from '../types.js';
import type { AnthropicManagedAgentsClient } from './managed-agents-client.js';

const CLEANUP_POLL_INTERVAL_MS = 1000;
const CLEANUP_MAX_POLL_ATTEMPTS = 15;

interface CleanupLogger {
	warn(message: string): void;
}

export async function cleanupManagedAgentRun(
	client: AnthropicManagedAgentsClient,
	resources: ManagedAgentRunResources,
	logger: CleanupLogger
): Promise<void> {
	await cleanupSession(client, resources.sessionId, logger);
	await cleanupUploadedFile(client, resources.uploadedFileId, logger);
	await cleanupEnvironment(client, resources.createdEnvironmentId, logger);
	await cleanupAgent(client, resources.createdAgentId, logger);
}

async function cleanupSession(
	client: AnthropicManagedAgentsClient,
	sessionId: string | undefined,
	logger: CleanupLogger
): Promise<void> {
	if (!sessionId) {
		return;
	}

	try {
		const session = await client.getSession(sessionId);

		if (session.status === 'running' || session.status === 'rescheduling') {
			await client.interruptSession(sessionId);

			try {
				await client.waitForSessionIdle(sessionId, {
					maxPollAttempts: CLEANUP_MAX_POLL_ATTEMPTS,
					pollIntervalMs: CLEANUP_POLL_INTERVAL_MS
				});
			} catch {
				// Best-effort cleanup continues below.
			}
		}

		await client.deleteSession(sessionId);
	} catch (error) {
		logger.warn(`Claude Managed Agent cleanup could not delete session ${sessionId}: ${formatCleanupError(error)}`);

		try {
			await client.archiveSession(sessionId);
		} catch (archiveError) {
			logger.warn(
				`Claude Managed Agent cleanup could not archive session ${sessionId}: ${formatCleanupError(archiveError)}`
			);
		}
	}
}

async function cleanupUploadedFile(
	client: AnthropicManagedAgentsClient,
	fileId: string | undefined,
	logger: CleanupLogger
): Promise<void> {
	if (!fileId) {
		return;
	}

	try {
		await client.deleteFile(fileId);
	} catch (error) {
		logger.warn(`Claude Managed Agent cleanup could not delete file ${fileId}: ${formatCleanupError(error)}`);
	}
}

async function cleanupEnvironment(
	client: AnthropicManagedAgentsClient,
	environmentId: string | undefined,
	logger: CleanupLogger
): Promise<void> {
	if (!environmentId) {
		return;
	}

	try {
		await client.deleteEnvironment(environmentId);
	} catch (error) {
		logger.warn(
			`Claude Managed Agent cleanup could not delete environment ${environmentId}: ${formatCleanupError(error)}`
		);
	}
}

async function cleanupAgent(
	client: AnthropicManagedAgentsClient,
	agentId: string | undefined,
	logger: CleanupLogger
): Promise<void> {
	if (!agentId) {
		return;
	}

	try {
		await client.archiveAgent(agentId);
	} catch (error) {
		logger.warn(`Claude Managed Agent cleanup could not archive agent ${agentId}: ${formatCleanupError(error)}`);
	}
}

function formatCleanupError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
