import {
	Entity,
	Column,
	PrimaryGeneratedColumn,
	CreateDateColumn,
	UpdateDateColumn
} from 'typeorm';

@Entity({ name: 'verifications' })
export class AuthVerification {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column()
	identifier: string;

	@Column({ type: 'text' })
	value: string;

	@Column()
	expiresAt: Date;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn({ nullable: true })
	updatedAt: Date;
}
