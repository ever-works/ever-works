import { IsIn, IsNotEmpty } from 'class-validator';
import { DirectoryMemberRole, ASSIGNABLE_MEMBER_ROLES } from '@packages/agent/entities';

export class UpdateMemberRoleDto {
    @IsIn(ASSIGNABLE_MEMBER_ROLES, {
        message: 'Role must be one of: viewer, editor, manager',
    })
    @IsNotEmpty()
    role: DirectoryMemberRole;
}
