import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    Index,
} from 'typeorm';
import { User } from './user.entity';

@Entity()
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
    user: User;

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
