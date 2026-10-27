import { describe, expect, it } from 'vitest';
import type { FleetListeningPort } from '@ever-works/contracts';
import {
    otherPortsLine,
    parsePortInput,
    portAddress,
    portsGroups,
    programLine,
    reasonKey,
    timeLeft,
} from './ports.shared';

const row = (
    port: number,
    kind: FleetListeningPort['kind'],
    extra: Partial<FleetListeningPort> = {},
) =>
    ({
        port,
        proto: 'tcp',
        bind: '0.0.0.0',
        localOnly: false,
        kind,
        ...extra,
    }) as FleetListeningPort;

describe('ports.shared (FL-10)', () => {
    it('orders web servers first and folds the others with their names (S1)', () => {
        const groups = portsGroups({
            ports: [
                row(5432, 'other', { wellKnown: 'postgres' }),
                row(5173, 'web'),
                row(22, 'other', { wellKnown: 'ssh' }),
                row(3000, 'web'),
            ],
        });
        expect(groups.web.map((port) => port.port)).toEqual([3000, 5173]);
        expect(otherPortsLine(groups.other)).toBe(':22 ssh · :5432 postgres');
    });

    it('reads the program line, a container first', () => {
        expect(
            programLine(
                row(3000, 'web', { program: { name: 'node', pid: 4812, cwd: '~/code/api' } }),
            ),
        ).toBe('node (pid 4812) · ~/code/api');
        expect(
            programLine(row(8080, 'web', { container: { id: 'abc', name: 'acme-proxy' } })),
        ).toBe('acme-proxy (container)');
        expect(programLine(row(9, 'other'))).toBeNull();
    });

    it('parses "Open a port…"', () => {
        expect(parsePortInput(' 4000 ')).toBe(4000);
        expect(parsePortInput(':5173')).toBe(5173);
        expect(parsePortInput('0')).toBeNull();
        expect(parsePortInput('70000')).toBeNull();
        expect(parsePortInput('80a')).toBeNull();
    });

    it('formats the time left and the address', () => {
        expect(timeLeft('2026-10-21T10:00:00.000Z', Date.parse('2026-10-21T09:00:48.000Z'))).toBe(
            '59:12',
        );
        expect(timeLeft('2026-10-21T10:00:00.000Z', Date.parse('2026-10-21T11:00:00.000Z'))).toBe(
            '0:00',
        );
        expect(
            portAddress(
                row(9000, 'web', {
                    web: { scheme: 'https', status: 200, title: null, probedAt: '' },
                }),
            ),
        ).toBe('https://127.0.0.1:9000/');
        expect(reasonKey('preview-off')).toBe('previewOff');
    });
});
