import { IsEnum, IsNotEmpty } from 'class-validator';
import { DirectoryMemberRole } from '@packages/agent/entities';

export class UpdateMemberRoleDto {
    @IsEnum(DirectoryMemberRole)
    @IsNotEmpty()
    role: DirectoryMemberRole;
}
