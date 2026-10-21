import { describe, expect, it } from 'vitest';
import type { FleetServiceView } from '@ever-works/contracts';
import {
    dialogForRow,
    dialogFromRefusal,
    fieldsForDialog,
    formatBytes,
    formatRuntime,
    isDangerDialog,
    rootRequiredFrom,
    typedNameMatches,
} from './machine-actions.shared';
import { atBootAction, primaryActions, riskMarker, visibleServices } from '../services/services.shared';
import { gpuParts, shouldOfferKill } from '../processes/processes.shared';

/**
 * FL-09 P1 — the pure half of the machine tabs: the dialog a row or a refusal
 * calls for, the CONTRACTS §2.2 fields that satisfy it, the root dialog, the
 * Services row buttons, and the GPU strip.
 */

describe('confirm dialogs (CONTRACTS §2.2)', () => {
    it('opens a plain confirm for a row without a warning', () => {
        const model = dialogForRow({ class: 'confirm', title: 'Restart nginx on build-01?' });
        expect(model).toEqual({ class: 'confirm', title: 'Restart nginx on build-01?' });
        expect(fieldsForDialog(model!)).toEqual({ confirm: true });
        expect(isDangerDialog(model!)).toBe(false);
    });

    it('raises a row with a blast radius to a red blast-radius dialog with both fields', () => {
        const model = dialogForRow({
            class: 'blast-radius',
            title: 'Stop NetworkManager on build-01?',
            blastRadius: { kind: 'network', sentence: 'This stops the network service…' },
        });
        expect(model).toMatchObject({ class: 'blast-radius', sentence: 'This stops the network service…' });
        expect(isDangerDialog(model!)).toBe(true);
        expect(fieldsForDialog(model!)).toEqual({ confirm: true, acknowledgeBlastRadius: true });
    });

    it('needs the exact name for a destructive dialog', () => {
        const model = dialogForRow({ class: 'confirm-destructive', title: 'Remove acme-api?', typeName: 'acme-api' })!;
        expect(typedNameMatches(model, 'acme-ap')).toBe(false);
        expect(typedNameMatches(model, 'acme-api')).toBe(true);
        expect(fieldsForDialog(model, 'acme-api')).toEqual({ confirmName: 'acme-api' });
    });

    it('reads the dialog a confirmation_required refusal describes', () => {
        const model = dialogFromRefusal(
            {
                code: 'confirmation_required',
                hint: 'x',
                details: { class: 'blast-radius', summary: 'Stop sshd on build-01?', sentence: 'This stops remote access…' },
            },
            'fallback',
        );
        expect(model).toEqual({ class: 'blast-radius', title: 'Stop sshd on build-01?', sentence: 'This stops remote access…' });
        expect(dialogFromRefusal({ code: 'invalid', hint: 'x' }, 'fallback')).toBeNull();
    });

    it('reads the root dialog, never a password field', () => {
        expect(
            rootRequiredFrom({
                code: 'root_required',
                hint: 'sudo systemctl restart nginx',
                details: { command: 'sudo systemctl restart nginx', shell: 'sh' },
            }),
        ).toEqual({ command: 'sudo systemctl restart nginx', shell: 'sh' });
        expect(rootRequiredFrom({ code: 'root_required', hint: 'Restart-Service -Name W3SVC', details: { shell: 'powershell' } })).toEqual({
            command: 'Restart-Service -Name W3SVC',
            shell: 'powershell',
        });
    });
});

describe('formatting', () => {
    it('formats bytes and run times like the spec', () => {
        expect(formatBytes(41 * 1024 * 1024)).toBe('41 MB');
        expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
        expect(formatBytes(null)).toBe('—');
        expect(formatRuntime(724)).toBe('12:04');
        expect(formatRuntime(3 * 86400)).toBe('3 d');
    });
});

function service(overrides: Partial<FleetServiceView>): FleetServiceView {
    return {
        id: 'systemd:system:x',
        name: 'x',
        description: null,
        manager: 'systemd',
        scope: 'system',
        state: 'running',
        since: null,
        exitCode: null,
        atBoot: true,
        pid: 1,
        cpuPercent: null,
        memBytes: null,
        actions: ['start', 'stop', 'restart', 'enable', 'disable'],
        confirmation: {},
        blastRadius: null,
        root: { required: true, preauthorized: null, command: null },
        isNode: false,
        ...overrides,
    };
}

describe('Services rows (spec §5.1)', () => {
    it('shows Start on a failed row and Restart + Stop on a running one', () => {
        expect(primaryActions(service({ state: 'failed' }))).toEqual(['start']);
        expect(primaryActions(service({ state: 'running' }))).toEqual(['restart', 'stop']);
        expect(primaryActions(service({ state: 'running', actions: [] }))).toEqual([]);
    });

    it('toggles at boot from the current value', () => {
        expect(atBootAction(service({ atBoot: true }))).toBe('disable');
        expect(atBootAction(service({ atBoot: false }))).toBe('enable');
        expect(atBootAction(service({ atBoot: null, actions: ['start'] }))).toBeNull();
    });

    it('marks the node and the risky services', () => {
        expect(riskMarker(service({ isNode: true }))).toBe('node');
        expect(riskMarker(service({ blastRadius: { kind: 'ssh', sentence: 's' } }))).toBe('ssh');
        expect(riskMarker(service({}))).toBeNull();
    });

    it('filters and keeps failed first', () => {
        const rows = visibleServices(
            [service({ id: 'a', name: 'nginx' }), service({ id: 'b', name: 'postgresql', state: 'failed' })],
            '',
        );
        expect(rows.map((row) => row.name)).toEqual(['postgresql', 'nginx']);
        expect(visibleServices(rows, 'ngi').map((row) => row.name)).toEqual(['nginx']);
    });
});

describe('Processes tab', () => {
    it('says utilisation unavailable rather than a dash on Apple', () => {
        expect(
            gpuParts({ vendor: 'apple', model: 'Apple M2 Max', utilizationPercent: null, memUsedBytes: null, memTotalBytes: 38 * 1024 ** 3, sharedMemory: true }),
        ).toEqual({ model: 'Apple M2 Max', utilization: null, memory: '38 GB', shared: true });
    });

    it('offers Kill 5 s after a Stop when the process is still listed', () => {
        expect(shouldOfferKill(1_000, true, 5_999)).toBe(false);
        expect(shouldOfferKill(1_000, true, 6_000)).toBe(true);
        expect(shouldOfferKill(1_000, false, 9_000)).toBe(false);
        expect(shouldOfferKill(undefined, true, 9_000)).toBe(false);
    });
});
