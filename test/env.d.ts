declare module 'cloudflare:test' {
	interface ProvidedEnv extends Env {
		/** Migrations handed to applyD1Migrations() by the vitest config. */
		TEST_MIGRATIONS: D1Migration[];
	}
}
