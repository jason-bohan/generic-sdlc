import { defineConfig } from 'cypress';

export default defineConfig({
    e2e: {
        // CYPRESS_BASE_URL env var overrides for Docker test isolation
        baseUrl: process.env.CYPRESS_BASE_URL || 'http://localhost:3847',
        supportFile: 'cypress/support/e2e.ts',
        specPattern: 'cypress/e2e/**/*.cy.ts',
        viewportWidth: 1280,
        viewportHeight: 800,
        defaultCommandTimeout: 10000,
        video: false,
        screenshotOnRunFailure: true,
        retries: { runMode: 1, openMode: 0 },
        env: {
            // CYPRESS_API_URL overrides for Docker test isolation
            // e.g. bin/docker-test.ps1 sets this to http://localhost:<container-port>
            apiUrl: process.env.CYPRESS_API_URL || 'http://localhost:3001',
        },
    },
});
