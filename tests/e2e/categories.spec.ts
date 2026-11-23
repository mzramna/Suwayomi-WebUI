/**
 * Configurações > Categorias (recurso nativo da WebUI): criar, renomear e apagar pela UI. Cada mudança chega ao servidor
 * como mutação GraphQL e vira uma operação CATEGORY no log do contrato v2.
 */
import type { Page } from '@playwright/test';
import { expect, SOURCE_A_ID, test } from './support/mock.ts';
import { openMangaPage } from './support/manga.ts';

const categoryCard = (page: Page, name: string) =>
    page.getByRole('heading', { name, exact: true }).locator('xpath=ancestor::*[.//*[@aria-label="Edit"]][1]');

const openCategories = async (page: Page) => {
    await page.goto('/settings/categories');
    await expect(page.getByRole('heading', { name: 'Action', exact: true })).toBeVisible();
};

const fillCategoryDialog = async (page: Page, title: string, name: string) => {
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(title);
    await dialog.getByLabel('Category Name').fill(name);
    await dialog.getByRole('button', { name: 'Submit' }).click();
    await expect(dialog).toBeHidden();
};

test.describe('Settings > Categories', () => {
    test('creates a category', async ({ page, mock }) => {
        await openCategories(page);

        const before = Date.now();
        await page.getByRole('button', { name: 'add' }).click();
        await fillCategoryDialog(page, 'New category', 'Test Category');

        await expect(page.getByRole('heading', { name: 'Test Category', exact: true })).toBeVisible();
        const [create] = await mock.waitForRequests({ operation: 'CREATE_CATEGORY' });
        expect(create.graphql?.variables).toMatchObject({ input: { name: 'Test Category' } });

        const { categories } = await mock.state();
        const created = categories.find(({ name }) => name === 'Test Category');
        expect(created, 'the mock server has no category named "Test Category"').toBeDefined();

        const operations = await mock.waitForOperations('CATEGORY');
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            entity: 'CATEGORY',
            key: `category:${created!.id}`,
            action: 'SET',
            value: { name: 'Test Category' },
            deviceId: 'web',
        });
        expect(operations[0].ts).toBeGreaterThanOrEqual(before);
        expect(operations[0].ts).toBeLessThanOrEqual(Date.now());
    });

    test('renames a category with updateCategory and logs a CATEGORY SET with the new name', async ({ page, mock }) => {
        await openCategories(page);

        const before = Date.now();
        await categoryCard(page, 'Action').getByLabel('Edit').click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByLabel('Category Name')).toHaveValue('Action');
        await fillCategoryDialog(page, 'Edit category', 'Action & Adventure');

        await expect(page.getByRole('heading', { name: 'Action & Adventure', exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Action', exact: true })).toHaveCount(0);

        const [update] = await mock.waitForRequests({ operation: 'UPDATE_CATEGORY' });
        expect(update.graphql?.variables).toMatchObject({
            input: { id: 1, patch: { name: 'Action & Adventure' } },
            getName: true,
        });
        expect((await mock.state()).categories.find(({ id }) => id === 1)?.name).toBe('Action & Adventure');

        const operations = await mock.waitForOperations('CATEGORY');
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            entity: 'CATEGORY',
            key: 'category:1',
            action: 'SET',
            value: { name: 'Action & Adventure' },
            deviceId: 'web',
        });
        expect(operations[0].ts).toBeGreaterThanOrEqual(before);
        expect(operations[0].ts).toBeLessThanOrEqual(Date.now());

        // persiste no servidor
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Action & Adventure', exact: true })).toBeVisible();
    });

    test('saving without changing the name is not logged as an operation', async ({ page, mock }) => {
        await openCategories(page);

        await categoryCard(page, 'Action').getByLabel('Edit').click();
        await fillCategoryDialog(page, 'Edit category', 'Action');

        // a mutação é enviada, mas o valor é o mesmo: o servidor só registra mudanças efetivas
        await mock.waitForRequests({ operation: 'UPDATE_CATEGORY' });
        expect(await mock.operations('CATEGORY')).toEqual([]);
    });

    test('does not allow an empty name', async ({ page, mock }) => {
        await openCategories(page);

        await categoryCard(page, 'Action').getByLabel('Edit').click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Category Name').fill('   ');
        await expect(dialog.getByText('Invalid input')).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Submit' })).toBeDisabled();
        await dialog.getByRole('button', { name: 'Cancel' }).click();

        await mock.expectNoRequest({ operation: 'UPDATE_CATEGORY' });
    });

    test('deletes a category after the confirmation', async ({ page, mock }) => {
        await openCategories(page);

        const before = Date.now();
        await categoryCard(page, 'Favorites').getByLabel('Delete').click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('You are about to delete category "Favorites"');
        await dialog.getByRole('button', { name: 'Ok' }).click();

        await expect(page.getByRole('heading', { name: 'Favorites', exact: true })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'Action', exact: true })).toBeVisible();

        const [remove] = await mock.waitForRequests({ operation: 'DELETE_CATEGORY' });
        expect(remove.graphql?.variables).toMatchObject({ input: { categoryId: 2 } });
        expect((await mock.state()).categories.map(({ id }) => id)).toEqual([0, 1]);

        const operations = await mock.waitForOperations('CATEGORY');
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            entity: 'CATEGORY',
            key: 'category:2',
            action: 'REMOVE',
            value: null,
            deviceId: 'web',
        });
        expect(operations[0].ts).toBeGreaterThanOrEqual(before);
        expect(operations[0].ts).toBeLessThanOrEqual(Date.now());
    });

    test('cancelling the delete confirmation keeps the category', async ({ page, mock }) => {
        await openCategories(page);

        await categoryCard(page, 'Favorites').getByLabel('Delete').click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('You are about to delete category "Favorites"');
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();

        await expect(page.getByRole('heading', { name: 'Favorites', exact: true })).toBeVisible();
        await mock.expectNoRequest({ operation: 'DELETE_CATEGORY' });
        expect(await mock.operations('CATEGORY')).toEqual([]);
    });

    test('create, rename and delete share the same category key in the log', async ({ page, mock }) => {
        await openCategories(page);

        await page.getByRole('button', { name: 'add' }).click();
        await fillCategoryDialog(page, 'New category', 'Lifecycle');
        await expect(page.getByRole('heading', { name: 'Lifecycle', exact: true })).toBeVisible();

        await categoryCard(page, 'Lifecycle').getByLabel('Edit').click();
        await fillCategoryDialog(page, 'Edit category', 'Lifecycle 2');
        await expect(page.getByRole('heading', { name: 'Lifecycle 2', exact: true })).toBeVisible();

        await categoryCard(page, 'Lifecycle 2').getByLabel('Delete').click();
        await page.getByRole('dialog').getByRole('button', { name: 'Ok' }).click();
        await expect(page.getByRole('heading', { name: 'Lifecycle 2', exact: true })).toHaveCount(0);

        const operations = await mock.waitForOperations('CATEGORY', 3);
        expect(operations.map(({ action, value }) => [action, value])).toEqual([
            ['SET', { name: 'Lifecycle' }],
            ['SET', { name: 'Lifecycle 2' }],
            ['REMOVE', null],
        ]);
        // o mesmo id de servidor identifica a categoria nas três operações
        expect(new Set(operations.map(({ key }) => key))).toEqual(new Set(['category:3']));
        expect(operations.map(({ seq }) => seq)).toEqual([...operations.map(({ seq }) => seq)].sort((a, b) => a - b));
    });
});

test.describe('Manga page > categories (CATEGORY_LINK)', () => {
    test('adding and removing a category logs the link operations', async ({ page, mock }) => {
        await openMangaPage(page);

        // o mangá 1 está na categoria "Action"; troca para "Favorites"
        await page.getByRole('button', { name: 'Edit manga categories' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('Set categories');
        await dialog.getByLabel('Favorites').check();
        await dialog.getByLabel('Action').uncheck();
        await dialog.getByRole('button', { name: 'Ok' }).click();

        const [update] = await mock.waitForRequests({ operation: 'UPDATE_MANGAS_CATEGORIES' });
        expect(update.graphql?.variables).toMatchObject({
            input: { ids: [1], patch: { addToCategories: [2], removeFromCategories: [1] } },
        });

        const operations = await mock.waitForOperations('CATEGORY_LINK', 2);
        const base = `link:${SOURCE_A_ID}|/manga/mock-manga-one|`;
        expect(operations.map(({ key, action, value }) => [key, action, value])).toEqual(
            expect.arrayContaining([
                [`${base}2`, 'SET', null],
                [`${base}1`, 'REMOVE', null],
            ]),
        );
        expect(operations.every(({ deviceId }) => deviceId === 'web')).toBe(true);
        expect((await mock.state()).mangas.find(({ id }) => id === 1)?.categoryIds).toEqual([2]);
    });
});
