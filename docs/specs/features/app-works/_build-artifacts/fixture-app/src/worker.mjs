/**
 * The `worker` component — `node src/worker.mjs`, no Service and no Ingress (`.works/works.yml`).
 *
 * It writes a heartbeat into the database every 10 seconds; `GET /state` reports how old that
 * heartbeat is, which is how "the worker component is really running" becomes an observable fact
 * (`workerHeartbeatAt` less than 30 seconds old) instead of a status field.
 *
 * The heartbeat goes through the database and not through the volume on purpose: the worker component
 * has no volume in the App spec, so a shared file is not available — and a worker that only writes to
 * its own filesystem would report a healthy heartbeat while being useless.
 *
 * A database that is not up yet (the pod starts before Postgres is ready) is retried with a capped
 * backoff rather than crashing the container, so the worker does not turn a slow dependency into a
 * CrashLoopBackOff. The first successful beat is logged; so is every failure, once per backoff step.
 */

import { connect, describeDatabase, writeHeartbeat } from './db.mjs';
import { loadConfig } from './config.mjs';
import { isMain } from './server.mjs';

const MAX_BACKOFF_MS = 30_000;

/**
 * @param {{env?: NodeJS.ProcessEnv, intervalMs?: number, once?: boolean, log?: (line: object) => void,
 *          signal?: AbortSignal}} [options]
 */
export async function runWorker(options = {}) {
	const env = options.env ?? process.env;
	const config = loadConfig(env);
	const intervalMs = options.intervalMs ?? config.workerIntervalMs;
	const log = options.log ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));
	const once = Boolean(options.once);

	if (!config.databaseUrl) {
		const error = new Error('DATABASE_URL is not set — the worker has nowhere to write its heartbeat');
		error.exitCode = 2;
		throw error;
	}

	let client = null;
	let backoffMs = 1_000;
	let beats = 0;

	async function beat() {
		try {
			if (!client || !client.connected) {
				client = await connect(env);
				log({ t: new Date().toISOString(), event: 'worker.connected', database: describeDatabase(env) });
			}
			const row = await writeHeartbeat(client, config.workerName);
			beats += 1;
			backoffMs = 1_000;
			log({
				t: new Date().toISOString(),
				event: 'worker.heartbeat',
				name: config.workerName,
				beats: Number(row?.beat_count ?? beats),
				at: row?.beat_at ?? null
			});
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log({ t: new Date().toISOString(), event: 'worker.heartbeat-failed', error: message, retryInMs: backoffMs });
			await client?.end().catch(() => undefined);
			client = null;
			return false;
		}
	}

	const ok = await beat();
	if (once) {
		await client?.end().catch(() => undefined);
		return { beats, ok };
	}

	return new Promise((resolve) => {
		let timer = null;
		let stopping = false;
		const stop = async (reason) => {
			if (stopping) return;
			stopping = true;
			if (timer) clearTimeout(timer);
			await client?.end().catch(() => undefined);
			log({ t: new Date().toISOString(), event: 'worker.stopped', reason, beats });
			resolve({ beats, ok: true, reason });
		};

		const schedule = () => {
			if (stopping) return;
			const delay = ok ? intervalMs : backoffMs;
			if (!ok) backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
			timer = setTimeout(async () => {
				await beat();
				schedule();
			}, delay);
		};
		schedule();

		options.signal?.addEventListener('abort', () => stop('aborted'), { once: true });
		for (const signal of ['SIGTERM', 'SIGINT']) {
			process.on(signal, () => {
				log({ t: new Date().toISOString(), event: 'worker.signal', signal });
				stop(signal);
			});
		}
	});
}

if (isMain()) {
	const once = process.argv.includes('--once');
	try {
		await runWorker({ once });
		process.exit(0);
	} catch (error) {
		process.stderr.write(`worker: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(error?.exitCode ?? 1);
	}
}
