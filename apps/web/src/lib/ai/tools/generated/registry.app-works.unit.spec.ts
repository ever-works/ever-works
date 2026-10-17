import { describe, expect, it } from 'vitest';
import { ALL_OPERATIONS } from './registry.all';
import { selectActiveToolNames } from '../tool-selection';

/**
 * APW-08 T26 — the App Works chat tools exist, point at the API routes that exist, and are
 * REACHABLE (APW08-G20: a registry row with no keyword slot is gated out of every turn).
 */
const byName = (toolName: string) => ALL_OPERATIONS.find((op) => op.toolName === toolName);
const ALL_TOOL_NAMES = ALL_OPERATIONS.map((op) => op.toolName);

describe('App Works chat tools (APW-08 T26)', () => {
    it('registers request_app_change against POST /api/works/{id}/evolve, behind confirmation', () => {
        const op = byName('request_app_change');
        expect(op).toMatchObject({
            method: 'POST',
            path: '/api/works/{id}/evolve',
            kind: 'action',
            body: true,
        });
        expect(op?.requiresConfirmation).toBe(true);
        expect(op?.bodyHint).toMatch(/request/);
        expect(op?.params?.map((p) => p.name)).toEqual(['id']);
    });

    it('registers the read and provisioning rows once each', () => {
        expect(byName('list_app_changes')).toMatchObject({
            method: 'GET',
            path: '/api/works/{id}/evolve',
        });
        expect(byName('provision_app_work')).toMatchObject({
            method: 'POST',
            path: '/api/works/{id}/provision',
        });
        expect(byName('get_app_provisioning')).toMatchObject({
            method: 'GET',
            path: '/api/works/{id}/provisioning',
        });
        for (const name of [
            'request_app_change',
            'list_app_changes',
            'provision_app_work',
            'get_app_provisioning',
        ]) {
            expect(ALL_TOOL_NAMES.filter((n) => n === name)).toHaveLength(1);
        }
    });

    it.each([
        ['add a feature to this app: SMS reminders', 'request_app_change'],
        ['can you fix the bug in the app where login loops', 'request_app_change'],
        ['what happened to my change request?', 'list_app_changes'],
        ['provision this app work', 'provision_app_work'],
    ])('%j reaches %s', (text, expected) => {
        expect(selectActiveToolNames(ALL_TOOL_NAMES, { text })).toContain(expected);
    });

    it('does not leak into unrelated turns', () => {
        for (const text of [
            'rotate my api key',
            'approve the pending item',
            'what happened yesterday',
        ]) {
            expect(selectActiveToolNames(ALL_TOOL_NAMES, { text })).not.toContain(
                'request_app_change',
            );
        }
    });
});
