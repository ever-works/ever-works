import {
	Entity,
	Column,
	PrimaryGeneratedColumn,
	ManyToOne,
	CreateDateColumn,
	UpdateDateColumn
} from 'typeorm';
import { AuthUser } from './auth-user.entity';

@Entity({ name: 'sessions' })
export class AuthSession {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column()
	userId: string;

	@ManyToOne(() => AuthUser, { onDelete: 'CASCADE' })
	user: AuthUser;

	@Column({ unique: true })
	token: string;

	@Column()
	expiresAt: Date;

	@Column({ nullable: true })
	ipAddress: string;

	@Column({ nullable: true })
	userAgent: string;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}
