/**
 * Contrato do próprio servidor mock: rotas Karasu que a UI não chama (upload de backup, histórico, lookups) e o log de
 * operações do contrato v2. Garante que o mock continua fiel ao contrato, já que os demais testes dependem dele.
 */
import { expect, KARASU, SOURCE_A_ID, test } from './support/mock.ts';

test.describe('Mock server: Karasu REST contract', () => {
    test('health, backups (upload/list/download/delete) and BACKUP operations', async ({ request, mock }) => {
        const health = await request.get(`${KARASU}/health`);
        expect(health.status()).toBe(200);
        expect(await health.json()).toMatchObject({
            status: 'ok',
            apiVersion: 1,
            database: { type: 'H2' },
            storage: { type: 'local' },
        });

        const content = Buffer.from('backup-bytes-\u0000\u0001ÿ'.repeat(10));
        const upload = await request.post(`${KARASU}/backups/upload?device=${encodeURIComponent('Pixel 9')}`, {
            multipart: { file: { name: 'new.tachibk', mimeType: 'application/octet-stream', buffer: content } },
            headers: { 'X-Karasu-Device': 'device-uuid-1' },
        });
        expect(upload.status()).toBe(201);
        const info = await upload.json();
        expect(info).toMatchObject({
            id: 'new.tachibk',
            name: 'new.tachibk',
            sizeBytes: content.length,
            device: 'Pixel 9',
        });
        expect(typeof info.createdAt).toBe('number');

        // mais novo primeiro
        const list = await (await request.get(`${KARASU}/backups`)).json();
        expect(list.map(({ id }: { id: string }) => id)[0]).toBe('new.tachibk');
        expect(list).toHaveLength(3);

        const download = await request.get(`${KARASU}/backups/new.tachibk/download`);
        expect(download.status()).toBe(200);
        expect((await download.body()).equals(content)).toBe(true);

        expect((await request.delete(`${KARASU}/backups/new.tachibk`)).status()).toBe(204);
        expect((await request.delete(`${KARASU}/backups/new.tachibk`)).status()).toBe(404);
        expect((await request.get(`${KARASU}/backups/new.tachibk/download`)).status()).toBe(404);

        // o header X-Karasu-Device identifica quem fez a mudança; sem ele vale "web"
        const operations = await mock.operations('BACKUP');
        expect(operations.map(({ action, key, deviceId }) => [action, key, deviceId])).toEqual([
            ['SET', 'backup:new.tachibk', 'device-uuid-1'],
            ['REMOVE', 'backup:new.tachibk', 'web'],
        ]);
        expect(operations[0].value).toEqual({ device: 'Pixel 9', sizeBytes: content.length });
    });

    test('merged groups: GET/PUT per manga, PUT by primary source and 404 for unknown manga', async ({
        request,
        mock,
    }) => {
        const empty = await (await request.get(`${KARASU}/manga/1/merged`)).json();
        expect(empty).toEqual({
            mangaId: 1,
            primary: { sourceId: SOURCE_A_ID, url: '/manga/mock-manga-one' },
            sources: [],
        });
        expect(await (await request.get(`${KARASU}/merged`)).json()).toEqual([]);

        const sources = [
            { sourceId: '42', url: '/x', priority: 1, updatesEnabled: false },
            { sourceId: '41', url: '/y', priority: 0, updatesEnabled: true },
        ];
        const put = await request.put(`${KARASU}/manga/1/merged`, { data: { sources } });
        expect(put.status()).toBe(200);
        expect((await put.json()).sources.map(({ sourceId }: { sourceId: string }) => sourceId)).toEqual(['41', '42']);
        expect(await (await request.get(`${KARASU}/merged`)).json()).toHaveLength(1);

        const byPrimary = await request.put(`${KARASU}/merged`, {
            data: { primary: { sourceId: SOURCE_A_ID, url: '/manga/mock-manga-one' }, sources: [] },
        });
        expect((await byPrimary.json()).sources).toEqual([]);
        const unknown = await request.put(`${KARASU}/merged`, {
            data: { primary: { sourceId: '1', url: '/nope' }, sources: [] },
        });
        expect(unknown.status()).toBe(404);
        expect(await unknown.json()).toHaveProperty('error');
        expect((await request.put(`${KARASU}/manga/999/merged`, { data: { sources: [] } })).status()).toBe(404);

        // lista inteira após cada mudança efetiva; PUT idêntico (no-op) não registra de novo
        await request.put(`${KARASU}/merged`, {
            data: { primary: { sourceId: SOURCE_A_ID, url: '/manga/mock-manga-one' }, sources: [] },
        });
        expect((await mock.operations('MERGED')).map(({ value }) => value)).toEqual([
            { sources: [sources[1], sources[0]] },
            { sources: [] },
        ]);
    });

    test('policy and deletions (POST/GET with afterId) and POLICY/DELETION operations', async ({ request, mock }) => {
        expect(await (await request.get(`${KARASU}/policy`)).json()).toEqual({ downloadPolicy: 'SERVER_ONLY' });
        expect((await request.put(`${KARASU}/policy`, { data: { downloadPolicy: 'NOPE' } })).status()).toBe(400);
        await request.put(`${KARASU}/policy`, { data: { downloadPolicy: 'SERVER_AND_CLIENTS' } });
        // no-op: o mesmo valor de novo não registra operação
        await request.put(`${KARASU}/policy`, { data: { downloadPolicy: 'SERVER_AND_CLIENTS' } });
        expect(await mock.operations('POLICY')).toHaveLength(1);

        expect((await request.post(`${KARASU}/deletions`, { data: { chapterIds: 'x' } })).status()).toBe(400);
        const deletion = await request.post(`${KARASU}/deletions`, {
            data: { chapterIds: [1, 2, 9999], deleteFromServer: true },
        });
        // ids inexistentes são ignorados
        expect(await deletion.json()).toEqual({ queued: 2 });

        const all = await (await request.get(`${KARASU}/deletions?afterId=0`)).json();
        expect(all).toEqual([
            expect.objectContaining({
                id: 1,
                sourceId: SOURCE_A_ID,
                mangaUrl: '/manga/mock-manga-one',
                chapterNumber: 1,
            }),
            expect.objectContaining({ id: 2, chapterUrl: '/manga/mock-manga-one/chapter-2', chapterNumber: 2 }),
        ]);
        expect(await (await request.get(`${KARASU}/deletions?afterId=1`)).json()).toHaveLength(1);
        expect((await mock.operations('DELETION')).map(({ value }) => value)).toEqual([
            { deleteFromServer: true },
            { deleteFromServer: true },
        ]);
    });

    test('history PUT, chapter/manga lookups and the CBZ archive', async ({ request, mock }) => {
        const put = await request.put(`${KARASU}/history`, {
            data: {
                entries: [
                    { chapterId: 2, lastReadAt: 1_700_000_000 },
                    { chapterId: 9999, lastReadAt: 5 },
                ],
            },
        });
        expect(await put.json()).toEqual({ updated: 1 });
        await request.put(`${KARASU}/history`, { data: { entries: [{ chapterId: 2, lastReadAt: 0 }] } });
        const history = await mock.operations('HISTORY');
        expect(history.map(({ action, value }) => [action, value])).toEqual([
            ['SET', { lastReadAt: 1_700_000_000 }],
            ['REMOVE', null],
        ]);

        const lookup = await request.get(
            `${KARASU}/chapter/lookup?sourceId=${SOURCE_A_ID}&mangaUrl=/manga/mock-manga-one&chapterUrl=/manga/mock-manga-one/chapter-2`,
        );
        expect(await lookup.json()).toEqual({ chapterId: 2, mangaId: 1, downloaded: true, sizeBytes: 2048 });
        expect(
            (await request.get(`${KARASU}/chapter/lookup?sourceId=${SOURCE_A_ID}&mangaUrl=/x&chapterUrl=/y`)).status(),
        ).toBe(404);

        const mangaLookup = await (
            await request.get(`${KARASU}/manga/lookup?sourceId=${SOURCE_A_ID}&url=/manga/mock-manga-one`)
        ).json();
        expect(mangaLookup.mangaId).toBe(1);
        expect(mangaLookup.chapters).toHaveLength(5);
        expect(mangaLookup.chapters.every(({ sizeBytes }: { sizeBytes: number }) => sizeBytes === -1)).toBe(true);

        // CBZ só de capítulo baixado; capítulo não baixado => 404 (nunca dispara download)
        const archive = await request.get(`${KARASU}/chapter/2/archive`);
        expect(archive.status()).toBe(200);
        expect(archive.headers()['content-length']).toBe('2048');
        expect((await request.head(`${KARASU}/chapter/2/archive`)).status()).toBe(200);
        expect((await request.get(`${KARASU}/chapter/5/archive`)).status()).toBe(404);
    });

    test('operations log: idempotent POST, afterSeq/entity/limit filters and serverTime', async ({ request }) => {
        const operation = (id: string, entity = 'PROGRESS') => ({
            id,
            deviceId: 'device-1',
            ts: 1_700_000_000_000,
            entity,
            key: `progress:s|m|${id}`,
            action: 'SET',
            value: { read: true, lastPageRead: 0 },
        });

        const first = await request.post(`${KARASU}/operations`, {
            data: { operations: [operation('a'), operation('b'), operation('c', 'HISTORY')] },
        });
        expect(await first.json()).toEqual({ accepted: 3, duplicates: 0 });
        const again = await request.post(`${KARASU}/operations`, {
            data: { operations: [operation('b'), operation('d')] },
        });
        expect(await again.json()).toEqual({ accepted: 1, duplicates: 1 });

        const before = Date.now();
        const all = await (await request.get(`${KARASU}/operations`)).json();
        expect(all.operations.map(({ id, seq }: { id: string; seq: number }) => [id, seq])).toEqual([
            ['a', 1],
            ['b', 2],
            ['c', 3],
            ['d', 4],
        ]);
        expect(all.lastSeq).toBe(4);
        expect(all.serverTime).toBeGreaterThanOrEqual(before - 1000);
        expect(all.operations[0].deviceId).toBe('device-1');

        const after = await (await request.get(`${KARASU}/operations?afterSeq=2&limit=1`)).json();
        expect(after.operations.map(({ id }: { id: string }) => id)).toEqual(['c']);
        const history = await (await request.get(`${KARASU}/operations?entity=HISTORY`)).json();
        expect(history.operations.map(({ id }: { id: string }) => id)).toEqual(['c']);
        // a UI não precisa chamar este endpoint: o POST só registra, nada é reaplicado
        const empty = await (await request.get(`${KARASU}/operations?afterSeq=4`)).json();
        expect(empty).toMatchObject({ operations: [], lastSeq: 4 });
    });

    test('a server without the fork answers 404 on every Karasu route', async ({ request, mock }) => {
        await mock.seed({ health: null });
        const paths = ['/health', '/backups', '/policy', '/merged', '/operations'];
        const statuses = await Promise.all(paths.map(async (path) => (await request.get(`${KARASU}${path}`)).status()));
        expect(Object.fromEntries(paths.map((path, index) => [path, statuses[index]]))).toEqual(
            Object.fromEntries(paths.map((path) => [path, 404])),
        );
    });
});
