import {
    IsBoolean,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    MaxLength,
    Validate,
    ValidatorConstraint,
    type ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN,
    isReservedMountDir,
    type TaskExtraRepo,
} from '@ever-works/contracts';

// `@Matches(FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN)` only checks the SHAPE of
// a directory name; `NUL`, `COM1`, `node_modules` or `.git` are well-formed
// and still can never be a mount directory. The fleet normalizer and
// `TasksService.normalizeExtraRepos` refuse them through the one shared
// `isReservedMountDir`, so the DTO applies the same rule here: the caller
// gets a 400 naming `mountDir` at the request boundary instead of one layer
// later, and the three gates cannot drift apart.
@ValidatorConstraint({ name: 'isNotReservedMountDir', async: false })
class IsNotReservedMountDirConstraint implements ValidatorConstraintInterface {
    validate(value: unknown): boolean {
        return typeof value === 'string' && !isReservedMountDir(value);
    }

    defaultMessage(): string {
        return "mountDir must not be '.git', '.mounts', 'node_modules' or a Windows device name such as NUL or COM1.";
    }
}

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
            'Directory under .mounts/ the repository is linked at on a fleet run (letters, digits, ".", "_" or "-", up to 64 characters; no leading or trailing dot; not .git, .mounts, node_modules or a Windows device name). Omitted = the connection\'s mount path or name.',
        maxLength: 64,
        nullable: true,
    })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    @Matches(FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN, {
        message:
            'mountDir must be a single directory name: start with a letter or digit, then letters, digits, ".", "_" or "-" (up to 64 characters, no trailing dot).',
    })
    @Validate(IsNotReservedMountDirConstraint)
    mountDir?: string | null;

    @ApiPropertyOptional({
        description:
            'false = read-only reference checkout: never committed, no pull request. Default true.',
    })
    @IsOptional()
    @IsBoolean()
    writable?: boolean;
}
