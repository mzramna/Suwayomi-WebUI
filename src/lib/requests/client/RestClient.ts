/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { BaseClient } from '@/lib/requests/client/BaseClient.ts';
import { AuthManager } from '@/features/authentication/AuthManager.ts';
import type { AbortableApolloMutationResponse } from '@/lib/requests/RequestManager.ts';
import type { RefreshAccessTokenMutation } from '@/lib/graphql/generated/graphql.ts';

export enum HttpMethod {
    GET = 'GET',
    POST = 'POST',
    PUT = 'PUT',
    PATCH = 'PATCH',
    DELETE = 'DELETE',
}

export type RestFetcherOptions = {
    data?: any;
    httpMethod?: HttpMethod;
    config?: RequestInit;
    checkResponseIsJson?: boolean;
};

export class RestRequestError extends Error {
    constructor(
        public readonly status: number,
        statusText: string,
        // o corpo ainda não foi consumido, permitindo ler a mensagem de erro retornada pelo servidor
        public readonly response?: Response,
    ) {
        super(`status ${status}: ${statusText}`);
        this.name = 'RestRequestError';
    }
}

export interface IRestClient {
    fetcher(url: string, options?: RestFetcherOptions): Promise<Response>;
    get(url: string): Promise<Response>;
    delete(url: string): Promise<Response>;
    post(url: string, data?: any): Promise<Response>;
    put(url: string, data?: any): Promise<Response>;
    patch(url: string, data?: any): Promise<Response>;
}

export class RestClient
    extends BaseClient<typeof fetch, RequestInit, (url: string, data: any) => Promise<Response>>
    implements IRestClient
{
    protected client!: typeof fetch;

    private config: RequestInit = {
        credentials: 'same-origin',
    };

    public readonly fetcher = async (
        url: string,
        { data, httpMethod = HttpMethod.GET, config, checkResponseIsJson = true }: RestFetcherOptions = {},
    ): Promise<Response> =>
        this.enqueueRequest(async () => {
            if (AuthManager.shouldRefreshAccessToken()) {
                await BaseClient.refreshAccessToken(this.handleRefreshToken);
            }

            const isBlobOrData = url.startsWith('blob:') || url.startsWith('data:');
            const addBaseUrl = !isBlobOrData && !url.startsWith('http');

            const updatedUrl = addBaseUrl ? `${this.getBaseUrl()}${url}` : url;
            const isAuthRequired = AuthManager.isAuthRequired();
            const accessToken = AuthManager.getAccessToken();

            await this.awaitRateLimit(updatedUrl);

            let result: Response;

            switch (httpMethod) {
                case HttpMethod.GET:
                    result = await this.client(updatedUrl, {
                        ...this.config,
                        ...config,
                        method: httpMethod,
                        headers: {
                            ...(isAuthRequired && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                            ...this.config.headers,
                            ...config?.headers,
                        },
                    });
                    break;
                case HttpMethod.POST:
                case HttpMethod.PUT:
                case HttpMethod.PATCH:
                case HttpMethod.DELETE:
                    result = await this.client(updatedUrl, {
                        ...this.config,
                        ...config,
                        method: httpMethod,
                        headers: {
                            ...(isAuthRequired && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
                            ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
                            ...this.config.headers,
                            ...config?.headers,
                        },
                        body: data !== undefined ? JSON.stringify(data) : undefined,
                    });
                    break;
                default:
                    throw new Error(`Unexpected HttpMethod "${httpMethod}"`);
            }

            if (result.status === 401) {
                await BaseClient.refreshAccessToken(this.handleRefreshToken);
                return this.fetcher(url, { data, httpMethod, config, checkResponseIsJson });
            }

            if (result.status === 429) {
                this.addRateLimit(updatedUrl, result.headers.get('Retry-After'));
                return this.fetcher(url, { data, httpMethod, config, checkResponseIsJson });
            }

            if (!result.ok) {
                throw new RestRequestError(result.status, result.statusText, result);
            }

            if (checkResponseIsJson && result.headers.get('content-type') !== 'application/json') {
                throw new Error('Response is not json');
            }

            return result;
        });

    constructor(
        handleRefreshToken: (refreshToken: string) => AbortableApolloMutationResponse<RefreshAccessTokenMutation>,
    ) {
        super(handleRefreshToken);

        this.createClient();
    }

    private createClient(): void {
        this.client = fetch.bind(window);
    }

    public updateConfig(config: RequestInit): void {
        this.config = { ...this.config, ...config };
    }

    public getClient(): typeof fetch {
        return this.client;
    }

    get get() {
        return (url: string) => this.fetcher(url);
    }

    get post() {
        return (url: string, data?: any) => this.fetcher(url, { data, httpMethod: HttpMethod.POST });
    }

    get put() {
        return (url: string, data?: any) => this.fetcher(url, { data, httpMethod: HttpMethod.PUT });
    }

    get patch() {
        return (url: string, data?: any) => this.fetcher(url, { data, httpMethod: HttpMethod.PATCH });
    }

    get delete() {
        return (url: string) => this.fetcher(url, { httpMethod: HttpMethod.DELETE });
    }
}
