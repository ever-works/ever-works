import { describe, expect, it } from 'vitest';
import { isUuid, sanitizeOpenBody, sanitizeUpdateBody, toComputerSocketUrl } from './computer-bff';

const NODE = '22222222-2222-4333-8444-555555555555';

describe('computer BFF helpers', () => {
    it('rebuilds the open body from its three accepted fields only', () => {
        expect(
            sanitizeOpenBody({
                nodeId: NODE,
                channels: ['screen', 'screen', 'microphone'],
                quality: 'steady',
                role: 'controller',
                profileKey: 'x',
            }),
        ).toEqual({ nodeId: NODE, channels: ['screen'], quality: 'steady' });
        expect(sanitizeOpenBody({ nodeId: '../x', channels: 'screen', quality: 'ultra' })).toEqual(
            {},
        );
    });

    it('rebuilds the update body from quality and channel only', () => {
        expect(
            sanitizeUpdateBody({ quality: 'smooth', activeChannel: 'terminal', status: 'ended' }),
        ).toEqual({
            quality: 'smooth',
            activeChannel: 'terminal',
        });
        expect(sanitizeUpdateBody({ quality: 'ultra' })).toEqual({});
    });

    it('turns the API base into the live-view socket URL on its origin', () => {
        expect(toComputerSocketUrl('https://api.ever.works/api', '/ws/computer/abc')).toBe(
            'wss://api.ever.works/ws/computer/abc',
        );
        expect(toComputerSocketUrl('http://localhost:3100/api/', 'ws/computer/abc')).toBe(
            'ws://localhost:3100/ws/computer/abc',
        );
    });

    it('checks ids before anything leaves the web tier', () => {
        expect(isUuid(NODE)).toBe(true);
        expect(isUuid('not-an-id')).toBe(false);
        expect(isUuid(undefined)).toBe(false);
    });
});
