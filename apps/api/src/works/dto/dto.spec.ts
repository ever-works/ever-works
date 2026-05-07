jest.mock('@ever-works/agent/entities', () => ({
    WorkMemberRole: {
        OWNER: 'owner',
        MANAGER: 'manager',
        EDITOR: 'editor',
        VIEWER: 'viewer',
    },
    ASSIGNABLE_MEMBER_ROLES: ['manager', 'editor', 'viewer'],
}));

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InviteMemberDto } from './invite-member.dto';
import { UpdateMemberRoleDto } from './update-member-role.dto';
import { ValidateTokenDto } from './deploy.dto';
import { BatchDeployDto, BatchDeployItemDto } from './batch-deploy.dto';
import { GenerateWorkDetailDto } from './generate-detail.dto';
import { GenerateManualComparisonDto } from './generate-manual-comparison.dto';

const constraintsFor = (errs: any[], property: string) =>
    errs.find((e) => e.property === property)?.constraints ?? {};

describe('works DTOs validation', () => {
    describe('InviteMemberDto', () => {
        it('accepts valid email + assignable role (editor)', async () => {
            const dto = plainToInstance(InviteMemberDto, {
                email: 'foo@bar.com',
                role: 'editor',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts viewer and manager roles', async () => {
            for (const role of ['viewer', 'manager']) {
                const dto = plainToInstance(InviteMemberDto, {
                    email: 'a@b.com',
                    role,
                });
                expect(await validate(dto)).toHaveLength(0);
            }
        });

        it('rejects "owner" role (not in ASSIGNABLE_MEMBER_ROLES)', async () => {
            const dto = plainToInstance(InviteMemberDto, {
                email: 'a@b.com',
                role: 'owner',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'role').isIn).toBe(
                'Role must be one of: viewer, editor, manager',
            );
        });

        it('rejects an invalid email format', async () => {
            const dto = plainToInstance(InviteMemberDto, {
                email: 'not-an-email',
                role: 'viewer',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'email').isEmail).toBeDefined();
        });

        it('rejects empty / missing role', async () => {
            const dto = plainToInstance(InviteMemberDto, {
                email: 'a@b.com',
                role: '',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'role').isNotEmpty).toBeDefined();
        });

        it('rejects empty / missing email', async () => {
            const dto = plainToInstance(InviteMemberDto, { email: '', role: 'editor' });
            const errs = await validate(dto);
            expect(errs.find((e) => e.property === 'email')).toBeDefined();
        });
    });

    describe('UpdateMemberRoleDto', () => {
        it('accepts each assignable role', async () => {
            for (const role of ['viewer', 'editor', 'manager']) {
                const dto = plainToInstance(UpdateMemberRoleDto, { role });
                expect(await validate(dto)).toHaveLength(0);
            }
        });

        it('rejects unknown role', async () => {
            const dto = plainToInstance(UpdateMemberRoleDto, { role: 'admin' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'role').isIn).toBe(
                'Role must be one of: viewer, editor, manager',
            );
        });

        it('rejects empty role', async () => {
            const dto = plainToInstance(UpdateMemberRoleDto, { role: '' });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'role').isNotEmpty).toBeDefined();
        });
    });

    describe('ValidateTokenDto (deploy.dto.ts)', () => {
        it('accepts a string token', async () => {
            const dto = plainToInstance(ValidateTokenDto, { token: 'abc123' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string token', async () => {
            const dto = plainToInstance(ValidateTokenDto, { token: 123 });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'token').isString).toBeDefined();
        });

        it('accepts empty string (no IsNotEmpty constraint)', async () => {
            const dto = plainToInstance(ValidateTokenDto, { token: '' });
            expect(await validate(dto)).toHaveLength(0);
        });
    });

    describe('BatchDeployDto', () => {
        it('accepts valid array with one item (no teamScope)', async () => {
            const dto = plainToInstance(BatchDeployDto, {
                works: [{ workId: 'w-1' }],
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts valid array with multiple items + per-item teamScope + default teamScope', async () => {
            const dto = plainToInstance(BatchDeployDto, {
                teamScope: 'team-x',
                works: [
                    { workId: 'w-1', teamScope: 'team-y' },
                    { workId: 'w-2' },
                ],
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects empty array (ArrayMinSize 1)', async () => {
            const dto = plainToInstance(BatchDeployDto, { works: [] });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'works').arrayMinSize).toBeDefined();
        });

        it('rejects when works is not an array', async () => {
            const dto = plainToInstance(BatchDeployDto, { works: 'not-array' as any });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'works').isArray).toBeDefined();
        });

        it('rejects nested item with non-string workId', async () => {
            const dto = plainToInstance(BatchDeployDto, {
                works: [{ workId: 123 as any }],
            });
            const errs = await validate(dto);
            const worksErr = errs.find((e) => e.property === 'works');
            const nested = worksErr?.children?.[0];
            const itemChild = nested?.children?.find((c: any) => c.property === 'workId');
            expect(itemChild?.constraints?.isString).toBeDefined();
        });

        it('rejects when default teamScope is non-string', async () => {
            const dto = plainToInstance(BatchDeployDto, {
                teamScope: 123 as any,
                works: [{ workId: 'w-1' }],
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'teamScope').isString).toBeDefined();
        });
    });

    describe('BatchDeployItemDto (standalone)', () => {
        it('accepts workId only', async () => {
            const dto = plainToInstance(BatchDeployItemDto, { workId: 'w-1' });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts workId + teamScope', async () => {
            const dto = plainToInstance(BatchDeployItemDto, {
                workId: 'w-1',
                teamScope: 'team-x',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects non-string workId', async () => {
            const dto = plainToInstance(BatchDeployItemDto, { workId: 1 as any });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'workId').isString).toBeDefined();
        });
    });

    describe('GenerateWorkDetailDto', () => {
        it('accepts valid work_name + prompt without ai_provider', async () => {
            const dto = plainToInstance(GenerateWorkDetailDto, {
                work_name: 'My Work',
                prompt: 'Generate a directory of...',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('accepts ai_provider when provided', async () => {
            const dto = plainToInstance(GenerateWorkDetailDto, {
                work_name: 'My Work',
                prompt: 'Generate...',
                ai_provider: 'openai',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects empty work_name', async () => {
            const dto = plainToInstance(GenerateWorkDetailDto, {
                work_name: '',
                prompt: 'p',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'work_name').isNotEmpty).toBeDefined();
        });

        it('rejects empty prompt', async () => {
            const dto = plainToInstance(GenerateWorkDetailDto, {
                work_name: 'n',
                prompt: '',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'prompt').isNotEmpty).toBeDefined();
        });

        it('rejects non-string ai_provider', async () => {
            const dto = plainToInstance(GenerateWorkDetailDto, {
                work_name: 'n',
                prompt: 'p',
                ai_provider: 123 as any,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'ai_provider').isString).toBeDefined();
        });
    });

    describe('GenerateManualComparisonDto', () => {
        it('accepts both slugs', async () => {
            const dto = plainToInstance(GenerateManualComparisonDto, {
                itemASlug: 'a',
                itemBSlug: 'b',
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects empty itemASlug', async () => {
            const dto = plainToInstance(GenerateManualComparisonDto, {
                itemASlug: '',
                itemBSlug: 'b',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'itemASlug').isNotEmpty).toBeDefined();
        });

        it('rejects empty itemBSlug', async () => {
            const dto = plainToInstance(GenerateManualComparisonDto, {
                itemASlug: 'a',
                itemBSlug: '',
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'itemBSlug').isNotEmpty).toBeDefined();
        });

        it('rejects non-string slugs', async () => {
            const dto = plainToInstance(GenerateManualComparisonDto, {
                itemASlug: 1 as any,
                itemBSlug: {} as any,
            });
            const errs = await validate(dto);
            expect(constraintsFor(errs, 'itemASlug').isString).toBeDefined();
            expect(constraintsFor(errs, 'itemBSlug').isString).toBeDefined();
        });
    });
});
