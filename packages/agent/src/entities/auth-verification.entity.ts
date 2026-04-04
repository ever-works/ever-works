import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'auth_verifications' })
@Index(['identifier'])
@Index(['value'], { unique: true })
export class AuthVerification {
	@PrimaryColumn({ type: 'varchar' })
	id: string;

	@Column({ type: 'varchar' })
	identifier: string;

	@Column({ type: 'text' })
	value: string;

	@Column({ type: 'timestamp' })
	expiresAt: Date;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}
