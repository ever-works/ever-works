import {
	Entity,
	Column,
	PrimaryGeneratedColumn,
	CreateDateColumn,
	UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'user_sync_configs' })
export class UserSyncConfig {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ unique: true })
	userId: string;

	@Column({ type: 'varchar', default: 'github' })
	provider: string;

	@Column()
	repoOwner: string;

	@Column()
	repoName: string;

	@Column({ type: 'boolean', default: false })
	includeSecrets: boolean;

	@Column({ type: 'datetime', nullable: true })
	lastPushAt?: Date | null;

	@Column({ type: 'datetime', nullable: true })
	lastPullAt?: Date | null;

	@Column({ type: 'varchar', nullable: true })
	lastSyncError?: string | null;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}
