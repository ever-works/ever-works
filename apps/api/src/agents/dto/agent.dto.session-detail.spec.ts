import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

/**
 * `agent.dto.ts` pulls its enums from the `@ever-works/agent/agents`
 * barrel, whose runtime graph (services → facades → entities) does not
 * load under this app's jest module mapping. Stub the three barrels with
 * exactly the values the decorators evaluate at module load — the cursor
 * rules under test use nothing from them, so the validation exercised here
 * is entirely real. Same precedent as `agent.dto.init-script.spec.ts`.
 *
 * `@ever-works/contracts` is deliberately NOT mocked: the cursor pattern
 * lives there, and the whole point of these cases is that the edge admits
 * exactly the shapes the store knows how to consume.
 */
jest.mock('@ever-works/agent/agents', () => ({
    AGENT_GUARDRAIL_MODES: ['off', 'warn', 'block'],
    AgentAvatarMode: { INITIALS: 'initials', ICON: 'icon', IMAGE: 'image' },
    AgentIdleBehavior: { PROPOSE: 'propose', IDLE: 'idle' },
    AgentScope: { TENANT: 'tenant', MISSION: 'mission', IDEA: 'idea', WORK: 'work' },
    AgentStatus: { DRAFT: 'draft', ACTIVE: 'active', PAUSED: 'paused' },
}));
jest.mock('@ever-works/agent/agent-approvals', () => ({
    AGENT_ACTION_PROPOSAL_ACTION_TYPES: ['commit', 'pull-request'],
}));
jest.mock('@ever-works/agent/validation', () => ({
    MergePolicyDto: class MergePolicyDto {},
}));

import { SessionDetailQueryDto } from './agent.dto';

/** The row id shape every non-sqlite store's tie-break column holds. */
const ROW_ID = '00000000-0000-4000-8000-00000000cc62';

async function cursorErrors(cursor: string) {
    const dto = plainToInstance(SessionDetailQueryDto, { cursor });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    return errors.filter((error) => error.property === 'cursor');
}

/**
 * Session detail (Feature K) — what
 * `GET /api/agents/runs/:runId/detail?cursor=…` accepts.
 *
 * The edge is the ONLY gate in front of the keyset predicate: the
 * controller's parser decides on shape alone and the repository binds what
 * it is given. So a cursor shape admitted here that no store's tie-break
 * column can hold is not a 400 — it is an `invalid input syntax for type
 * uuid` from Postgres, surfacing as an HTTP 500.
 */
describe('SessionDetailQueryDto — timeline cursor', () => {
    it('accepts the uuid cursor a browser minted before the integer form existed', async () => {
        // Backward compatibility is the reason the shape was widened at
        // all: a tab open across the change keeps paging.
        await expect(cursorErrors(`1758128000000_${ROW_ID}`)).resolves.toEqual([]);
    });

    it('accepts the integer insertion-order cursor the sqlite family mints', async () => {
        await expect(cursorErrors('1758128000000_42')).resolves.toEqual([]);
        await expect(cursorErrors('0_1')).resolves.toEqual([]);
    });

    it('⭐ rejects a tie-break of a shape no store can compare', async () => {
        for (const cursor of [
            // 36 hex-ish characters that are not a uuid — accepted by a
            // pattern that counts characters instead of naming the shape.
            '1758128000000_000000000000000000000000000000000000',
            '1758128000000_------------------------------------',
            '1758128000000_00000000-0000-4000-8000-00000000cc6',
            '1758128000000_12345678901234567890',
        ]) {
            const errors = await cursorErrors(cursor);
            expect(errors).toHaveLength(1);
            expect(errors[0].constraints ?? {}).toHaveProperty('matches');
        }
    });

    it('still rejects a garbage cursor outright', async () => {
        for (const cursor of ['', '_42', 'x_42', '1758128000000', '1758128000000_42_1']) {
            await expect(cursorErrors(cursor)).resolves.not.toEqual([]);
        }
    });

    it('leaves the first page (no cursor) valid', async () => {
        const dto = plainToInstance(SessionDetailQueryDto, { limit: 50 });
        await expect(
            validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
        ).resolves.toEqual([]);
    });
});
