import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'auth_sessions' })
@Index(['token'], { unique: true })
@Index(['userId'])
export class AuthSession {
	@PrimaryColumn({ type: 'varchar' })
	id: string;

	@Column({ type: 'varchar' })
	userId: string;

	@Column({ type: 'text' })
	token: string;

	@Column({ type: 'timestamp' })
	expiresAt: Date;

	@Column({ type: 'varchar', nullable: true })
	ipAddress?: string | null;

	@Column({ type: 'varchar', nullable: true })
	userAgent?: string | null;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}
