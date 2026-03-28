import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'users', synchronize: false })
export class AuthUser {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'username' })
    name: string;

    @Column({ unique: true })
    email: string;

    @Column({ default: false })
    emailVerified: boolean;

    @Column({ name: 'avatar', nullable: true })
    image: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
