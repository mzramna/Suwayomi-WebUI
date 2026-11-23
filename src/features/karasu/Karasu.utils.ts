/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { KarasuDownloadPolicy } from '@/features/karasu/Karasu.types.ts';
import type { SelectSettingValue } from '@/base/components/settings/SelectSetting.tsx';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Formata uma quantidade de bytes de forma legível (base 1024), ex.: 1536 => "1.5 KB".
 */
export const formatBytes = (bytes: number | null | undefined): string => {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
        return '-';
    }

    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    const fractionDigits = unitIndex === 0 || value >= 100 ? 0 : 1;

    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: fractionDigits }).format(value)} ${BYTE_UNITS[unitIndex]}`;
};

export const KARASU_DATABASE_TYPE_TO_TRANSLATION: Record<string, MessageDescriptor> = {
    H2: msg`Local (H2)`,
    POSTGRESQL: msg`PostgreSQL`,
};

export const KARASU_STORAGE_TYPE_TO_TRANSLATION: Record<string, MessageDescriptor> = {
    local: msg`Local`,
    nfs: msg`NFS`,
};

export const KARASU_DOWNLOAD_POLICY_SELECT_VALUES: SelectSettingValue<KarasuDownloadPolicy>[] = [
    [
        KarasuDownloadPolicy.SERVER_ONLY,
        {
            text: msg`Server only (NFS)`,
            description: msg`Chapters are only downloaded to the server (e.g. a shared NFS volume). Karasu devices read them from the server.`,
        },
    ],
    [
        KarasuDownloadPolicy.SERVER_AND_CLIENTS,
        {
            text: msg`Server and Karasu devices`,
            description: msg`Chapters are downloaded to the server and also to the connected Karasu devices.`,
        },
    ],
];

export const downloadFile = (url: string) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
};
