/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import { useLingui } from '@lingui/react/macro';
import type { KarasuHealth } from '@/features/karasu/Karasu.types.ts';
import { useKarasuAvailability } from '@/features/karasu/hooks/useKarasu.ts';
import {
    formatBytes,
    KARASU_DATABASE_TYPE_TO_TRANSLATION,
    KARASU_STORAGE_TYPE_TO_TRANSLATION,
} from '@/features/karasu/Karasu.utils.ts';
import { getErrorMessage } from '@/lib/HelperFunctions.ts';

const InfoRow = ({ label, value }: { label: string; value: string }) => (
    <Stack sx={{ flexDirection: 'row', justifyContent: 'space-between', gap: 2 }}>
        <Typography variant="body2" color="textSecondary">
            {label}
        </Typography>
        <Typography variant="body2" sx={{ textAlign: 'right', wordBreak: 'break-word' }}>
            {value}
        </Typography>
    </Stack>
);

const StorageCardContent = ({ health }: { health: KarasuHealth }) => {
    const { t } = useLingui();

    const databaseType = health.database?.type;
    const { storage } = health;

    const databaseLabel = (() => {
        if (!databaseType) {
            return null;
        }

        const translation = KARASU_DATABASE_TYPE_TO_TRANSLATION[databaseType];
        return translation ? t(translation) : databaseType;
    })();
    const storageTypeLabel = (() => {
        if (!storage?.type) {
            return null;
        }

        const translation = KARASU_STORAGE_TYPE_TO_TRANSLATION[storage.type];
        return translation ? t(translation) : storage.type;
    })();

    const { freeBytes, totalBytes } = storage ?? {};
    const hasSpaceInfo = freeBytes != null && totalBytes != null && totalBytes > 0;
    const usedPercentage = hasSpaceInfo ? Math.min(100, Math.max(0, ((totalBytes - freeBytes) / totalBytes) * 100)) : 0;

    return (
        <Stack sx={{ gap: 1 }}>
            {databaseLabel && <InfoRow label={t`Database`} value={databaseLabel} />}
            {storageTypeLabel && <InfoRow label={t`Storage`} value={storageTypeLabel} />}
            {!!storage?.path && <InfoRow label={t`Path`} value={storage.path} />}
            {hasSpaceInfo && (
                <>
                    <LinearProgress variant="determinate" value={usedPercentage} sx={{ mt: 1 }} />
                    <InfoRow
                        label={t`Free space`}
                        value={t`${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)}`}
                    />
                </>
            )}
            {!!health.serverVersion && <InfoRow label={t`Server version`} value={health.serverVersion} />}
        </Stack>
    );
};

/**
 * Card com o banco de dados ativo e o armazenamento (local/NFS) do servidor.
 * Em servidores sem a API do Karasu (rota inexistente) o card não é renderizado.
 */
export const KarasuStorageCard = () => {
    const { t } = useLingui();
    const { isAvailable, health, error, refetch } = useKarasuAvailability();

    if (error) {
        return (
            <Card sx={{ m: 2 }}>
                <CardContent>
                    <Typography variant="h6" component="h3" sx={{ mb: 1 }}>
                        {t`Server storage`}
                    </Typography>
                    <Typography variant="body2" color="textSecondary" sx={{ mb: 1, wordBreak: 'break-word' }}>
                        {t`Could not load the storage information`}: {getErrorMessage(error)}
                    </Typography>
                    <Button size="small" onClick={() => refetch()}>
                        {t`Retry`}
                    </Button>
                </CardContent>
            </Card>
        );
    }

    if (!isAvailable || !health) {
        return null;
    }

    return (
        <Card sx={{ m: 2 }}>
            <CardContent>
                <Typography variant="h6" component="h3" sx={{ mb: 1 }}>
                    {t`Server storage`}
                </Typography>
                <StorageCardContent health={health} />
            </CardContent>
        </Card>
    );
};
