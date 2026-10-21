import { describe, expect, it } from 'vitest';
import {
	composeActionArgs,
	composeActions,
	composeCounts,
	mergeComposeServices,
	parseComposeConfig,
	parseComposeLs,
	parseComposePs,
	projectView
} from './compose';

/**
 * FL-09 P3 — Compose through `docker compose`: the three reads merged into
 * the picture's description, Down never removing named volumes, and a project
 * whose files are gone offering Down only.
 */

const CONFIG = JSON.stringify({
	name: 'acme',
	services: {
		api: {
			image: 'acme/api:1.4',
			depends_on: { db: { condition: 'service_healthy' }, cache: { condition: 'service_started' } },
			ports: [{ target: 3000, published: '3000', protocol: 'tcp' }],
			networks: { acme_default: null }
		},
		db: {
			image: 'postgres:16',
			volumes: [{ type: 'volume', source: 'pgdata', target: '/var/lib/postgresql/data' }],
			networks: { acme_default: null }
		},
		cache: { image: 'redis:7', volumes: [{ type: 'bind', source: '/srv/acme/redis.conf', target: '/etc/redis.conf' }] }
	},
	networks: { acme_default: {} },
	volumes: { pgdata: {} }
});

describe('compose readers', () => {
	it('reads compose ls with comma-separated config files', () => {
		expect(parseComposeLs('[{"Name":"acme","Status":"running(3)","ConfigFiles":"/srv/acme/compose.yml,/srv/acme/compose.override.yml"}]')).toEqual([
			{ name: 'acme', status: 'running(3)', configFiles: ['/srv/acme/compose.yml', '/srv/acme/compose.override.yml'] }
		]);
		expect(composeCounts('exited(1), running(2)')).toEqual({ running: 2, total: 3 });
	});

	it('offers Down only when the files are gone (U14)', () => {
		const view = projectView({ name: 'acme', status: 'running(3)', configFiles: ['/gone/compose.yml'] }, () => false);
		expect(view).toMatchObject({ filesMissing: true, actions: ['down'] });
		expect(composeActions(false)).toEqual(['up', 'down', 'restart', 'pull']);
	});

	it('reads depends_on conditions, ports, networks, named volumes and mounts', () => {
		const config = parseComposeConfig(CONFIG);
		const api = config.services.find((service) => service.name === 'api');
		expect(api?.dependsOn).toEqual([
			{ service: 'db', condition: 'service_healthy' },
			{ service: 'cache', condition: 'service_started' }
		]);
		expect(api?.ports).toEqual([{ hostIp: null, hostPort: 3000, containerPort: 3000, proto: 'tcp' }]);
		expect(config.services.find((service) => service.name === 'db')?.volumes).toEqual(['pgdata']);
		expect(config.services.find((service) => service.name === 'cache')?.mounts).toEqual(['/srv/acme/redis.conf']);
		expect(config.volumes).toEqual(['pgdata']);
	});

	it('reads compose ps as a JSON array or as JSON lines, and merges', () => {
		const lines = [
			JSON.stringify({ Service: 'api', ID: 'aaaaaaaaaaaa1111', Name: 'acme-api-1', State: 'running', Health: '', Publishers: [] }),
			JSON.stringify({ Service: 'db', ID: 'bbbbbbbbbbbb2222', Name: 'acme-db-1', State: 'running', Health: 'starting' })
		].join('\n');
		const fromLines = parseComposePs(lines);
		const fromArray = parseComposePs(`[${lines.split('\n').join(',')}]`);
		expect(fromLines).toEqual(fromArray);
		const merged = mergeComposeServices(parseComposeConfig(CONFIG), fromLines, new Map([['aaaaaaaaaaaa', { cpuPercent: 2, memBytes: 180 }]]));
		expect(merged.map((service) => [service.name, service.state, service.health])).toEqual([
			['api', 'running', null],
			['db', 'running', 'starting'],
			['cache', 'absent', null]
		]);
		expect(merged[0]).toMatchObject({ cpuPercent: 2, containerId: 'aaaaaaaaaaaa' });
	});
});

describe('compose acts (FR-32, FR-34, FR-36)', () => {
	it('never removes named volumes on Down', () => {
		const args = composeActionArgs('acme', ['/srv/acme/compose.yml'], 'down');
		expect(args).toEqual(['compose', '-p', 'acme', '-f', '/srv/acme/compose.yml', '--project-directory', '/srv/acme', 'down']);
		expect(args).not.toContain('-v');
		expect(args).not.toContain('--volumes');
	});

	it('targets one service when asked, and works from the labels without files', () => {
		expect(composeActionArgs('acme', ['/srv/acme/compose.yml'], 'up', 'api')).toEqual([
			'compose',
			'-p',
			'acme',
			'-f',
			'/srv/acme/compose.yml',
			'--project-directory',
			'/srv/acme',
			'up',
			'-d',
			'api'
		]);
		expect(composeActionArgs('acme', [], 'down')).toEqual(['compose', '-p', 'acme', 'down']);
	});
});
