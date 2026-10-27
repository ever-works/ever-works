import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fleetConfirmFields } from '../fleet-confirm';
import { fleetPathWithQuery } from '../fleet-client';
import { FLEET_EXIT, fleetExitFor } from '../fleet-exit';
import {
    emitFleetError,
    emitFleetOk,
    fleetFirstList,
    fleetTable,
    readFleetCliError,
} from '../fleet-output';

/**
 * FL-19 T-09 — the CLI contract (spec ACC-FL19-13): the `--json` envelope, the
 * exit map 0 / 1 / 2 / 124, `--yes` / `--confirm-name` as the CONTRACTS §2.2
 * fields (no tokens), refusals read off the API's typed envelope.
 */

class Exit extends Error {
    constructor(readonly code: number) {
        super(`exit ${code}`);
    }
}

describe('fleet CLI contract', () => {
    let stdout: string[];
    let stderr: string[];

    beforeEach(() => {
        stdout = [];
        stderr = [];
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
            stdout.push(String(chunk));
            return true;
        });
        vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
            stderr.push(String(chunk));
            return true;
        });
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Exit(code ?? 0);
        }) as never);
    });

    afterEach(() => vi.restoreAllMocks());

    it('maps exits 0 / 1 / 2 / 124', () => {
        expect(FLEET_EXIT).toEqual({ ok: 0, failed: 1, usage: 2, timeout: 124 });
        expect(fleetExitFor('confirmation_required')).toBe(2);
        expect(fleetExitFor('invalid')).toBe(2);
        expect(fleetExitFor('permission_denied')).toBe(1);
        expect(fleetExitFor('timeout')).toBe(124);
    });

    it('prints { ok: true, data } with --json and exits 0', () => {
        expect(() => emitFleetOk(true, { computers: [] }, () => undefined)).toThrow(new Exit(0));
        expect(JSON.parse(stdout.join(''))).toEqual({ ok: true, data: { computers: [] } });
    });

    it('prints { ok: false, error } and exits 2 on a missing confirmation, summary on stderr (U10)', () => {
        const error = {
            code: 'confirmation_required' as const,
            hint: 'call again with confirm: true',
            details: { class: 'confirm', summary: 'Restart nginx on build-01?' },
        };
        expect(() => emitFleetError(true, error)).toThrow(new Exit(2));
        expect(JSON.parse(stdout.join(''))).toEqual({ ok: false, error });
        expect(stderr.join('')).toContain('confirmation_required');
        expect(stderr.join('')).toContain('Restart nginx on build-01?');
    });

    it('exits 1 on a refusal', () => {
        expect(() =>
            emitFleetError(false, { code: 'permission_denied', hint: 'ask the owner' }),
        ).toThrow(new Exit(1));
        expect(stderr.join('')).toContain('permission_denied — ask the owner');
    });

    it('reads the typed envelope, else the HTTP status', () => {
        expect(
            readFleetCliError({
                response: { status: 409, data: { error: { code: 'busy', hint: 'Ana holds it' } } },
            }),
        ).toEqual({ code: 'busy', hint: 'Ana holds it' });
        expect(
            readFleetCliError({
                response: { status: 404, data: { message: 'Cannot find route' } },
            }),
        ).toEqual({
            code: 'not_found',
            hint: 'Cannot find route',
        });
        expect(readFleetCliError(new Error('socket hang up'))).toEqual({
            code: 'internal',
            hint: 'socket hang up',
        });
    });

    it('turns --yes / --confirm-name / --ack-blast-radius / --no-wait into the request fields', () => {
        expect(fleetConfirmFields({})).toEqual({});
        expect(
            fleetConfirmFields({
                yes: true,
                confirmName: 'win-11-vm',
                ackBlastRadius: true,
                wait: false,
            }),
        ).toEqual({
            confirm: true,
            confirmName: 'win-11-vm',
            acknowledgeBlastRadius: true,
            wait: false,
        });
    });

    it('builds query strings without empty values', () => {
        expect(
            fleetPathWithQuery('/fleet/operations', {
                state: 'running',
                nodeId: undefined,
                limit: '20',
            }),
        ).toBe('/fleet/operations?state=running&limit=20');
        expect(fleetPathWithQuery('/fleet/status', {})).toBe('/fleet/status');
    });

    it('finds the list in a reply and aligns a table', () => {
        expect(fleetFirstList({ meta: 1, services: [{ name: 'nginx' }] })).toEqual([
            { name: 'nginx' },
        ]);
        expect(
            fleetTable([
                ['A', 'BB'],
                ['ccc', 'd'],
            ]),
        ).toBe('A    BB\nccc  d');
    });
});
