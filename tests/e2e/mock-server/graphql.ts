/**
 * GraphQL `/api/graphql` do mock.
 *
 * Sem schema: um executor mínimo percorre o documento enviado pela WebUI (fragments, aliases, @include/@skip) e lê
 * cada campo do objeto devolvido pelo resolver da raiz. Campos ausentes viram `null`; campos que são funções recebem
 * os argumentos do documento. Campos da raiz sem handler são registrados em `state.unhandled` e devolvem erro, para
 * que os testes falhem com uma mensagem clara quando a UI passar a usar algo que o mock não implementa.
 */
import {
    Kind,
    parse,
    valueFromASTUntyped,
    type DocumentNode,
    type FieldNode,
    type FragmentDefinitionNode,
    type SelectionSetNode,
} from 'graphql';
import {
    chapterKey,
    findChapter,
    findManga,
    mangaKey,
    recordOperation,
    state,
    type MockCategory,
    type MockChapter,
    type MockManga,
    type MockSource,
} from './state.ts';

type Args = Record<string, any>;
type Variables = Record<string, unknown>;

export class GraphQLMockError extends Error {}

// ---- executor ----

const documentCache = new Map<string, DocumentNode>();

const parseCached = (query: string): DocumentNode => {
    let document = documentCache.get(query);
    if (!document) {
        document = parse(query);
        documentCache.set(query, document);
    }
    return document;
};

type ExecutionContext = {
    fragments: Map<string, FragmentDefinitionNode>;
    variables: Variables;
};

const isDirectiveSkipped = (node: { directives?: readonly any[] }, variables: Variables): boolean =>
    (node.directives ?? []).some((directive) => {
        const name = directive.name.value;
        if (name !== 'include' && name !== 'skip') {
            return false;
        }

        const condition = directive.arguments?.find((argument: any) => argument.name.value === 'if');
        const value = condition ? valueFromASTUntyped(condition.value, variables as any) : true;
        return name === 'include' ? !value : !!value;
    });

const fragmentApplies = (typeCondition: string | undefined, typename: string | undefined): boolean =>
    // sem __typename conhecido (ou condição ausente) o fragment é aplicado; os filtros de união usam __typename
    !typeCondition || !typename || typeCondition === typename;

const collectFields = (
    selectionSets: readonly SelectionSetNode[],
    typename: string | undefined,
    context: ExecutionContext,
    fields: Map<string, FieldNode[]> = new Map(),
): Map<string, FieldNode[]> => {
    selectionSets.forEach((selectionSet) => {
        selectionSet.selections.forEach((selection) => {
            if (isDirectiveSkipped(selection, context.variables)) {
                return;
            }

            if (selection.kind === Kind.FIELD) {
                const key = selection.alias?.value ?? selection.name.value;
                fields.set(key, [...(fields.get(key) ?? []), selection]);
                return;
            }

            if (selection.kind === Kind.INLINE_FRAGMENT) {
                if (fragmentApplies(selection.typeCondition?.name.value, typename)) {
                    collectFields([selection.selectionSet], typename, context, fields);
                }
                return;
            }

            const fragment = context.fragments.get(selection.name.value);
            if (!fragment) {
                throw new GraphQLMockError(`Unknown fragment ${selection.name.value}`);
            }
            if (fragmentApplies(fragment.typeCondition.name.value, typename)) {
                collectFields([fragment.selectionSet], typename, context, fields);
            }
        });
    });

    return fields;
};

const resolveValue = (
    value: unknown,
    selectionSets: readonly SelectionSetNode[],
    context: ExecutionContext,
): unknown => {
    if (value === null || value === undefined) {
        return null;
    }
    if (Array.isArray(value)) {
        return value.map((item) => resolveValue(item, selectionSets, context));
    }
    if (typeof value === 'object' && selectionSets.length) {
        return executeSelection(value as Record<string, unknown>, selectionSets, context);
    }
    return value;
};

const executeSelection = (
    source: Record<string, unknown>,
    selectionSets: readonly SelectionSetNode[],
    context: ExecutionContext,
    onMissingRootField?: (fieldName: string) => void,
): Record<string, unknown> => {
    const typename = source.__typename as string | undefined;
    const result: Record<string, unknown> = {};

    collectFields(selectionSets, typename, context).forEach(([field, ...rest], responseKey) => {
        const fieldName = field.name.value;
        if (fieldName === '__typename') {
            result[responseKey] = typename ?? null;
            return;
        }

        const args: Args = {};
        field.arguments?.forEach((argument) => {
            args[argument.name.value] = valueFromASTUntyped(argument.value, context.variables as any);
        });

        if (onMissingRootField && !(fieldName in source)) {
            onMissingRootField(fieldName);
            result[responseKey] = null;
            return;
        }

        const raw = source[fieldName];
        const value = typeof raw === 'function' ? (raw as (args: Args) => unknown)(args) : raw;
        const subSelections = [field, ...rest].flatMap(({ selectionSet }) => (selectionSet ? [selectionSet] : []));
        result[responseKey] = resolveValue(value, subSelections, context);
    });

    return result;
};

// ---- helpers de dados ----

const toCamel = (value: string) =>
    value.toLowerCase().replaceAll(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

type OrderInput = { by: string; byType?: 'ASC' | 'DESC' };

const sortItems = <Item extends Record<string, any>>(items: Item[], order?: OrderInput[] | null): Item[] => {
    if (!order?.length) {
        return items;
    }

    return [...items].sort((a, b) => {
        for (const { by, byType } of order) {
            const field = toCamel(by);
            const first = a[field];
            const second = b[field];
            if (first === second) {
                continue;
            }
            const direction = byType === 'DESC' ? -1 : 1;
            return (first > second ? 1 : -1) * direction;
        }
        return 0;
    });
};

const matchesOperators = (value: any, operators: Record<string, any>): boolean =>
    Object.entries(operators).every(([operator, expected]) => {
        switch (operator) {
            case 'equalTo':
                return value === expected;
            case 'notEqualTo':
                return value !== expected;
            case 'in':
                return (expected as unknown[]).includes(value);
            case 'notIn':
                return !(expected as unknown[]).includes(value);
            case 'greaterThan':
                return value > expected;
            case 'greaterThanOrEqualTo':
                return value >= expected;
            case 'lessThan':
                return value < expected;
            case 'lessThanOrEqualTo':
                return value <= expected;
            case 'includesInsensitive':
                return String(value ?? '')
                    .toLowerCase()
                    .includes(String(expected).toLowerCase());
            case 'isNull':
                return (value === null || value === undefined) === expected;
            default:
                // operadores desconhecidos não filtram
                return true;
        }
    });

const matchesFilter = (item: Record<string, any>, filter: Record<string, any> | null | undefined): boolean => {
    if (!filter) {
        return true;
    }

    return Object.entries(filter).every(([key, condition]) => {
        if (condition === null || condition === undefined) {
            return true;
        }
        if (key === 'and') {
            return (condition as Record<string, any>[]).every((sub) => matchesFilter(item, sub));
        }
        if (key === 'or') {
            return (condition as Record<string, any>[]).some((sub) => matchesFilter(item, sub));
        }
        if (key === 'not') {
            return !matchesFilter(item, condition);
        }
        return matchesOperators(item[key], condition);
    });
};

const connection = <Item extends Record<string, any>>(items: Item[], args: Args = {}, typename = 'Connection') => {
    const filtered = sortItems(
        items.filter(
            (item) =>
                matchesFilter(item, args.filter) &&
                Object.entries(args.condition ?? {}).every(
                    ([key, expected]) => expected == null || item[key] === expected,
                ),
        ),
        args.order,
    );
    const offset = args.offset ?? 0;
    const page = args.first != null ? filtered.slice(offset, offset + args.first) : filtered.slice(offset);

    return {
        __typename: typename,
        nodes: page,
        totalCount: filtered.length,
        pageInfo: {
            __typename: 'PageInfo',
            hasNextPage: offset + page.length < filtered.length,
            hasPreviousPage: offset > 0,
            startCursor: page.length ? String(offset) : null,
            endCursor: page.length ? String(offset + page.length - 1) : null,
        },
    };
};

const toLongString = (value: number): string => String(Math.trunc(value));

// ---- views (objetos que o GraphQL devolve, derivados do estado) ----

const sourceView = (source: MockSource | undefined, sourceId?: string) =>
    source
        ? {
              __typename: 'SourceType',
              id: source.id,
              name: source.name,
              displayName: source.displayName,
              lang: source.lang,
              iconUrl: source.iconUrl,
              supportsLatest: source.supportsLatest,
              isConfigurable: source.isConfigurable,
              isNsfw: source.isNsfw,
              contentWarning: null,
              meta: [],
              extension: {
                  __typename: 'ExtensionType',
                  pkgName: source.pkgName,
                  storeIndexUrl: null,
                  extensionStore: null,
              },
              preferences: [],
              filters: [],
          }
        : {
              // fonte desconhecida (ex.: id sem extensão instalada)
              __typename: 'SourceType',
              id: sourceId ?? '0',
              name: `Unknown ${sourceId}`,
              displayName: `Unknown ${sourceId}`,
              lang: 'all',
              iconUrl: '',
          };

const chapterView = (chapter: MockChapter | undefined): Record<string, unknown> | null =>
    chapter
        ? {
              __typename: 'ChapterType',
              id: chapter.id,
              name: chapter.name,
              mangaId: chapter.mangaId,
              scanlator: chapter.scanlator,
              realUrl: `https://mock.example${chapter.url}`,
              url: chapter.url,
              sourceOrder: chapter.sourceOrder,
              chapterNumber: chapter.chapterNumber,
              isRead: chapter.isRead,
              isDownloaded: chapter.isDownloaded,
              isBookmarked: chapter.isBookmarked,
              lastPageRead: chapter.lastPageRead,
              lastReadAt: toLongString(chapter.lastReadAt),
              pageCount: chapter.pageCount,
              uploadDate: toLongString(chapter.uploadDate),
              fetchedAt: toLongString(chapter.fetchedAt),
              meta: [],
              get manga() {
                  return mangaView(findManga(chapter.mangaId));
              },
          }
        : null;

const chaptersOf = (mangaId: number) => state.chapters.filter((chapter) => chapter.mangaId === mangaId);

const mangaView = (manga: MockManga | undefined): Record<string, unknown> | null => {
    if (!manga) {
        return null;
    }

    const chapters = () => chaptersOf(manga.id);
    const byNumber = (list: MockChapter[]) => [...list].sort((a, b) => a.chapterNumber - b.chapterNumber);

    return {
        __typename: 'MangaType',
        id: manga.id,
        title: manga.title,
        url: manga.url,
        realUrl: `https://mock.example${manga.url}`,
        sourceId: manga.sourceId,
        inLibrary: manga.inLibrary,
        initialized: true,
        thumbnailUrl: manga.thumbnailUrl,
        thumbnailUrlLastFetched: '1700000000',
        author: manga.author,
        artist: manga.artist,
        description: manga.description,
        genre: manga.genre,
        status: manga.status,
        lastFetchedAt: '1700000000',
        inLibraryAt: manga.inLibrary ? '1700000000' : '0',
        updateStrategy: 'ALWAYS_UPDATE',
        get meta() {
            return Object.entries(state.mangaMetas[manga.id] ?? {}).map(([key, value]) =>
                mangaMetaView(manga.id, key, value),
            );
        },
        get source() {
            return sourceView(
                state.sources.find(({ id }) => id === manga.sourceId),
                manga.sourceId,
            );
        },
        get unreadCount() {
            return chapters().filter(({ isRead }) => !isRead).length;
        },
        get downloadCount() {
            return chapters().filter(({ isDownloaded }) => isDownloaded).length;
        },
        get bookmarkCount() {
            return chapters().filter(({ isBookmarked }) => isBookmarked).length;
        },
        hasDuplicateChapters: false,
        chapters: (args: Args) => connection(chapters().map(chapterView) as any[], args, 'ChapterNodeList'),
        trackRecords: (args: Args) => connection([], args, 'TrackRecordNodeList'),
        categories: (args: Args) =>
            connection(
                state.categories.filter(({ id }) => manga.categoryIds.includes(id)).map(categoryView),
                args,
                'CategoryNodeList',
            ),
        get firstUnreadChapter() {
            return chapterView(byNumber(chapters().filter(({ isRead }) => !isRead))[0]);
        },
        get lastReadChapter() {
            return chapterView(
                [...chapters()]
                    .filter(({ lastReadAt }) => lastReadAt > 0)
                    .sort((a, b) => b.lastReadAt - a.lastReadAt)[0],
            );
        },
        get latestReadChapter() {
            return chapterView(byNumber(chapters().filter(({ isRead }) => isRead)).at(-1));
        },
        get latestFetchedChapter() {
            return chapterView(chapters()[0]);
        },
        get latestUploadedChapter() {
            return chapterView([...chapters()].sort((a, b) => b.uploadDate - a.uploadDate)[0]);
        },
        get highestNumberedChapter() {
            return chapterView(byNumber(chapters()).at(-1));
        },
    };
};

const categoryView = (category: MockCategory): Record<string, unknown> => ({
    __typename: 'CategoryType',
    id: category.id,
    name: category.name,
    order: category.order,
    default: category.default,
    isDefaultCategory: category.id === 0,
    includeInUpdate: category.includeInUpdate,
    includeInDownload: category.includeInDownload,
    meta: [],
    mangas: (args: Args) =>
        connection(
            state.mangas
                .filter(({ categoryIds, inLibrary }) => inLibrary && categoryIds.includes(category.id))
                .map(mangaView) as any[],
            args,
            'MangaNodeList',
        ),
});

const serverSettings = {
    __typename: 'SettingsType',
    ip: '0.0.0.0',
    port: 4567,
    socksProxyEnabled: false,
    socksProxyVersion: 5,
    socksProxyHost: '',
    socksProxyPort: '',
    socksProxyUsername: '',
    socksProxyPassword: '',
    webUIFlavor: 'WEBUI',
    initialOpenInBrowserEnabled: false,
    webUIInterface: 'BROWSER',
    electronPath: '',
    webUIChannel: 'STABLE',
    webUIUpdateCheckInterval: 23,
    downloadAsCbz: true,
    downloadsPath: '/data/downloads',
    autoDownloadNewChapters: false,
    excludeEntryWithUnreadChapters: true,
    autoDownloadNewChaptersLimit: 0,
    autoDownloadIgnoreReUploads: false,
    downloadConversions: [],
    serveConversions: [],
    maxSourcesInParallel: 6,
    excludeUnreadChapters: true,
    excludeNotStarted: true,
    excludeCompleted: true,
    globalUpdateInterval: 12,
    updateMangas: false,
    authMode: 'NONE',
    authPassword: '',
    authUsername: '',
    jwtAudience: 'suwayomi-server-api',
    jwtTokenExpiry: '5m',
    jwtRefreshExpiry: '60d',
    debugLogsEnabled: false,
    systemTrayEnabled: false,
    maxLogFileSize: '10mb',
    maxLogFiles: 31,
    maxLogFolderSize: '100mb',
    backupPath: '/data/backups',
    backupTime: '00:00',
    backupInterval: 1,
    backupTTL: 14,
    autoBackupIncludeCategories: true,
    autoBackupIncludeChapters: true,
    autoBackupIncludeClientData: true,
    autoBackupIncludeHistory: true,
    autoBackupIncludeManga: true,
    autoBackupIncludeServerSettings: true,
    autoBackupIncludeTracking: true,
    localSourcePath: '/data/local',
    flareSolverrEnabled: false,
    flareSolverrUrl: 'http://localhost:8191',
    flareSolverrTimeout: 60,
    flareSolverrSessionName: 'suwayomi',
    flareSolverrSessionTtl: 15,
    flareSolverrAsResponseFallback: false,
    opdsUseBinaryFileSizes: false,
    opdsItemsPerPage: 50,
    opdsEnablePageReadProgress: true,
    opdsMarkAsReadOnDownload: false,
    opdsShowOnlyUnreadChapters: false,
    opdsShowOnlyDownloadedChapters: false,
    opdsChapterSortOrder: 'DESC',
    opdsCbzMimetype: 'MODERN',
    opdsSkipChapterMetadataFeed: false,
    koreaderSyncChecksumMethod: 'BINARY',
    koreaderSyncStrategyBackward: 'DISABLED',
    koreaderSyncStrategyForward: 'DISABLED',
    koreaderSyncPercentageTolerance: 1e-15,
    databaseType: 'H2',
    databaseUrl: 'postgresql://localhost:5432/suwayomi',
    databaseUsername: '',
    databasePassword: '',
    databaseSchema: 'public',
    useHikariConnectionPool: true,
    hikariMaxPoolSize: 10,
    kcefEnabled: false,
    syncDataCategories: true,
    syncDataChapters: true,
    syncDataHistory: true,
    syncDataManga: true,
    syncDataTracking: true,
    syncInterval: 'OFF',
    syncYomiApiKey: '',
    syncYomiEnabled: false,
    syncYomiHost: '',
} as Record<string, unknown>;

// ---- registro de operações do Karasu (contrato v2) ----

const recordLinkOperations = (manga: MockManga, before: number[], after: number[]) => {
    after
        .filter((id) => !before.includes(id))
        .forEach((id) => recordOperation('CATEGORY_LINK', `link:${mangaKey(manga)}|${id}`, 'SET', null));
    before
        .filter((id) => !after.includes(id))
        .forEach((id) => recordOperation('CATEGORY_LINK', `link:${mangaKey(manga)}|${id}`, 'REMOVE', null));
};

const updateMangaCategories = (mangaId: number, patch: Args) => {
    const manga = findManga(mangaId);
    if (!manga) {
        throw new GraphQLMockError(`Manga ${mangaId} not found`);
    }

    const before = manga.categoryIds;
    let after = patch.clearCategories ? [] : [...before];
    after = after.filter((id) => !(patch.removeFromCategories ?? []).includes(id));
    (patch.addToCategories ?? []).forEach((id: number) => {
        if (!after.includes(id)) {
            after.push(id);
        }
    });

    manga.categoryIds = after;
    recordLinkOperations(manga, before, after);
    return manga;
};

const updateChapterFields = (chapter: MockChapter, patch: Args) => {
    const previous = { isRead: chapter.isRead, lastPageRead: chapter.lastPageRead };

    if (typeof patch.isRead === 'boolean') {
        chapter.isRead = patch.isRead;
    }
    if (typeof patch.isBookmarked === 'boolean') {
        chapter.isBookmarked = patch.isBookmarked;
    }
    if (typeof patch.lastPageRead === 'number') {
        chapter.lastPageRead = patch.lastPageRead;
    }

    if (chapter.isRead !== previous.isRead || chapter.lastPageRead !== previous.lastPageRead) {
        recordOperation('PROGRESS', `progress:${chapterKey(chapter)}`, 'SET', {
            read: chapter.isRead,
            lastPageRead: chapter.lastPageRead,
        });
    }

    // o servidor só grava lastReadAt (como "agora", em segundos) ao mudar lastPageRead
    if (chapter.lastPageRead !== previous.lastPageRead) {
        chapter.lastReadAt = Math.floor(Date.now() / 1000);
        recordOperation('HISTORY', `history:${chapterKey(chapter)}`, 'SET', { lastReadAt: chapter.lastReadAt });
    }
};

const requireChapter = (id: number): MockChapter => {
    const chapter = findChapter(id);
    if (!chapter) {
        throw new GraphQLMockError(`Chapter ${id} not found`);
    }
    return chapter;
};

const requireCategory = (id: number): MockCategory => {
    const category = state.categories.find((item) => item.id === id);
    if (!category) {
        throw new GraphQLMockError(`Category ${id} not found`);
    }
    return category;
};

const updateCategoryFields = (category: MockCategory, patch: Args) => {
    if (typeof patch.name === 'string' && patch.name !== category.name) {
        category.name = patch.name;
        recordOperation('CATEGORY', `category:${category.id}`, 'SET', { name: category.name });
    }
    if (typeof patch.default === 'boolean') {
        category.default = patch.default;
    }
    if (patch.includeInUpdate) {
        category.includeInUpdate = patch.includeInUpdate;
    }
    if (patch.includeInDownload) {
        category.includeInDownload = patch.includeInDownload;
    }
};

const normalizeCategoryOrder = () => {
    state.categories.sort((a, b) => a.order - b.order).forEach((category, index) => (category.order = index));
};

const globalMetaView = ({ key, value }: { key: string; value: string }) => ({
    __typename: 'GlobalMetaType',
    key,
    value,
});

const mangaMetaView = (mangaId: number, key: string, value: string) => ({
    __typename: 'MangaMetaType',
    mangaId,
    key,
    value,
});

/** Chaves de `metas` que casam com `keys` (exatas) ou `prefixes`. */
const matchMetaKeys = (metas: Record<string, string>, { keys, prefixes }: { keys?: string[]; prefixes?: string[] }) =>
    Object.keys(metas).filter((key) => keys?.includes(key) || prefixes?.some((prefix) => key.startsWith(prefix)));

// ---- raiz ----

const Query: Record<string, unknown> = {
    aboutServer: () => ({
        __typename: 'AboutServerPayload',
        buildTime: '1700000000',
        buildType: 'Stable',
        discord: 'https://discord.gg/mock',
        github: 'https://github.com/Suwayomi/Suwayomi-Server',
        name: 'Suwayomi-Server',
        version: state.health?.serverVersion ?? 'v2.1.0',
        platformInfo: {
            __typename: 'PlatformInfo',
            os: { __typename: 'OsInfo', name: 'Linux', build: 'mock', version: '6.0' },
            arch: 'amd64',
            headless: true,
            jvm: {
                __typename: 'JvmInfo',
                javaVersion: '21',
                vmName: 'OpenJDK 64-Bit Server VM',
                vmVendor: 'Mock',
                vmVersion: '21',
            },
        },
    }),
    aboutWebUI: () => ({ __typename: 'AboutWebUI', channel: 'STABLE', tag: 'r0', updateTimestamp: '1700000000' }),
    checkForServerUpdates: () => [],
    checkForWebUIUpdate: () => ({
        __typename: 'WebUIUpdateCheck',
        channel: 'STABLE',
        tag: 'r0',
        updateAvailable: false,
    }),
    getWebUIUpdateStatus: () => ({
        __typename: 'WebUIUpdateStatus',
        info: { __typename: 'WebUIUpdateInfo', channel: 'STABLE', tag: 'r0' },
        progress: 0,
        state: 'IDLE',
    }),
    settings: () => serverSettings,
    metas: (args: Args) =>
        connection(
            Object.entries(state.globalMetas).map(([key, value]) => globalMetaView({ key, value })),
            args,
            'GlobalMetaNodeList',
        ),
    lastUpdateTimestamp: () => ({ __typename: 'LastUpdateTimestampPayload', timestamp: '0' }),
    downloadStatus: () => ({ __typename: 'DownloadStatus', state: 'STOPPED', queue: [] }),
    updateStatus: () => ({
        __typename: 'UpdateStatus',
        isRunning: false,
        completeJobs: { __typename: 'UpdateStatusType', mangas: { nodes: [], totalCount: 0 }, totalCount: 0 },
        failedJobs: { __typename: 'UpdateStatusType', mangas: { nodes: [], totalCount: 0 }, totalCount: 0 },
        pendingJobs: { __typename: 'UpdateStatusType', mangas: { nodes: [], totalCount: 0 }, totalCount: 0 },
        runningJobs: { __typename: 'UpdateStatusType', mangas: { nodes: [], totalCount: 0 }, totalCount: 0 },
        skippedJobs: { __typename: 'UpdateStatusType', mangas: { nodes: [], totalCount: 0 }, totalCount: 0 },
        skippedMangas: { __typename: 'UpdateStatusType', mangas: { nodes: [], totalCount: 0 }, totalCount: 0 },
    }),
    categories: (args: Args) => connection(state.categories.map(categoryView), args, 'CategoryNodeList'),
    category: ({ id }: Args) => {
        const category = state.categories.find((item) => item.id === id);
        return category ? categoryView(category) : null;
    },
    sources: (args: Args) =>
        connection(
            state.sources.map((source) => sourceView(source)),
            args,
            'SourceNodeList',
        ),
    source: ({ id }: Args) => {
        const source = state.sources.find((item) => item.id === id);
        return source ? sourceView(source) : null;
    },
    manga: ({ id }: Args) => mangaView(findManga(id)),
    mangas: (args: Args) => connection(state.mangas.map(mangaView) as any[], args, 'MangaNodeList'),
    chapter: ({ id }: Args) => chapterView(findChapter(id)),
    chapters: (args: Args) => connection(state.chapters.map(chapterView) as any[], args, 'ChapterNodeList'),
    extensions: (args: Args) => connection([], args, 'ExtensionNodeList'),
    trackers: (args: Args) => connection([], args, 'TrackerNodeList'),
    koSyncStatus: () => ({ __typename: 'KoSyncStatusPayload', isLoggedIn: false, username: null }),
};

const Mutation: Record<string, unknown> = {
    updateChapter: ({ input }: Args) => {
        const chapter = requireChapter(input.id);
        updateChapterFields(chapter, input.patch ?? {});
        return { __typename: 'UpdateChapterPayload', chapter: chapterView(chapter) };
    },
    updateChapters: ({ input }: Args) => {
        const chapters = (input.ids as number[]).map(requireChapter);
        chapters.forEach((chapter) => updateChapterFields(chapter, input.patch ?? {}));
        return { __typename: 'UpdateChaptersPayload', chapters: chapters.map(chapterView) };
    },
    deleteDownloadedChapter: ({ input }: Args) => {
        const chapter = requireChapter(input.id);
        chapter.isDownloaded = false;
        return { __typename: 'DeleteDownloadedChapterPayload', chapters: chapterView(chapter) };
    },
    deleteDownloadedChapters: ({ input }: Args) => {
        const chapters = (input.ids as number[]).map(requireChapter);
        chapters.forEach((chapter) => {
            chapter.isDownloaded = false;
            chapter.sizeBytes = -1;
        });
        return { __typename: 'DeleteDownloadedChaptersPayload', chapters: chapters.map(chapterView) };
    },
    fetchMangaAndChapters: ({ input }: Args) => ({
        __typename: 'FetchMangaAndChaptersPayload',
        manga: mangaView(findManga(input.id)),
        chapters: chaptersOf(input.id).map(chapterView),
    }),
    fetchSourceManga: ({ input }: Args) => {
        const query = String(input.query ?? '').toLowerCase();
        const mangas = state.mangas.filter(
            (manga) => manga.sourceId === input.source && manga.title.toLowerCase().includes(query),
        );
        return { __typename: 'FetchSourceMangaPayload', hasNextPage: false, mangas: mangas.map(mangaView) };
    },
    updateManga: ({ input }: Args) => {
        const manga = findManga(input.id);
        if (manga && typeof input.patch?.inLibrary === 'boolean') {
            manga.inLibrary = input.patch.inLibrary;
        }
        return { __typename: 'UpdateMangaPayload', manga: mangaView(manga) };
    },
    updateMangaCategories: ({ input }: Args) => ({
        __typename: 'UpdateMangaCategoriesPayload',
        manga: mangaView(updateMangaCategories(input.id, input.patch ?? {})),
    }),
    updateMangasCategories: ({ input }: Args) => ({
        __typename: 'UpdateMangasCategoriesPayload',
        mangas: (input.ids as number[]).map((id) => mangaView(updateMangaCategories(id, input.patch ?? {}))),
    }),
    createCategory: ({ input }: Args) => {
        const category: MockCategory = {
            id: state.nextCategoryId++,
            name: input.name,
            order: Math.max(0, ...state.categories.map(({ order }) => order)) + 1,
            default: !!input.default,
            includeInUpdate: input.includeInUpdate ?? 'UNSET',
            includeInDownload: input.includeInDownload ?? 'UNSET',
        };
        state.categories.push(category);
        recordOperation('CATEGORY', `category:${category.id}`, 'SET', { name: category.name });
        return { __typename: 'CreateCategoryPayload', category: categoryView(category) };
    },
    updateCategory: ({ input }: Args) => {
        const category = requireCategory(input.id);
        updateCategoryFields(category, input.patch ?? {});
        return { __typename: 'UpdateCategoryPayload', category: categoryView(category) };
    },
    updateCategories: ({ input }: Args) => {
        const categories = (input.ids as number[]).map(requireCategory);
        categories.forEach((category) => updateCategoryFields(category, input.patch ?? {}));
        return { __typename: 'UpdateCategoriesPayload', categories: categories.map(categoryView) };
    },
    deleteCategory: ({ input }: Args) => {
        const category = requireCategory(input.categoryId);
        state.mangas.forEach((manga) => {
            if (manga.categoryIds.includes(category.id)) {
                const before = manga.categoryIds;
                manga.categoryIds = before.filter((id) => id !== category.id);
                recordLinkOperations(manga, before, manga.categoryIds);
            }
        });
        state.categories = state.categories.filter(({ id }) => id !== category.id);
        normalizeCategoryOrder();
        recordOperation('CATEGORY', `category:${category.id}`, 'REMOVE', null);
        return { __typename: 'DeleteCategoryPayload', category: categoryView(category) };
    },
    updateCategoryOrder: ({ input }: Args) => {
        const category = requireCategory(input.id);
        const ordered = state.categories.filter(({ id }) => id !== category.id).sort((a, b) => a.order - b.order);
        ordered.splice(input.position, 0, category);
        ordered.forEach((item, index) => (item.order = index));
        state.categories = ordered;
        return { __typename: 'UpdateCategoryOrderPayload', categories: ordered.map(categoryView) };
    },
    updateServerSettings: ({ input }: Args) => {
        Object.assign(serverSettings, input.settings ?? {});
        return { __typename: 'UpdateServerSettingsPayload', settings: serverSettings };
    },
    setGlobalMetas: ({ input }: Args) => {
        (input.metas as { key: string; value: string }[]).forEach(({ key, value }) => {
            state.globalMetas[key] = String(value);
        });
        return {
            __typename: 'SetGlobalMetasPayload',
            metas: (input.metas as { key: string; value: string }[]).map(globalMetaView),
        };
    },
    deleteGlobalMetas: ({ input }: Args) => {
        const keys = matchMetaKeys(state.globalMetas, input);
        const removed = keys.map((key) => globalMetaView({ key, value: state.globalMetas[key] }));
        keys.forEach((key) => delete state.globalMetas[key]);
        return { __typename: 'DeleteGlobalMetasPayload', metas: removed };
    },
    setMangaMetas: ({ input }: Args) => {
        const metas: unknown[] = [];
        (input.items as { mangaIds: number[]; metas: { key: string; value: string }[] }[]).forEach((item) =>
            item.mangaIds.forEach((mangaId) =>
                item.metas.forEach(({ key, value }) => {
                    (state.mangaMetas[mangaId] ??= {})[key] = String(value);
                    metas.push(mangaMetaView(mangaId, key, String(value)));
                }),
            ),
        );
        return { __typename: 'SetMangaMetasPayload', metas };
    },
    deleteMangaMetas: ({ input }: Args) => {
        const metas: unknown[] = [];
        (input.items as { mangaIds: number[]; keys?: string[]; prefixes?: string[] }[]).forEach((item) =>
            item.mangaIds.forEach((mangaId) => {
                const stored = (state.mangaMetas[mangaId] ??= {});
                matchMetaKeys(stored, item).forEach((key) => {
                    metas.push(mangaMetaView(mangaId, key, stored[key]));
                    delete stored[key];
                });
            }),
        );
        return { __typename: 'DeleteMangaMetasPayload', metas };
    },
    fetchExtensions: () => ({ __typename: 'FetchExtensionsPayload', extensions: [], extensionStores: [] }),
};

export type GraphQLRequestBody = {
    query?: string;
    operationName?: string | null;
    variables?: Variables | null;
};

type GraphQLResponse = { data: unknown; errors?: { message: string }[] };

/** Executa uma operação `query`/`mutation` e devolve a resposta no formato GraphQL padrão. */
export const executeGraphQL = ({ query, operationName, variables }: GraphQLRequestBody): GraphQLResponse => {
    if (!query) {
        return { data: null, errors: [{ message: 'Missing query' }] };
    }

    const errors: { message: string }[] = [];

    try {
        const document = parseCached(query);
        const fragments = new Map<string, FragmentDefinitionNode>();
        document.definitions.forEach((definition) => {
            if (definition.kind === Kind.FRAGMENT_DEFINITION) {
                fragments.set(definition.name.value, definition);
            }
        });

        const operations = document.definitions.filter((definition) => definition.kind === Kind.OPERATION_DEFINITION);
        const operation = operationName
            ? operations.find((definition) => definition.name?.value === operationName)
            : operations[0];
        if (!operation) {
            return { data: null, errors: [{ message: `Unknown operation ${operationName}` }] };
        }

        const root = operation.operation === 'mutation' ? Mutation : Query;
        const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
        const data = executeSelection(
            root as Record<string, unknown>,
            [operation.selectionSet],
            { fragments, variables: variables ?? {} },
            (fieldName) => {
                const description = `${rootType}.${fieldName} (operation ${operation.name?.value ?? 'anonymous'})`;
                state.unhandled.push(description);
                errors.push({ message: `mock server: ${description} is not implemented` });
            },
        );

        return errors.length ? { data, errors } : { data };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { data: null, errors: [{ message }] };
    }
};
