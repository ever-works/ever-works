import { describe, expect, it } from 'vitest';
import {
    countNeedingAttention,
    countSendingUnencrypted,
    healthHintKey,
    healthLabelKey,
    healthTone,
    rowHealth,
    sendsCredentialsUnencrypted,
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
        // Unencrypted credentials are a warning on a working connection, never danger.
        expect(healthTone('insecure_transport')).toBe('warning');
    });

    it('labels every state with a camelCase i18n leaf', () => {
        expect(healthLabelKey('healthy')).toBe('healthy');
        expect(healthLabelKey('expired')).toBe('expired');
        expect(healthLabelKey('insecure_transport')).toBe('insecureTransport');
        expect(rowHealth({ health: 'insecure_transport' })).toBe('insecure_transport');
    });

    it('flags unencrypted credentials from the stored shape or the health warning, and never counts them as needing attention', () => {
        const rows = [
            { health: 'insecure_transport' },
            { health: 'unknown', insecureCredentialTransport: true },
            { health: 'healthy', insecureCredentialTransport: false },
            { health: 'expired', lastErrorCode: 'https_required' },
            {},
        ];
        expect(rows.map((row) => sendsCredentialsUnencrypted(row))).toEqual([
            true,
            true,
            false,
            false,
            false,
        ]);
        expect(countSendingUnencrypted(rows)).toBe(2);
        expect(countNeedingAttention(rows)).toBe(1);
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
        expect(healthHintKey({ lastErrorCode: 'https_required' })).toBe('httpsRequiredHint');
        expect(healthHintKey({ lastErrorCode: 'timeout' })).toBeNull();
        expect(healthHintKey({})).toBeNull();
    });
});
