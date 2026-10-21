import { describe, expect, it } from 'vitest';
import { resolveVirtualImage, runnableImageRef, splitImageDigest, virtualImageOverrideEnv } from './catalogue';
import { containerBootstrapScript, GUEST_TOKEN_FILE, isBootstrapSafe } from './container-bootstrap';
import {
	containerControlArgs,
	containerRunArgs,
	guestWriteTokenArgs,
	homeVolumeName,
	homeVolumeRemoveArgs
} from './docker-args';
import { parseChildMeta, VirtualState } from './state';

/** Virtual computers (FL-16, T-14, T-15) — the host's argv, catalogue, bootstrap and folders. */

const CHILD = '0b9c5f3e-6f0a-4a43-9a51-1f2d3c4b5a69';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('containerRunArgs (plan §6.7)', () => {
	const args = containerRunArgs({
		childNodeId: CHILD,
		name: 'ubuntu-nina',
		image: `docker.io/library/ubuntu@${DIGEST}`,
		cpus: 2,
		memoryGiB: 4,
		runDir: `/home/owner/.config/ever-works-node/virtual/${CHILD}/run`
	});

	it('pins the exact argv: caps, labels, the home volume, the read-only bootstrap', () => {
		expect(args).toEqual([
			'run',
			'-d',
			'--name',
			`ew-virtual-${CHILD}`,
			'--hostname',
			'ubuntu-nina',
			'--init',
			'--cpus',
			'2',
			'--memory',
			'4g',
			'--pids-limit',
			'4096',
			'--restart',
			'unless-stopped',
			'--label',
			'works.ever.fleet.virtual=true',
			'--label',
			`works.ever.fleet.virtual.child=${CHILD}`,
			'--env',
			'HOME=/home/ever',
			'--mount',
			`type=volume,source=ew-virtual-${CHILD}-home,target=/home/ever`,
			'--mount',
			`type=bind,source=/home/owner/.config/ever-works-node/virtual/${CHILD}/run,target=/run/ever-works,readonly`,
			'--entrypoint',
			'/bin/sh',
			`docker.io/library/ubuntu@${DIGEST}`,
			'/run/ever-works/bootstrap.sh'
		]);
	});

	it('never hands the child the Docker socket, privileged mode or a host namespace', () => {
		const joined = args.join(' ');
		expect(joined).not.toContain('docker.sock');
		expect(joined).not.toContain('--privileged');
		expect(joined).not.toMatch(/--(pid|network|ipc|uts)=host/);
	});

	it('refuses a name or id that could become a flag', () => {
		const base = { childNodeId: CHILD, name: 'ok-name', image: 'alpine', cpus: 2, memoryGiB: 4, runDir: '/r' };
		expect(() => containerRunArgs({ ...base, name: '--privileged' })).toThrow();
		expect(() => containerRunArgs({ ...base, childNodeId: 'x; rm -rf /' })).toThrow();
		expect(() => containerRunArgs({ ...base, runDir: '/a,b' })).toThrow();
	});

	it('stops a Container with its grace and removes it with its volume', () => {
		expect(containerControlArgs('stop', CHILD, 10)).toEqual(['stop', '-t', '10', `ew-virtual-${CHILD}`]);
		expect(containerControlArgs('remove', CHILD)).toEqual(['rm', '-f', `ew-virtual-${CHILD}`]);
		expect(homeVolumeRemoveArgs(CHILD)).toEqual(['volume', 'rm', '-f', homeVolumeName(CHILD)]);
	});

	it('writes the token from stdin with a constant script (no token on any argv)', () => {
		const argv = guestWriteTokenArgs(CHILD, GUEST_TOKEN_FILE);
		expect(argv.slice(0, 5)).toEqual(['exec', '-i', `ew-virtual-${CHILD}`, 'sh', '-c']);
		expect(argv[5]).toBe(
			'umask 077 && mkdir -p /home/ever/.ever-works && cat > /home/ever/.ever-works/enroll-token.part && mv /home/ever/.ever-works/enroll-token.part /home/ever/.ever-works/enroll-token'
		);
	});
});

describe('the catalogue (FR-19)', () => {
	it('uses the catalogue tag, then the lock digest, and honours an operator override', () => {
		expect(resolveVirtualImage('ubuntu-26.04', { env: {} })).toEqual({
			ref: 'docker.io/library/ubuntu:26.04',
			digest: null,
			source: 'catalogue'
		});
		const locked = resolveVirtualImage('ubuntu-26.04', {
			env: {},
			lock: { 'ubuntu-26.04': { ref: 'docker.io/library/ubuntu:26.04', digest: DIGEST } }
		});
		expect(locked?.digest).toBe(DIGEST);
		expect(runnableImageRef(locked!)).toBe(`docker.io/library/ubuntu@${DIGEST}`);
		const override = resolveVirtualImage('ubuntu-26.04', {
			env: { [virtualImageOverrideEnv('ubuntu-26.04')]: `registry.example.com/base/ubuntu@${DIGEST}` }
		});
		expect(override).toMatchObject({ source: 'override', digest: DIGEST });
	});

	it('has no image for a Windows system before phase 2', () => {
		expect(resolveVirtualImage('windows-11', { env: {} })).toBeNull();
	});

	it('names the override variable predictably', () => {
		expect(virtualImageOverrideEnv('ubuntu-26.04')).toBe('EVER_WORKS_NODE_VIRTUAL_IMAGE_UBUNTU_26_04');
		expect(splitImageDigest('alpine:3.22')).toEqual({ repository: 'alpine:3.22', digest: null });
	});
});

describe('the bootstrap (T-15)', () => {
	const script = containerBootstrapScript({
		family: 'ubuntu',
		runtimeSpec: 'ever-works-node@0.2.7',
		nodeMajor: 26,
		apiUrl: 'https://api.ever.works'
	});

	it('pins the host runtime version and never carries a token', () => {
		expect(script).toContain('npm install -g --no-fund --no-audit --loglevel=error ever-works-node@0.2.7');
		expect(script).toContain('--token-file /home/ever/.ever-works/enroll-token');
		expect(script).not.toMatch(/--token(?!-file)/);
	});

	it('writes the readiness marker before it waits for the token', () => {
		expect(script.indexOf(': > /home/ever/.ever-works/ready')).toBeGreaterThan(0);
		expect(script.indexOf(': > /home/ever/.ever-works/ready')).toBeLessThan(script.indexOf('while [ ! -s'));
	});

	it('starts the runtime with --work --manage and never --attend (FR-15)', () => {
		expect(script).toContain('exec ever-works-node start --work --manage');
		expect(script).not.toContain('--attend');
	});

	it('verifies the official Node.js build against its checksums', () => {
		expect(script).toContain('latest-v26.x');
		expect(script).toContain('sha256sum -c');
	});

	it('refuses inputs that could break out of the script', () => {
		expect(isBootstrapSafe({ apiUrl: 'https://api.ever.works; rm -rf /', runtimeSpec: 'ever-works-node', nodeMajor: 26 })).toBe(
			false
		);
		expect(isBootstrapSafe({ apiUrl: 'https://api.ever.works', runtimeSpec: 'ever-works-node@$(id)', nodeMajor: 26 })).toBe(
			false
		);
	});
});

describe('the host folders (state.ts)', () => {
	it('builds every path from a validated id and refuses anything else', () => {
		const state = new VirtualState('/srv/node/virtual');
		expect(state.childDir(CHILD)).toBe(`/srv/node/virtual/${CHILD}`);
		expect(() => state.childDir('../etc')).toThrow();
	});

	it('reads back a meta.json and rejects a foreign file', () => {
		expect(
			parseChildMeta(
				JSON.stringify({ childNodeId: CHILD, name: 'n1', systemId: 'alpine', kind: 'container', cpus: 2, memoryGiB: 4 })
			)
		).toMatchObject({ childNodeId: CHILD, systemId: 'alpine' });
		expect(parseChildMeta('{"childNodeId":"x"}')).toBeNull();
	});
});
