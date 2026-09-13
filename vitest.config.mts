import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

/**
 * Tests run inside the Workers runtime via workerd, with a real local D1.
 * Migrations are read once here and applied by test/apply-migrations.ts.
 *
 * PBKDF2_ITERATIONS is lowered so account tests are fast; the iteration count
 * is stored inside each hash, so this does not change the code under test.
 */
const migrations = await readD1Migrations('./migrations');

export default defineWorkersConfig({
	test: {
		setupFiles: ['./test/apply-migrations.ts'],
		poolOptions: {
			workers: {
				singleWorker: true,
				/*
				 * Tests are fully local: a workerd instance plus a local D1 built from
				 * ./migrations. Nothing here reaches Cloudflare, so there is no remote
				 * binding to proxy and no credentials needed to run the suite.
				 */
				remoteBindings: false,
				/*
				 * The test config, not the deploy config: the pool pins an older wrangler
				 * internally that rejects the deploy-only route keys in wrangler.jsonc and
				 * would abort the run before any test executed. See wrangler.test.jsonc.
				 */
				wrangler: { configPath: './wrangler.test.jsonc' },
				miniflare: {
					bindings: {
						TEST_MIGRATIONS: migrations,
						CREDENTIAL_ENCRYPTION_KEY: 'bXVzZS1wcm94eS10ZXN0LWtleS0zMi1ieXRlcyEhISE=',
						PBKDF2_ITERATIONS: '1000',
						SIGNUP_ENABLED: 'true',
						SESSION_TTL_DAYS: '30',
						ALLOW_PRIVATE_NETWORKS: 'false',
						ALLOW_INSECURE_HTTP: 'false',
						AGENT_CORS_ORIGIN: '',
					},
				},
			},
		},
	},
});
