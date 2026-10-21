import { execFileWithVerifiedCancellation } from '@ever-works/local-workspace-plugin';

/**
 * Checkouts on computers (FL-14 P3, spec FR-31, S11, U11) — container
 * isolation: every session and command for a container-isolated checkout
 * runs inside a fresh container with the checkout's folder mounted at
 * `/workspace`, never on the host.
 *
 * Refused (`unsupported_on_node`) on Windows (Windows containers are out of
 * scope, spec §8) and on a node without a working Docker, naming the missing
 * piece. The wrapper is argv only — the image and the folder are never
 * interpolated into a shell string.
 */

/** Where the folder is mounted inside the container. */
export const CHECKOUT_CONTAINER_WORKDIR = '/workspace';

/** Why this node cannot isolate a checkout in a container, or null when it can. */
export function containerRefusal(platform: string, dockerAvailable: boolean): string | null {
	if (platform === 'win32') return 'Container checkouts are not available on Windows computers';
	if (!dockerAvailable) return 'Container checkouts need Docker on this computer';
	return null;
}

/** A container image reference the node will hand to `docker run`: no option-looking leading `-`, bounded, no spaces. */
export function isContainerImageReference(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 255 &&
		!value.startsWith('-') &&
		/^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/.test(value)
	);
}

/**
 * The argv that runs `command` for a container-isolated checkout:
 * `docker run --rm -i [-t] -v <path>:/workspace -w /workspace <image> <command…>`.
 */
export function containerRunArgv(input: {
	path: string;
	image: string;
	command: readonly string[];
	tty?: boolean;
	name?: string;
}): string[] {
	if (!isContainerImageReference(input.image)) throw new Error('invalid container image');
	const argv = ['docker', 'run', '--rm', '-i'];
	if (input.tty) argv.push('-t');
	if (input.name) argv.push('--name', input.name);
	argv.push('-v', `${input.path}:${CHECKOUT_CONTAINER_WORKDIR}`, '-w', CHECKOUT_CONTAINER_WORKDIR, input.image);
	argv.push(...input.command);
	return argv;
}

/** Is a Docker daemon reachable for this user? One bounded `docker version` call. */
export async function detectDocker(signal?: AbortSignal): Promise<boolean> {
	try {
		const timeout = AbortSignal.timeout(5_000);
		const { error, stdout } = await execFileWithVerifiedCancellation(
			'docker',
			['version', '--format', '{{.Server.Version}}'],
			{ windowsHide: true, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }
		);
		return !error && String(stdout ?? '').trim().length > 0;
	} catch {
		return false;
	}
}
