import { StateMarkerService, type MarkerFileWriter, STATE_MARKER_DEFAULT_PATH } from '../state-marker.service';

describe('StateMarkerService', () => {
    const baseInput = {
        repoUrl: 'https://github.com/octocat/awesome-mcp',
        token: 'token-aaaa',
        state: {
            status: 'deployed' as const,
            workId: 'w-1',
            subdomain: 'mydir.ever.works',
            deploymentUrl: 'https://mydir.ever.works',
            updatedAt: '2026-05-05T00:00:00Z',
            deliveryId: 'd-1',
        },
    };

    it('writes the marker to .works/state.json by default', async () => {
        const writer: MarkerFileWriter = { writeFile: jest.fn().mockResolvedValue(undefined) };
        const svc = new StateMarkerService(writer);

        await svc.write(baseInput);

        expect(writer.writeFile).toHaveBeenCalledTimes(1);
        const arg = (writer.writeFile as jest.Mock).mock.calls[0][0];
        expect(arg.path).toBe(STATE_MARKER_DEFAULT_PATH);
        expect(arg.repoUrl).toBe(baseInput.repoUrl);
        expect(arg.commitMessage).toContain('deployed');
        expect(arg.commitMessage).toContain('w-1');
        expect(arg.commitMessage).toContain('d-1');
        const body = JSON.parse(arg.contents);
        expect(body).toMatchObject({
            status: 'deployed',
            workId: 'w-1',
            deliveryId: 'd-1',
        });
    });

    it('uses a custom marker path when supplied', async () => {
        const writer: MarkerFileWriter = { writeFile: jest.fn().mockResolvedValue(undefined) };
        const svc = new StateMarkerService(writer);

        await svc.write({ ...baseInput, markerPath: '.works/status/latest.json' });

        const arg = (writer.writeFile as jest.Mock).mock.calls[0][0];
        expect(arg.path).toBe('.works/status/latest.json');
    });

    it('throws when the marker path is outside .works/', async () => {
        const writer: MarkerFileWriter = { writeFile: jest.fn() };
        const svc = new StateMarkerService(writer);

        await expect(
            svc.write({ ...baseInput, markerPath: 'state.json' }),
        ).rejects.toThrow(/under \.works\//);
        expect(writer.writeFile).not.toHaveBeenCalled();
    });

    it('propagates writer errors', async () => {
        const writer: MarkerFileWriter = {
            writeFile: jest.fn().mockRejectedValue(new Error('git push failed')),
        };
        const svc = new StateMarkerService(writer);

        await expect(svc.write(baseInput)).rejects.toThrow('git push failed');
    });

    it('serialises failure payloads', async () => {
        const writer: MarkerFileWriter = { writeFile: jest.fn().mockResolvedValue(undefined) };
        const svc = new StateMarkerService(writer);

        await svc.write({
            ...baseInput,
            state: {
                ...baseInput.state,
                status: 'failed',
                failureCode: 'manifest_invalid',
                failureMessage: 'spec.domain invalid',
            },
        });

        const arg = (writer.writeFile as jest.Mock).mock.calls[0][0];
        const body = JSON.parse(arg.contents);
        expect(body.status).toBe('failed');
        expect(body.failureCode).toBe('manifest_invalid');
        expect(body.failureMessage).toBe('spec.domain invalid');
    });
});
