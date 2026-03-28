import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { AuthUser } from './auth-user.entity';

@Entity({ name: 'accounts' })
export class AuthAccount {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    userId: string;

    @ManyToOne(() => AuthUser, { onDelete: 'CASCADE' })
    user: AuthUser;

    @Column()
    accountId: string;

    @Column()
    providerId: string;

    @Column({ type: 'text', nullable: true })
    accessToken: string;

    @Column({ type: 'text', nullable: true })
    refreshToken: string;

    @Column({ type: 'datetime', nullable: true })
    accessTokenExpiresAt: Date;

    @Column({ type: 'datetime', nullable: true })
    refreshTokenExpiresAt: Date;

    @Column({ type: 'datetime', nullable: true })
    expiresAt: Date;

    @Column({ nullable: true })
    scope: string;

    @Column({ type: 'text', nullable: true })
    password: string;

    @Column({ type: 'text', nullable: true })
    idToken: string;

    @Column({ nullable: true })
    tokenType: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
