import { isFleetPortLoopbackUrl, makeFleetLinkError } from '@ever-works/contracts';
import type { CommandRunner } from '../../../capabilities';
import { MachineVerbError } from '../registry';

/**
 * Servers and ports (FL-10, R-3, spec S3, FR-9, FR-13) — **Open on the
 * desktop**: the machine's default browser opens the address on the desktop
 * the owner can watch.
 *
 * The opener is a seam ({@link DesktopUrlOpener}). FL-07's desktop helper —
 * which owns the interactive session of a machine whose node runs as a
 * service — binds it when it lands (`desktopHooks.openUrl`). Until then the
 * runtime binds the system opener below ONLY when the node itself runs in a
 * desktop session (`--attend` with a display): `xdg-open`, `open`, or
 * Windows' URL protocol handler, each handed one argument — the loopback
 * address the node built from a port number — and never a shell string.
 *
 * Refusals: without `--attend` → `consent_missing` naming the flag; with it
 * but no opener → `unsupported_on_node` pointing at the preview browser.
 */

export interface DesktopUrlOpener {
	/** Open `url` (always `http(s)://127.0.0.1:<port>/`) in the machine's default browser on its desktop. */
	openUrl(url: string): Promise<void>;
}

/** The system opener for a node running inside a desktop session. */
export function createSystemBrowserOpener(runner: CommandRunner, platform: string): DesktopUrlOpener {
	return {
		async openUrl(url: string): Promise<void> {
			if (!isFleetPortLoopbackUrl(url)) throw new Error('only a loopback address may be opened');
			const [command, args] =
				platform === 'win32'
					? ['rundll32', ['url.dll,FileProtocolHandler', url]]
					: platform === 'darwin'
						? ['open', [url]]
						: ['xdg-open', [url]];
			const result = await runner.run(command, args, { timeoutMs: 10_000 });
			if (result.spawnError === 'ENOENT') throw new Error(`${command} is not available on this machine`);
			// `rundll32` and `xdg-open` answer 0 once the browser was asked; anything else is a failure.
			if (result.code !== 0 && !result.timedOut) {
				const line = (result.stderr.split(/\r?\n/).find((l) => l.trim()) ?? '').trim().slice(0, 200);
				throw new Error(`${command} exited ${result.code}${line ? `: ${line}` : ''}`);
			}
		}
	};
}

export interface OpenOnDesktopInput {
	url: string;
	attend: boolean;
	opener: DesktopUrlOpener | null;
	nodeName: string;
}

/** Open on the desktop, or throw the typed refusal. */
export async function openOnDesktop(input: OpenOnDesktopInput): Promise<void> {
	if (!isFleetPortLoopbackUrl(input.url)) {
		throw new MachineVerbError(makeFleetLinkError('invalid', 'only a port on this machine can be opened'));
	}
	if (!input.attend) {
		throw new MachineVerbError(
			makeFleetLinkError('consent_missing', `start the node with --attend on ${input.nodeName}`, {
				consent: 'attend',
				target: 'desktop'
			})
		);
	}
	if (!input.opener) {
		throw new MachineVerbError(
			makeFleetLinkError(
				'unsupported_on_node',
				`${input.nodeName} has no desktop the node can open a browser on — open it in the preview browser instead`,
				{ target: 'desktop' }
			)
		);
	}
	try {
		await input.opener.openUrl(input.url);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new MachineVerbError(
			makeFleetLinkError('operation_failed', message.slice(0, 300), { target: 'desktop' })
		);
	}
}
