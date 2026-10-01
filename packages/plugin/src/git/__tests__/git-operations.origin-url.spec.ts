import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `cloneOrPull` re-asserts `origin` before it pulls an existing checkout.
 *
 * `pull` and `push` send the git credentials to whatever `origin` points at in
 * `.git/config`, and a persistent checkout's config is a file anything writing
 * into the checkout can change. The agent `commitToRepo` tool could write
 * `.git/config`; reproduced against this class with a local stand-in server,
 * a rewritten `origin` received the token on its first `401` challenge.
 *
 * The tool now refuses paths inside `.git`. This is the second layer: whatever
 * rewrote `origin`, the next `cloneOrPull` puts it back to the URL it computes
 * itself before any credential is used — and if it cannot, it clones fresh
 * rather than pulling from a remote nobody chose.
 */

const calls: string[] = [];
const setConfigMock = vi.fn();
const pullMock = vi.fn();
const cloneMock = vi.fn();

vi.mock('isomorphic-git', () => ({
	default: {
		setConfig: (...args: unknown[]) => {
			calls.push('setConfig');
			return setConfigMock(...args);
		},
		pull: (...args: unknown[]) => {
			calls.push('pull');
			return pullMock(...args);
		},
		clone: (...args: unknown[]) => {
			calls.push('clone');
			return cloneMock(...args);
		},
		init: vi.fn(),
		addRemote: vi.fn(),
		currentBranch: vi.fn().mockResolvedValue('main'),
		listBranches: vi.fn().mockResolvedValue(['main'])
	}
}));

const { GitOperations } = await import('../git-operations.js');

const OWNER = 'acme';
const REPO = 'their-app';
const KEY = 'work:w-1:agent-commit';
let baseDir: string;

function makeOps(): InstanceType<typeof GitOperations> {
	return new GitOperations(
		() => ({ username: 'x-access-token', password: 'token' }),
		(owner, repo) => `https://github.com/${owner}/${repo}.git`,
		{ baseDir }
	);
}

/** An existing checkout, as a previous `cloneOrPull` would have left it. */
function existingCheckout(ops: InstanceType<typeof GitOperations>): string {
	const dir = ops.getLocalDir(OWNER, REPO, KEY);
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	return dir;
}

const pullInput = {
	owner: OWNER,
	repo: REPO,
	token: 'token',
	checkoutKey: KEY,
	autoSwitchToMainBranch: false
};

beforeEach(() => {
	baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-origin-url-'));
	calls.length = 0;
	setConfigMock.mockReset().mockResolvedValue(undefined);
	pullMock.mockReset().mockResolvedValue(undefined);
	cloneMock.mockReset().mockResolvedValue(undefined);
});

describe('cloneOrPull — origin is re-asserted before an existing checkout is pulled', () => {
	it('sets origin to the URL it computes, BEFORE pulling', async () => {
		const ops = makeOps();
		const dir = existingCheckout(ops);

		await ops.cloneOrPull(pullInput);

		expect(setConfigMock).toHaveBeenCalledWith(
			expect.objectContaining({
				dir,
				path: 'remote.origin.url',
				value: 'https://github.com/acme/their-app.git'
			})
		);
		expect(calls.indexOf('setConfig')).toBeLessThan(calls.indexOf('pull'));
		expect(cloneMock).not.toHaveBeenCalled();
	});

	it('clones FRESH when origin cannot be reset — it never pulls from a remote nobody chose', async () => {
		const ops = makeOps();
		existingCheckout(ops);
		setConfigMock.mockRejectedValue(new Error('config is not writable'));

		await ops.cloneOrPull(pullInput);

		expect(pullMock).not.toHaveBeenCalled();
		expect(cloneMock).toHaveBeenCalledWith(
			expect.objectContaining({ url: 'https://github.com/acme/their-app.git' })
		);
	});

	it('does not touch config on a first clone — there is nothing to re-assert yet', async () => {
		const ops = makeOps();

		await ops.cloneOrPull(pullInput);

		expect(setConfigMock).not.toHaveBeenCalled();
		expect(cloneMock).toHaveBeenCalledTimes(1);
	});
});
