import { CONNECTION_HEALTH_ERROR_CODES } from '@ever-works/contracts';
import { classifyProbeResult } from '../connection-health';

describe('classifyProbeResult', () => {
    it('success is healthy and resets the failure count', () => {
        expect(classifyProbeResult({ ok: true }, 7)).toEqual({
            health: 'healthy',
            errorCode: null,
            failureCount: 0,
        });
    });

    it('a rejected credential expires the connection immediately', () => {
        expect(classifyProbeResult({ ok: false, errorCode: 'credential_rejected' }, 0)).toEqual({
            health: 'expired',
            errorCode: 'credential_rejected',
            failureCount: 1,
        });
    });

    it('a missing Vault-style credential reference maps to expired with credential_missing', () => {
        expect(classifyProbeResult({ ok: false, errorCode: 'credential_missing' })).toEqual({
            health: 'expired',
            errorCode: 'credential_missing',
            failureCount: 1,
        });
    });

    it('credentials refused on a plain-http endpoint need the owner, so they expire', () => {
        expect(classifyProbeResult({ ok: false, errorCode: 'https_required' })).toEqual({
            health: 'expired',
            errorCode: 'https_required',
            failureCount: 1,
        });
    });

    it('literal credentials sent over plain http are a WARNING on a working connection, never expired', () => {
        expect(classifyProbeResult({ ok: true, warning: 'insecure_transport' }, 4)).toEqual({
            health: 'insecure_transport',
            errorCode: 'insecure_transport',
            failureCount: 0,
        });
        // A failed attempt is classified by its own cause; insecure_transport
        // alone can never expire a connection.
        expect(classifyProbeResult({ ok: false, errorCode: 'insecure_transport' }).health).toBe(
            'degraded',
        );
    });

    it('an unknown warning leaves a success healthy', () => {
        expect(classifyProbeResult({ ok: true, warning: 'something_else' })).toEqual({
            health: 'healthy',
            errorCode: null,
            failureCount: 0,
        });
    });

    it('1–2 consecutive other failures are degraded, the 3rd is unreachable', () => {
        expect(classifyProbeResult({ ok: false, errorCode: 'timeout' }, 0)).toEqual({
            health: 'degraded',
            errorCode: 'timeout',
            failureCount: 1,
        });
        expect(classifyProbeResult({ ok: false, errorCode: 'unreachable' }, 1).health).toBe(
            'degraded',
        );
        expect(classifyProbeResult({ ok: false, errorCode: 'unreachable' }, 2)).toEqual({
            health: 'unreachable',
            errorCode: 'unreachable',
            failureCount: 3,
        });
        expect(classifyProbeResult({ ok: false, errorCode: 'not_found' }, 10).health).toBe(
            'unreachable',
        );
    });

    it('an unknown or absent code is a plain failure — it can degrade, never expire', () => {
        expect(classifyProbeResult({ ok: false })).toEqual({
            health: 'degraded',
            errorCode: 'failed',
            failureCount: 1,
        });
        expect(
            classifyProbeResult({ ok: false, errorCode: 'Bearer sk-live-looks-like-a-body' }),
        ).toEqual({ health: 'degraded', errorCode: 'failed', failureCount: 1 });
    });

    it('never returns anything but a catalogue code', () => {
        for (const errorCode of [...CONNECTION_HEALTH_ERROR_CODES, 'raw body', null, undefined]) {
            const result = classifyProbeResult({ ok: false, errorCode });
            expect(CONNECTION_HEALTH_ERROR_CODES).toContain(result.errorCode);
        }
    });

    it('treats a corrupt previous count as zero', () => {
        expect(classifyProbeResult({ ok: false }, Number.NaN).failureCount).toBe(1);
        expect(classifyProbeResult({ ok: false }, -4).failureCount).toBe(1);
    });
});
