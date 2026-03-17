/**
 * Token Manager for GitHub repository access.
 *
 * Handles scoped, short-lived token generation and cleanup for passing
 * repository access to SIM workflows securely.
 */

export interface TokenInfo {
	token: string;
	repoUrl: string;
	expiresAt: number;
}

/** Active tokens that need cleanup after workflow completion */
const activeTokens = new Map<string, TokenInfo>();

/**
 * Registers a token for cleanup tracking.
 * Called during the prepare-payload step when repo access is enabled.
 *
 * @param executionId - Unique execution ID to associate the token with
 * @param tokenInfo - Token details including expiry
 */
export function registerToken(executionId: string, tokenInfo: TokenInfo): void {
	activeTokens.set(executionId, tokenInfo);
}

/**
 * Cleans up a token after workflow completion.
 * Called during the cleanup step to remove tracking of tokens that are
 * no longer needed.
 *
 * @param executionId - The execution ID to clean up
 * @returns The removed token info, or undefined if not found
 */
export function revokeToken(executionId: string): TokenInfo | undefined {
	const token = activeTokens.get(executionId);
	activeTokens.delete(executionId);
	return token;
}

/**
 * Cleans up all expired tokens.
 * Can be called periodically or during plugin health checks.
 */
export function cleanupExpiredTokens(): number {
	const now = Date.now();
	let cleaned = 0;

	for (const [id, info] of activeTokens) {
		if (info.expiresAt < now) {
			activeTokens.delete(id);
			cleaned++;
		}
	}

	return cleaned;
}

/**
 * Sanitizes a token for safe logging (shows first 4 and last 4 chars).
 */
export function sanitizeTokenForLog(token: string): string {
	if (token.length <= 8) return '***';
	return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
