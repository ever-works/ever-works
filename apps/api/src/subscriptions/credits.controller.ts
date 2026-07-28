import {
    BadRequestException,
    Controller,
    Get,
    Header,
    HttpCode,
    HttpStatus,
    Logger,
    Query,
    Res,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { AuthSessionGuard, CurrentUser } from '@src/auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { ScopeContextService } from '@src/scope';
import {
    CreditLedgerService,
    InvalidUsagePeriodError,
    USAGE_EXPORT_COLUMNS,
    USAGE_SUMMARY_GROUP_BYS,
    UsageSummaryService,
    type UsageExportRow,
    type UsageExportStream,
    type UsageSummaryGroupBy,
} from '@ever-works/agent/subscriptions';
import { CreditLedgerEntry, CreditLedgerKind } from '@ever-works/agent/entities';

/**
 * Minimal Response surface for the streamed CSV. Mirrors the convention
 * in budgets/usage.controller.ts and activity-log.controller.ts (avoids
 * pulling the full `import('express').Response` type), extended with
 * `write`/`end` because this export streams instead of buffering.
 */
type StreamingCsvResponse = {
    setHeader(name: string, value: string): void;
    write(chunk: string): unknown;
    end(): unknown;
};

export class CreditsUsageSummaryQueryDto {
    /**
     * Grouping dimension for the §4.3 charts. Omitted = the §4.1/§4.2
     * stat-tile totals (credits used/added, tasks completed, works
     * active, agent runs).
     */
    @IsOptional()
    @IsIn(USAGE_SUMMARY_GROUP_BYS)
    groupBy?: UsageSummaryGroupBy;

    /** `YYYY-MM` calendar month (default: current), or rolling `7d`/`30d`. */
    @IsOptional()
    @Matches(/^(\d{4}-(0[1-9]|1[0-2])|7d|30d)$/, {
        message: 'period must be YYYY-MM, 7d, or 30d',
    })
    period?: string;
}

/** B29 — query contract for the account-wide usage CSV export. */
export class CreditsUsageExportQueryDto {
    /** `YYYY-MM` calendar month (default: current), or rolling `7d`/`30d`. */
    @IsOptional()
    @Matches(/^(\d{4}-(0[1-9]|1[0-2])|7d|30d)$/, {
        message: 'period must be YYYY-MM, 7d, or 30d',
    })
    period?: string;

    /** Only `csv` is supported — mirrors the per-Work export's contract. */
    @IsOptional()
    @IsIn(['csv'], { message: "Unsupported format. Only 'csv' is supported." })
    format?: string;
}

class CreditsLedgerQueryDto {
    /** Calendar month filter, e.g. `2026-07` (matches the usage controllers). */
    @IsOptional()
    @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period must be YYYY-MM' })
    period?: string;

    /** Comma-separated entry kinds, e.g. `purchase,consumption`. */
    @IsOptional()
    @IsString()
    kinds?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(100)
    pageSize?: number;
}

const VALID_KINDS = new Set<string>(Object.values(CreditLedgerKind));

/**
 * Read-only credits surface (pricing Wave 9 M1) — owner-scoped; the
 * Billing / Usage & Credits pages (Wave 13) consume these. Writes never
 * happen over public HTTP: purchases arrive via the billing-provider
 * webhook (Wave 9.4) and consumption via the metering debit hook.
 */
@ApiTags('Credits')
@ApiBearerAuth('JWT-auth')
@Controller('api/credits')
@UseGuards(AuthSessionGuard)
export class CreditsController {
    private readonly logger = new Logger(CreditsController.name);

    constructor(
        private readonly creditLedgerService: CreditLedgerService,
        // Wave 13 — account-wide usage aggregations for the Usage &
        // Credits page (`usage-summary` below).
        private readonly usageSummaryService: UsageSummaryService,
        // B29 — the active Organization for the CSV export's scope
        // filter. Read from the request scope context, never a param.
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get('balance')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Get credits balance',
        description:
            'Current credits balance for the authenticated user (SUM of ledger movements).',
    })
    @ApiResponse({ status: 200, description: 'Current credits balance' })
    async getBalance(@CurrentUser() auth: AuthenticatedUser) {
        const balanceCredits = await this.creditLedgerService.getBalance(auth.userId);
        return { status: 'success', balanceCredits };
    }

    @Get('ledger')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'List credits ledger',
        description:
            'Paginated credits ledger for the authenticated user. Filters: period (YYYY-MM), kinds (comma-separated: purchase, grant, daily-free, consumption, adjustment, expiry).',
    })
    @ApiResponse({ status: 200, description: 'Paginated ledger entries' })
    @ApiResponse({ status: 400, description: 'Invalid period or kind filter' })
    async getLedger(@CurrentUser() auth: AuthenticatedUser, @Query() query: CreditsLedgerQueryDto) {
        const kinds = this.parseKinds(query.kinds);
        const { entries, total, page, pageSize } = await this.creditLedgerService.getLedger(
            auth.userId,
            {
                period: query.period,
                kinds,
                page: query.page,
                pageSize: query.pageSize,
            },
        );

        return {
            status: 'success',
            entries: entries.map((entry) => this.toLedgerRow(entry)),
            total,
            page,
            pageSize,
        };
    }

    @Get('usage-summary')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Account-wide usage summary',
        description:
            'Owner-scoped usage aggregations for the Usage & Credits page (Wave 13). ' +
            'Without groupBy: period totals (credits consumed/added, metered spend, tasks completed, ' +
            'works active, agent runs). With groupBy=day|model|agent|work: grouped spend rows for the charts. ' +
            'period accepts YYYY-MM (default: current month), 7d, or 30d.',
    })
    @ApiResponse({ status: 200, description: 'Usage summary (totals or grouped rows)' })
    @ApiResponse({ status: 400, description: 'Invalid groupBy or period' })
    async getUsageSummary(
        @CurrentUser() auth: AuthenticatedUser,
        @Query() query: CreditsUsageSummaryQueryDto,
    ) {
        try {
            if (query.groupBy) {
                const grouped = await this.usageSummaryService.getGrouped(
                    auth.userId,
                    query.groupBy,
                    query.period,
                );
                return { status: 'success', ...grouped };
            }
            const totals = await this.usageSummaryService.getTotals(auth.userId, query.period);
            return { status: 'success', ...totals };
        } catch (error) {
            // Defence-in-depth: the DTO regex already rejects bad periods,
            // but the service's stable-named error must still map to a 4xx
            // (billing PRD §6 — never an unmapped 500).
            if (error instanceof InvalidUsagePeriodError) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }
    }

    @Get('usage/export')
    @HttpCode(HttpStatus.OK)
    @Header('Cache-Control', 'no-store')
    @ApiOperation({
        summary: 'Download account-wide usage events as CSV',
        description:
            'Streams every metered usage event attributed to the authenticated user inside the ' +
            "period as CSV. Scoped to the request's active Organization when there is one, so a " +
            "user acting inside one Org never exports another Org's spend. period accepts " +
            'YYYY-MM (default: current month), 7d, or 30d.',
    })
    @ApiResponse({ status: 200, description: 'CSV stream of usage events' })
    @ApiResponse({ status: 400, description: 'Invalid period or format' })
    async exportUsageCsv(
        @CurrentUser() auth: AuthenticatedUser,
        @Res() res: StreamingCsvResponse,
        @Query() query: CreditsUsageExportQueryDto,
    ): Promise<void> {
        // Scope filter comes from the request context ONLY — accepting an
        // orgId param here would be a cross-org billing read.
        const organizationId = this.scopeContext.getOrganizationId();

        let stream: UsageExportStream;
        try {
            stream = this.usageSummaryService.createExport(auth.userId, {
                period: query.period,
                organizationId,
            });
        } catch (error) {
            // Defence-in-depth: the DTO regex already rejects bad periods.
            if (error instanceof InvalidUsagePeriodError) {
                throw new BadRequestException(error.message);
            }
            throw error;
        }

        // Headers + the CSV header row are written LAZILY, on the first
        // chunk (or once the stream completes empty). A repository error
        // on the very first page therefore still maps to a normal HTTP
        // error response instead of a half-written 200.
        let started = false;
        const start = () => {
            if (started) {
                return;
            }
            started = true;
            // Security: strip `"`/CR/LF before interpolating into the
            // quoted Content-Disposition header so a quote/newline can't
            // terminate the quoted-string and inject additional header
            // parameters or split the response. Mirrors
            // budgets/usage.controller.ts. The period is already
            // regex-validated, so valid inputs are unchanged.
            const filename = `usage-${stream.window.period}.csv`.replace(/["\r\n]/g, '_');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.write(`${USAGE_EXPORT_COLUMNS.join(',')}\n`);
        };

        try {
            // Streamed, not buffered: each repository page is written out
            // and dropped, so a long period costs one page of rows in
            // memory rather than the whole period.
            for await (const chunk of stream.chunks) {
                start();
                res.write(chunk.map((row) => this.toCsvLine(row)).join(''));
            }
            start();
        } catch (error) {
            if (!started) {
                // Nothing on the wire yet — let the exception filters map it.
                throw error;
            }
            // Mid-stream failure: the response is already committed, so all
            // we can do is log and close rather than hang the download.
            this.logger.error(
                `Account-wide usage export failed mid-stream for period ${stream.window.period}`,
                error instanceof Error ? error.stack : String(error),
            );
        }
        res.end();
    }

    /** One CSV record (RFC 4180 escaping), newline included. */
    private toCsvLine(row: UsageExportRow): string {
        return `${USAGE_EXPORT_COLUMNS.map((column) => this.escapeCsv(row[column])).join(',')}\n`;
    }

    private escapeCsv(value: unknown): string {
        if (value === null || value === undefined) {
            return '';
        }
        const str = typeof value === 'string' ? value : String(value);
        if (/[",\n\r]/.test(str)) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    private parseKinds(raw?: string): CreditLedgerKind[] | undefined {
        if (!raw) {
            return undefined;
        }
        const kinds = raw
            .split(',')
            .map((kind) => kind.trim())
            .filter((kind) => kind.length > 0);
        for (const kind of kinds) {
            if (!VALID_KINDS.has(kind)) {
                throw new BadRequestException(`Unknown ledger kind: ${kind}`);
            }
        }
        return kinds as CreditLedgerKind[];
    }

    /** Explicit projection — owner-scoped rows, no scope columns leaked. */
    private toLedgerRow(entry: CreditLedgerEntry) {
        return {
            id: entry.id,
            kind: entry.kind,
            amountCredits: entry.amountCredits,
            balanceAfter: entry.balanceAfter,
            costCentsRef: entry.costCentsRef ?? null,
            refType: entry.refType ?? null,
            refId: entry.refId ?? null,
            description: entry.description ?? null,
            createdAt: entry.createdAt,
        };
    }
}
