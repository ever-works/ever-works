import { IsEmail, IsEnum, IsNotEmpty } from 'class-validator';
import { DirectoryMemberRole } from '@packages/agent/entities';

export class InviteMemberDto {
    @IsEmail()
    @IsNotEmpty()
    email: string;

    @IsEnum(DirectoryMemberRole)
    @IsNotEmpty()
    role: DirectoryMemberRole;
}
