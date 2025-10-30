import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    Index,
} from 'typeorm';
import { User } from './user.entity';
import type { ClassToObject } from './types';

@Entity({ name: 'refresh_tokens' })
@Index(['token'], { unique: true })
@Index(['expiresAt'])
export class RefreshToken {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ unique: true })
    token: string;

    @Column()
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    user: ClassToObject<User>;

    @Column()
    expiresAt: Date;

    @Column({ nullable: true })
    family: string; // For refresh token rotation tracking

    @Column({ default: false })
    revoked: boolean;

    @Column({ nullable: true })
    revokedAt: Date;

    @Column({ nullable: true })
    revokedReason: string;

    @Column({ nullable: true })
    userAgent: string;

    @Column({ nullable: true })
    ipAddress: string;

    @CreateDateColumn()
    createdAt: Date;
}
