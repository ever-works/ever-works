import { createHash, randomUUID } from 'node:crypto';
import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    Logger,
    UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
    createEverPlatformClient,
    type EverPlatformClient,
    type InstanceSigner,
} from '@ever-co/connect-sdk';
import {
    EVER_CONNECT_CONNECTION_ROW_ID,
    EverConnectConnection,
    type EverConnectConnectionStatus,
} from '@ever-works/agent/entities';
import { getBuildInfo } from '../health/build-info';
import { versionAndChannel } from '../instance-stats/instance-stats.mapping';
import {
    CONNECT_CODE_PATTERN,
    EVER_CONNECT_CONFIG,
    type EverConnectConfig,
} from './ever-connect.config';
import { EverConnectConnectionChangedEvent } from './ever-connect.events';
import { EverConnectKeyService } from './ever-connect-key.service';
import type { EverConnectPlatform } from './identity/ever-connect-identity.ports';
import { describeFailure, platformFailure } from './identity/platform-answer';

/** What the operator sees of the connection (ids only). */
export interface EverConnectStatus {
    readonly status: EverConnectConnectionStatus;
    readonly platformInstanceId: string | null;
    readonly connectedAt: string | null;
    readonly lastError: string | null;
}

/** How long a disconnect waits for Ever Platform before cleaning up locally. */
const DISCONNECT_TIMEOUT_MS = 10_000;

/**
 * This installation's connection to Ever Platform: connect with an `EVC-…`
 * code, disconnect, and the SDK client every Ever Connect call goes through.
 *
 * The client authenticates with the installation's own token, which the SDK
 * gets with a client assertion signed by the connect key and keeps in memory
 * only. It exists while the installation is connected (or waits for approval);
 * otherwise {@link client} answers `null` and nothing is sent.
 */
@Injectable()
export class EverConnectService implements EverConnectPlatform {
    private readonly logger = new Logger(EverConnectService.name);
    private cached: { key: string; client: EverPlatformClient } | null = null;

    constructor(
        @InjectRepository(EverConnectConnection)
        private readonly connections: Repository<EverConnectConnection>,
        private readonly keys: EverConnectKeyService,
        @Inject(EVER_CONNECT_CONFIG) private readonly config: EverConnectConfig,
        private readonly events: EventEmitter2,
    ) {}

    /** The connection row, created (disconnected) on first use. */
    async connection(): Promise<EverConnectConnection> {
        const existing = await this.connections.findOne({
            where: { id: EVER_CONNECT_CONNECTION_ROW_ID },
        });
        if (existing) return existing;
        await this.connections
            .createQueryBuilder()
            .insert()
            .into(EverConnectConnection)
            .values({ id: EVER_CONNECT_CONNECTION_ROW_ID, status: 'disconnected' })
            .orIgnore()
            .execute();
        const row = await this.connections.findOne({
            where: { id: EVER_CONNECT_CONNECTION_ROW_ID },
        });
        if (!row) throw new Error('ever_connect_connection row could not be created');
        return row;
    }

    async status(): Promise<EverConnectStatus> {
        const row = await this.connection();
        return {
            status: row.status,
            platformInstanceId: row.platformInstanceId,
            connectedAt: row.connectedAt ? new Date(row.connectedAt).toISOString() : null,
            lastError: row.lastError,
        };
    }

    /** The client of the connection, or `null` when the installation is not connected. */
    async client(): Promise<EverPlatformClient | null> {
        const row = await this.connection();
        if (
            (row.status !== 'active' && row.status !== 'pending_approval') ||
            !row.platformInstanceId
        ) {
            return null;
        }
        const signer = await this.keys.signer();
        if (!signer) return null;
        const key = `${row.platformInstanceId}|${signer.kid}`;
        if (this.cached?.key !== key) {
            const registryId = row.platformInstanceId;
            this.cached = { key, client: this.build(signer, () => registryId) };
        }
        return this.cached.client;
    }

    /**
     * Connect with a connect code: redeem it with the connect key and store the
     * connection. A code that is not one, or a connection that exists, is
     * refused before any request.
     */
    async connect(rawCode: string): Promise<EverConnectStatus> {
        const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
        if (!CONNECT_CODE_PATTERN.test(code)) {
            throw new BadRequestException({ code: 'code_invalid', message: 'Not a connect code.' });
        }
        const current = await this.connection();
        if (current.status === 'active' || current.status === 'pending_approval') {
            throw new ConflictException({
                code: 'already_connected',
                message: 'Already connected.',
            });
        }

        const publicJwk = await this.keys.ensure();
        const signer = await this.keys.signer();
        if (!signer) throw new Error('The connect key could not be read');
        const anonymous = this.build(signer, () => null);
        let redeemed: { instance_id: string; kid: string; status: string };
        try {
            redeemed = await anonymous.connect.redeem(
                {
                    code,
                    product: 'works',
                    version: versionAndChannel(getBuildInfo().version).version,
                    install_source: this.config.installSource,
                    kind: this.config.installSource === 'cloud' ? 'cloud' : 'self_hosted',
                    public_jwk: publicJwk,
                } as unknown as Parameters<EverPlatformClient['connect']['redeem']>[0],
                createHash('sha256').update(`${signer.kid}|${code}`).digest('hex'),
            );
        } catch (error) {
            const failure = platformFailure(error);
            const failureCode = failure.kind === 'problem' ? failure.code : failure.kind;
            await this.connections.update(
                { id: current.id },
                { lastError: failureCode.slice(0, 64) },
            );
            this.logger.warn(`Connecting to Ever Platform failed: ${describeFailure(failure)}`);
            if (failure.kind === 'problem' && failure.status === 409) {
                throw new ConflictException({ code: failure.code, message: 'Already connected.' });
            }
            if (failure.kind === 'problem' && failure.status < 500) {
                throw new UnprocessableEntityException({
                    code: failure.code,
                    message: 'Ever Platform refused the connect code.',
                });
            }
            throw error;
        }

        const status: EverConnectConnectionStatus =
            redeemed.status === 'pending_approval' ? 'pending_approval' : 'active';
        await this.connections.update(
            { id: current.id },
            {
                status,
                platformInstanceId: redeemed.instance_id,
                kid: redeemed.kid,
                connectedAt: new Date(),
                disconnectedAt: null,
                lastFeedCursor: null,
                lastError: null,
            },
        );
        this.cached = null;
        this.logger.log(`Connected to Ever Platform (${status})`);
        this.events.emit(
            EverConnectConnectionChangedEvent.EVENT_NAME,
            new EverConnectConnectionChangedEvent(status),
        );
        return this.status();
    }

    /** The operator disconnects: tell Ever Platform (best effort), then clean up here. */
    async disconnect(): Promise<EverConnectStatus> {
        const client = await this.client();
        if (client) {
            try {
                await Promise.race([
                    client.instances.disconnect(`disconnect-${randomUUID()}`),
                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error('timeout')),
                            DISCONNECT_TIMEOUT_MS,
                        ).unref(),
                    ),
                ]);
            } catch (error) {
                this.logger.warn(
                    `Ever Platform was not told of the disconnect: ${describeFailure(platformFailure(error))}`,
                );
            }
        }
        await this.ended('disconnected');
        return this.status();
    }

    /**
     * The connection ended (disconnected or revoked, here or at Ever Platform):
     * forget the client and the connect key, which Ever Platform never accepts
     * again. Integrations and the stored sign-in client are cleared by the
     * listeners of the event.
     */
    async ended(status: 'disconnected' | 'revoked'): Promise<void> {
        const row = await this.connection();
        await this.connections.update(
            { id: row.id },
            { status, disconnectedAt: new Date(), lastFeedCursor: null },
        );
        await this.keys.discard();
        this.cached = null;
        this.logger.log(`Ever Platform connection ${status}`);
        this.events.emit(
            EverConnectConnectionChangedEvent.EVENT_NAME,
            new EverConnectConnectionChangedEvent(status),
        );
    }

    /** An installation waiting for approval was approved. */
    async approved(): Promise<void> {
        const row = await this.connection();
        if (row.status !== 'pending_approval') return;
        await this.connections.update({ id: row.id }, { status: 'active' });
        this.events.emit(
            EverConnectConnectionChangedEvent.EVENT_NAME,
            new EverConnectConnectionChangedEvent('active'),
        );
    }

    /** Remember the last feed event handled. */
    async saveFeedCursor(cursor: string): Promise<void> {
        await this.connections.update(
            { id: EVER_CONNECT_CONNECTION_ROW_ID },
            { lastFeedCursor: cursor },
        );
    }

    /** Remember that the code from the environment was used, so it is never used again. */
    async markEnvCodeUsed(code: string): Promise<boolean> {
        const hash = createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
        const row = await this.connection();
        if (row.envCodeConsumedHash === hash) return false;
        await this.connections.update({ id: row.id }, { envCodeConsumedHash: hash });
        return true;
    }

    private build(
        signer: InstanceSigner,
        registryInstanceId: () => string | null,
    ): EverPlatformClient {
        return createEverPlatformClient({
            baseUrl: this.config.platformApiUrl,
            ...(this.config.issuer ? { issuer: this.config.issuer } : {}),
            userAgentProduct: {
                product: 'works',
                version: versionAndChannel(getBuildInfo().version).version,
            },
            signer,
            registryInstanceId,
            onWarning: (message) => this.logger.warn(message),
        });
    }
}
