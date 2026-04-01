import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
    BeforeInsert,
} from 'typeorm';

const AUTH_PROVIDER_PLACEHOLDER_PASSWORD_HASH =
    '$2b$10$3FpU5KTq.lf4tUSzT4i0JOuuywnxGPnkKorObPlIEG14V0wl17ANS';

@Entity({ name: 'users', synchronize: false })
export class AuthUser {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ name: 'username' })
    name: string;

    @Column({ unique: true })
    email: string;

    @Column()
    password: string;

    @Column({ default: false })
    emailVerified: boolean;

    @Column({ name: 'avatar', nullable: true })
    image: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @BeforeInsert()
    ensurePlaceholderPassword() {
        if (!this.password) {
            this.password = AUTH_PROVIDER_PLACEHOLDER_PASSWORD_HASH;
        }
    }
}
