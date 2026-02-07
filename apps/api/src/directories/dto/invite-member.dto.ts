import { IsEmail, IsIn, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { DirectoryMemberRole, ASSIGNABLE_MEMBER_ROLES } from '@ever-works/agent/entities';

export class InviteMemberDto {
    @ApiProperty({
        description: 'Email address of the user to invite',
        example: 'collaborator@example.com',
    })
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @ApiProperty({
        description: 'Role to assign to the member',
        enum: ['viewer', 'editor', 'manager'],
        example: 'editor',
    })
    @IsIn(ASSIGNABLE_MEMBER_ROLES, {
        message: 'Role must be one of: viewer, editor, manager',
    })
    @IsNotEmpty()
    role: DirectoryMemberRole;
}
