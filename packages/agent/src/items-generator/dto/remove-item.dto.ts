import { IsString, IsNotEmpty, IsOptional, IsBoolean, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { RemoveItemDto as IRemoveItemDto } from '@ever-works/contracts/api';

export class RemoveItemDto implements IRemoveItemDto {
    @ApiProperty({ description: 'Slug of the item to remove' })
    @IsString()
    @IsNotEmpty()
    // Security (path traversal): defence-in-depth at the DTO boundary. `item_slug`
    // is attacker-controlled and flows into `DataRepository.getItemPath`
    // (`path.join(dataDir, slug)`, no confinement). The service already
    // normalises it via `slugifyText`, but reject path separators / `.` here too.
    // The character set mirrors `slugifyText` output ([a-z0-9_-]) so no
    // legitimately-created slug is rejected, while `.`, `/`, `\` cannot pass.
    @Matches(/^[a-z0-9_-]+$/, {
        message: 'item_slug must contain only lowercase letters, digits, hyphens, and underscores',
    })
    item_slug: string;

    @ApiPropertyOptional({ description: 'Reason for removing the item' })
    @IsOptional()
    @IsString()
    // Security (resource exhaustion / log injection): `reason` is interpolated
    // into git commit messages and PR bodies. Cap its length so an oversized
    // value cannot bloat git history or downstream tooling.
    @MaxLength(500)
    reason?: string;

    @ApiPropertyOptional({
        description: 'Whether to create a pull request for this change',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    create_pull_request?: boolean;
}
