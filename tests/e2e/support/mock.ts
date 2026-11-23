/**
 * Fixtures dos testes E2E: cliente do servidor mock (reset/seed/consulta ao que a UI enviou).
 */
import { expect, test as base, type APIRequestContext } from '@playwright/test';
import {
    deterministicBytes,
    SOURCE_A_ID,
    SOURCE_B_ID,
    type MockManga,
    type MockSource,
    type Operation,
    type OperationEntity,
    type RecordedRequest,
    type SeedBody,
} from '../mock-server/state.ts';

export { deterministicBytes, SOURCE_A_ID, SOURCE_B_ID };
export type { Operation, RecordedRequest, SeedBody };

export const KARASU = '/api/v1/karasu';

/** Fonte instalada extra (os ids reais são Long de 64 bits, por isso sempre strings). */
export const makeSource = (id: string, name: string): MockSource => ({
    id,
    name,
    lang: 'en',
    displayName: `${name} (EN)`,
    iconUrl: `/api/v1/extension/icon/mock.${id}`,
    supportsLatest: true,
    isConfigurable: false,
    isNsfw: false,
    pkgName: `eu.kanade.tachiyomi.extension.en.mock${id}`,
});

export const SOURCE_C_ID = '1234567890123456789';
export const SOURCE_D_ID = '8765432109876543210';

export const sourceA = makeSource(SOURCE_A_ID, 'Mock Source A');
export const sourceB = makeSource(SOURCE_B_ID, 'Mock Source B');
export const sourceC = makeSource(SOURCE_C_ID, 'Mock Source C');
export const sourceD = makeSource(SOURCE_D_ID, 'Mock Source D');

type RequestFilter = {
    method?: string;
    /** caminho exato (sem a query string) ou prefixo, se terminar com `*` */
    path?: string;
    operation?: string;
};

const matchesPath = (requestPath: string, expected: string): boolean => {
    const [path] = requestPath.split('?');
    return expected.endsWith('*') ? path.startsWith(expected.slice(0, -1)) : path === expected;
};

/** Variáveis GraphQL de uma requisição registrada. */
export const variablesOf = (request: RecordedRequest): Record<string, any> => request.graphql?.variables ?? {};

export class MockClient {
    constructor(private readonly api: APIRequestContext) {}

    private async getJson<T>(path: string): Promise<T> {
        const response = await this.api.get(path);
        expect(response.ok(), `GET ${path} on the mock server failed (${response.status()})`).toBeTruthy();
        return (await response.json()) as T;
    }

    async reset(): Promise<void> {
        const response = await this.api.post('/__mock/reset');
        expect(response.ok(), 'POST /__mock/reset failed: is the mock server running?').toBeTruthy();
    }

    async seed(body: SeedBody): Promise<void> {
        const response = await this.api.post('/__mock/seed', { data: body });
        expect(response.ok(), `POST /__mock/seed failed (${response.status()})`).toBeTruthy();
    }

    /** Acrescenta obras às semeadas (`seed({ mangas })` substitui a lista inteira). */
    async addMangas(...extra: MockManga[]): Promise<void> {
        const { mangas } = await this.state();
        await this.seed({ mangas: [...mangas, ...extra] });
    }

    requests(): Promise<RecordedRequest[]> {
        return this.getJson('/__mock/requests');
    }

    /** Requisições recebidas que casam com o filtro (GraphQL: pelo nome da operação). */
    async find({ method, path, operation }: RequestFilter): Promise<RecordedRequest[]> {
        return (await this.requests()).filter(
            (request) =>
                (!method || request.method === method) &&
                (!path || matchesPath(request.path, path)) &&
                (!operation || request.graphql?.operationName === operation),
        );
    }

    /** Variáveis de cada chamada de uma operação GraphQL. */
    async graphqlVariables(operation: string): Promise<Record<string, any>[]> {
        return (await this.find({ operation })).map(({ graphql }) => graphql?.variables ?? {});
    }

    /** Espera (sem timeout fixo) até que o mock receba ao menos `count` requisições que casam com o filtro. */
    async waitForRequests(filter: RequestFilter, count = 1): Promise<RecordedRequest[]> {
        const description = JSON.stringify(filter);
        await expect
            .poll(async () => (await this.find(filter)).length, {
                message: `the mock server never received ${count} request(s) matching ${description}`,
            })
            .toBeGreaterThanOrEqual(count);
        return this.find(filter);
    }

    /** Garante que NENHUMA requisição que case com o filtro chegou ao mock. */
    async expectNoRequest(filter: RequestFilter): Promise<void> {
        const matching = await this.find(filter);
        expect(matching, `the UI must not send ${JSON.stringify(filter)}, but the mock server received it`).toEqual([]);
    }

    async operations(entity?: OperationEntity): Promise<Operation[]> {
        const query = entity ? `?entity=${entity}` : '';
        return (await this.getJson<{ operations: Operation[] }>(`/__mock/operations${query}`)).operations;
    }

    async waitForOperations(entity: OperationEntity, count = 1): Promise<Operation[]> {
        await expect
            .poll(async () => (await this.operations(entity)).length, {
                message: `the mock server never logged ${count} ${entity} operation(s)`,
            })
            .toBeGreaterThanOrEqual(count);
        return this.operations(entity);
    }

    state(): Promise<{
        policy: string;
        merged: Record<string, unknown[]>;
        deletions: unknown[];
        categories: { id: number; name: string }[];
        mangas: MockManga[];
        chapters: { id: number; isRead: boolean; isDownloaded: boolean }[];
        backups: { id: string }[];
    }> {
        return this.getJson('/__mock/state');
    }

    unhandled(): Promise<string[]> {
        return this.getJson('/__mock/unhandled');
    }
}

export const test = base.extend<{ mock: MockClient }>({
    // `auto`: o reset acontece em TODO teste, mesmo naqueles que não usam o cliente do mock
    mock: [
        async ({ request }, use) => {
            const mock = new MockClient(request);
            await mock.reset();

            await use(mock);

            // a UI passou a usar algo que o mock não implementa: o teste deve falhar com a lista do que falta
            expect(
                await mock.unhandled(),
                'the UI sent GraphQL operations the mock server does not implement (extend tests/e2e/mock-server/graphql.ts)',
            ).toEqual([]);
        },
        { auto: true },
    ],
});

export { expect };
