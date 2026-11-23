/**
 * Configurações > Downloads: política de download do Karasu (GET/PUT /api/v1/karasu/policy).
 */
import type { Page } from '@playwright/test';
import { expect, KARASU, test } from './support/mock.ts';

const SERVER_ONLY = 'Server only (NFS)';
const SERVER_AND_CLIENTS = 'Server and Karasu devices';

const openPolicyDialog = async (page: Page) => {
    await page.goto('/settings/download');

    const setting = page.locator('.MuiListItemButton-root', { hasText: 'Download policy' });
    await expect(setting).toBeVisible();
    await setting.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Download policy');
    return { setting, dialog };
};

test.describe('Settings > Downloads > Karasu download policy', () => {
    test('shows the policy stored on the server', async ({ page, mock }) => {
        await page.goto('/settings/download');

        const setting = page.locator('.MuiListItemButton-root', { hasText: 'Download policy' });
        await expect(setting).toContainText(SERVER_ONLY);
        expect(await mock.find({ method: 'GET', path: `${KARASU}/policy` })).toHaveLength(1);

        await mock.seed({ policy: 'SERVER_AND_CLIENTS' });
        await page.reload();
        await expect(page.locator('.MuiListItemButton-root', { hasText: 'Download policy' })).toContainText(
            SERVER_AND_CLIENTS,
        );
    });

    test('saves "Server and Karasu devices" with PUT /policy after OK', async ({ page, mock }) => {
        const { setting, dialog } = await openPolicyDialog(page);

        const before = Date.now();
        await dialog.getByRole('combobox').click();
        await page.getByRole('option', { name: SERVER_AND_CLIENTS }).click();
        await expect(dialog).toContainText('also to the connected Karasu devices');
        await dialog.getByRole('button', { name: 'Ok' }).click();

        const puts = await mock.waitForRequests({ method: 'PUT', path: `${KARASU}/policy` });
        expect(puts).toHaveLength(1);
        expect(puts[0].body).toEqual({ downloadPolicy: 'SERVER_AND_CLIENTS' });
        expect(puts[0].status).toBe(200);

        await expect(setting).toContainText(SERVER_AND_CLIENTS);
        expect((await mock.state()).policy).toBe('SERVER_AND_CLIENTS');

        const operations = await mock.waitForOperations('POLICY');
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            entity: 'POLICY',
            key: 'policy',
            action: 'SET',
            value: { downloadPolicy: 'SERVER_AND_CLIENTS' },
            deviceId: 'web',
        });
        expect(operations[0].ts).toBeGreaterThanOrEqual(before);
        expect(operations[0].ts).toBeLessThanOrEqual(Date.now());
    });

    test('goes back to "Server only (NFS)" with PUT /policy', async ({ page, mock }) => {
        await mock.seed({ policy: 'SERVER_AND_CLIENTS' });
        const { setting, dialog } = await openPolicyDialog(page);
        await expect(setting).toContainText(SERVER_AND_CLIENTS);

        await dialog.getByRole('combobox').click();
        await page.getByRole('option', { name: SERVER_ONLY }).click();
        await dialog.getByRole('button', { name: 'Ok' }).click();

        const puts = await mock.waitForRequests({ method: 'PUT', path: `${KARASU}/policy` });
        expect(puts).toHaveLength(1);
        expect(puts[0].body).toEqual({ downloadPolicy: 'SERVER_ONLY' });
        await expect(setting).toContainText(SERVER_ONLY);
        expect((await mock.state()).policy).toBe('SERVER_ONLY');
    });

    test('does not send anything when the dialog is cancelled', async ({ page, mock }) => {
        const { setting, dialog } = await openPolicyDialog(page);

        await dialog.getByRole('combobox').click();
        await page.getByRole('option', { name: SERVER_AND_CLIENTS }).click();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();

        await expect(setting).toContainText(SERVER_ONLY);
        await mock.expectNoRequest({ method: 'PUT', path: `${KARASU}/policy` });
        expect((await mock.state()).policy).toBe('SERVER_ONLY');
        expect(await mock.operations('POLICY')).toEqual([]);

        // reabrir o diálogo mostra o valor salvo, não o que foi cancelado
        await setting.click();
        await expect(page.getByRole('dialog').getByRole('combobox')).toHaveText(SERVER_ONLY);
    });

    test('keeps the old value and notifies when saving the policy fails', async ({ page, mock }) => {
        await mock.seed({
            faults: [{ method: 'PUT', path: `${KARASU}/policy`, status: 500, error: 'policy storage is read-only' }],
        });
        const { setting, dialog } = await openPolicyDialog(page);

        await dialog.getByRole('combobox').click();
        await page.getByRole('option', { name: SERVER_AND_CLIENTS }).click();
        await dialog.getByRole('button', { name: 'Ok' }).click();

        await expect(page.getByText('Failed to save changes')).toBeVisible();
        await expect(page.getByText('policy storage is read-only')).toBeVisible();
        const puts = await mock.waitForRequests({ method: 'PUT', path: `${KARASU}/policy` });
        expect(puts[0].status).toBe(500);
        await expect(setting).toContainText(SERVER_ONLY);
        expect((await mock.state()).policy).toBe('SERVER_ONLY');
    });
});
