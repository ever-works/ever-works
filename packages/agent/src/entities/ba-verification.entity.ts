import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'ba_verification' })
export class BaVerification {
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
