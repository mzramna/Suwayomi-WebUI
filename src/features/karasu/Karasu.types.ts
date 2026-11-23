/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Tipos da API REST `/api/v1/karasu/*` (contrato v1 com o Suwayomi-Server fork).
 * Todos os `sourceId` são strings (Long de 64 bits não cabe em number no JS).
 */

export type KarasuDatabaseType = 'H2' | 'POSTGRESQL';
export type KarasuStorageType = 'local' | 'nfs';

export type KarasuHealth = {
    status: string;
    serverVersion?: string;
    apiVersion?: number;
    database?: { type: KarasuDatabaseType | string };
    storage?: {
        type: KarasuStorageType | string;
        path?: string;
        freeBytes?: number | null;
        totalBytes?: number | null;
    };
};

export type KarasuBackupInfo = {
    /** nome do arquivo no servidor, usado nas rotas /backups/{id} */
    id: string;
    name: string;
    sizeBytes: number;
    /** epoch em milissegundos */
    createdAt: number;
    device: string | null;
};

export type KarasuMergedSource = {
    sourceId: string;
    url: string;
    /** 0 = prioridade mais alta */
    priority: number;
    /** false = fonte reserva (usada apenas como fallback, não atualiza capítulos) */
    updatesEnabled: boolean;
};

export type KarasuPrimarySource = {
    sourceId: string;
    url: string;
};

export type KarasuMergedGroup = {
    mangaId: number;
    primary: KarasuPrimarySource;
    sources: KarasuMergedSource[];
};

export enum KarasuDownloadPolicy {
    SERVER_ONLY = 'SERVER_ONLY',
    SERVER_AND_CLIENTS = 'SERVER_AND_CLIENTS',
}

export type KarasuDownloadPolicyResponse = {
    downloadPolicy: KarasuDownloadPolicy;
};

export type KarasuDeletionRequest = {
    chapterIds: number[];
    deleteFromServer: boolean;
};

export type KarasuDeletionResponse = {
    queued: number;
};
