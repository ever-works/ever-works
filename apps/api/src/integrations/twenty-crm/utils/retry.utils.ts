/**
 * Utility functions for retry logic
 */
export class RetryUtils {
    /**
     * Execute a function with retry logic
     */
    static async withRetry<T>(
        fn: () => Promise<T>,
        maxAttempts: number = 3,
        delayMs: number = 1000,
        backoffMultiplier: number = 2,
    ): Promise<T> {
        let lastError: Error;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error as Error;
                
                if (attempt === maxAttempts) {
                    throw lastError;
                }
                
                const delay = delayMs * Math.pow(backoffMultiplier, attempt - 1);
                await this.sleep(delay);
            }
        }
        
        throw lastError!;
    }

    /**
     * Sleep for specified milliseconds
     */
    private static sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Check if error is retryable
     */
    static isRetryableError(error: any): boolean {
        // Network errors, timeouts, and 5xx status codes are retryable
        if (error.code === 'ECONNRESET' || 
            error.code === 'ETIMEDOUT' || 
            error.code === 'ENOTFOUND') {
            return true;
        }
        
        if (error.response?.status >= 500) {
            return true;
        }
        
        // Rate limiting (429) is retryable
        if (error.response?.status === 429) {
            return true;
        }
        
        return false;
    }

    /**
     * Calculate retry delay with jitter
     */
    static calculateRetryDelay(
        baseDelayMs: number,
        attempt: number,
        backoffMultiplier: number = 2,
        maxDelayMs: number = 30000,
    ): number {
        const delay = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);
        const jitter = Math.random() * 0.1 * delay; // Add 10% jitter
        return Math.min(delay + jitter, maxDelayMs);
    }
}
