/**
 * Rotas REST `/api/v1/karasu/*` (contrato v1 + log de operações do contrato v2) em memória.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    chapterKey,
    deterministicBytes,
    findChapter,
    findManga,
    mangaKey,
    recordOperation,
    state,
    type BackupRecord,
    type MergedSource,
    type Operation,
    type OperationEntity,
} from './state.ts';

export const KARASU_PREFIX = '/api/v1/karasu';

const MAX_OPERATIONS_LIMIT = 5000;
const DEFAULT_OPERATIONS_LIMIT = 1000;

export const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    res.end(payload);
};

const sendError = (res: ServerResponse, status: number, error: string): void => sendJson(res, status, { error });

class HttpError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

const parseJsonBody = (body: Buffer): any => {
    try {
        return JSON.parse(body.toString('utf-8'));
    } catch {
        throw new HttpError(400, 'Invalid JSON body');
    }
};

// ---- multipart ----

/** Extrai o primeiro campo `file` de um corpo multipart/form-data. */
export const parseMultipartFile = (
    contentType: string,
    body: Buffer,
): { filename: string; data: Buffer } | undefined => {
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    const boundaryValue = boundary?.[1] ?? boundary?.[2];
    if (!boundaryValue) {
        return undefined;
    }

    const delimiter = Buffer.from(`--${boundaryValue}`);
    let position = body.indexOf(delimiter);

    while (position !== -1) {
        const partStart = position + delimiter.length;
        const next = body.indexOf(delimiter, partStart);
        if (next === -1) {
            break;
        }

        // a parte vai de depois do delimitador (+CRLF) até antes do CRLF que precede o próximo delimitador
        const part = body.subarray(partStart + 2, next - 2);
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
            const headers = part.subarray(0, headerEnd).toString('utf-8');
            const nameMatch = /name="([^"]*)"/i.exec(headers);
            const filenameMatch = /filename="([^"]*)"/i.exec(headers);
            if (nameMatch?.[1] === 'file') {
                return { filename: filenameMatch?.[1] ?? 'upload', data: part.subarray(headerEnd + 4) };
            }
        }

        position = next;
    }

    return undefined;
};

// ---- serialização ----

const toBackupInfo = ({ id, name, sizeBytes, createdAt, device }: BackupRecord) => ({
    id,
    name,
    sizeBytes,
    createdAt,
    device,
});

export const toMergedGroup = (mangaId: number) => {
    const manga = findManga(mangaId);
    if (!manga) {
        throw new HttpError(404, `Manga ${mangaId} not found`);
    }

    return {
        mangaId,
        primary: { sourceId: manga.sourceId, url: manga.url },
        sources: [...(state.merged[mangaId] ?? [])].sort((a, b) => a.priority - b.priority),
    };
};

const normalizeMergedSources = (value: unknown): MergedSource[] => {
    if (!Array.isArray(value)) {
        throw new HttpError(400, '"sources" must be an array');
    }

    return value.map((source) => {
        if (
            typeof source?.sourceId !== 'string' ||
            typeof source?.url !== 'string' ||
            typeof source?.priority !== 'number' ||
            typeof source?.updatesEnabled !== 'boolean'
        ) {
            throw new HttpError(400, 'Invalid merged source (sourceId and url must be strings)');
        }

        return {
            sourceId: source.sourceId,
            url: source.url,
            priority: source.priority,
            updatesEnabled: source.updatesEnabled,
        };
    });
};

const setMerged = (mangaId: number, sources: MergedSource[]) => {
    const manga = findManga(mangaId);
    if (!manga) {
        throw new HttpError(404, `Manga ${mangaId} not found`);
    }

    const previous = JSON.stringify(state.merged[mangaId] ?? []);
    const next = [...sources].sort((a, b) => a.priority - b.priority);

    if (previous !== JSON.stringify(next)) {
        state.merged[mangaId] = next;
        recordOperation('MERGED', `merged:${mangaKey(manga)}`, 'SET', { sources: next });
    }

    return toMergedGroup(mangaId);
};

// ---- handler ----

type RouteContext = {
    method: string;
    path: string;
    query: URLSearchParams;
    body: Buffer;
    contentType: string;
    deviceId: string | undefined;
    res: ServerResponse;
};

const handleRoute = ({ method, path, query, body, contentType, res }: RouteContext): void => {
    let match: RegExpExecArray | null;

    if (path === '/health' && method === 'GET') {
        return sendJson(res, 200, state.health);
    }

    // ---- CBZ de capítulo baixado ----
    if (path === '/chapter/lookup' && method === 'GET') {
        const manga = state.mangas.find(
            (item) => item.sourceId === query.get('sourceId') && item.url === query.get('mangaUrl'),
        );
        const chapter = state.chapters.find(
            (item) => item.mangaId === manga?.id && item.url === query.get('chapterUrl'),
        );
        if (!manga || !chapter) {
            return sendError(res, 404, 'Chapter not found');
        }
        return sendJson(res, 200, {
            chapterId: chapter.id,
            mangaId: manga.id,
            downloaded: chapter.isDownloaded,
            sizeBytes: chapter.isDownloaded ? chapter.sizeBytes : -1,
        });
    }

    if (path === '/manga/lookup' && method === 'GET') {
        const manga = state.mangas.find(
            (item) => item.sourceId === query.get('sourceId') && item.url === query.get('url'),
        );
        if (!manga) {
            return sendError(res, 404, 'Manga not found');
        }
        return sendJson(res, 200, {
            mangaId: manga.id,
            title: manga.title,
            // contrato: sizeBytes é sempre -1 neste endpoint
            chapters: state.chapters
                .filter((chapter) => chapter.mangaId === manga.id)
                .map((chapter) => ({
                    chapterId: chapter.id,
                    url: chapter.url,
                    chapterNumber: chapter.chapterNumber,
                    downloaded: chapter.isDownloaded,
                    sizeBytes: -1,
                })),
        });
    }

    if ((match = /^\/chapter\/(\d+)\/archive$/.exec(path)) && (method === 'GET' || method === 'HEAD')) {
        const chapter = findChapter(Number(match[1]));
        if (!chapter?.isDownloaded) {
            return sendError(res, 404, 'Chapter is not downloaded');
        }
        const data = deterministicBytes(`chapter-${chapter.id}`, chapter.sizeBytes);
        res.writeHead(200, {
            'Content-Type': 'application/vnd.comicbook+zip',
            'Content-Length': data.length,
            'Content-Disposition': `attachment; filename="${chapter.name}.cbz"`,
        });
        return void res.end(method === 'HEAD' ? undefined : data);
    }

    // ---- backups ----
    if (path === '/backups/upload' && method === 'POST') {
        const file = parseMultipartFile(contentType, body);
        if (!file) {
            return sendError(res, 400, 'Missing multipart field "file"');
        }
        const id = file.filename.replaceAll(/[^\w.\- ]/g, '_');
        const backup: BackupRecord = {
            id,
            name: id,
            sizeBytes: file.data.length,
            createdAt: Date.now(),
            device: query.get('device'),
            data: file.data,
        };
        state.backups = [backup, ...state.backups.filter((item) => item.id !== id)];
        recordOperation('BACKUP', `backup:${id}`, 'SET', { device: backup.device, sizeBytes: backup.sizeBytes });
        return sendJson(res, 201, toBackupInfo(backup));
    }

    if (path === '/backups' && method === 'GET') {
        return sendJson(res, 200, [...state.backups].sort((a, b) => b.createdAt - a.createdAt).map(toBackupInfo));
    }

    if ((match = /^\/backups\/([^/]+)\/download$/.exec(path)) && method === 'GET') {
        const backup = state.backups.find((item) => item.id === decodeURIComponent(match![1]));
        if (!backup) {
            return sendError(res, 404, 'Backup not found');
        }
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': backup.data.length,
            'Content-Disposition': `attachment; filename="${backup.name}"`,
        });
        return void res.end(backup.data);
    }

    if ((match = /^\/backups\/([^/]+)$/.exec(path)) && method === 'DELETE') {
        const id = decodeURIComponent(match[1]);
        const backup = state.backups.find((item) => item.id === id);
        if (!backup) {
            return sendError(res, 404, 'Backup not found');
        }
        state.backups = state.backups.filter((item) => item.id !== id);
        recordOperation('BACKUP', `backup:${id}`, 'REMOVE', null);
        res.writeHead(204);
        return void res.end();
    }

    // ---- fontes mescladas ----
    if (path === '/merged' && method === 'GET') {
        return sendJson(
            res,
            200,
            Object.entries(state.merged)
                .filter(([, sources]) => sources.length)
                .map(([mangaId]) => toMergedGroup(Number(mangaId))),
        );
    }

    if (path === '/merged' && method === 'PUT') {
        const payload = parseJsonBody(body);
        const manga = state.mangas.find(
            (item) => item.sourceId === payload?.primary?.sourceId && item.url === payload?.primary?.url,
        );
        if (!manga) {
            return sendError(res, 404, 'Primary manga not found');
        }
        return sendJson(res, 200, setMerged(manga.id, normalizeMergedSources(payload.sources)));
    }

    if ((match = /^\/manga\/(\d+)\/merged$/.exec(path))) {
        const mangaId = Number(match[1]);
        if (method === 'GET') {
            return sendJson(res, 200, toMergedGroup(mangaId));
        }
        if (method === 'PUT') {
            return sendJson(res, 200, setMerged(mangaId, normalizeMergedSources(parseJsonBody(body)?.sources)));
        }
    }

    // ---- política de download e exclusão remota ----
    if (path === '/policy' && method === 'GET') {
        return sendJson(res, 200, { downloadPolicy: state.policy });
    }

    if (path === '/policy' && method === 'PUT') {
        const { downloadPolicy } = parseJsonBody(body) ?? {};
        if (downloadPolicy !== 'SERVER_ONLY' && downloadPolicy !== 'SERVER_AND_CLIENTS') {
            return sendError(res, 400, 'Invalid downloadPolicy');
        }
        if (downloadPolicy !== state.policy) {
            state.policy = downloadPolicy;
            recordOperation('POLICY', 'policy', 'SET', { downloadPolicy });
        }
        return sendJson(res, 200, { downloadPolicy: state.policy });
    }

    if (path === '/deletions' && method === 'POST') {
        const { chapterIds, deleteFromServer } = parseJsonBody(body) ?? {};
        if (
            !Array.isArray(chapterIds) ||
            !chapterIds.every(Number.isInteger) ||
            typeof deleteFromServer !== 'boolean'
        ) {
            return sendError(res, 400, 'Expected {"chapterIds":[int],"deleteFromServer":boolean}');
        }

        let queued = 0;
        (chapterIds as number[]).forEach((chapterId) => {
            const chapter = findChapter(chapterId);
            const manga = chapter && findManga(chapter.mangaId);
            if (!chapter || !manga) {
                // ids inexistentes são ignorados
                return;
            }

            queued++;
            state.deletions.push({
                id: state.nextDeletionId++,
                sourceId: manga.sourceId,
                mangaUrl: manga.url,
                chapterUrl: chapter.url,
                chapterNumber: chapter.chapterNumber,
                requestedAt: Date.now(),
            });
            if (deleteFromServer) {
                chapter.isDownloaded = false;
                chapter.sizeBytes = -1;
            }
            recordOperation('DELETION', `deletion:${chapterKey(chapter)}`, 'SET', { deleteFromServer });
        });

        return sendJson(res, 200, { queued });
    }

    if (path === '/deletions' && method === 'GET') {
        const afterId = Number(query.get('afterId') ?? 0);
        return sendJson(
            res,
            200,
            state.deletions.filter(({ id }) => id > afterId).sort((a, b) => a.id - b.id),
        );
    }

    // ---- histórico ----
    if (path === '/history' && method === 'PUT') {
        const { entries } = parseJsonBody(body) ?? {};
        if (!Array.isArray(entries)) {
            return sendError(res, 400, 'Expected {"entries":[...]}');
        }

        let updated = 0;
        entries.forEach(({ chapterId, lastReadAt }: { chapterId: number; lastReadAt: number }) => {
            const chapter = findChapter(chapterId);
            if (!chapter || typeof lastReadAt !== 'number') {
                return;
            }

            updated++;
            if (chapter.lastReadAt === lastReadAt) {
                return;
            }
            chapter.lastReadAt = lastReadAt;
            const key = `history:${chapterKey(chapter)}`;
            if (lastReadAt === 0) {
                recordOperation('HISTORY', key, 'REMOVE', null);
            } else {
                recordOperation('HISTORY', key, 'SET', { lastReadAt });
            }
        });

        return sendJson(res, 200, { updated });
    }

    // ---- log de operações (v2) ----
    if (path === '/operations' && method === 'POST') {
        const { operations } = parseJsonBody(body) ?? {};
        if (!Array.isArray(operations)) {
            return sendError(res, 400, 'Expected {"operations":[...]}');
        }

        let accepted = 0;
        let duplicates = 0;
        (operations as Operation[]).forEach((operation) => {
            if (state.operations.some(({ id }) => id === operation.id)) {
                duplicates++;
                return;
            }
            accepted++;
            state.operations.push({ ...operation, seq: state.nextOperationSeq++ });
        });

        return sendJson(res, 200, { accepted, duplicates });
    }

    if (path === '/operations' && method === 'GET') {
        return sendJson(res, 200, listOperations(query));
    }

    return sendError(res, 404, `No route for ${method} ${KARASU_PREFIX}${path}`);
};

export const listOperations = (query: URLSearchParams) => {
    const afterSeq = Number(query.get('afterSeq') ?? 0);
    const entity = query.get('entity') as OperationEntity | null;
    const limit = Math.min(Number(query.get('limit') ?? DEFAULT_OPERATIONS_LIMIT), MAX_OPERATIONS_LIMIT);

    const operations = state.operations
        .filter((operation) => operation.seq > afterSeq && (!entity || operation.entity === entity))
        .slice(0, limit);

    return {
        operations,
        lastSeq: operations.at(-1)?.seq ?? afterSeq,
        serverTime: Date.now(),
    };
};

/**
 * Atende uma requisição para `/api/v1/karasu/*`. Com `state.health === null` o servidor simula a ausência do fork
 * (todas as rotas devolvem 404), como o Suwayomi-Server upstream.
 */
export const handleKarasuRequest = (req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer): void => {
    const path = url.pathname.slice(KARASU_PREFIX.length) || '/';

    if (state.health === null) {
        return sendError(res, 404, 'Not found');
    }

    const fault = state.faults.find((item) => item.method === req.method && item.path === url.pathname);
    if (fault) {
        return sendError(res, fault.status, fault.error ?? 'Injected failure');
    }

    try {
        handleRoute({
            method: req.method ?? 'GET',
            path,
            query: url.searchParams,
            body,
            contentType: req.headers['content-type'] ?? '',
            deviceId: req.headers['x-karasu-device'] as string | undefined,
            res,
        });
    } catch (e) {
        if (e instanceof HttpError) {
            return sendError(res, e.status, e.message);
        }
        throw e;
    }
};
