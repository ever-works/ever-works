import { IsIn, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { WorkMemberRole, ASSIGNABLE_MEMBER_ROLES } from '@ever-works/agent/entities';

export class UpdateMemberRoleDto {
    @ApiProperty({
        description: 'New role for the member',
        enum: ['viewer', 'editor', 'manager'],
        example: 'editor',
    })
    @IsIn(ASSIGNABLE_MEMBER_ROLES, {
        message: 'Role must be one of: viewer, editor, manager',
    })
    @IsNotEmpty()
    role: WorkMemberRole;
}
