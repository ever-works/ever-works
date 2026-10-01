import { IsOptional, IsString, IsBoolean, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class DeleteWorkDto {
    @IsOptional()
    @IsString()
    reason?: string;

    @IsOptional()
    @IsBoolean()
    force_delete?: boolean = false;

    @IsOptional()
    @IsBoolean()
    delete_data_repository?: boolean = false;

    @IsOptional()
    @IsBoolean()
    delete_markdown_repository?: boolean = false;

    @IsOptional()
    @IsBoolean()
    delete_website_repository?: boolean = false;

    /**
     * APW-01 T39 (FR-40a, Resolution R-15) — **Also delete stored data**.
     *
     * Honoured for `kind: 'app'` only, and only together with `confirm_slug` (FR-40b):
     * the option removes the App Work's volumes and App dependencies, so an omitted
     * flag means "keep stored data" for every caller, including chat, MCP and
     * command-line clients. `apps/mcp` lists it in the `delete_work` entry's
     * `omitArgs`, so no agent can set it through a tool argument at all.
     */
    @ApiPropertyOptional({
        description:
            'App Work only: also delete the stored data (volumes and App dependencies). ' +
            'Requires confirm_slug to equal the Work slug; omitted means stored data is kept.',
        default: false,
    })
    @IsOptional()
    @IsBoolean()
    delete_stored_data?: boolean = false;

    /**
     * APW-01 T39 (FR-40b) — the server-side half of the typed confirmation.
     *
     * `delete_stored_data: true` is refused `422 confirmation_mismatch` unless this
     * equals the App Work's **slug** exactly. Bounded because it is compared against a
     * slug, never stored: nothing legitimate needs 200 characters.
     */
    @ApiPropertyOptional({
        description:
            'App Work only: the Work slug, typed by the member. Required whenever ' +
            'delete_stored_data is true.',
        maxLength: 200,
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    confirm_slug?: string;
}

export interface DeleteWorkResponseDto {
    status: 'success' | 'error' | 'pending';
    slug: string;
    message: string;
    deleted_repositories?: string[];
    /**
     * APW-01 T39 (FR-40a, ACC-NEG-07) — `true` when the App runtime took over the
     * removal: the workloads are being torn down and the Work row stays (it reads
     * **Deleting…**) until `WorkLifecycleService.completeAppWorkDeletion(workId)` is
     * called. Absent for every other outcome, so every existing caller reads the same
     * shape it always did.
     */
    deleting?: boolean;
}
