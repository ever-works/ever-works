import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Tasks feature — Phase 11.2 (spec.md `§3.3`).
 *
 * Per-user counter that gives Tasks their human-readable slug
 * (e.g. `T-12345`). The service-side `TaskService.create` uses a
 * transactional CAS-increment on this row to avoid two parallel
 * inserts colliding on the same slug — same posture as the work
 * generation history sequence counter.
 */
@Entity({ name: 'user_task_counter' })
export class UserTaskCounter {
	@PrimaryColumn({ type: 'uuid' })
	userId: string;

	@Column({ type: 'int', default: 0 })
	lastSlugNumber: number;

	@UpdateDateColumn()
	updatedAt: Date;
}
