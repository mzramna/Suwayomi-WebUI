/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useState } from 'react';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import DownloadIcon from '@mui/icons-material/Download';
import DeleteIcon from '@mui/icons-material/Delete';
import { useLingui } from '@lingui/react/macro';
import { ListSubheader } from '@/base/components/lists/ListSubheader.tsx';
import { CustomTooltip } from '@/base/components/CustomTooltip.tsx';
import { LoadingPlaceholder } from '@/base/components/feedback/LoadingPlaceholder.tsx';
import { EmptyViewAbsoluteCentered } from '@/base/components/feedback/EmptyViewAbsoluteCentered.tsx';
import { Confirmation } from '@/base/AppAwaitableComponent.ts';
import { Notifications } from '@/base/notification/Notifications.ts';
import { getDateString } from '@/base/utils/DateHelper.ts';
import { getErrorMessage } from '@/lib/HelperFunctions.ts';
import { AuthManager } from '@/features/authentication/AuthManager.ts';
import { KarasuRequests } from '@/features/karasu/Karasu.requests.ts';
import type { KarasuBackupInfo } from '@/features/karasu/Karasu.types.ts';
import { useKarasuBackups } from '@/features/karasu/hooks/useKarasu.ts';
import { downloadFile, formatBytes } from '@/features/karasu/Karasu.utils.ts';

const triggerBackupDownload = async (backup: KarasuBackupInfo) => {
    // com autenticação por token (Bearer) um link simples não envia as credenciais, então o arquivo é baixado via fetch
    if (AuthManager.isAuthRequired()) {
        const blob = await KarasuRequests.downloadBackupBlob(backup.id);
        const objectUrl = URL.createObjectURL(blob);

        try {
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = backup.name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        } finally {
            // o download já foi iniciado, o objeto pode ser liberado depois do clique
            setTimeout(() => URL.revokeObjectURL(objectUrl), 60 * 1000);
        }
        return;
    }

    downloadFile(KarasuRequests.getBackupDownloadUrl(backup.id));
};

/**
 * Lista os backups enviados pelos dispositivos Karasu ao servidor, permitindo baixá-los e excluí-los.
 */
export const KarasuBackupsManager = () => {
    const { t } = useLingui();
    const { data: backups, loading, error, refetch, setData } = useKarasuBackups();
    const [busyBackupId, setBusyBackupId] = useState<string | null>(null);

    const downloadBackup = async (backup: KarasuBackupInfo) => {
        setBusyBackupId(backup.id);

        try {
            await triggerBackupDownload(backup);
        } catch (e) {
            Notifications.error(t`Could not download the backup`, getErrorMessage(e));
        } finally {
            setBusyBackupId(null);
        }
    };

    const deleteBackup = async (backup: KarasuBackupInfo) => {
        try {
            await Confirmation.show({
                title: t`Are you sure?`,
                message: t`The backup "${backup.name}" will be permanently deleted from the server.`,
                actions: { confirm: { title: t`Delete` } },
            });
        } catch (_) {
            return;
        }

        setBusyBackupId(backup.id);

        try {
            await KarasuRequests.deleteBackup(backup.id);
            setData((backups ?? []).filter(({ id }) => id !== backup.id));
            Notifications.success(t`Backup deleted`);
        } catch (e) {
            Notifications.error(t`Could not delete the backup`, getErrorMessage(e));
        } finally {
            setBusyBackupId(null);
        }
    };

    if (loading && !backups) {
        return <LoadingPlaceholder />;
    }

    if (error) {
        return (
            <EmptyViewAbsoluteCentered
                message={t`Unable to load data`}
                messageExtra={getErrorMessage(error)}
                retry={() => {
                    refetch();
                }}
            />
        );
    }

    return (
        <List
            subheader={
                <ListSubheader component="div" id="karasu-backups">
                    {t`Karasu backups`}
                </ListSubheader>
            }
        >
            {!backups?.length && (
                <ListItem>
                    <ListItemText primary={t`No backups uploaded by Karasu devices yet`} />
                </ListItem>
            )}
            {backups?.map((backup) => {
                const details = [
                    backup.device ?? t`Unknown device`,
                    formatBytes(backup.sizeBytes),
                    getDateString(backup.createdAt, true, true),
                ].join(' • ');

                return (
                    <ListItem
                        key={backup.id}
                        secondaryAction={
                            <Stack sx={{ flexDirection: 'row', gap: 0.5 }}>
                                <CustomTooltip title={t`Download`}>
                                    <IconButton
                                        disabled={busyBackupId === backup.id}
                                        onClick={() => downloadBackup(backup)}
                                    >
                                        <DownloadIcon />
                                    </IconButton>
                                </CustomTooltip>
                                <CustomTooltip title={t`Delete`}>
                                    <IconButton
                                        disabled={busyBackupId === backup.id}
                                        onClick={() => deleteBackup(backup)}
                                    >
                                        <DeleteIcon />
                                    </IconButton>
                                </CustomTooltip>
                            </Stack>
                        }
                    >
                        <ListItemText
                            primary={backup.name}
                            secondary={details}
                            slotProps={{ primary: { sx: { wordBreak: 'break-word', pr: 10 } } }}
                        />
                    </ListItem>
                );
            })}
        </List>
    );
};
