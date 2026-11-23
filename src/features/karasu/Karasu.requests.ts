/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { requestManager } from '@/lib/requests/RequestManager.ts';
import { HttpMethod, RestRequestError } from '@/lib/requests/client/RestClient.ts';
import type {
    KarasuBackupInfo,
    KarasuDeletionRequest,
    KarasuDeletionResponse,
    KarasuDownloadPolicyResponse,
    KarasuHealth,
    KarasuMergedGroup,
    KarasuMergedSource,
    KarasuDownloadPolicy,
} from '@/features/karasu/Karasu.types.ts';

const KARASU_ENDPOINT_PREFIX = 'karasu';

/**
 * Erro de uma chamada à API do Karasu.
 * `status` é o status HTTP (ou 0 quando a resposta não pôde ser interpretada).
 */
export class KarasuApiError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'KarasuApiError';
    }

    /**
     * Servidor sem as rotas do fork (ex.: Suwayomi-Server upstream): a WebUI deve esconder os recursos em silêncio.
     */
    get isUnsupported(): boolean {
        return this.status === 404 || this.status === 405 || this.status === 501;
    }
}

const getKarasuUrl = (path: string, query?: Record<string, string | number | undefined>): string => {
    const url = requestManager.getValidUrlFor(`${KARASU_ENDPOINT_PREFIX}${path}`);

    if (!query) {
        return url;
    }

    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined) {
            params.set(key, String(value));
        }
    });

    const queryString = params.toString();
    return queryString ? `${url}?${queryString}` : url;
};

const readErrorMessage = async (error: RestRequestError): Promise<string> => {
    try {
        const body = await error.response?.json();
        if (typeof body?.error === 'string') {
            return body.error;
        }
    } catch {
        // corpo ausente ou que não é json, usa a mensagem padrão
    }

    return error.message;
};

type KarasuRequestOptions = {
    method?: HttpMethod;
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    signal?: AbortSignal;
};

const karasuRequest = async <Result>(
    path: string,
    { method = HttpMethod.GET, body, query, signal }: KarasuRequestOptions = {},
): Promise<Result> => {
    let response: Response;

    try {
        response = await requestManager.getClient().fetcher(getKarasuUrl(path, query), {
            httpMethod: method,
            data: body,
            checkResponseIsJson: false,
            config: { signal },
        });
    } catch (e) {
        if (e instanceof RestRequestError) {
            throw new KarasuApiError(e.status, await readErrorMessage(e));
        }

        throw e;
    }

    // 204 (ex.: DELETE) não possui corpo
    if (response.status === 204) {
        return undefined as Result;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
        // um servidor que devolve html (ex.: fallback da SPA) não possui a rota
        throw new KarasuApiError(404, 'Response is not json');
    }

    return (await response.json()) as Result;
};

export class KarasuRequests {
    static getHealth(signal?: AbortSignal): Promise<KarasuHealth> {
        return karasuRequest<KarasuHealth>('/health', { signal });
    }

    // backups

    static getBackups(signal?: AbortSignal): Promise<KarasuBackupInfo[]> {
        return karasuRequest<KarasuBackupInfo[]>('/backups', { signal });
    }

    static getBackupDownloadUrl(backupId: string): string {
        return getKarasuUrl(`/backups/${encodeURIComponent(backupId)}/download`);
    }

    static async downloadBackupBlob(backupId: string): Promise<Blob> {
        try {
            const response = await requestManager.getClient().fetcher(KarasuRequests.getBackupDownloadUrl(backupId), {
                checkResponseIsJson: false,
            });

            return await response.blob();
        } catch (e) {
            if (e instanceof RestRequestError) {
                throw new KarasuApiError(e.status, await readErrorMessage(e));
            }

            throw e;
        }
    }

    static deleteBackup(backupId: string): Promise<void> {
        return karasuRequest<void>(`/backups/${encodeURIComponent(backupId)}`, { method: HttpMethod.DELETE });
    }

    // fontes mescladas

    static getMergedGroups(signal?: AbortSignal): Promise<KarasuMergedGroup[]> {
        return karasuRequest<KarasuMergedGroup[]>('/merged', { signal });
    }

    static getMangaMerged(mangaId: number, signal?: AbortSignal): Promise<KarasuMergedGroup> {
        return karasuRequest<KarasuMergedGroup>(`/manga/${mangaId}/merged`, { signal });
    }

    /**
     * Substitui TODAS as fontes extras do mangá. A prioridade é recalculada a partir da ordem do array.
     */
    static setMangaMerged(mangaId: number, sources: KarasuMergedSource[]): Promise<KarasuMergedGroup> {
        return karasuRequest<KarasuMergedGroup>(`/manga/${mangaId}/merged`, {
            method: HttpMethod.PUT,
            body: { sources: sources.map((source, index) => ({ ...source, priority: index })) },
        });
    }

    // política de download e exclusão remota

    static getDownloadPolicy(signal?: AbortSignal): Promise<KarasuDownloadPolicyResponse> {
        return karasuRequest<KarasuDownloadPolicyResponse>('/policy', { signal });
    }

    static setDownloadPolicy(downloadPolicy: KarasuDownloadPolicy): Promise<KarasuDownloadPolicyResponse> {
        return karasuRequest<KarasuDownloadPolicyResponse>('/policy', {
            method: HttpMethod.PUT,
            body: { downloadPolicy },
        });
    }

    static requestDeletions(request: KarasuDeletionRequest): Promise<KarasuDeletionResponse> {
        return karasuRequest<KarasuDeletionResponse>('/deletions', { method: HttpMethod.POST, body: request });
    }
}
