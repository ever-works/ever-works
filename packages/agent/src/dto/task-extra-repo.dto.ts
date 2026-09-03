import { IsBoolean, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN, type TaskExtraRepo } from '@ever-works/contracts';

/**
 * Validated body shape for one extra repository of a Task (multi-repo Task
 * workspaces, self-build slice C / PR C2). Shared by the Task create and
 * update DTOs so both surfaces enforce the same constraints on what is, at
 * rest, the same `simple-json` shape. Ownership of the repository
 * connection and directory uniqueness are checked by `TasksService`.
 */
export class TaskExtraRepoDto implements TaskExtraRepo {
    @ApiProperty({
        description: 'Id of a repository connection in your repository registry.',
        format: 'uuid',
    })
    @IsUUID()
    repoConnectionId: string;

    @ApiPropertyOptional({
        description:
            'Directory under .mounts/ the repository is linked at on a fleet run (letters, digits, ".", "_" or "-", up to 64 characters; no leading dot). Omitted = the connection\'s mount path or name.',
        maxLength: 64,
        nullable: true,
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    @Matches(FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN, {
        message:
            'mountDir must be a single directory name: start with a letter or digit, then letters, digits, ".", "_" or "-" (up to 64 characters).',
    })
    mountDir?: string | null;

    @ApiPropertyOptional({
        description:
            'false = read-only reference checkout: never committed, no pull request. Default true.',
    })
    @IsOptional()
    @IsBoolean()
    writable?: boolean;
}
