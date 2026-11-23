/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import List from '@mui/material/List';
import { useLingui } from '@lingui/react/macro';
import { ListSubheader } from '@/base/components/lists/ListSubheader.tsx';
import { SelectSetting } from '@/base/components/settings/SelectSetting.tsx';
import { Notifications } from '@/base/notification/Notifications.ts';
import { getErrorMessage } from '@/lib/HelperFunctions.ts';
import { KarasuRequests } from '@/features/karasu/Karasu.requests.ts';
import type { KarasuDownloadPolicy } from '@/features/karasu/Karasu.types.ts';
import { useKarasuAvailability, useKarasuDownloadPolicy } from '@/features/karasu/hooks/useKarasu.ts';
import { KARASU_DOWNLOAD_POLICY_SELECT_VALUES } from '@/features/karasu/Karasu.utils.ts';

const PolicySetting = () => {
    const { t } = useLingui();
    const { data, setData } = useKarasuDownloadPolicy();

    const updatePolicy = async (downloadPolicy: KarasuDownloadPolicy) => {
        try {
            setData(await KarasuRequests.setDownloadPolicy(downloadPolicy));
        } catch (e) {
            Notifications.error(t`Failed to save changes`, getErrorMessage(e));
        }
    };

    // enquanto a política não foi carregada o select não deve ser exibido, evitando mostrar um valor errado
    if (!data) {
        return null;
    }

    return (
        <List
            subheader={
                <ListSubheader component="div" id="download-settings-karasu">
                    {t`Karasu`}
                </ListSubheader>
            }
        >
            <SelectSetting
                settingName={t`Download policy`}
                dialogDescription={t`Defines where downloaded chapters are stored.`}
                value={data.downloadPolicy}
                values={KARASU_DOWNLOAD_POLICY_SELECT_VALUES}
                handleChange={updatePolicy}
            />
        </List>
    );
};

/**
 * Seletor da política de download do Karasu ("Apenas Servidor (NFS)" vs "Servidor e Dispositivos Karasu").
 * Não é renderizado em servidores sem a API do Karasu.
 */
export const KarasuDownloadPolicySetting = () => {
    const { isAvailable } = useKarasuAvailability();

    if (!isAvailable) {
        return null;
    }

    return <PolicySetting />;
};
