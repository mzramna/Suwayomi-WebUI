/**
 * Capítulos: marcar como lido / não lido pela UI (mutação GraphQL `updateChapters` com `patch.isRead`) e o servidor
 * refletindo o estado na lista; cada mudança efetiva vira uma operação PROGRESS no log do contrato v2.
 */
import type { Page } from '@playwright/test';
import { CHAPTER_URL, openChapterMenu, openMangaPage } from './support/manga.ts';
import { expect, SOURCE_A_ID, test, variablesOf } from './support/mock.ts';

const UPDATE_OPERATION = 'UPDATE_CHAPTERS';

const progressKey = (number: number) => `progress:${SOURCE_A_ID}|/manga/mock-manga-one|${CHAPTER_URL(number)}`;

/** Abre o menu do capítulo, devolve os itens de leitura exibidos e o fecha. */
const readMenuItems = async (page: Page, number: number): Promise<string[]> => {
    const menu = await openChapterMenu(page, number);
    const items = (await menu.getByRole('menuitem').allTextContents()).filter((text) =>
        /^Mark as (un)?read$/.test(text),
    );
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    return items;
};

test.describe('Chapters: read state', () => {
    test('marks an unread chapter as read', async ({ page, mock }) => {
        await openMangaPage(page);
        expect(await readMenuItems(page, 2)).toEqual(['Mark as read']);

        const before = Date.now();
        await (await openChapterMenu(page, 2)).getByRole('menuitem', { name: 'Mark as read' }).click();

        const [update] = await mock.waitForRequests({ operation: UPDATE_OPERATION });
        expect(update.graphql?.variables).toMatchObject({
            input: { ids: [2], patch: { isRead: true } },
            getRead: true,
        });

        // a lista mostra o novo estado (resposta do servidor) e o mock também
        await expect.poll(() => readMenuItems(page, 2)).toEqual(['Mark as unread']);
        expect((await mock.state()).chapters.find(({ id }) => id === 2)?.isRead).toBe(true);

        const operations = await mock.waitForOperations('PROGRESS');
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            entity: 'PROGRESS',
            key: progressKey(2),
            action: 'SET',
            value: { read: true, lastPageRead: 0 },
            deviceId: 'web',
        });
        expect(operations[0].ts).toBeGreaterThanOrEqual(before);
        expect(operations[0].ts).toBeLessThanOrEqual(Date.now());

        // recarregar a página busca a lista de novo do servidor: o estado persiste
        await page.reload();
        await expect(page.getByText('Chapter 2', { exact: true })).toBeVisible();
        expect(await readMenuItems(page, 2)).toEqual(['Mark as unread']);
    });

    test('marks a read chapter as NOT read', async ({ page, mock }) => {
        // o capítulo 1 do mangá semeado já está lido
        await openMangaPage(page);
        expect(await readMenuItems(page, 1)).toEqual(['Mark as unread']);

        await (await openChapterMenu(page, 1)).getByRole('menuitem', { name: 'Mark as unread' }).click();

        const [update] = await mock.waitForRequests({ operation: UPDATE_OPERATION });
        expect(update.graphql?.variables).toMatchObject({ input: { ids: [1], patch: { isRead: false } } });

        await expect.poll(() => readMenuItems(page, 1)).toEqual(['Mark as read']);
        expect((await mock.state()).chapters.find(({ id }) => id === 1)?.isRead).toBe(false);

        const operations = await mock.waitForOperations('PROGRESS');
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            entity: 'PROGRESS',
            key: progressKey(1),
            action: 'SET',
            value: { read: false, lastPageRead: 0 },
            deviceId: 'web',
        });

        await page.reload();
        await expect(page.getByText('Chapter 1', { exact: true })).toBeVisible();
        expect(await readMenuItems(page, 1)).toEqual(['Mark as read']);
    });

    test('read then unread again logs both changes in order', async ({ page, mock }) => {
        await openMangaPage(page);

        await (await openChapterMenu(page, 3)).getByRole('menuitem', { name: 'Mark as read' }).click();
        await expect.poll(() => readMenuItems(page, 3)).toEqual(['Mark as unread']);
        await (await openChapterMenu(page, 3)).getByRole('menuitem', { name: 'Mark as unread' }).click();
        await expect.poll(() => readMenuItems(page, 3)).toEqual(['Mark as read']);

        const updates = await mock.waitForRequests({ operation: UPDATE_OPERATION }, 2);
        expect(updates.map((request) => variablesOf(request).input.patch.isRead)).toEqual([true, false]);

        const operations = await mock.waitForOperations('PROGRESS', 2);
        expect(operations.map(({ value }) => value)).toEqual([
            { read: true, lastPageRead: 0 },
            { read: false, lastPageRead: 0 },
        ]);
        expect(operations.map(({ key }) => key)).toEqual([progressKey(3), progressKey(3)]);
        expect(operations[0].seq).toBeLessThan(operations[1].seq);
        expect(operations[0].ts).toBeLessThanOrEqual(operations[1].ts);
    });

    test('"Mark all as read" sends every unread chapter in a single mutation', async ({ page, mock }) => {
        await openMangaPage(page);

        await page.getByRole('button', { name: 'Mark all as read' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('You are about to mark 4 chapters as read');
        await dialog.getByRole('button', { name: 'Ok' }).click();

        const [update] = await mock.waitForRequests({ operation: UPDATE_OPERATION });
        const { ids, patch } = variablesOf(update).input as { ids: number[]; patch: { isRead: boolean } };
        expect([...ids].sort()).toEqual([2, 3, 4, 5]);
        expect(patch.isRead).toBe(true);

        const operations = await mock.waitForOperations('PROGRESS', 4);
        expect(operations.map(({ key }) => key).sort()).toEqual([2, 3, 4, 5].map(progressKey).sort());
        expect((await mock.state()).chapters.filter(({ id }) => id <= 5).every(({ isRead }) => isRead)).toBe(true);
    });
});
