/**
 * Helpers da página do mangá (lista de capítulos).
 */
import { expect, type Locator, type Page } from '@playwright/test';

export const CHAPTER_URL = (number: number, manga: 'one' | 'two' = 'one') =>
    `/manga/mock-manga-${manga}/chapter-${number}`;

/** Card de um capítulo: o menor ancestral do título que contém o botão "more". */
export const chapterRow = (page: Page, number: number): Locator =>
    page.getByText(`Chapter ${number}`, { exact: true }).locator('xpath=ancestor::*[.//button[@aria-label="more"]][1]');

export const openMangaPage = async (page: Page, mangaId = 1): Promise<void> => {
    await page.goto(`/manga/${mangaId}`);
    await expect(page.getByText('Chapter 1', { exact: true })).toBeVisible();
};

export const openChapterMenu = async (page: Page, number: number): Promise<Locator> => {
    await chapterRow(page, number).getByRole('button', { name: 'more' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    return menu;
};
