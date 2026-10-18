import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { FLEET_LINK_CLOSE_CODES, FLEET_LINK_DEFAULT_LIMITS } from '@ever-works/contracts';
import { FleetHeartbeatDto } from '../../fleet/dto/fleet.dto';
import { FleetLinkRegistry } from '../fleet-link.registry';
import { hello, NODE_ID, OWNER, RecordingPort } from './link-test-kit';

/**
 * The link's wire truth, platform side (FL-02, ACC-FL02-03): what the API
 * actually answers matches `packages/contracts/fixtures/fleet-link-contract.v1.json`,
 * and the heartbeat's `consents` passes the deployment's own validation pipe
 * (`whitelist + forbidNonWhitelisted`) — including a consent this API has
 * never heard of, which must not fail a newer node's beat.
 */

interface LinkFixture {
    limits: Record<string, number>;
    linkToken: { response: Record<string, unknown> };
    closeCodes: Record<string, number>;
    control: Record<string, Record<string, unknown>>;
}

const fixture = JSON.parse(
    readFileSync(
        resolve(
            __dirname,
            '../../../../../packages/contracts/fixtures/fleet-link-contract.v1.json',
        ),
        'utf8',
    ),
) as LinkFixture;

/** The pipe main.ts runs. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const beat = (extra: Record<string, unknown>) =>
    pipe.transform(
        { nodeId: NODE_ID, secret: 'a'.repeat(43), platform: 'linux/x64', ...extra },
        { type: 'body', metatype: FleetHeartbeatDto },
    );

describe('fleet-link-contract.v1.json — platform side', () => {
    it('answers ready with the fixture’s limits and shape', () => {
        const registry = new FleetLinkRegistry();
        const session = registry.accept({
            nodeId: NODE_ID,
            ownerUserId: OWNER,
            nodeName: 'build-01',
            nodeKind: 'node',
            hello: hello(),
            socket: new RecordingPort(),
        });
        expect(Object.keys(session.ready).sort()).toEqual(
            Object.keys(fixture.control.ready).sort(),
        );
        expect(session.ready.limits).toEqual(fixture.control.ready.limits);
        expect(FLEET_LINK_DEFAULT_LIMITS).toMatchObject({
            maxFrameBytes: fixture.limits.maxFrameBytes,
            maxChannels: fixture.limits.maxChannels,
        });
    });

    it('keeps the close codes the node reads', () => {
        expect({ ...FLEET_LINK_CLOSE_CODES }).toEqual(fixture.closeCodes);
    });

    it('mints the token response the fixture names', () => {
        expect(Object.keys(fixture.linkToken.response).sort()).toEqual([
            'expiresInSec',
            'token',
            'wsPath',
        ]);
    });
});

describe('heartbeat consents through the deployment’s validation pipe', () => {
    it('accepts the four consents', async () => {
        const dto = (await beat({
            consents: { work: true, attend: false, manage: true, usageScan: false },
        })) as FleetHeartbeatDto;
        expect(dto.consents).toEqual({ work: true, attend: false, manage: true, usageScan: false });
    });

    it('accepts a consent this API has never heard of (a newer node)', async () => {
        await expect(
            beat({
                consents: {
                    work: true,
                    attend: false,
                    manage: true,
                    usageScan: false,
                    teleport: true,
                },
            }),
        ).resolves.toBeDefined();
    });

    it('refuses a non-boolean value, a non-object, and an absurd key count', async () => {
        await expect(beat({ consents: { work: 'yes' } })).rejects.toBeInstanceOf(
            BadRequestException,
        );
        await expect(beat({ consents: ['work'] })).rejects.toBeInstanceOf(BadRequestException);
        await expect(beat({ consents: 'all' })).rejects.toBeInstanceOf(BadRequestException);
        const many = Object.fromEntries(
            Array.from({ length: 17 }, (_, i) => [`consent${i}`, true]),
        );
        await expect(beat({ consents: many })).rejects.toBeInstanceOf(BadRequestException);
        await expect(beat({ consents: { 'not a key': true } })).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('still answers a beat without consents exactly as before', async () => {
        await expect(beat({})).resolves.toBeDefined();
    });
});
