/**
 * The process entrypoint. Kubernetes starts this; nothing imports it.
 *
 * Everything decidable lives in `bootstrap.ts` so it can be tested without spawning a process. This
 * file only does the three things a spec cannot: read the real environment, install signal handlers
 * and set an exit code.
 *
 * Today it always refuses — the reconciler registry is empty (see `reconcile/index.ts`) — and it
 * says so on stderr with `EX_CONFIG`. That is the intended behaviour of this skeleton: a controller
 * Pod must never report healthy while reconciling nothing.
 *
 * The work is inside an `async main()` rather than at the top level on purpose: `tsc` accepts
 * top-level `await` under `module: ESNext`, but the bundler targets `es2021` and rejects it, so a
 * green `type-check` would ship a package that cannot build.
 */
import { bootstrap, EXIT_CONFIGURATION_REFUSED } from './bootstrap.js';
import { RECONCILERS } from './reconcile/index.js';
import type { ReconcilerLogger } from './reconciler.port.js';

/** One-line JSON to stdout/stderr: what the zone's log collector expects, and no dependency. */
const logger: ReconcilerLogger = {
	info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
	warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
	error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields }))
};

async function main(): Promise<void> {
	const result = await bootstrap({ env: process.env, reconcilers: RECONCILERS, logger });

	if (!result.ok) {
		process.exitCode = EXIT_CONFIGURATION_REFUSED;
		return;
	}

	const stop = async (signal: string): Promise<void> => {
		logger.info('shutting down', { signal });
		await result.shutdown();
		process.exitCode = 0;
	};

	process.once('SIGTERM', () => void stop('SIGTERM'));
	process.once('SIGINT', () => void stop('SIGINT'));
}

main().catch((error: unknown) => {
	// An unhandled rejection here means a reconciler could not establish its watch and the rollback
	// rethrew. Exiting non-zero lets Kubernetes restart us; staying up would be the silent-zone bug.
	logger.error('controller exited abnormally', { error: String(error) });
	process.exitCode = 1;
});
