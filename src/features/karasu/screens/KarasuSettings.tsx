/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useLingui } from '@lingui/react/macro';
import { LoadingPlaceholder } from '@/base/components/feedback/LoadingPlaceholder.tsx';
import { EmptyViewAbsoluteCentered } from '@/base/components/feedback/EmptyViewAbsoluteCentered.tsx';
import { useAppTitle } from '@/features/navigation-bar/hooks/useAppTitle.ts';
import { KarasuStorageCard } from '@/features/karasu/components/KarasuStorageCard.tsx';
import { KarasuBackupsManager } from '@/features/karasu/components/KarasuBackupsManager.tsx';
import { useKarasuAvailability } from '@/features/karasu/hooks/useKarasu.ts';
import { getErrorMessage } from '@/lib/HelperFunctions.ts';

/**
 * Configurações do Karasu: armazenamento do servidor e gerenciador de backups enviados pelos dispositivos.
 */
export const KarasuSettings = () => {
    const { t } = useLingui();

    useAppTitle(t`Karasu`);

    const { isAvailable, error, refetch } = useKarasuAvailability();

    if (isAvailable === undefined) {
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

    if (!isAvailable) {
        return (
            <EmptyViewAbsoluteCentered
                message={t`Karasu integration is not available`}
                messageExtra={t`This server does not provide the Karasu API. It requires the Suwayomi-Server fork.`}
                noFaces
            />
        );
    }

    return (
        <>
            <KarasuStorageCard />
            <KarasuBackupsManager />
        </>
    );
};
