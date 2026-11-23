/**
 * Configurações > Karasu: card de armazenamento, gerenciador de backups e servidor sem as rotas do fork.
 */
import { deterministicBytes, expect, KARASU, test } from './support/mock.ts';

const PIXEL_BACKUP = 'karasu-pixel-8-2023-11-14.tachibk';
const TABLET_BACKUP = 'karasu-tablet-2023-11-13.tachibk';

test.describe('Settings > Karasu: storage card', () => {
    test('shows the Karasu entry in the settings menu when the server supports it', async ({ page }) => {
        await page.goto('/settings');

        await page.locator('#appMainContainer a[href="/settings/karasu"]').click();
        await expect(page).toHaveURL(/\/settings\/karasu$/);
        await expect(page.getByText('Server storage')).toBeVisible();
    });

    test('shows a H2 database as "Local (H2)" with local storage and free space', async ({ page }) => {
        await page.goto('/settings/karasu');

        const card = page.locator('.MuiCard-root', { hasText: 'Server storage' });
        await expect(card).toContainText('Database');
        await expect(card).toContainText('Local (H2)');
        await expect(card).toContainText('Storage');
        await expect(card).toContainText('/data/downloads');
        await expect(card).toContainText('100 GB free of 500 GB');
        await expect(card).toContainText('v2.1.0');
    });

    test('shows PostgreSQL and NFS storage', async ({ page, mock }) => {
        await mock.seed({
            health: {
                status: 'ok',
                serverVersion: 'v2.1.0',
                apiVersion: 1,
                database: { type: 'POSTGRESQL' },
                storage: {
                    type: 'nfs',
                    path: '/mnt/nfs/suwayomi',
                    freeBytes: 2 * 1024 ** 4,
                    totalBytes: 4 * 1024 ** 4,
                },
            },
        });
        await page.goto('/settings/karasu');

        const card = page.locator('.MuiCard-root', { hasText: 'Server storage' });
        await expect(card).toContainText('PostgreSQL');
        await expect(card).not.toContainText('Local (H2)');
        await expect(card).toContainText('NFS');
        await expect(card).toContainText('/mnt/nfs/suwayomi');
        await expect(card).toContainText('2 TB free of 4 TB');
    });
});

test.describe('Settings > Karasu: backups', () => {
    test('lists the backups with name, device, size and date', async ({ page, mock }) => {
        await page.goto('/settings/karasu');

        const pixel = page.getByRole('listitem').filter({ hasText: PIXEL_BACKUP });
        await expect(pixel).toContainText('Pixel 8 • 2 KB • 11/14/2023, 10:13 PM');
        const tablet = page.getByRole('listitem').filter({ hasText: TABLET_BACKUP });
        await expect(tablet).toContainText('Galaxy Tab • 5 MB • 11/13/2023, 06:26 PM');

        // o mais novo vem primeiro (a ordem é a do servidor)
        await expect(page.getByRole('listitem').filter({ hasText: 'tachibk' })).toHaveCount(2);
        await expect(page.getByRole('listitem').filter({ hasText: 'tachibk' }).first()).toContainText(PIXEL_BACKUP);

        expect(await mock.find({ method: 'GET', path: `${KARASU}/backups` })).toHaveLength(1);
    });

    test('shows the empty state when there are no backups', async ({ page, mock }) => {
        await mock.seed({ backups: [] });
        await page.goto('/settings/karasu');

        await expect(page.getByText('No backups uploaded by Karasu devices yet')).toBeVisible();
        await expect(page.getByRole('listitem').filter({ hasText: 'tachibk' })).toHaveCount(0);
    });

    test('downloads a backup with the exact bytes stored on the server', async ({ page, mock }) => {
        await page.goto('/settings/karasu');

        const row = page.getByRole('listitem').filter({ hasText: PIXEL_BACKUP });
        await expect(row).toBeVisible();

        const downloadPromise = page.waitForEvent('download');
        await row.getByLabel('Download').click();
        const download = await downloadPromise;

        expect(download.suggestedFilename()).toBe(PIXEL_BACKUP);
        const chunks: Buffer[] = [];
        for await (const chunk of await download.createReadStream()) {
            chunks.push(chunk as Buffer);
        }
        const received = Buffer.concat(chunks);
        const expected = deterministicBytes(PIXEL_BACKUP, 2048);
        expect(received.length, 'size of the downloaded backup').toBe(expected.length);
        expect(received.equals(expected), 'downloaded bytes differ from the backup stored on the server').toBe(true);

        expect(await mock.find({ method: 'GET', path: `${KARASU}/backups/${PIXEL_BACKUP}/download` })).toHaveLength(1);
    });

    test('deletes a backup after the confirmation and logs a BACKUP REMOVE operation', async ({ page, mock }) => {
        await page.goto('/settings/karasu');

        const row = page.getByRole('listitem').filter({ hasText: PIXEL_BACKUP });
        await expect(row).toBeVisible();

        const before = Date.now();
        await row.getByLabel('Delete').click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('Are you sure?');
        await expect(dialog).toContainText(`The backup "${PIXEL_BACKUP}" will be permanently deleted from the server.`);
        await dialog.getByRole('button', { name: 'Delete' }).click();

        await expect(page.getByRole('listitem').filter({ hasText: PIXEL_BACKUP })).toHaveCount(0);
        await expect(page.getByRole('listitem').filter({ hasText: TABLET_BACKUP })).toBeVisible();

        const deletes = await mock.waitForRequests({ method: 'DELETE', path: `${KARASU}/backups/${PIXEL_BACKUP}` });
        expect(deletes).toHaveLength(1);
        expect(deletes[0].status).toBe(204);
        expect((await mock.state()).backups.map(({ id }) => id)).toEqual([TABLET_BACKUP]);

        const operations = await mock.waitForOperations('BACKUP');
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            entity: 'BACKUP',
            key: `backup:${PIXEL_BACKUP}`,
            action: 'REMOVE',
            value: null,
            deviceId: 'web',
        });
        expect(operations[0].ts).toBeGreaterThanOrEqual(before);
        expect(operations[0].ts).toBeLessThanOrEqual(Date.now());
    });

    test('does not delete the backup when the confirmation is cancelled', async ({ page, mock }) => {
        await page.goto('/settings/karasu');

        const row = page.getByRole('listitem').filter({ hasText: PIXEL_BACKUP });
        await expect(row).toBeVisible();

        await row.getByLabel('Delete').click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('Are you sure?');
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();

        await expect(row).toBeVisible();
        await mock.expectNoRequest({ method: 'DELETE', path: `${KARASU}/backups/*` });
        expect((await mock.state()).backups).toHaveLength(2);
        expect(await mock.operations('BACKUP')).toEqual([]);
    });
});

test.describe('Server without the Karasu routes (upstream Suwayomi-Server)', () => {
    test.beforeEach(async ({ mock }) => {
        // GET /api/v1/karasu/health => 404
        await mock.seed({ health: null });
    });

    test('hides the Karasu menu entry while the rest of the settings keep working', async ({ page, mock }) => {
        await page.goto('/settings');

        const menu = page.locator('#appMainContainer');
        await expect(menu.locator('a[href="/settings/download"]')).toBeVisible();
        await expect(menu.locator('a[href="/settings/backup"]')).toBeVisible();
        await expect(menu.locator('a[href="/settings/server"]')).toBeVisible();

        const health = await mock.waitForRequests({ method: 'GET', path: `${KARASU}/health` });
        expect(health[0].status).toBe(404);
        await expect(menu.locator('a[href="/settings/karasu"]')).toHaveCount(0);

        // outras telas de configuração abrem normalmente, sem a seção do Karasu
        await menu.locator('a[href="/settings/download"]').click();
        await expect(page.getByText('Delete chapters', { exact: true })).toBeVisible();
        await expect(page.getByText('Download policy')).toHaveCount(0);
        await mock.expectNoRequest({ path: `${KARASU}/policy` });
    });

    test('explains that the integration is unavailable when /settings/karasu is opened directly', async ({
        page,
        mock,
    }) => {
        await page.goto('/settings/karasu');

        await expect(page.getByText('Karasu integration is not available')).toBeVisible();
        await expect(page.getByText('This server does not provide the Karasu API.')).toBeVisible();
        await expect(page.getByText('Server storage')).toHaveCount(0);
        await mock.expectNoRequest({ path: `${KARASU}/backups` });
    });

    test('keeps the manga page working without the merged sources section', async ({ page, mock }) => {
        await page.goto('/manga/1');

        await expect(page.getByRole('heading', { name: 'Chapter 3' }).or(page.getByText('Chapter 3'))).toBeVisible();
        await expect(page.getByText('5 chapters')).toBeVisible();
        await expect(page.getByText('Merged sources')).toHaveCount(0);
        await mock.expectNoRequest({ path: `${KARASU}/manga/*` });
    });
});
