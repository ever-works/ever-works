import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { MilestoneRecord, RosterProvisionRecord } from '@ever-works/contracts/api';
import { OnboardingChecklist } from '../../entities/onboarding-checklist.entity';

/** Fields a write may set on a checklist row. Omitted fields are left alone. */
export interface OnboardingChecklistPatch {
    readonly milestones?: Record<string, MilestoneRecord>;
    readonly provisioning?: RosterProvisionRecord | null;
    readonly rosterAcknowledgedAt?: Date | null;
    readonly hiddenAt?: Date | null;
    readonly dismissedAt?: Date | null;
    readonly completedAt?: Date | null;
    readonly evaluatedAt?: Date | null;
}

/**
 * AW-20 — persistence for `onboarding_checklists`.
 *
 * One row per (person, workspace scope). Access pattern is a single-row
 * read followed by a field-level write, so this is shaped like
 * `OrganizationOnboardingProfileRepository`: find + ensure + patch, no
 * list, no delete. Nothing sweeps this table — a first hour that never
 * finished is a record, not garbage.
 *
 * Every method takes the scope explicitly. There is deliberately no
 * "find by userId" that ignores the Organization: two workspaces are two
 * first hours, and a read that forgot which one it was in would silently
 * show the wrong progress.
 */
@Injectable()
export class OnboardingChecklistRepository {
    constructor(
        @InjectRepository(OnboardingChecklist)
        private readonly repository: Repository<OnboardingChecklist>,
    ) {}

    /** The row for this person in this scope, or null when none exists yet. */
    async find(userId: string, organizationId: string | null): Promise<OnboardingChecklist | null> {
        return this.repository.findOne({
            where: { userId, scopeKey: organizationId ?? 'personal' },
        });
    }

    /**
     * The row, creating it if this is the first read (FR-43 — an account
     * that never loads the checklist never gets a row).
     *
     * A lost insert race is treated as success: the UNIQUE
     * `(userId, scopeKey)` index lets exactly one racer win, and the
     * loser simply re-reads the winner's row. Two tabs opening the
     * dashboard at once is the common case, not an error worth surfacing.
     */
    async ensure(userId: string, organizationId: string | null): Promise<OnboardingChecklist> {
        const existing = await this.find(userId, organizationId);
        if (existing) return existing;

        const row = this.repository.create({
            userId,
            organizationId: organizationId ?? null,
            scopeKey: organizationId ?? 'personal',
            milestones: {},
        });
        try {
            return await this.repository.save(row);
        } catch {
            const raced = await this.find(userId, organizationId);
            if (raced) return raced;
            throw new Error('Could not create or read the onboarding checklist row.');
        }
    }

    /** Field-level update; `undefined` leaves a field alone, `null` clears it. */
    async patch(
        userId: string,
        organizationId: string | null,
        patch: OnboardingChecklistPatch,
    ): Promise<OnboardingChecklist> {
        const row = await this.ensure(userId, organizationId);

        const update: Partial<OnboardingChecklist> = {};
        if (patch.milestones !== undefined) update.milestones = patch.milestones;
        if (patch.provisioning !== undefined) update.provisioning = patch.provisioning;
        if (patch.rosterAcknowledgedAt !== undefined) {
            update.rosterAcknowledgedAt = patch.rosterAcknowledgedAt;
        }
        if (patch.hiddenAt !== undefined) update.hiddenAt = patch.hiddenAt;
        if (patch.dismissedAt !== undefined) update.dismissedAt = patch.dismissedAt;
        if (patch.completedAt !== undefined) update.completedAt = patch.completedAt;
        if (patch.evaluatedAt !== undefined) update.evaluatedAt = patch.evaluatedAt;

        if (Object.keys(update).length === 0) return row;

        await this.repository.update({ id: row.id }, update);
        return (await this.find(userId, organizationId)) ?? row;
    }

    /**
     * Start a provisioning run, but only if the caller's view of the row
     * is still current.
     *
     * This is the whole of the "at most one run in flight per person and
     * scope" guarantee (FR-16). Two tabs pressing **Create my agents**
     * within a second of each other both read the same row; each passes
     * the `updatedAt` it saw, and the UPDATE's WHERE clause lets exactly
     * one of them land. The loser gets `false` and is told a run is
     * already going, instead of both tabs queueing a run and racing to
     * create the same four agents.
     *
     * Optimistic concurrency on `updatedAt` rather than a comparison of
     * the stored JSON: `provisioning` is a `simple-json` (text) column, so
     * matching on its contents would mean string-matching serialized JSON
     * in SQL — fragile on one dialect and wrong on the other.
     */
    async startProvisioningIfUnchanged(
        userId: string,
        organizationId: string | null,
        seenUpdatedAt: Date,
        next: RosterProvisionRecord,
    ): Promise<boolean> {
        const row = await this.find(userId, organizationId);
        if (!row) return false;

        const result = await this.repository
            .createQueryBuilder()
            .update(OnboardingChecklist)
            .set({ provisioning: next })
            .where('id = :id', { id: row.id })
            .andWhere('updatedAt = :seenUpdatedAt', { seenUpdatedAt })
            .execute();

        return (result.affected ?? 0) > 0;
    }

    /**
     * The row whose provisioning record names this run — used by the
     * background worker, which is handed a run id and has to find the row
     * that owns it. At most one row can match: a run id is a fresh uuid.
     */
    async findByRunId(userId: string, runId: string): Promise<OnboardingChecklist | null> {
        const rows = await this.repository.find({ where: { userId } });
        return rows.find((row) => row.provisioning?.runId === runId) ?? null;
    }
}
