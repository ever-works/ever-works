import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Mission } from '../entities/mission.entity';
import { toMissionDto, type MissionDto } from './types';

/**
 * Phase 3 PR G — MissionsService skeleton (Missions/Ideas/Works
 * build).
 *
 * This PR only ships the listForUser read path so the module's DI
 * graph is exercised at boot and `GET /me/missions` returns []
 * gracefully for users with no Missions yet. Full CRUD + lifecycle
 * (pause / resume / complete / delete / run-now) lands in PR H.
 *
 * The service intentionally injects the raw TypeORM `Repository<Mission>`
 * rather than a custom `MissionRepository` class — the Mission
 * data-access surface is small enough that a custom repository
 * doesn't earn its keep yet. If/when query complexity grows
 * (Phase 3 PR J's tick worker may want hand-tuned queries) we can
 * extract a repository later without changing the service contract.
 */
@Injectable()
export class MissionsService {
    private readonly logger = new Logger(MissionsService.name);

    constructor(
        @InjectRepository(Mission)
        private readonly missions: Repository<Mission>,
    ) {}

    /**
     * List all Missions owned by `userId`, sorted by `updatedAt`
     * desc (most-recently-touched first). Returns DTOs, not raw
     * entities, so consumers don't accidentally lean on TypeORM
     * internals.
     *
     * Phase 3 PR G placeholder: no status filtering, no pagination.
     * PR H adds filter + pagination; PR R (Phase 6 frontend) drives
     * the design for which controls land where.
     */
    async listForUser(userId: string): Promise<MissionDto[]> {
        const rows = await this.missions.find({
            where: { userId },
            order: { updatedAt: 'DESC' },
        });
        return rows.map(toMissionDto);
    }
}
