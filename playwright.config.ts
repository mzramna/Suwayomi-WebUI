import { defineConfig } from '@playwright/test';

/**
 * Testes E2E da WebUI contra o servidor mock (tests/e2e/mock-server). O mock mantém estado em memória, por isso os
 * testes rodam em série (1 worker) e cada teste faz `reset` antes de começar.
 */
const port = Number(process.env.MOCK_PORT ?? 4580);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
    testDir: 'tests/e2e',
    testMatch: '**/*.spec.ts',
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    timeout: 30_000,
    expect: { timeout: 10_000 },
    reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : [['list']],
    outputDir: 'test-results',
    use: {
        baseURL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        // o service worker do PWA não deve interceptar as requisições que os testes observam
        serviceWorkers: 'block',
        locale: 'en-US',
        timezoneId: 'UTC',
        // Chromium já instalado fora do cache do Playwright (ex.: ambiente local sem acesso à rede)
        launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
    },
    // sobe o mock quando ainda não há um rodando (no CI ele já é iniciado em background pelo workflow)
    webServer: {
        command: 'pnpm exec tsx tests/e2e/mock-server/server.ts',
        url: `${baseURL}/__mock/unhandled`,
        reuseExistingServer: true,
        env: { PORT: String(port) },
        timeout: 30_000,
    },
});
