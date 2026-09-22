import type { ActionsRepositoryRef, ActionsRunsPort } from './actions-runs.port.js';

/**
 * APW-05 T13 — the failing job's log, bounded before it is read.
 *
 * Plan §4.8: *"`GET actions/jobs/{job_id}/logs` (follows the redirect), reading
 * at most the last 2 MiB with a `Range` request"*.
 *
 * ## Why the bound is on the REQUEST and not on the response
 *
 * A GitHub Actions job log has no size limit a caller can rely on: a build that
 * prints its dependency tree, or one stuck in a retry loop, produces hundreds of
 * megabytes. Reading it and then slicing means the platform has already pulled
 * all of it across the network and into memory, per poll, per Build. A
 * `Range: bytes=-2097152` asks the server for the tail and nothing else.
 *
 * The tail is also the RIGHT part, not merely the cheap one: a build fails at
 * the end, and every signal plan §4.9 classifies on — the exit code, the
 * BuildKit step, `No space left on device` — is printed in the last moments.
 *
 * ## A server that ignores `Range` is handled, not trusted
 *
 * `Range` is a request, not a guarantee; a server may answer `200` with the
 * whole body. So the bytes are cut again on arrival. Trusting the header would
 * mean one unbounded read is all it takes.
 *
 * ## A missing log is empty, never an error
 *
 * Logs expire, a cancelled job may have none, and a job that never started has
 * nothing to print. All three are "no log", and a Build whose log has aged out
 * must still report the status it already knows — so this answers `''` and the
 * classifier reports `unknown` rather than the observation failing.
 */

/** Plan §4.8's ceiling: the last 2 MiB of the job's log. */
export const LOG_TAIL_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The tail of one job's log, as text.
 *
 * The first line is dropped when the response was a partial one: a byte range
 * almost never starts on a line boundary, so the first line is a fragment, and
 * a fragment in an excerpt reads as corruption to whoever is trying to work out
 * why their build failed.
 */
export async function readJobLogTail(
	port: ActionsRunsPort,
	input: { readonly repository: ActionsRepositoryRef; readonly jobId: number }
): Promise<string> {
	if (typeof port.downloadJobLogTail !== 'function') {
		// The port is optional on purpose: a caller with no log access still gets
		// a classified failure (`unknown`) rather than a thrown observation.
		return '';
	}

	let tail: { readonly bytes: Uint8Array; readonly partial: boolean } | null;
	try {
		tail = await port.downloadJobLogTail({ ...input, maxBytes: LOG_TAIL_MAX_BYTES });
	} catch {
		// See the file docstring: expired, absent and unreadable are all "no log".
		return '';
	}
	if (!tail || tail.bytes.byteLength === 0) return '';

	// The server may have ignored `Range`. Cut again rather than trust it.
	const bounded =
		tail.bytes.byteLength > LOG_TAIL_MAX_BYTES
			? tail.bytes.slice(tail.bytes.byteLength - LOG_TAIL_MAX_BYTES)
			: tail.bytes;

	const text = new TextDecoder('utf-8', { fatal: false }).decode(bounded);
	if (!tail.partial) return text;

	const firstBreak = text.indexOf('\n');
	return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
}
