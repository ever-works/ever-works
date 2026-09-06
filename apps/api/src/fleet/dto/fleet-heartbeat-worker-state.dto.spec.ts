import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
    FLEET_MAX_WORKER_STATE_REASON_LENGTH,
    FLEET_NODE_WORKER_STATES,
} from '@ever-works/contracts';
import { FleetHeartbeatDto } from './fleet.dto';

/**
 * Fleet health signals (EW-776) — the heartbeat DTO's half of the
 * compatibility contract.
 *
 * The global pipe runs `whitelist + forbidNonWhitelisted`, which makes
 * this file load-bearing in a way most DTOs are not: a field the DTO does
 * not accept is not dropped, it fails the whole request — and a failed
 * heartbeat is a node that goes offline. So both directions are pinned
 * here:
 *
 *   - a NEWER node reporting a worker state an OLDER API has never heard
 *     of must still beat (hence `@IsString`, not `@IsIn`);
 *   - an OLDER node that sends nothing must still beat (hence
 *     `@IsOptional`).
 *
 * The node-side half — that a daemon keeps beating when a 400 says the
 * API predates the field — lives in `apps/node/src/core/heartbeat.spec.ts`.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'a'.repeat(43);

async function failingProperties(dto: object): Promise<string[]> {
    const errors = await validate(dto);
    return errors.map((error) => error.property).sort();
}

const beat = (extra: Record<string, unknown>) =>
    plainToInstance(FleetHeartbeatDto, { nodeId: NODE_ID, secret: SECRET, ...extra });

describe('FleetHeartbeatDto — worker state', () => {
    it.each(FLEET_NODE_WORKER_STATES.map((state) => [state]))('accepts %s', async (state) => {
        await expect(failingProperties(beat({ workerState: state }))).resolves.toEqual([]);
    });

    it('accepts a state with its reason', async () => {
        const dto = beat({
            workerState: 'quarantined',
            workerStateReason: 'process tree for job 42 could not be proven terminated',
        });
        await expect(failingProperties(dto)).resolves.toEqual([]);
    });

    it('accepts a value a NEWER node invented, rather than failing the beat', async () => {
        // This is the whole reason the field is bounded as a string. A 400
        // here would take a live machine offline for reporting the truth
        // about itself; the server records it as "unknown" instead.
        await expect(failingProperties(beat({ workerState: 'hibernating' }))).resolves.toEqual([]);
    });

    it('accepts a beat that says nothing about the worker at all', async () => {
        // Every daemon in the field today. Absent must stay valid, and the
        // service reads it as "leave the stored value alone".
        await expect(failingProperties(beat({}))).resolves.toEqual([]);
    });

    it('accepts the reason at exactly the contract bound', async () => {
        const dto = beat({
            workerState: 'throttled',
            workerStateReason: 'x'.repeat(FLEET_MAX_WORKER_STATE_REASON_LENGTH),
        });
        await expect(failingProperties(dto)).resolves.toEqual([]);
    });

    it('rejects a reason past the bound', async () => {
        // The reason is free text from an untrusted machine; without a cap
        // a heartbeat field is unbounded storage.
        const dto = beat({
            workerState: 'throttled',
            workerStateReason: 'x'.repeat(FLEET_MAX_WORKER_STATE_REASON_LENGTH + 1),
        });
        await expect(failingProperties(dto)).resolves.toEqual(['workerStateReason']);
    });

    it('rejects an absurdly long worker state', async () => {
        await expect(failingProperties(beat({ workerState: 'x'.repeat(33) }))).resolves.toEqual([
            'workerState',
        ]);
    });

    it.each([
        ['a number', 42],
        ['an object', { state: 'idle' }],
        ['an array', ['idle']],
    ])('rejects %s as a worker state', async (_label, workerState) => {
        await expect(failingProperties(beat({ workerState }))).resolves.toEqual(['workerState']);
    });

    it('treats an explicit null as "said nothing", like every other optional field', async () => {
        // `@IsOptional()` skips null by design, and the service matches
        // that: a client that serializes missing fields as null must not
        // wipe a reading an older client would have preserved.
        await expect(failingProperties(beat({ workerState: null }))).resolves.toEqual([]);
    });

    it('rejects a non-string reason', async () => {
        await expect(
            failingProperties(beat({ workerState: 'idle', workerStateReason: 7 })),
        ).resolves.toEqual(['workerStateReason']);
    });

    it('still requires the credential — the new fields buy no authority', async () => {
        const dto = plainToInstance(FleetHeartbeatDto, { workerState: 'idle' });
        await expect(failingProperties(dto)).resolves.toEqual(['nodeId', 'secret']);
    });
});
