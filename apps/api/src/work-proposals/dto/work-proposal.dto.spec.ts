import 'reflect-metadata';

// The DTO re-imports enums from @ever-works/agent/user-research, whose
// transitive imports drag in the agent's entities (which reach back through
// @src/* paths and break Jest resolution). Stub the surface area we use.
jest.mock(
    '@ever-works/agent/user-research',
    () => ({
        WorkProposalStatus: {
            PENDING: 'pending',
            DISMISSED: 'dismissed',
            ACCEPTED: 'accepted',
        },
        WorkProposalSource: {
            AUTO_SIGNUP: 'auto-signup',
            USER_REFRESH: 'user-refresh',
            DISCOVER: 'discover',
            SCHEDULED: 'scheduled',
        },
    }),
    { virtual: true },
);

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListWorkProposalsQueryDto } from './work-proposal.dto';

describe('ListWorkProposalsQueryDto', () => {
    async function transformAndValidate(input: Record<string, unknown>) {
        const instance = plainToInstance(ListWorkProposalsQueryDto, input);
        const errors = await validate(instance);
        return { instance, errors };
    }

    it('accepts a single statuses value (string from Express)', async () => {
        const { instance, errors } = await transformAndValidate({ statuses: 'pending' });
        expect(errors).toHaveLength(0);
        expect(instance.statuses).toEqual(['pending']);
    });

    it('accepts a repeated statuses query (array from Express)', async () => {
        const { instance, errors } = await transformAndValidate({
            statuses: ['pending', 'accepted'],
        });
        expect(errors).toHaveLength(0);
        expect(instance.statuses).toEqual(['pending', 'accepted']);
    });

    it('omits statuses entirely (defaults applied in controller)', async () => {
        const { instance, errors } = await transformAndValidate({});
        expect(errors).toHaveLength(0);
        expect(instance.statuses).toBeUndefined();
    });

    it('rejects an unknown status value', async () => {
        const { errors } = await transformAndValidate({ statuses: 'bogus' });
        expect(errors).toHaveLength(1);
        expect(errors[0].constraints).toMatchObject({ isEnum: expect.any(String) });
    });
});
