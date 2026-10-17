/**
 * APW-07 T17/T25 (A0.10, lane aw-deploy-2, 2026-10-17) — **the API ends of the dependency
 * worker's proxies**.
 *
 * `app-dependency-provision` runs `AppDependenciesService` inside the isolated App runtime worker
 * (its provider calls dial the owner's cluster), but the worker owns no `DataSource` and no
 * encryption key. These three narrow relays are what it reaches by name over the authenticated
 * internal channel (`TriggerInternalController.remoteMap`), each exposing only the members the
 * service and runner actually call:
 *
 * - {@link AppDependencyRowsRelay} — the entity repository's `insert` / `findOne({ where: { id } })`
 *   / `update({ id }, patch)` (`app-dependencies.service.ts:1454,1638,1719`), id-scoped only: no
 *   free-form query, no delete, and a patch can never move a row to another Work or kind.
 * - {@link AppDependencyConfigCipherRelay} — `AppEnvCrypto`'s `encrypt` / `decrypt` (the config
 *   and outputs envelopes); the key never leaves the API.
 * - {@link AppDependencyProvisionDispatchRelay} — the runner's re-dispatch, through the API's own
 *   job-runtime dispatcher (FR-43's schedule), so the worker needs no job-runtime binding.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';

import { WorkAppDependency } from '../entities/work-app-dependency.entity';
import {
    APP_DEPENDENCY_CONFIG_CIPHER,
    APP_DEPENDENCY_PROVISION_DISPATCHER,
    type AppDependencyConfigCipher,
    type AppDependencyProvisionDispatcher,
} from './app-dependencies.service';

/** Columns a relayed patch may never write: the row's identity. */
const IDENTITY_COLUMNS = ['id', 'workId', 'kind', 'createdAt'] as const;

@Injectable()
export class AppDependencyRowsRelay {
    constructor(
        @Optional()
        @InjectRepository(WorkAppDependency)
        private readonly rows?: Repository<WorkAppDependency>,
    ) {}

    async insert(row: Partial<WorkAppDependency>): Promise<{ inserted: boolean }> {
        const repo = this.require();
        if (!row || typeof row.workId !== 'string' || typeof row.kind !== 'string') {
            throw new Error('A dependency row needs a workId and a kind.');
        }
        await repo.insert(row as WorkAppDependency);
        return { inserted: true };
    }

    async findOne(options: { where?: { id?: unknown } }): Promise<WorkAppDependency | null> {
        const id = options?.where?.id;
        if (typeof id !== 'string' || !id) return null;
        return this.require().findOne({ where: { id } });
    }

    async update(
        criteria: { id?: unknown },
        patch: Record<string, unknown>,
    ): Promise<{ affected: number }> {
        const id = criteria?.id;
        if (typeof id !== 'string' || !id)
            throw new Error('A dependency row update is scoped by id only.');
        const safe: Record<string, unknown> = { ...(patch ?? {}) };
        for (const column of IDENTITY_COLUMNS) delete safe[column];
        if (Object.keys(safe).length === 0) return { affected: 0 };
        const result = await this.require().update({ id }, safe as never);
        return { affected: result?.affected ?? 0 };
    }

    private require(): Repository<WorkAppDependency> {
        if (!this.rows)
            throw new Error('No WorkAppDependency repository is bound in this process.');
        return this.rows;
    }
}

@Injectable()
export class AppDependencyConfigCipherRelay implements AppDependencyConfigCipher {
    constructor(
        @Optional()
        @Inject(APP_DEPENDENCY_CONFIG_CIPHER)
        private readonly cipher?: AppDependencyConfigCipher,
    ) {}

    async encrypt(value: string): Promise<string> {
        if (!this.cipher) throw new Error('No dependency config cipher is bound in this process.');
        return this.cipher.encrypt(String(value));
    }

    async decrypt(envelope: string): Promise<string> {
        if (!this.cipher) throw new Error('No dependency config cipher is bound in this process.');
        return this.cipher.decrypt(String(envelope));
    }
}

@Injectable()
export class AppDependencyProvisionDispatchRelay {
    constructor(
        @Optional()
        @Inject(APP_DEPENDENCY_PROVISION_DISPATCHER)
        private readonly dispatcher?: AppDependencyProvisionDispatcher,
    ) {}

    async dispatchAppDependencyProvision(
        payload: Parameters<AppDependencyProvisionDispatcher['dispatchAppDependencyProvision']>[0],
    ): Promise<string> {
        if (!this.dispatcher?.dispatchAppDependencyProvision) {
            throw new Error('No app-dependency-provision dispatcher is bound in this process.');
        }
        return this.dispatcher.dispatchAppDependencyProvision(payload);
    }
}
