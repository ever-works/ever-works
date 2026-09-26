/**
 * Startup, as a function rather than as a side effect.
 *
 * `main.ts` is four lines because everything that can be decided is decided here, where a spec can
 * drive it: configuration, registry validation, the order things start in and the exit code. The
 * process never learns anything the bootstrap did not hand it.
 */
import { loadControllerConfig, type ControllerConfig, type ControllerRefusal } from './config.js';
import { validateRegistry, type Reconciler, type ReconcilerLogger, type RegistryRefusal } from './reconciler.port.js';

/**
 * `78` is `EX_CONFIG` from `sysexits.h`: the configuration is wrong, so retrying the same Pod spec
 * cannot help. Kubernetes will still restart the container — the point of a distinct code is that
 * an operator reading `kubectl describe` can tell "you configured me wrongly" apart from "I
 * crashed", and a `CrashLoopBackOff` on 78 is a ticket for a human, not for a retry.
 */
export const EXIT_CONFIGURATION_REFUSED = 78;

/** What a bootstrap did. */
export type BootstrapResult =
	| {
			readonly ok: true;
			readonly config: ControllerConfig;
			/** The reconcilers that were started, in order. */
			readonly started: readonly string[];
			/** Stops every started reconciler, in reverse order. Idempotent. */
			readonly shutdown: () => Promise<void>;
	  }
	| {
			readonly ok: false;
			readonly exitCode: typeof EXIT_CONFIGURATION_REFUSED;
			readonly refusals: readonly (ControllerRefusal | RegistryRefusal)[];
	  };

/** Inputs, so a spec supplies its own env, registry and logger. */
export interface BootstrapOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly reconcilers: readonly Reconciler[];
	readonly logger: ReconcilerLogger;
}

/**
 * Load the configuration, validate the registry, then start every reconciler.
 *
 * Refusals are collected and reported together: an operator restarting a Deployment wants the whole
 * list, not the first line of it. Nothing is started unless every check passed — a controller that
 * runs three of five loops is a zone that is silently wrong about four kinds of object.
 */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
	const { env, reconcilers, logger } = options;

	const configuration = loadControllerConfig(env);
	const registryRefusals = validateRegistry(reconcilers);
	const refusals: (ControllerRefusal | RegistryRefusal)[] = [
		...(configuration.ok ? [] : configuration.refusals),
		...registryRefusals
	];

	if (refusals.length > 0 || !configuration.ok) {
		for (const refusal of refusals) logger.error(`refused to start: ${refusal.code}`, { detail: refusal.message });
		return { ok: false, exitCode: EXIT_CONFIGURATION_REFUSED, refusals };
	}

	const { config } = configuration;
	logger.info('starting hosting-tier controller', {
		zoneId: config.zoneId,
		controlNamespace: config.controlNamespace,
		apiVersion: config.apiVersion,
		credentials: config.credentials.kind,
		version: config.version,
		reconcilers: reconcilers.map((reconciler) => reconciler.name)
	});

	const controller = new AbortController();
	const started: string[] = [];
	let stopped = false;

	const shutdown = async (): Promise<void> => {
		if (stopped) return;
		stopped = true;
		controller.abort();
		// Reverse order: a loop started later may depend on one started earlier.
		for (const name of [...started].reverse()) {
			const reconciler = reconcilers.find((candidate) => candidate.name === name);
			if (reconciler === undefined) continue;
			try {
				await reconciler.stop();
			} catch (error) {
				logger.warn('reconciler did not stop cleanly', { reconciler: name, error: String(error) });
			}
		}
	};

	for (const reconciler of reconcilers) {
		try {
			await reconciler.start({ config, logger, shutdown: controller.signal });
			started.push(reconciler.name);
		} catch (error) {
			// A loop that cannot establish its watch is not a degraded zone, it is a wrong one: stop
			// the ones already running rather than serving a partial control plane.
			logger.error('reconciler failed to start; rolling back', {
				reconciler: reconciler.name,
				error: String(error)
			});
			await shutdown();
			throw error;
		}
	}

	return { ok: true, config, started, shutdown };
}
