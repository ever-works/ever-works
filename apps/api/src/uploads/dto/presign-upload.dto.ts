import { IsInt, IsMimeType, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * EW-637 — body of `POST /api/uploads/presign`.
 *
 * The active backend uses these fields to mint a pre-signed PUT URL. The
 * browser then uploads bytes directly to S3 / MinIO; the API never sees
 * the payload, so MIME / magic-byte validation has to happen client-side
 * (or in a post-upload integrity check). For untrusted clients, use the
 * regular `POST /api/uploads` route instead so the API can sniff bytes.
 */
export class PresignUploadDto {
    @ApiProperty({ description: 'Original filename (used for extension only)' })
    @IsString()
    @MaxLength(256)
    filename!: string;

    @ApiProperty({ description: 'MIME type the browser will upload as' })
    @IsString()
    @IsMimeType()
    mimeType!: string;

    @ApiProperty({ description: 'Byte size of the file to upload' })
    @IsInt()
    @Min(1)
    // Hard cap pinned to 2 GiB — anything larger should go through a
    // dedicated multipart-upload flow, not a single presigned PUT.
    @Max(2 * 1024 * 1024 * 1024)
    size!: number;

    @ApiPropertyOptional({
        description:
            'Correlation id from the website landing form, for stitching the upload to the prompt-submit funnel step.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(128)
    correlationId?: string;
}
