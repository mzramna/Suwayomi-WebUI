/**
 * Página do mangá > Fontes mescladas (GET/PUT /api/v1/karasu/manga/{id}/merged).
 */
import type { Locator, Page } from '@playwright/test';
import {
    expect,
    KARASU,
    SOURCE_A_ID,
    SOURCE_B_ID,
    SOURCE_C_ID,
    SOURCE_D_ID,
    sourceA,
    sourceB,
    sourceC,
    sourceD,
    test,
} from './support/mock.ts';
import type { MockManga } from './mock-server/state.ts';

const MANGA_ID = 1;
const MERGED_PATH = `${KARASU}/manga/${MANGA_ID}/merged`;
const PRIMARY_KEY = `merged:${SOURCE_A_ID}|/manga/mock-manga-one`;

const B_URL = '/manga/b-entry';
const C_URL = '/manga/c-entry';

const linked = (sourceId: string, url: string, priority: number, updatesEnabled = true) => ({
    sourceId,
    url,
    priority,
    updatesEnabled,
});

/** Mangá 1 (fonte A) com as fontes extras B (prioridade 0) e C (prioridade 1). */
const seedLinkedSources = (
    mock: { seed: (body: any) => Promise<void> },
    sources = [linked(SOURCE_B_ID, B_URL, 0), linked(SOURCE_C_ID, C_URL, 1)],
) =>
    mock.seed({
        sources: [sourceA, sourceB, sourceC, sourceD],
        merged: { [MANGA_ID]: sources },
    });

const openMergedSources = async (page: Page) => {
    await page.goto(`/manga/${MANGA_ID}`);
    await page.getByRole('button', { name: 'Merged sources' }).click();
    await expect(page.getByText('Chapters from all linked sources are combined.')).toBeVisible();
};

/** Linha de uma fonte vinculada: o menor `div` que contém a url e o switch "Backup". */
const rowOf = (page: Page, url: string): Locator =>
    page.getByText(url, { exact: true }).locator('xpath=ancestor::div[.//input[@type="checkbox"]][1]');

const rowUrls = (page: Page) =>
    page
        .locator('.MuiAccordionDetails-root')
        .getByText(/^\/manga\//)
        .allTextContents();

/** Espera o elemento parar de se mover (animação do accordion, scroll) antes de arrastar. */
const waitUntilStable = async (locator: Locator) => {
    let previous = '';
    await expect
        .poll(async () => {
            const current = JSON.stringify(await locator.boundingBox());
            const isStable = current === previous;
            previous = current;
            return isStable;
        })
        .toBe(true);
};

const lastPut = async (mock: { find: (filter: any) => Promise<any[]> }) => {
    const puts = await mock.find({ method: 'PUT', path: MERGED_PATH });
    return puts.at(-1);
};

test.describe('Manga page > Merged sources', () => {
    test('lists the linked sources in priority order', async ({ page, mock }) => {
        await seedLinkedSources(mock, [linked(SOURCE_C_ID, C_URL, 1), linked(SOURCE_B_ID, B_URL, 0, false)]);
        await openMergedSources(page);

        // ordenadas por prioridade (0 primeiro), independentemente da ordem devolvida pelo servidor
        await expect.poll(() => rowUrls(page)).toEqual([B_URL, C_URL]);
        await expect(rowOf(page, B_URL)).toContainText('Mock Source B (EN)');
        await expect(rowOf(page, C_URL)).toContainText('Mock Source C (EN)');

        // só a fonte reserva (updatesEnabled:false) mostra o selo "Backup" e o switch ligado
        await expect(rowOf(page, B_URL).locator('.MuiChip-root')).toHaveText('Backup');
        await expect(rowOf(page, B_URL).locator('input[type="checkbox"]')).toBeChecked();
        await expect(rowOf(page, C_URL).locator('.MuiChip-root')).toHaveCount(0);
        await expect(rowOf(page, C_URL).locator('input[type="checkbox"]')).not.toBeChecked();

        expect(await mock.find({ method: 'GET', path: MERGED_PATH })).toHaveLength(1);
        await mock.expectNoRequest({ method: 'PUT', path: MERGED_PATH });
    });

    test('shows an empty state when the entry has no extra sources', async ({ page, mock }) => {
        await mock.seed({ sources: [sourceA, sourceB] });
        await openMergedSources(page);

        await expect(page.getByText('No additional sources linked to this entry')).toBeVisible();
        expect(await rowUrls(page)).toEqual([]);
    });

    test('toggles "Backup" and saves the full list with PUT', async ({ page, mock }) => {
        await seedLinkedSources(mock);
        await openMergedSources(page);

        const before = Date.now();
        // o switch é controlado pelos dados do servidor, então ele só muda depois do PUT; por isso click + expect
        await rowOf(page, B_URL).locator('input[type="checkbox"]').click();

        await expect(rowOf(page, B_URL).locator('.MuiChip-root')).toHaveText('Backup');
        await expect(rowOf(page, B_URL).locator('input[type="checkbox"]')).toBeChecked();
        const [put] = await mock.waitForRequests({ method: 'PUT', path: MERGED_PATH });
        expect(put.body).toEqual({
            sources: [linked(SOURCE_B_ID, B_URL, 0, false), linked(SOURCE_C_ID, C_URL, 1, true)],
        });
        expect(put.status).toBe(200);

        const operations = await mock.waitForOperations('MERGED');
        expect(operations).toHaveLength(1);
        expect(operations[0]).toMatchObject({
            entity: 'MERGED',
            key: PRIMARY_KEY,
            action: 'SET',
            deviceId: 'web',
            value: { sources: [linked(SOURCE_B_ID, B_URL, 0, false), linked(SOURCE_C_ID, C_URL, 1, true)] },
        });
        expect(operations[0].ts).toBeGreaterThanOrEqual(before);
        expect(operations[0].ts).toBeLessThanOrEqual(Date.now());

        // desligar de novo grava a lista com a fonte voltando a atualizar
        await rowOf(page, B_URL).locator('input[type="checkbox"]').click();
        await expect(rowOf(page, B_URL).locator('.MuiChip-root')).toHaveCount(0);
        await expect(rowOf(page, B_URL).locator('input[type="checkbox"]')).not.toBeChecked();
        await mock.waitForRequests({ method: 'PUT', path: MERGED_PATH }, 2);
        expect((await lastPut(mock)).body).toEqual({
            sources: [linked(SOURCE_B_ID, B_URL, 0, true), linked(SOURCE_C_ID, C_URL, 1, true)],
        });
    });

    test('reorders by drag and drop and recalculates the priorities', async ({ page, mock }) => {
        await seedLinkedSources(mock);
        await openMergedSources(page);
        await expect.poll(() => rowUrls(page)).toEqual([B_URL, C_URL]);

        // arrasta a linha de C (embaixo) para cima da linha de B
        const handle = rowOf(page, C_URL).locator('svg').first();
        const target = rowOf(page, B_URL);
        // o mouse só alcança elementos dentro da janela
        await handle.scrollIntoViewIfNeeded();
        await waitUntilStable(handle);
        await waitUntilStable(target);
        const handleBox = (await handle.boundingBox())!;
        const targetBox = (await target.boundingBox())!;
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        // o sensor só ativa depois de 8px de movimento
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y - 12, { steps: 4 });
        await page.mouse.move(handleBox.x + handleBox.width / 2, targetBox.y + 4, { steps: 10 });
        await page.mouse.up();

        const [put] = await mock.waitForRequests({ method: 'PUT', path: MERGED_PATH });
        expect(put.body).toEqual({ sources: [linked(SOURCE_C_ID, C_URL, 0), linked(SOURCE_B_ID, B_URL, 1)] });
        await expect.poll(() => rowUrls(page)).toEqual([C_URL, B_URL]);

        const operations = await mock.waitForOperations('MERGED');
        expect(operations[0].value).toEqual({
            sources: [linked(SOURCE_C_ID, C_URL, 0), linked(SOURCE_B_ID, B_URL, 1)],
        });
    });

    test('removes a linked source', async ({ page, mock }) => {
        await seedLinkedSources(mock);
        await openMergedSources(page);

        await rowOf(page, B_URL).getByRole('button').last().click();

        await expect(page.getByText(B_URL, { exact: true })).toHaveCount(0);
        const [put] = await mock.waitForRequests({ method: 'PUT', path: MERGED_PATH });
        // a lista completa é reenviada e a prioridade da fonte restante volta a 0
        expect(put.body).toEqual({ sources: [linked(SOURCE_C_ID, C_URL, 0)] });
        expect((await mock.state()).merged[MANGA_ID]).toEqual([linked(SOURCE_C_ID, C_URL, 0)]);

        const operations = await mock.waitForOperations('MERGED');
        expect(operations[0]).toMatchObject({
            key: PRIMARY_KEY,
            action: 'SET',
            value: { sources: [linked(SOURCE_C_ID, C_URL, 0)] },
        });
    });

    test('adds a source by typing the entry URL manually', async ({ page, mock }) => {
        await seedLinkedSources(mock);
        await openMergedSources(page);

        await page.getByRole('button', { name: 'Add source' }).click();
        const dialog = page.getByRole('dialog');
        const addButton = dialog.getByRole('button', { name: 'Add', exact: true });
        await expect(addButton).toBeDisabled();

        await dialog.getByRole('combobox', { name: 'Source' }).click();
        await page.getByRole('option', { name: 'Mock Source D (EN)' }).click();
        await expect(addButton).toBeDisabled();
        await dialog.getByLabel('Entry URL in the source').fill('  /manga/d-manual  ');
        await expect(addButton).toBeEnabled();
        await addButton.click();

        await expect(page.getByText('/manga/d-manual', { exact: true })).toBeVisible();
        const [put] = await mock.waitForRequests({ method: 'PUT', path: MERGED_PATH });
        // prioridades 0..n-1 na ordem exibida, nova fonte no fim e com atualizações ligadas; a url é aparada
        expect(put.body).toEqual({
            sources: [
                linked(SOURCE_B_ID, B_URL, 0),
                linked(SOURCE_C_ID, C_URL, 1),
                linked(SOURCE_D_ID, '/manga/d-manual', 2),
            ],
        });
        expect(put.status).toBe(200);
        await expect.poll(() => rowUrls(page)).toEqual([B_URL, C_URL, '/manga/d-manual']);
    });

    test('adds a source picked from the search results', async ({ page, mock }) => {
        await seedLinkedSources(mock);
        const alt: MockManga = {
            id: 3,
            sourceId: SOURCE_D_ID,
            url: '/manga/d-entry',
            title: 'Mock Manga One (alt)',
            inLibrary: false,
            author: '',
            artist: '',
            description: '',
            genre: [],
            status: 'ONGOING',
            thumbnailUrl: '/api/v1/manga/3/thumbnail',
            categoryIds: [],
        };
        await mock.addMangas(alt);
        await openMergedSources(page);

        await page.getByRole('button', { name: 'Add source' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('combobox', { name: 'Source' }).click();
        await page.getByRole('option', { name: 'Mock Source D (EN)' }).click();

        // o campo de busca já vem com o título do mangá
        await expect(dialog.getByLabel('Search title')).toHaveValue('Mock Manga One');
        await dialog.getByRole('button', { name: 'Search' }).click();
        await dialog.getByText('Mock Manga One (alt)').click();
        await expect(dialog.getByLabel('Entry URL in the source')).toHaveValue('/manga/d-entry');
        await dialog.getByRole('button', { name: 'Add', exact: true }).click();

        const [put] = await mock.waitForRequests({ method: 'PUT', path: MERGED_PATH });
        expect((put.body as { sources: unknown[] }).sources).toEqual([
            linked(SOURCE_B_ID, B_URL, 0),
            linked(SOURCE_C_ID, C_URL, 1),
            linked(SOURCE_D_ID, '/manga/d-entry', 2),
        ]);

        const [search] = await mock.graphqlVariables('KARASU_SEARCH_SOURCE_MANGAS');
        expect(search.input).toMatchObject({ source: SOURCE_D_ID, query: 'Mock Manga One', page: 1, type: 'SEARCH' });
    });

    test('does not allow linking the same source and URL twice', async ({ page, mock }) => {
        await seedLinkedSources(mock);
        await openMergedSources(page);

        await page.getByRole('button', { name: 'Add source' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('combobox', { name: 'Source' }).click();
        await page.getByRole('option', { name: 'Mock Source B (EN)' }).click();
        await dialog.getByLabel('Entry URL in the source').fill(B_URL);

        await expect(dialog.getByText('This source is already linked')).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();

        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await mock.expectNoRequest({ method: 'PUT', path: MERGED_PATH });
    });

    test('keeps the list and notifies when saving fails', async ({ page, mock }) => {
        await seedLinkedSources(mock);
        await mock.seed({ faults: [{ method: 'PUT', path: MERGED_PATH, status: 500, error: 'database is locked' }] });
        await openMergedSources(page);

        await rowOf(page, B_URL).locator('input[type="checkbox"]').click();

        await expect(page.getByText('Failed to save changes')).toBeVisible();
        const [put] = await mock.waitForRequests({ method: 'PUT', path: MERGED_PATH });
        expect(put.status).toBe(500);
        // nada mudou na tela nem no servidor
        await expect(rowOf(page, B_URL).locator('input[type="checkbox"]')).not.toBeChecked();
        await expect(rowOf(page, B_URL).locator('.MuiChip-root')).toHaveCount(0);
        expect((await mock.state()).merged[MANGA_ID]).toEqual([
            linked(SOURCE_B_ID, B_URL, 0),
            linked(SOURCE_C_ID, C_URL, 1),
        ]);
        expect(await mock.operations('MERGED')).toEqual([]);
    });
});
