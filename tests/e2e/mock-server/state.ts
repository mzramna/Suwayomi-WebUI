/**
 * Estado em memória do servidor mock (Suwayomi-Server + rotas Karasu).
 *
 * O formato dos dados espelha o servidor real: ids numéricos (Int), `sourceId` SEMPRE string (Long de 64 bits),
 * `createdAt`/`ts` em milissegundos e `lastReadAt`/`uploadDate` como o GraphQL do Suwayomi devolve.
 */

export const SOURCE_A_ID = '2499283573021220255';
export const SOURCE_B_ID = '6247824327199706550';

export type KarasuHealth = {
    status: string;
    serverVersion?: string;
    apiVersion?: number;
    database?: { type: string };
    storage?: { type: string; path?: string; freeBytes?: number | null; totalBytes?: number | null };
};

export type MockSource = {
    id: string;
    name: string;
    lang: string;
    displayName: string;
    iconUrl: string;
    supportsLatest: boolean;
    isConfigurable: boolean;
    isNsfw: boolean;
    pkgName: string;
};

export type MockCategory = {
    id: number;
    name: string;
    order: number;
    default: boolean;
    includeInUpdate: string;
    includeInDownload: string;
};

export type MockManga = {
    id: number;
    sourceId: string;
    url: string;
    title: string;
    inLibrary: boolean;
    author: string;
    artist: string;
    description: string;
    genre: string[];
    status: string;
    thumbnailUrl: string;
    categoryIds: number[];
};

export type MockChapter = {
    id: number;
    mangaId: number;
    url: string;
    name: string;
    chapterNumber: number;
    sourceOrder: number;
    scanlator: string | null;
    isRead: boolean;
    isBookmarked: boolean;
    isDownloaded: boolean;
    lastPageRead: number;
    /** segundos (epoch); 0 = fora do histórico */
    lastReadAt: number;
    pageCount: number;
    uploadDate: number;
    fetchedAt: number;
    /** tamanho do CBZ servido em /chapter/{id}/archive */
    sizeBytes: number;
};

export type MergedSource = { sourceId: string; url: string; priority: number; updatesEnabled: boolean };

export type BackupRecord = {
    id: string;
    name: string;
    sizeBytes: number;
    createdAt: number;
    device: string | null;
    data: Buffer;
};

export type Deletion = {
    id: number;
    sourceId: string;
    mangaUrl: string;
    chapterUrl: string;
    chapterNumber: number;
    requestedAt: number;
};

export type OperationEntity =
    | 'CATEGORY'
    | 'CATEGORY_LINK'
    | 'PROGRESS'
    | 'HISTORY'
    | 'MERGED'
    | 'DELETION'
    | 'POLICY'
    | 'BACKUP';

export type Operation = {
    id: string;
    deviceId: string;
    ts: number;
    entity: OperationEntity;
    key: string;
    action: 'SET' | 'REMOVE';
    value: unknown;
    seq: number;
};

export type RecordedRequest = {
    seq: number;
    method: string;
    /** caminho + query string, ex.: `/api/v1/karasu/backups?x=1` */
    path: string;
    /** json interpretado quando o corpo é json; texto cru ou descrição (multipart) nos demais casos */
    body: unknown;
    /** só para o GraphQL: nome da operação e variáveis */
    graphql?: { operationName: string | null; variables: Record<string, unknown> };
    /** status devolvido pelo mock */
    status: number;
};

/** Falha injetada: as requisições `method` + `path` (sem query string) do Karasu respondem `status`. */
export type Fault = { method: string; path: string; status: number; error?: string };

export type MockState = {
    faults: Fault[];
    /** `null` simula um servidor SEM as rotas karasu (todas devolvem 404) */
    health: KarasuHealth | null;
    policy: 'SERVER_ONLY' | 'SERVER_AND_CLIENTS';
    backups: BackupRecord[];
    /** mangaId -> fontes extras */
    merged: Record<number, MergedSource[]>;
    deletions: Deletion[];
    operations: Operation[];
    sources: MockSource[];
    categories: MockCategory[];
    mangas: MockManga[];
    chapters: MockChapter[];
    /** metadados chave/valor (a WebUI grava preferências por obra e globais) */
    globalMetas: Record<string, string>;
    mangaMetas: Record<number, Record<string, string>>;
    nextCategoryId: number;
    nextDeletionId: number;
    nextOperationSeq: number;
    requests: RecordedRequest[];
    nextRequestSeq: number;
    /** campos/operações GraphQL que o mock não implementa (os testes exigem que fique vazio) */
    unhandled: string[];
};

/** Bytes determinísticos de um arquivo de `size` bytes (para comparar downloads byte a byte). */
export const deterministicBytes = (seed: string, size: number): Buffer => {
    const buffer = Buffer.alloc(size);
    let value = 0;
    for (let i = 0; i < seed.length; i++) {
        value = (value * 31 + seed.charCodeAt(i)) >>> 0;
    }
    for (let i = 0; i < size; i++) {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        buffer[i] = value >>> 24;
    }
    return buffer;
};

const DEFAULT_CHAPTER_COUNT = 5;

const createDefaultMangas = (): MockManga[] => [
    {
        id: 1,
        sourceId: SOURCE_A_ID,
        url: '/manga/mock-manga-one',
        title: 'Mock Manga One',
        inLibrary: true,
        author: 'Author One',
        artist: 'Artist One',
        description: 'First mocked entry.',
        genre: ['Action', 'Adventure'],
        status: 'ONGOING',
        thumbnailUrl: '/api/v1/manga/1/thumbnail',
        categoryIds: [1],
    },
    {
        id: 2,
        sourceId: SOURCE_B_ID,
        url: '/manga/mock-manga-two',
        title: 'Mock Manga Two',
        inLibrary: true,
        author: 'Author Two',
        artist: 'Artist Two',
        description: 'Second mocked entry.',
        genre: ['Drama'],
        status: 'COMPLETED',
        thumbnailUrl: '/api/v1/manga/2/thumbnail',
        categoryIds: [],
    },
];

const FIXED_FETCH_TIME = 1_700_000_000_000;

const createDefaultChapters = (): MockChapter[] => {
    const chapters: MockChapter[] = [];
    let id = 1;

    [1, 2].forEach((mangaId) => {
        for (let number = 1; number <= DEFAULT_CHAPTER_COUNT; number++) {
            const isDownloaded = number <= 3;
            chapters.push({
                id,
                mangaId,
                url: `/manga/mock-manga-${mangaId === 1 ? 'one' : 'two'}/chapter-${number}`,
                name: `Chapter ${number}`,
                chapterNumber: number,
                sourceOrder: number,
                scanlator: null,
                // no mangá 1 o capítulo 1 já foi lido; os demais estão não lidos
                isRead: mangaId === 1 && number === 1,
                isBookmarked: false,
                isDownloaded,
                lastPageRead: 0,
                lastReadAt: 0,
                pageCount: 10,
                uploadDate: FIXED_FETCH_TIME + number * 86_400_000,
                fetchedAt: FIXED_FETCH_TIME,
                sizeBytes: isDownloaded ? 1024 * number : -1,
            });
            id++;
        }
    });

    return chapters;
};

export const createDefaultBackups = (): BackupRecord[] => [
    {
        id: 'karasu-pixel-8-2023-11-14.tachibk',
        name: 'karasu-pixel-8-2023-11-14.tachibk',
        sizeBytes: 2048,
        createdAt: 1_700_000_000_000,
        device: 'Pixel 8',
        data: deterministicBytes('karasu-pixel-8-2023-11-14.tachibk', 2048),
    },
    {
        id: 'karasu-tablet-2023-11-13.tachibk',
        name: 'karasu-tablet-2023-11-13.tachibk',
        sizeBytes: 5 * 1024 * 1024,
        createdAt: 1_699_900_000_000,
        device: 'Galaxy Tab',
        data: deterministicBytes('karasu-tablet-2023-11-13.tachibk', 5 * 1024 * 1024),
    },
];

export const createDefaultState = (): MockState => ({
    faults: [],
    health: {
        status: 'ok',
        serverVersion: 'v2.1.0',
        apiVersion: 1,
        database: { type: 'H2' },
        storage: {
            type: 'local',
            path: '/data/downloads',
            freeBytes: 100 * 1024 ** 3,
            totalBytes: 500 * 1024 ** 3,
        },
    },
    policy: 'SERVER_ONLY',
    backups: createDefaultBackups(),
    merged: {},
    deletions: [],
    operations: [],
    sources: [
        {
            id: SOURCE_A_ID,
            name: 'Mock Source A',
            lang: 'en',
            displayName: 'Mock Source A (EN)',
            iconUrl: '/api/v1/extension/icon/mock.a',
            supportsLatest: true,
            isConfigurable: false,
            isNsfw: false,
            pkgName: 'eu.kanade.tachiyomi.extension.en.mocka',
        },
        {
            id: SOURCE_B_ID,
            name: 'Mock Source B',
            lang: 'en',
            displayName: 'Mock Source B (EN)',
            iconUrl: '/api/v1/extension/icon/mock.b',
            supportsLatest: true,
            isConfigurable: false,
            isNsfw: false,
            pkgName: 'eu.kanade.tachiyomi.extension.en.mockb',
        },
    ],
    categories: [
        {
            id: 0,
            name: 'Default',
            order: 0,
            default: true,
            includeInUpdate: 'UNSET',
            includeInDownload: 'UNSET',
        },
        {
            id: 1,
            name: 'Action',
            order: 1,
            default: false,
            includeInUpdate: 'UNSET',
            includeInDownload: 'UNSET',
        },
        {
            id: 2,
            name: 'Favorites',
            order: 2,
            default: false,
            includeInUpdate: 'UNSET',
            includeInDownload: 'UNSET',
        },
    ],
    mangas: createDefaultMangas(),
    chapters: createDefaultChapters(),
    globalMetas: {},
    mangaMetas: {},
    nextCategoryId: 3,
    nextDeletionId: 1,
    nextOperationSeq: 1,
    requests: [],
    nextRequestSeq: 1,
    unhandled: [],
});

export const state: MockState = createDefaultState();

/** Volta tudo ao estado inicial (inclusive o log de requisições e de operações). */
export const resetState = (): void => {
    Object.assign(state, createDefaultState());
};

// ---- seed ----

export type BackupSeed = {
    id?: string;
    name: string;
    sizeBytes?: number;
    createdAt?: number;
    device?: string | null;
    /** conteúdo em base64; sem ele, bytes determinísticos de `sizeBytes` são gerados */
    contentBase64?: string;
};

export type SeedBody = {
    health?: KarasuHealth | null;
    policy?: MockState['policy'];
    backups?: BackupSeed[];
    merged?: Record<string, MergedSource[]>;
    sources?: MockSource[];
    categories?: MockCategory[];
    mangas?: MockManga[];
    chapters?: MockChapter[];
    faults?: Fault[];
};

/**
 * Substitui partes do estado atual (sem apagar o log de requisições). Chaves ausentes não são alteradas.
 * Normalmente usado logo depois de `reset`.
 */
export const applySeed = (seed: SeedBody): void => {
    if ('health' in seed) {
        state.health = seed.health ?? null;
    }
    if (seed.policy) {
        state.policy = seed.policy;
    }
    if (seed.backups) {
        state.backups = seed.backups.map((backup) => {
            const data = backup.contentBase64
                ? Buffer.from(backup.contentBase64, 'base64')
                : deterministicBytes(backup.id ?? backup.name, backup.sizeBytes ?? 0);
            return {
                id: backup.id ?? backup.name,
                name: backup.name,
                sizeBytes: backup.contentBase64 ? data.length : (backup.sizeBytes ?? data.length),
                createdAt: backup.createdAt ?? Date.now(),
                device: backup.device ?? null,
                data,
            };
        });
    }
    if (seed.merged) {
        state.merged = Object.fromEntries(Object.entries(seed.merged).map(([mangaId, sources]) => [mangaId, sources]));
    }
    if (seed.sources) {
        state.sources = seed.sources;
    }
    if (seed.categories) {
        state.categories = seed.categories;
        state.nextCategoryId = Math.max(0, ...seed.categories.map(({ id }) => id)) + 1;
    }
    if (seed.mangas) {
        state.mangas = seed.mangas;
    }
    if (seed.chapters) {
        state.chapters = seed.chapters;
    }
    if (seed.faults) {
        state.faults = seed.faults;
    }
};

// ---- log de operações (contrato v2) ----

/** `deviceId` da requisição em andamento: header `X-Karasu-Device` ou "web" (WebUI e demais clientes). */
export const requestContext = { deviceId: 'web' };

/**
 * Registra uma operação como o servidor real fará: `deviceId = "web"` (a WebUI não envia `X-Karasu-Device`) e `ts` do
 * relógio do mock. Só registra mudanças EFETIVAS, então o chamador deve passar `changed = false` para no-ops.
 */
export const recordOperation = (
    entity: OperationEntity,
    key: string,
    action: Operation['action'],
    value: unknown,
    deviceId: string = requestContext.deviceId,
): Operation => {
    const operation: Operation = {
        id: crypto.randomUUID(),
        deviceId,
        ts: Date.now(),
        entity,
        key,
        action,
        value: value ?? null,
        seq: state.nextOperationSeq++,
    };
    state.operations.push(operation);
    return operation;
};

export const findManga = (id: number): MockManga | undefined => state.mangas.find((manga) => manga.id === id);

export const findChapter = (id: number): MockChapter | undefined => state.chapters.find((chapter) => chapter.id === id);

export const mangaKey = (manga: Pick<MockManga, 'sourceId' | 'url'>): string => `${manga.sourceId}|${manga.url}`;

export const chapterKey = (chapter: MockChapter): string => {
    const manga = findManga(chapter.mangaId);
    return `${manga ? mangaKey(manga) : `?|?`}|${chapter.url}`;
};
