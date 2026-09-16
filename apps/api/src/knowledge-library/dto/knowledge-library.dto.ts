import { Transform, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    ArrayMinSize,
    IsArray,
    IsIn,
    IsInt,
    IsOptional,
    IsString,
    IsUUID,
    Matches,
    Max,
    MaxLength,
    Min,
    ValidateIf,
} from 'class-validator';
import {
    KB_DOCUMENT_CLASSES,
    KB_LIBRARY_ARCHIVED_FILTERS,
    KB_LIBRARY_FILE_BATCH_MAX,
    KB_LIBRARY_PAGE_SIZE_MAX,
    KB_LIBRARY_QUERY_MAX,
    KB_LIBRARY_SORTS,
    KB_LIBRARY_UNFILED,
    type KbDocumentClass,
    type KbLibraryArchivedFilter,
    type KbLibrarySort,
} from '@ever-works/contracts';

/**
 * Normalize a repeatable query-string param to `string[]` — the three shapes
 * Express hands over (`?class=a&class=b`, `?class=a,b`, `?class=a`). Same
 * helper shape as the organization knowledge list uses.
 */
function toStringArray(value: unknown): string[] {
    const raw = Array.isArray(value) ? value : [value];
    return raw
        .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
}

const UUID_OR_UNFILED = new RegExp(
    `^(${KB_LIBRARY_UNFILED}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$`,
);

/** Query of `GET /api/knowledge/library`. */
export class KnowledgeLibraryQueryDto {
    /** A shared folder id, or `unfiled`. Omitted = every folder. */
    @IsOptional()
    @IsString()
    @Matches(UUID_OR_UNFILED, { message: 'folderId must be a folder id or "unfiled"' })
    folderId?: string;

    @IsOptional()
    @IsIn(KB_LIBRARY_ARCHIVED_FILTERS as unknown as readonly string[])
    archived?: KbLibraryArchivedFilter;

    @IsOptional()
    @IsString()
    @MaxLength(KB_LIBRARY_QUERY_MAX)
    q?: string;

    @IsOptional()
    @Transform(({ value }) => toStringArray(value))
    @IsIn(KB_DOCUMENT_CLASSES as unknown as readonly string[], { each: true })
    class?: KbDocumentClass[];

    @IsOptional()
    @IsUUID()
    workId?: string;

    @IsOptional()
    @IsIn(KB_LIBRARY_SORTS as unknown as readonly string[])
    sort?: KbLibrarySort;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(KB_LIBRARY_PAGE_SIZE_MAX)
    limit?: number;

    @IsOptional()
    @IsString()
    @MaxLength(256)
    cursor?: string;
}

/** Body of `PATCH /api/knowledge/documents/file`. `folderId: null` unfiles. */
export class FileKnowledgeDocumentsDto {
    @IsArray()
    @ArrayMinSize(1)
    @ArrayMaxSize(KB_LIBRARY_FILE_BATCH_MAX, {
        message: `You can file up to ${KB_LIBRARY_FILE_BATCH_MAX} documents at once.`,
    })
    @IsUUID(undefined, { each: true })
    documentIds: string[];

    @ValidateIf((o: FileKnowledgeDocumentsDto) => o.folderId !== null)
    @IsUUID()
    folderId: string | null;
}

/** Query of `GET /api/knowledge/documents/:docId/export`. */
export class ExportKnowledgeDocumentQueryDto {
    /** Markdown only for a single document today. */
    @IsOptional()
    @IsIn(['md'])
    format?: 'md';
}
