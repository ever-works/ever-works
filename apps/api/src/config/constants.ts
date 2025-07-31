export const jwtConstants = {
    secret: () => process.env.JWT_SECRET || 'secret_key_here',
};
