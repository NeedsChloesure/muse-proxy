import { applyD1Migrations, env } from 'cloudflare:test';

// Setup files run outside isolated storage and may run more than once.
// applyD1Migrations() only applies migrations that have not been applied yet,
// so calling it here is safe and works with per-test isolated storage.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
