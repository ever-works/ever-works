import { describe, expect, it } from 'vitest';
import type { FleetComposeServiceView } from '@ever-works/contracts';
import { composeLayers, edgeTone, layoutCompose } from './compose-layout';
import { requestFromForm, splitCommand, EMPTY_RUN_FORM } from './docker.shared';

/**
 * FL-09 P3 — the Compose picture's layout (deterministic, cycle-safe, arrows
 * pointing from a service to what it depends on) and the Run dialog's
 * form → request.
 */

function service(name: string, overrides: Partial<FleetComposeServiceView> = {}): FleetComposeServiceView {
    return {
        name,
        image: `${name}:1`,
        state: 'running',
        health: null,
        containerId: null,
        containerName: null,
        cpuPercent: null,
        memBytes: null,
        ports: [],
        networks: [],
        volumes: [],
        mounts: [],
        dependsOn: [],
        ...overrides,
    };
}

describe('compose layout (FR-33)', () => {
    const services = [
        service('api', { dependsOn: [{ service: 'db', condition: 'service_healthy' }, { service: 'cache', condition: 'service_started' }] }),
        service('db', { health: 'starting' }),
        service('cache'),
    ];

    it('puts a service left of what it depends on', () => {
        const layout = layoutCompose(services);
        const x = new Map(layout.boxes.map((box) => [box.name, box.x]));
        expect(x.get('api')).toBeLessThan(x.get('db')!);
        expect(x.get('db')).toBe(x.get('cache'));
        expect(layout.edges).toHaveLength(2);
    });

    it('is the same for the same input', () => {
        expect(layoutCompose(services)).toEqual(layoutCompose([...services].reverse()));
    });

    it('colours an arrow amber while a healthy-condition dependency is not healthy, red when down', () => {
        expect(edgeTone(services[1], 'service_healthy')).toBe('amber');
        expect(edgeTone({ state: 'running', health: 'healthy' }, 'service_healthy')).toBe('grey');
        expect(edgeTone({ state: 'exited', health: null }, 'service_started')).toBe('red');
        expect(edgeTone(undefined, 'service_started')).toBe('red');
    });

    it('survives a cycle', () => {
        const layers = composeLayers([
            { name: 'a', dependsOn: [{ service: 'b', condition: 'service_started' }] },
            { name: 'b', dependsOn: [{ service: 'a', condition: 'service_started' }] },
        ]);
        expect([...layers.keys()].sort()).toEqual(['a', 'b']);
    });
});

describe('Run dialog form (FR-28, FR-29)', () => {
    it('splits a command with quotes', () => {
        expect(splitCommand('redis-server --save "60 1" --appendonly yes')).toEqual(['redis-server', '--save', '60 1', '--appendonly', 'yes']);
    });

    it('builds a validated request and a preview without values', () => {
        const built = requestFromForm({
            ...EMPTY_RUN_FORM,
            image: 'redis:7',
            name: 'cache',
            ports: [{ host: '6379', container: '6379', proto: 'tcp' }],
            env: [{ name: 'REDIS_ARGS', value: 'secret-value' }],
        });
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        expect(built.preview).toBe('docker run -d --name cache -p 6379:6379 -e REDIS_ARGS=… --restart unless-stopped redis:7');
        expect(built.preview).not.toContain('secret-value');
    });

    it('refuses the socket as a volume', () => {
        const built = requestFromForm({
            ...EMPTY_RUN_FORM,
            image: 'redis:7',
            volumes: [{ source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: false }],
        });
        expect(built).toMatchObject({ ok: false, field: 'volumes' });
    });
});
