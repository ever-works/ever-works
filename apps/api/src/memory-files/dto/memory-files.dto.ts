import { Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsBoolean,
    IsIn,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    MinLength,
    ValidateIf,
    ValidateNested,
} from 'class-validator';

export const MEMORY_FILE_SOURCES = ['upload', 'kb-upload'] as const;
export type MemoryFileSourceParam = (typeof MEMORY_FILE_SOURCES)[number];

/** Query for `GET /api/memory/files` (the unified list). */
export class ListMemoryFilesQueryDto {
    /** Folder to list; omitted = the root (unfiled files). */
    @IsOptional()
    @IsUUID()
    folderId?: string;

    @IsOptional()
    @IsIn(MEMORY_FILE_SOURCES as unknown as readonly string[])
    source?: MemoryFileSourceParam;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    q?: string;
}

/** Repo coordinates for a folder's manual git sync — never credentials. */
export class SyncRepoDto {
    @IsOptional()
    @IsString()
    @MaxLength(512)
    repoUrl?: string;

    @IsOptional()
    @IsString()
    @MaxLength(120)
    owner?: string;

    @IsOptional()
    @IsString()
    @MaxLength(120)
    repo?: string;

    @IsOptional()
    @IsString()
    @MaxLength(120)
    branch?: string;

    @IsOptional()
    @IsString()
    @MaxLength(256)
    dirPrefix?: string;
}

/** Body for `POST /api/memory/files/folders`. */
export class CreateMemoryFolderDto {
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name: string;

    @IsOptional()
    @IsUUID()
    parentId?: string;

    /** Set to make the folder private to one agent; omit for Global. */
    @IsOptional()
    @IsUUID()
    ownerAgentId?: string;
}

/**
 * Body for `PATCH /api/memory/files/folders/:id`. Each knob is optional
 * and independent: `name` renames, `parentId` moves (`null` = to the
 * root — signalled by `moveToRoot` since JSON null cannot carry intent
 * through optional validation cleanly), `syncRepo` configures the manual
 * git-sync target (`clearSyncRepo` removes it).
 */
export class UpdateMemoryFolderDto {
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(120)
    name?: string;

    @IsOptional()
    @IsUUID()
    parentId?: string;

    @IsOptional()
    @IsBoolean()
    moveToRoot?: boolean;

    @IsOptional()
    @ValidateNested()
    @Type(() => SyncRepoDto)
    syncRepo?: SyncRepoDto;

    @IsOptional()
    @IsBoolean()
    clearSyncRepo?: boolean;
}

/** One item of a batch move. */
export class MoveMemoryFileItemDto {
    @IsIn(MEMORY_FILE_SOURCES as unknown as readonly string[])
    source: MemoryFileSourceParam;

    @IsUUID()
    id: string;
}

/** Body for `PATCH /api/memory/files/move`. `folderId: null` = unfile. */
export class MoveMemoryFilesDto {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(100)
    @ValidateNested({ each: true })
    @Type(() => MoveMemoryFileItemDto)
    files: MoveMemoryFileItemDto[];

    @ValidateIf((o: MoveMemoryFilesDto) => o.folderId !== null)
    @IsUUID()
    folderId: string | null;
}

/** Multipart body companion for `POST /api/memory/files/upload`. */
export class UploadMemoryFileDto {
    @IsOptional()
    @IsUUID()
    folderId?: string;
}

/** Query for `GET /api/memory/files/:id/download`. */
export class DownloadMemoryFileQueryDto {
    @IsIn(MEMORY_FILE_SOURCES as unknown as readonly string[])
    source: MemoryFileSourceParam;
}

/** Query for `DELETE /api/memory/files/folders/:id`. */
export class DeleteMemoryFolderQueryDto {
    @IsOptional()
    @IsIn(['true', 'false'])
    recursive?: 'true' | 'false';
}
