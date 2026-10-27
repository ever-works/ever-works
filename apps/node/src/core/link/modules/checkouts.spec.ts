import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetConsents } from '@ever-works/contracts';
import type { WorkspaceInventory } from '../../workspaces/workspace-inventory';
import { createCheckoutsModule } from './checkouts';
import type { CheckoutGitRunner } from './checkouts/checkout-git';
import { MachineVerbError, type MachineVerbContext, type NodeLinkControlState } from './registry';

const MANAGE: FleetConsents = { work: false, attend: false, manage: true, usageScan: false };
const WORK_ONLY: FleetConsents = { work: true, attend: false, manage: false, usageScan: false };

function control(paused = false): NodeLinkControlState {
	return { paused, drain: null, onChange: () => () => undefined };
}

function context(params: Record<string, unknown>, consents: FleetConsents, verb: string): MachineVerbContext {
	return {
		verb,
		params,
		consents,
		control: control(),
		nodeVersion: '1.0.0',
		nodeName: 'build-01',
		signal: new AbortController().signal,
		progress: () => undefined
	};
}

const STATUS = '# branch.oid ' + 'a'.repeat(40) + '\n# branch.head main\n';

describe('checkouts module (FL-14 T-11)', () => {
	let root: string;
	let code: string;
	let pool: string;
	let calls: string[][];
	let git: CheckoutGitRunner;
	const emptyInventory = async (): Promise<WorkspaceInventory> => ({
		rootPath: pool,
		exists: true,
		scannedAt: 0,
		remoteRefreshed: false,
		repositories: [],
		totalBytes: 0,
		unrecognised: []
	});

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'fl14-module-'));
		code = join(root, 'code');
		pool = join(root, 'pool');
		await mkdir(join(code, 'api', '.git'), { recursive: true });
		await mkdir(join(code, 'web', '.git'), { recursive: true });
		await mkdir(pool, { recursive: true });
		calls = [];
		git = async (args) => {
			calls.push([...args]);
			if (args[0] === 'status') return { code: 0, stdout: STATUS, stderr: '' };
			if (args[0] === 'fetch') return { code: 0, stdout: '', stderr: '' };
			return { code: 1, stdout: '', stderr: '' };
		};
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function build(consents: FleetConsents) {
		return createCheckoutsModule({
			registryPath: join(root, 'checkouts.json'),
			codeFolders: [code],
			workspaceRoot: pool,
			consents,
			nodeName: 'build-01',
			git,
			scanTaskWorkspaces: emptyInventory,
			measure: async () => 1024
		});
	}

	it('refuses a person’s rescan without --manage, naming the flag (spec U2)', async () => {
		const module = build(WORK_ONLY);
		const list = module.machineVerbs!['checkouts.list'];
		await expect(list.run(context({ rescan: true }, WORK_ONLY, 'checkouts.list'))).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof MachineVerbError &&
				error.error.code === 'consent_missing' &&
				error.error.hint.includes('--manage')
		);
	});

	it('rescans the code folders and answers every clone with its git line (spec S1)', async () => {
		const module = build(MANAGE);
		const reply = (await module.machineVerbs!['checkouts.list'].run(
			context({ rescan: true, refresh: true, measureSize: true }, MANAGE, 'checkouts.list')
		)) as {
			checkouts: Array<{ path: string; present: boolean; gitLine: unknown; sizeBytes: number }>;
			complete: boolean;
		};
		expect(reply.complete).toBe(true);
		expect(reply.checkouts.map((record) => record.path).sort()).toEqual(
			[join(code, 'api'), join(code, 'web')].sort()
		);
		expect(reply.checkouts.every((record) => record.present && record.gitLine && record.sizeBytes === 1024)).toBe(
			true
		);
		// A list never contacts the remote (spec FR-10).
		expect(calls.some((argv) => argv.includes('fetch'))).toBe(false);
	});

	it('answers a --work-only node with its Task worktrees only, never as the whole picture', async () => {
		const module = build(WORK_ONLY);
		const reply = (await module.machineVerbs!['checkouts.list'].run(context({}, WORK_ONLY, 'checkouts.list'))) as {
			complete: boolean;
			codeFolders: string[];
		};
		expect(reply.complete).toBe(false);
		expect(reply.codeFolders).toEqual([]);
	});

	it('fetches a registered checkout and refuses one it does not hold', async () => {
		const module = build(MANAGE);
		await module.machineVerbs!['checkouts.list'].run(context({ rescan: true }, MANAGE, 'checkouts.list'));
		const sync = module.machineVerbs!['checkouts.sync'];
		const result = (await sync.run(
			context({ path: join(code, 'api'), op: 'fetch' }, MANAGE, 'checkouts.sync')
		)) as { exitCode: number; op: string };
		expect(result).toMatchObject({ exitCode: 0, op: 'fetch' });
		expect(calls).toContainEqual(['fetch', '--prune', 'origin']);
		await expect(
			sync.run(context({ path: join(root, 'elsewhere'), op: 'fetch' }, MANAGE, 'checkouts.sync'))
		).rejects.toSatisfy((error: unknown) => error instanceof MachineVerbError && error.error.code === 'not_found');
		await expect(
			sync.run(context({ path: join(pool, 'repositories', 'x'), op: 'fetch' }, MANAGE, 'checkouts.sync'))
		).rejects.toSatisfy((error: unknown) => error instanceof MachineVerbError && error.error.code === 'invalid');
	});

	it('pulls fast-forward only on a clean discovered checkout, with the machine’s own git (spec FR-23)', async () => {
		const module = build(MANAGE);
		await module.machineVerbs!['checkouts.list'].run(context({ rescan: true }, MANAGE, 'checkouts.list'));
		await module.machineVerbs!['checkouts.sync'].run(
			context({ path: join(code, 'api'), op: 'pull' }, MANAGE, 'checkouts.sync')
		);
		expect(calls).toContainEqual(['pull', '--ff-only', '--no-rebase', 'origin']);
	});

	it('only forgets a discovered checkout, never deletes its folder (spec FR-25)', async () => {
		const module = build(MANAGE);
		await module.machineVerbs!['checkouts.list'].run(context({ rescan: true }, MANAGE, 'checkouts.list'));
		const remove = module.machineVerbs!['checkouts.delete'];
		await expect(
			remove.run(context({ path: join(code, 'api'), mode: 'delete' }, MANAGE, 'checkouts.delete'))
		).rejects.toSatisfy((error: unknown) => error instanceof MachineVerbError && error.error.code === 'invalid');
		const forgotten = (await remove.run(
			context({ path: join(code, 'api'), mode: 'forget' }, MANAGE, 'checkouts.delete')
		)) as { removed: boolean };
		expect(forgotten.removed).toBe(false);
	});

	it('refuses a create outside the checkouts root and a person’s create without --manage', async () => {
		const module = build(MANAGE);
		const create = module.machineVerbs!['checkouts.create'];
		await expect(
			create.run(
				context(
					{
						checkoutId: '11111111-1111-1111-1111-111111111111',
						path: join(code, 'api', 'inside-parent'),
						source: { kind: 'worktree', parentPath: join(code, 'api') },
						branch: 'nina/fix',
						baseRef: null,
						createdBy: 'user'
					},
					MANAGE,
					'checkouts.create'
				)
			)
		).rejects.toSatisfy((error: unknown) => error instanceof MachineVerbError && error.error.code === 'invalid');
		await expect(
			build(WORK_ONLY).machineVerbs!['checkouts.create'].run(
				context({ createdBy: 'user' }, WORK_ONLY, 'checkouts.create')
			)
		).rejects.toSatisfy(
			(error: unknown) => error instanceof MachineVerbError && error.error.code === 'consent_missing'
		);
	});

	it('declares list read-only and sync state-changing (the kill switch refuses sync)', () => {
		const module = build(MANAGE);
		expect(module.machineVerbs!['checkouts.list'].stateChanging).toBe(false);
		expect(module.machineVerbs!['checkouts.sync'].stateChanging).toBe(true);
	});
});
