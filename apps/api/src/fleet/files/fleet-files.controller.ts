import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    Req,
    Res,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
    FLEET_FILES_REQUEST_RATE_LIMIT,
    FLEET_FILES_TRANSFER_RATE_LIMIT,
    type FleetFileConflictView,
    type FleetFileEntryView,
    type FleetFileListView,
    type FleetFileRootsResponse,
    type FleetFilesDeleteResult,
    type FleetFilesDownloadCheck,
    type FleetFilesOperationStarted,
    type FleetFilesTransfersResponse,
} from '@ever-works/contracts';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { FleetEnabledGuard } from '../guards/fleet-enabled.guard';
import { FleetMachineFactsEnabledGuard } from '../machine/fleet-machine-facts-enabled.guard';
import {
    FleetFilesCancelQueryDto,
    FleetFilesConflictsDto,
    FleetFilesCopyDto,
    FleetFilesDeleteDto,
    FleetFilesDownloadCheckDto,
    FleetFilesDownloadQueryDto,
    FleetFilesListQueryDto,
    FleetFilesStatQueryDto,
    FleetFilesUploadQueryDto,
} from './dto/fleet-files.dto';
import {
    FleetFilesTransferService,
    type FleetFilesDownloadSink,
    type FleetFilesUploadResult,
} from './fleet-files-transfer.service';
import { FleetFilesService } from './fleet-files.service';

/** Express's response as a download sink. */
function sinkOf(res: Response): FleetFilesDownloadSink {
    let started = false;
    return {
        start(headers) {
            started = true;
            res.status(200);
            for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
            res.flushHeaders?.();
        },
        write: (chunk) => res.write(chunk),
        onDrain: (listener) => {
            res.once('drain', listener);
        },
        end: () => res.end(),
        destroy: () => res.destroy(),
        onClose: (listener) => {
            res.once('close', () => {
                if (!res.writableFinished) listener();
            });
        },
        get started() {
            return started;
        },
    };
}

/**
 * Files on computers (FL-11, plan §5, CONTRACTS §11.2) — `/api/fleet/nodes/:id/files/*`,
 * dark (404) unless `FLEET_ENABLED` and `FLEET_MACHINE_FACTS_ENABLED` are both on:
 *
 *  - `GET  roots` — the computer's allowed roots (checkouts, the workspace
 *    root, `--files-root` folders; never the home directory);
 *  - `GET  list` · `GET stat` — entries of a folder, flagged (hidden,
 *    credential-shaped, links inside or outside the root);
 *  - `POST conflicts` — the same-name entries an upload would meet (FR-12);
 *  - `GET  download` — one file as itself, several or a folder as a `.zip`,
 *    streamed through the node link with credit (FR-10, FR-11); a
 *    credential-shaped file needs `confirm=true` (class `confirm`, FR-17);
 *  - `POST upload` — the request body is the files stream (the web builds
 *    it), written into the folder by the conflict policy (Skip by default);
 *  - `POST delete` — class `confirm-destructive`: `confirmName` must be the
 *    target's name (FR-18);
 *  - `GET  transfers` · `DELETE transfers/:transferId` — the Operations strip
 *    and its Cancel (FR-14).
 *
 * Every route is the `files` action family (default audience `owner`), needs
 * `--manage` on the machine, is refused `kill_switch` while all computers are
 * stopped, and answers the CONTRACTS §8 envelope on refusal. Lists (once per
 * visit), downloads, uploads and deletes are audited (`node.files.*`); no
 * file content is ever stored or logged.
 */
@ApiTags('fleet')
@Controller('api/fleet')
@UseGuards(FleetEnabledGuard, FleetMachineFactsEnabledGuard)
export class FleetFilesController {
    constructor(
        private readonly files: FleetFilesService,
        private readonly transfers: FleetFilesTransferService,
    ) {}

    @Get('nodes/:id/files/roots')
    @ApiOperation({
        summary:
            "The folders this computer lets Ever Works see: every ready checkout, the node's workspace root and each folder its owner listed with --files-root. The home directory is never one unless listed. Needs --manage; 404 for a computer I cannot see.",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_FILES_REQUEST_RATE_LIMIT, ttl: 60_000 } })
    roots(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetFileRootsResponse> {
        return this.files.rootsForUser(auth.userId, id);
    }

    @Get('nodes/:id/files/list')
    @ApiOperation({
        summary:
            'The entries of one folder under a root (at most 5 000, by name; `truncated` says when there were more): name, kind, size, modification time, hidden, credential-shaped, and for links whether the target stays inside the root. Hidden entries only with `hidden=true`.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_FILES_REQUEST_RATE_LIMIT * 2, ttl: 60_000 } })
    list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: FleetFilesListQueryDto,
    ): Promise<FleetFileListView> {
        return this.files.listForUser(auth.userId, id, {
            root: query.root,
            path: query.path ?? '',
            hidden: query.hidden === true,
        });
    }

    @Get('nodes/:id/files/stat')
    @ApiOperation({ summary: 'One entry of a folder, flagged as in the list.' })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_FILES_REQUEST_RATE_LIMIT * 2, ttl: 60_000 } })
    stat(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: FleetFilesStatQueryDto,
    ): Promise<FleetFileEntryView> {
        return this.files.statForUser(auth.userId, id, {
            root: query.root,
            path: query.path ?? '',
            name: query.name,
        });
    }

    @Post('nodes/:id/files/conflicts')
    @ApiOperation({
        summary:
            'The entries of the folder that have one of these names — what an upload or a copy would replace — with size and modification time. Nothing is written.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_FILES_REQUEST_RATE_LIMIT, ttl: 60_000 } })
    conflicts(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetFilesConflictsDto,
    ): Promise<FleetFileConflictView[]> {
        return this.files.conflictsForUser(auth.userId, id, {
            root: body.root,
            path: body.path ?? '',
            names: body.names,
        });
    }

    @Post('nodes/:id/files/download/check')
    @ApiOperation({
        summary:
            'What a download of these entries would move — entries, bytes, whether it is one file, and the credential-shaped files inside — asked before the download starts. Nothing is sent.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_FILES_REQUEST_RATE_LIMIT, ttl: 60_000 } })
    checkDownload(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetFilesDownloadCheckDto,
    ): Promise<FleetFilesDownloadCheck> {
        return this.files.checkDownloadForUser(auth.userId, id, {
            root: body.root,
            path: body.path ?? '',
            entries: body.entries,
        });
    }

    @Get('nodes/:id/files/download')
    @ApiOperation({
        summary:
            "Download entries of a folder: one file as itself, several entries or a folder as one .zip (links inside the selection kept, links leaving it skipped and counted). Streamed through the computer's link in 64 KiB chunks; at most 2 GiB and 5 000 entries. A credential-shaped file (.env, keys, keystores, cloud credentials) needs `confirm=true` — without it 409 `confirmation_required`. Audited (`node.files.read`).",
    })
    @Throttle({ long: { limit: FLEET_FILES_TRANSFER_RATE_LIMIT, ttl: 60_000 } })
    async download(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: FleetFilesDownloadQueryDto,
        @Res() res: Response,
    ): Promise<void> {
        const sink = sinkOf(res);
        try {
            await this.transfers.downloadForUser(
                auth.userId,
                id,
                {
                    root: query.root,
                    path: query.path ?? '',
                    entries: query.entries,
                    confirm: query.confirm === true,
                },
                sink,
            );
        } catch (error) {
            // Before the first byte the refusal is the CONTRACTS §8 envelope (the
            // exception filter renders it); after it, the response was aborted.
            if (!sink.started) throw error;
        }
    }

    @Post('nodes/:id/files/upload')
    @ApiOperation({
        summary:
            'Upload into a folder: the request body (`application/octet-stream`) is the files stream (FL-11 contract records). Same-name entries are skipped unless `replace` names them or `replaceAll=true` — ask `conflicts` first. Written into a partial folder on the computer and moved into place at the end; a cancelled or failed upload leaves nothing partial. At most 2 GiB and 5 000 entries. Audited (`node.files.write`).',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_FILES_TRANSFER_RATE_LIMIT, ttl: 60_000 } })
    upload(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() query: FleetFilesUploadQueryDto,
        @Req() req: Request,
    ): Promise<FleetFilesUploadResult> {
        return this.transfers.uploadForUser(
            auth.userId,
            id,
            {
                root: query.root,
                path: query.path ?? '',
                policy: {
                    ...(query.replaceAll ? { replaceAll: true } : {}),
                    ...(query.replace ? { replace: query.replace } : {}),
                },
                ...(query.entries !== undefined ? { expectedEntries: query.entries } : {}),
                ...(query.bytes !== undefined ? { expectedBytes: query.bytes } : {}),
                ...(query.label ? { label: query.label } : {}),
            },
            req,
        );
    }

    @Post('nodes/:id/files/copy')
    @ApiOperation({
        summary:
            'Copy entries of a folder to another computer (or another folder of this one) THROUGH Ever Works: the two computers never connect to each other. Same-name entries at the destination are skipped unless `replace` names them or `replaceAll` is set — ask `conflicts` on the destination first. Both computers need --manage and my `files` access. Answers 202 once both sides accepted; follow it in `transfers` on either computer. Audited on both (`node.files.copy`).',
    })
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ long: { limit: FLEET_FILES_TRANSFER_RATE_LIMIT, ttl: 60_000 } })
    copy(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetFilesCopyDto,
    ): Promise<FleetFilesOperationStarted> {
        return this.transfers.copyForUser(auth.userId, id, {
            root: body.root,
            path: body.path ?? '',
            entries: body.entries,
            to: { nodeId: body.to.nodeId, root: body.to.root, path: body.to.path ?? '' },
            policy: {
                ...(body.replaceAll ? { replaceAll: true } : {}),
                ...(body.replace ? { replace: body.replace } : {}),
            },
            confirm: body.confirm === true,
        });
    }

    @Post('nodes/:id/files/delete')
    @ApiOperation({
        summary:
            "Delete entries of a folder (class `confirm-destructive`): `confirmName` must be the entry's name, or for several entries the folder's name — without it 409 `confirmation_required` with what to type. A link is removed, never its target. Audited (`node.files.delete`).",
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_FILES_TRANSFER_RATE_LIMIT, ttl: 60_000 } })
    delete(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Body() body: FleetFilesDeleteDto,
    ): Promise<FleetFilesDeleteResult> {
        return this.files.deleteForUser(auth.userId, id, {
            root: body.root,
            path: body.path ?? '',
            entries: body.entries,
            ...(body.confirmName !== undefined ? { confirmName: body.confirmName } : {}),
        });
    }

    @Get('nodes/:id/files/transfers')
    @ApiOperation({
        summary:
            'My transfers on this computer (running, and those that ended in the last 10 minutes) with bytes, speed and state, and the bytes moved through Ever Works for it today. Transfers spend no credits.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_FILES_REQUEST_RATE_LIMIT * 2, ttl: 60_000 } })
    transfersList(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<FleetFilesTransfersResponse> {
        return this.transfers.transfersForUser(auth.userId, id);
    }

    @Delete('nodes/:id/files/transfers/:transferId')
    @ApiOperation({
        summary:
            'Cancel a running transfer: the download stops, an upload leaves nothing partial on the computer.',
    })
    @HttpCode(HttpStatus.OK)
    @Throttle({ long: { limit: FLEET_FILES_REQUEST_RATE_LIMIT, ttl: 60_000 } })
    cancel(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('transferId', ParseUUIDPipe) transferId: string,
        @Query() query: FleetFilesCancelQueryDto,
    ): Promise<{ transferId: string; sent: boolean }> {
        return this.transfers.cancelForUser(auth.userId, id, transferId, query.operationId ?? null);
    }
}
