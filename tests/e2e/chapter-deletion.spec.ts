/**
 * Exclusão de capítulo baixado: checkbox "Also delete from connected Karasu devices" (POST /api/v1/karasu/deletions).
 */
import type { Page } from '@playwright/test';
import { chapterRow, CHAPTER_URL, openChapterMenu, openMangaPage } from './support/manga.ts';
import { expect, KARASU, SOURCE_A_ID, test } from './support/mock.ts';

const DELETE_OPERATION = 'DELETE_DOWNLOADED_CHAPTERS';
const DELETIONS = `${KARASU}/deletions`;
const CONFIRM_TEXT = 'You are about to delete one download';

const downloadedLabel = (page: Page, number: number) => chapterRow(page, number).getByText('Downloaded');

test.describe('Delete a downloaded chapter', () => {
    test('with the checkbox checked it deletes on the server and POSTs /deletions', async ({ page, mock }) => {
        await openMangaPage(page);
        await expect(downloadedLabel(page, 3)).toBeVisible();

        const before = Date.now();
        await (await openChapterMenu(page, 3)).getByRole('menuitem', { name: 'Delete' }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText(CONFIRM_TEXT);
        const checkbox = dialog.getByLabel('Also delete from connected Karasu devices');
        await expect(checkbox).not.toBeChecked();
        await checkbox.check();
        await dialog.getByRole('button', { name: 'Ok' }).click();

        // a exclusão normal acontece primeiro; só depois o servidor é avisado
        const [graphqlDelete] = await mock.waitForRequests({ operation: DELETE_OPERATION });
        expect(graphqlDelete.graphql?.variables).toMatchObject({ input: { ids: [3] } });
        const [post] = await mock.waitForRequests({ method: 'POST', path: DELETIONS });
        expect(post.body).toEqual({ chapterIds: [3], deleteFromServer: true });
        expect(post.status).toBe(200);
        expect(post.seq).toBeGreaterThan(graphqlDelete.seq);

        await expect(downloadedLabel(page, 3)).toHaveCount(0);
        await expect(downloadedLabel(page, 2)).toBeVisible();

        const state = await mock.state();
        expect(state.deletions).toEqual([
            expect.objectContaining({
                sourceId: SOURCE_A_ID,
                mangaUrl: '/manga/mock-manga-one',
                chapterUrl: CHAPTER_URL(3),
                chapterNumber: 3,
            }),
        ]);
        expect(state.chapters.find(({ id }) => id === 3)?.isDownloaded).toBe(false);

        const operations = await mock.waitForOperations('DELETION');
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            entity: 'DELETION',
            key: `deletion:${SOURCE_A_ID}|/manga/mock-manga-one|${CHAPTER_URL(3)}`,
            action: 'SET',
            value: { deleteFromServer: true },
            deviceId: 'web',
        });
        expect(operations[0].ts).toBeGreaterThanOrEqual(before);
        expect(operations[0].ts).toBeLessThanOrEqual(Date.now());
    });

    test('with the checkbox unchecked it only deletes on the server', async ({ page, mock }) => {
        await openMangaPage(page);

        await (await openChapterMenu(page, 3)).getByRole('menuitem', { name: 'Delete' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText(CONFIRM_TEXT);
        await dialog.getByRole('button', { name: 'Ok' }).click();

        await mock.waitForRequests({ operation: DELETE_OPERATION });
        await expect(downloadedLabel(page, 3)).toHaveCount(0);
        await mock.expectNoRequest({ method: 'POST', path: DELETIONS });
        expect((await mock.state()).deletions).toEqual([]);
        expect(await mock.operations('DELETION')).toEqual([]);
    });

    test('checking and unchecking again does not call /deletions', async ({ page, mock }) => {
        await openMangaPage(page);

        await (await openChapterMenu(page, 3)).getByRole('menuitem', { name: 'Delete' }).click();
        const dialog = page.getByRole('dialog');
        const checkbox = dialog.getByLabel('Also delete from connected Karasu devices');
        await checkbox.check();
        await checkbox.uncheck();
        await dialog.getByRole('button', { name: 'Ok' }).click();

        await mock.waitForRequests({ operation: DELETE_OPERATION });
        await expect(downloadedLabel(page, 3)).toHaveCount(0);
        await mock.expectNoRequest({ method: 'POST', path: DELETIONS });
    });

    test('cancelling the dialog deletes nothing', async ({ page, mock }) => {
        await openMangaPage(page);

        await (await openChapterMenu(page, 3)).getByRole('menuitem', { name: 'Delete' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Also delete from connected Karasu devices').check();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();

        await expect(downloadedLabel(page, 3)).toBeVisible();
        await mock.expectNoRequest({ operation: DELETE_OPERATION });
        await mock.expectNoRequest({ method: 'POST', path: DELETIONS });
    });

    test('deleting several selected chapters sends all their ids in one POST', async ({ page, mock }) => {
        await openMangaPage(page);

        await (await openChapterMenu(page, 3)).getByRole('menuitem', { name: 'Select' }).click();
        // no modo de seleção as linhas trocam o botão "more" por um checkbox
        await page.getByText('Chapter 2', { exact: true }).click();
        await page.getByRole('button', { name: '2 chapters' }).click();
        await page.getByRole('menuitem', { name: 'Delete' }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('You are about to delete 2 downloads');
        await dialog.getByLabel('Also delete from connected Karasu devices').check();
        await dialog.getByRole('button', { name: 'Ok' }).click();

        const [post] = await mock.waitForRequests({ method: 'POST', path: DELETIONS });
        const body = post.body as { chapterIds: number[]; deleteFromServer: boolean };
        expect([...body.chapterIds].sort()).toEqual([2, 3]);
        expect(body.deleteFromServer).toBe(true);

        await expect(downloadedLabel(page, 2)).toHaveCount(0);
        await expect(downloadedLabel(page, 3)).toHaveCount(0);
        const operations = await mock.waitForOperations('DELETION', 2);
        expect(operations.map(({ key }) => key).sort()).toEqual([
            `deletion:${SOURCE_A_ID}|/manga/mock-manga-one|${CHAPTER_URL(2)}`,
            `deletion:${SOURCE_A_ID}|/manga/mock-manga-one|${CHAPTER_URL(3)}`,
        ]);
    });

    test('a failing POST /deletions only notifies: the chapter stays deleted on the server', async ({ page, mock }) => {
        await mock.seed({
            faults: [{ method: 'POST', path: DELETIONS, status: 500, error: 'tombstone table unavailable' }],
        });
        await openMangaPage(page);

        await (await openChapterMenu(page, 3)).getByRole('menuitem', { name: 'Delete' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Also delete from connected Karasu devices').check();
        await dialog.getByRole('button', { name: 'Ok' }).click();

        await expect(page.getByText('Could not delete the chapters from the Karasu devices')).toBeVisible();
        await expect(page.getByText('tombstone table unavailable')).toBeVisible();

        const [post] = await mock.waitForRequests({ method: 'POST', path: DELETIONS });
        expect(post.status).toBe(500);
        // a exclusão do arquivo no servidor (GraphQL) já tinha sido concluída
        await expect(downloadedLabel(page, 3)).toHaveCount(0);
        expect((await mock.state()).chapters.find(({ id }) => id === 3)?.isDownloaded).toBe(false);
        expect(await mock.operations('DELETION')).toEqual([]);
    });

    test('on a server without Karasu the dialog has no checkbox and /deletions is never called', async ({
        page,
        mock,
    }) => {
        await mock.seed({ health: null });
        await openMangaPage(page);

        await (await openChapterMenu(page, 3)).getByRole('menuitem', { name: 'Delete' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText(CONFIRM_TEXT);
        // o health já respondeu 404 quando o diálogo abriu; o checkbox não pode aparecer
        await mock.waitForRequests({ method: 'GET', path: `${KARASU}/health` });
        await expect(dialog.getByLabel('Also delete from connected Karasu devices')).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Ok' }).click();

        await mock.waitForRequests({ operation: DELETE_OPERATION });
        await expect(downloadedLabel(page, 3)).toHaveCount(0);
        await mock.expectNoRequest({ method: 'POST', path: DELETIONS });
    });
});
