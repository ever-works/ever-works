import { describe, expect, it } from 'vitest';
import { validateFleetRunRequest } from '@ever-works/contracts';
import { resolveAllowedRoots } from '../../allowed-roots';
import { bindSourceAllowed } from '../docker';
import {
	containerActions,
	countImageUse,
	parseContainers,
	parseDockerPorts,
	parseDockerSize,
	parseDockerTime,
	parseImages,
	parseStats
} from './docker-cli';
import { createPullProgress, dockerRunArgv, mountSpec, parsePruneSummary, safeOutputLine } from './docker-ops';

/**
 * FL-09 P2 — Docker through its CLI: the `{{json .}}` parsers (Engine and
 * Desktop print the same shape), the run argv that never carries a value,
 * the pull percentage, and the shared folders a bind mount must come from.
 */

describe('docker-cli parsers', () => {
	it('reads ps rows with ports, labels and states', () => {
		const rows = parseContainers(
			[
				JSON.stringify({
					ID: 'a1b2c3d4e5f6a7b8c9d0',
					Names: 'acme-api',
					Image: 'acme/api:1.4',
					State: 'running',
					Status: 'Up 2 hours',
					Ports: '0.0.0.0:3000->3000/tcp, :::3000->3000/tcp',
					CreatedAt: '2026-10-21 07:00:00 +0000 UTC',
					Labels: 'com.docker.compose.project=acme,com.docker.compose.service=api'
				}),
				JSON.stringify({ ID: 'ffffffffffff1111', Names: 'old-build', Image: 'node:22', State: 'exited', Status: 'Exited (1) 3 days ago', Ports: '' }),
				'not json'
			].join('\n')
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			id: 'a1b2c3d4e5f6',
			name: 'acme-api',
			state: 'running',
			composeProject: 'acme',
			composeService: 'api',
			ports: [{ hostIp: '0.0.0.0', hostPort: 3000, containerPort: 3000, proto: 'tcp' }],
			actions: ['stop', 'restart'],
			confirmation: { stop: 'confirm', restart: 'confirm' }
		});
		expect(rows[1]).toMatchObject({ state: 'exited', actions: ['start', 'remove'], confirmation: { remove: 'confirm-destructive' } });
	});

	it('reads exposed-only ports as internal', () => {
		expect(parseDockerPorts('5432/tcp')).toEqual([{ hostIp: null, hostPort: null, containerPort: 5432, proto: 'tcp' }]);
	});

	it('reads sizes, times and stats', () => {
		expect(parseDockerSize('412MB')).toBe(412_000_000);
		expect(parseDockerSize('180MiB')).toBe(180 * 1024 * 1024);
		expect(parseDockerSize('nope')).toBeNull();
		expect(parseDockerTime('2026-10-21 07:00:00 +0000 UTC')).toBe('2026-10-21T07:00:00.000Z');
		const stats = parseStats(JSON.stringify({ ID: 'a1b2c3d4e5f6', CPUPerc: '2.00%', MemUsage: '180MiB / 7.7GiB' }));
		expect(stats.get('a1b2c3d4e5f6')).toEqual({ cpuPercent: 2, memBytes: 180 * 1024 * 1024 });
	});

	it('counts which images containers use', () => {
		const images = parseImages(
			[
				JSON.stringify({ ID: 'sha256:aaaaaaaaaaaa1111', Repository: 'acme/api', Tag: '1.4', Size: '412MB' }),
				JSON.stringify({ ID: 'sha256:bbbbbbbbbbbb2222', Repository: 'node', Tag: '22', Size: '1.1GB' }),
				JSON.stringify({ ID: 'sha256:cccccccccccc3333', Repository: 'redis', Tag: 'latest', Size: '41MB' })
			].join('\n')
		);
		const counted = countImageUse(images, ['acme/api:1.4', 'redis']);
		expect(counted.map((image) => [image.repoTags[0], image.inUseBy])).toEqual([
			['acme/api:1.4', 1],
			['node:22', 0],
			['redis:latest', 1]
		]);
	});

	it('never offers remove on a running container', () => {
		expect(containerActions('running')).not.toContain('remove');
		expect(containerActions('exited')).toContain('remove');
	});
});

describe('docker run (FR-28, FR-29, U13)', () => {
	it('passes environment values through the environment, never the command line', () => {
		const validated = validateFleetRunRequest({
			image: 'redis:7',
			name: 'cache',
			ports: [{ host: 6379, container: 6379 }],
			env: [{ name: 'REDIS_ARGS', value: '--requirepass hunter2-secret' }],
			volumes: [{ source: 'redisdata', target: '/data' }],
			restart: 'unless-stopped'
		});
		expect(validated.ok).toBe(true);
		if (!validated.ok) return;
		const { args, env } = dockerRunArgv(validated.request);
		expect(args).toEqual([
			'run',
			'-d',
			'--name',
			'cache',
			'-p',
			'6379:6379/tcp',
			'-e',
			'REDIS_ARGS',
			'--mount',
			'type=volume,source=redisdata,target=/data',
			'--restart',
			'unless-stopped',
			'redis:7'
		]);
		expect(args.join(' ')).not.toContain('hunter2');
		expect(env).toEqual({ REDIS_ARGS: '--requirepass hunter2-secret' });
	});

	it.each([
		[{ image: 'redis:7', privileged: true }, 'privileged'],
		[{ image: 'redis:7', network: 'host' }, 'network'],
		[{ image: 'redis:7', pid: 'host' }, 'pid'],
		[{ image: 'redis:7', volumes: [{ source: '/var/run/docker.sock', target: '/var/run/docker.sock' }] }, 'volumes'],
		[{ image: 'redis:7', env: [{ name: 'DOCKER_HOST', value: 'tcp://x' }] }, 'env'],
		[{ image: '--privileged' }, 'image'],
		[{ image: 'redis:7; rm -rf /' }, 'image'],
		[{ image: 'redis:7', name: 'a b' }, 'name'],
		[{ image: 'redis:7', volumes: [{ source: '/srv/a,b', target: '/x' }] }, 'volumes'],
		[{ image: 'redis:7', volumes: [{ source: 'pg', target: 'relative' }] }, 'volumes']
	])('refuses %j at %s', (request, field) => {
		const validated = validateFleetRunRequest(request);
		expect(validated).toMatchObject({ ok: false, field });
	});

	it('mounts host paths as binds with key=value syntax', () => {
		expect(mountSpec('/srv/shared/data', '/data', true)).toBe('type=bind,source=/srv/shared/data,target=/data,readonly');
		expect(mountSpec('C:\\shared', '/data', false)).toBe('type=bind,source=C:\\shared,target=/data');
	});

	it('masks run values and scans every output line', () => {
		expect(safeOutputLine('error: bad --requirepass hunter2-secret', ['--requirepass hunter2-secret'])).toBe('error: bad …');
	});
});

describe('pull progress and prune', () => {
	it('turns layer lines into a percentage', () => {
		const progress = createPullProgress();
		progress('a2abf6c4d29d: Pulling fs layer');
		const half = progress('a2abf6c4d29d: Downloading [=====>    ]  20.5MB/41MB');
		expect(half?.percent).toBe(25);
		const done = progress('a2abf6c4d29d: Pull complete');
		expect(done?.percent).toBe(100);
		expect(progress('Status: Downloaded newer image for redis:7')).toEqual({ message: 'Status: Downloaded newer image for redis:7' });
	});

	it('reads the prune summary', () => {
		expect(parsePruneSummary(['deleted: sha256:aaa', 'deleted: sha256:bbb', 'Total reclaimed space: 1.6GB'])).toEqual({
			reclaimedBytes: 1_600_000_000,
			removedCount: 2
		});
	});
});

describe('bind-mount sources under the shared folders (R-18, R-39)', () => {
	const realpath = async (target: string) => {
		if (target.startsWith('/missing')) throw new Error('ENOENT');
		// /srv/shared/link points outside the root.
		if (target === '/srv/shared/link') return '/etc';
		return target.replace(/\/+$/, '') || '/';
	};

	it('accepts a folder inside a root and refuses one outside, missing, or escaping through a link', async () => {
		const roots = resolveAllowedRoots({ workspaceRoot: '/srv/shared', extraRoots: ['relative'], purpose: 'files', platform: 'linux' });
		expect(roots).toEqual(['/srv/shared']);
		expect(await bindSourceAllowed('/srv/shared/data', roots, 'linux', realpath)).toBe(true);
		expect(await bindSourceAllowed('/srv/shared', roots, 'linux', realpath)).toBe(true);
		expect(await bindSourceAllowed('/srv/shared-other', roots, 'linux', realpath)).toBe(false);
		expect(await bindSourceAllowed('/srv/shared/link', roots, 'linux', realpath)).toBe(false);
		expect(await bindSourceAllowed('/missing/data', roots, 'linux', realpath)).toBe(false);
		expect(await bindSourceAllowed('/home/ops', roots, 'linux', realpath)).toBe(false);
	});
});
