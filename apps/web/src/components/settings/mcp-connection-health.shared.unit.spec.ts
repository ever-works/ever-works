import { describe, expect, it } from 'vitest';
import {
    countNeedingAttention,
    healthHintKey,
    healthTone,
    rowHealth,
} from './mcp-connection-health.shared';

describe('MCP connection health presentation', () => {
    it('reads a row without health columns as not checked yet', () => {
        expect(rowHealth({})).toBe('unknown');
        expect(rowHealth({ health: 'bogus' })).toBe('unknown');
        expect(rowHealth({ health: 'expired' })).toBe('expired');
    });

    it('maps each state to a tone', () => {
        expect(healthTone('healthy')).toBe('success');
        expect(healthTone('degraded')).toBe('warning');
        expect(healthTone('expired')).toBe('danger');
        expect(healthTone('unreachable')).toBe('danger');
        expect(healthTone('unknown')).toBe('muted');
    });

    it('counts only expired and unreachable rows for the banner', () => {
        expect(
            countNeedingAttention([
                { health: 'healthy' },
                { health: 'expired' },
                { health: 'degraded' },
                { health: 'unreachable' },
                {},
            ]),
        ).toBe(2);
    });

    it('adds a hint only for failures the owner has to fix', () => {
        expect(healthHintKey({ lastErrorCode: 'credential_missing' })).toBe(
            'credentialMissingHint',
        );
        expect(healthHintKey({ lastErrorCode: 'insecure_transport' })).toBe(
            'insecureTransportHint',
        );
        expect(healthHintKey({ lastErrorCode: 'credential_rejected' })).toBe(
            'credentialRejectedHint',
        );
        expect(healthHintKey({ lastErrorCode: 'timeout' })).toBeNull();
        expect(healthHintKey({})).toBeNull();
    });
});
