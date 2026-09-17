import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Work } from '../entities/work.entity';
import { WorkKnowledgeChunkRepository } from '../database/repositories/work-knowledge-chunk.repository';
import { VectorNamespaceChunkRepository } from '../database/repositories/vector-namespace-chunk.repository';
import { CustomCapabilityRegistryService } from '../plugins/services/custom-capability-registry.service';

/**
 * Name the host publishes its chunk tables under through the plugin host's
 * custom-capability channel (`PluginContext.getCustomCapability(name)`).
 * A capability name, not a plugin id. The bundled pgvector store mirrors the
 * literal as `PGVECTOR_HOST_CHUNK_TABLES_CAPABILITY`; each side's spec pins it.
 */
export const VECTOR_STORE_HOST_CHUNK_TABLES_CAPABILITY = 'vector-store:host-chunk-tables';

/** Provider id recorded on the capability registration — the platform itself. */
export const VECTOR_STORE_HOST_PROVIDER = 'platform';

/**
 * Structural mirror of the pgvector plugin's `PgVectorChunkRepositoryPort`.
 * `@ever-works/agent` cannot import a plugin package, so the shape is
 * restated here; `vector-store-host-chunk-tables.service.spec.ts` pins the
 * method set.
 */
export interface HostChunkTablePort {
    replaceForDocument(
        key: string,
        documentId: string,
        chunks: ReadonlyArray<{
            readonly id: string;
            readonly documentId: string;
            readonly chunkIndex: number;
            readonly content: string;
            readonly tokenCount: number;
            readonly embedding?: number[] | null;
            readonly metadata?: Record<string, unknown> | null;
            readonly tenantId?: string | null;
            readonly organizationId?: string | null;
        }>,
    ): Promise<void>;
    findNearestByEmbedding(
        key: string,
        embedding: readonly number[],
        limit: number,
    ): Promise<
        Array<{
            id: string;
            workId: string;
            documentId: string;
            chunkIndex: number;
            content: string;
            distance: number;
        }>
    >;
    deleteByDocument(key: string, documentId: string): Promise<void>;
    deleteByWork(key: string): Promise<void>;
}

/** Structural mirror of the pgvector plugin's `PgVectorHostChunkTables`. */
export interface HostChunkTables {
    readonly chunkRepository: HostChunkTablePort;
    readonly namespaceChunkRepository: HostChunkTablePort;
    readonly workNamespaces: { isWork(namespaceId: string): Promise<boolean> };
    readonly pingDatabase: () => Promise<boolean>;
}

const WORK_ID_CACHE_MAX = 5_000;
const VECTOR_EXTENSION_RECHECK_MS = 60_000;

/**
 * AW-07 — publishes the platform database's vector chunk tables to row-filter
 * vector stores (the bundled pgvector plugin) through the plugin host.
 *
 * ## Why this exists
 *
 * The pgvector plugin delegates its SQL to a host repository port
 * (`setChunkRepository`), but nothing in the API ever supplied one: every
 * pgvector call threw `unavailable`, so the Knowledge Base degraded to
 * lexical ranking and memory facts to exact-words search on the default
 * install. This service is that wiring, through the plugin host's EXISTING
 * sharing channel — `CustomCapabilityRegistryService`, which every
 * `PluginContext.getCustomCapability()` reads — so no plugin id appears here
 * and a registry-installed vector store (e.g. Qdrant) is untouched.
 *
 * ## The two tables
 *
 *  - `chunkRepository` — `WorkKnowledgeChunkRepository` over
 *    `work_knowledge_chunks`, exactly as the Knowledge Base always used it:
 *    same methods, same SQL.
 *  - `namespaceChunkRepository` — `VectorNamespaceChunkRepository` over
 *    `vector_namespace_chunks`, for namespaces that are not a Work (a
 *    workspace's memory facts), which the Work table's foreign keys refuse.
 *  - `workNamespaces.isWork(id)` — decides between them from the `works`
 *    table. Positive answers are cached (a Work id stays a Work id; its
 *    chunks cascade away with it); negative answers are NOT, so a Work
 *    created after a lookup can never be routed to the wrong table.
 *
 * ## Availability
 *
 * `pingDatabase` answers `true` only on Postgres with the `vector` extension
 * installed. On SQLite (tests, the OSS e2e stack) it answers `false`, so
 * memory facts keep reporting exact-words mode there instead of promising
 * meaning-based search the database cannot run.
 */
@Injectable()
export class VectorStoreHostChunkTablesService implements OnModuleInit {
    private readonly logger = new Logger(VectorStoreHostChunkTablesService.name);
    private readonly knownWorkIds = new Set<string>();
    private vectorExtension: { available: boolean; checkedAt: number } | null = null;

    constructor(
        private readonly capabilities: CustomCapabilityRegistryService,
        private readonly workChunks: WorkKnowledgeChunkRepository,
        private readonly namespaceChunks: VectorNamespaceChunkRepository,
        @InjectRepository(Work)
        private readonly works: Repository<Work>,
    ) {}

    onModuleInit(): void {
        if (this.capabilities.has(VECTOR_STORE_HOST_CHUNK_TABLES_CAPABILITY)) {
            return;
        }
        this.capabilities.register(
            {
                name: VECTOR_STORE_HOST_CHUNK_TABLES_CAPABILITY,
                description:
                    'Platform database vector chunk tables for row-filter vector stores: ' +
                    'Work-scoped Knowledge Base chunks and non-Work namespaces.',
                version: '1',
                methods: [
                    'chunkRepository',
                    'namespaceChunkRepository',
                    'workNamespaces',
                    'pingDatabase',
                ],
            },
            this.tables(),
            VECTOR_STORE_HOST_PROVIDER,
        );
        this.logger.log('Published vector chunk tables to the plugin host');
    }

    /** The bindings object published under the capability. */
    tables(): HostChunkTables {
        const work = this.workChunks;
        const namespaced = this.namespaceChunks;
        return {
            chunkRepository: {
                replaceForDocument: (key, documentId, chunks) =>
                    work.replaceForDocument(key, documentId, chunks),
                findNearestByEmbedding: (key, embedding, limit) =>
                    work.findNearestByEmbedding(key, embedding, limit),
                deleteByDocument: (key, documentId) => work.deleteByDocument(key, documentId),
                deleteByWork: (key) => work.deleteByWork(key),
            },
            namespaceChunkRepository: {
                replaceForDocument: (key, documentId, chunks) =>
                    namespaced.replaceForDocument(key, documentId, chunks),
                findNearestByEmbedding: (key, embedding, limit) =>
                    namespaced.findNearestByEmbedding(key, embedding, limit),
                deleteByDocument: (key, documentId) => namespaced.deleteByDocument(key, documentId),
                deleteByWork: (key) => namespaced.deleteByWork(key),
            },
            workNamespaces: { isWork: (id) => this.isWork(id) },
            pingDatabase: () => this.pingDatabase(),
        };
    }

    /** Whether `namespaceId` names a row in `works`. */
    async isWork(namespaceId: string): Promise<boolean> {
        if (this.knownWorkIds.has(namespaceId)) {
            return true;
        }
        const exists = await this.works.exists({ where: { id: namespaceId } });
        if (exists) {
            if (this.knownWorkIds.size >= WORK_ID_CACHE_MAX) {
                const oldest = this.knownWorkIds.values().next().value;
                if (oldest !== undefined) this.knownWorkIds.delete(oldest);
            }
            this.knownWorkIds.add(namespaceId);
        }
        return exists;
    }

    /** `true` only on Postgres with the `vector` extension installed. */
    async pingDatabase(): Promise<boolean> {
        const connection = this.works.manager.connection;
        if (connection.options.type !== 'postgres') {
            return false;
        }
        const cached = this.vectorExtension;
        if (
            cached &&
            (cached.available || Date.now() - cached.checkedAt < VECTOR_EXTENSION_RECHECK_MS)
        ) {
            return cached.available;
        }
        let available = false;
        try {
            const rows = (await this.works.manager.query(
                `SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
            )) as unknown[];
            available = Array.isArray(rows) && rows.length > 0;
        } catch {
            available = false;
        }
        this.vectorExtension = { available, checkedAt: Date.now() };
        return available;
    }
}
