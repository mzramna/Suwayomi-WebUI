/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useKarasuAvailability } from '@/features/karasu/hooks/useKarasu.ts';

/**
 * Conteúdo do diálogo de confirmação de exclusão de capítulos baixados.
 * Quando o servidor suporta o Karasu, adiciona o checkbox para propagar a exclusão aos dispositivos conectados.
 */
export const KarasuDeleteConfirmationMessage = ({
    message,
    onChange,
}: {
    message: string;
    onChange: (deleteFromKarasuDevices: boolean) => void;
}) => {
    const { t } = useLingui();
    const { isAvailable } = useKarasuAvailability();
    const [checked, setChecked] = useState(false);

    return (
        <Stack>
            <span>{message}</span>
            {isAvailable && (
                <FormControlLabel
                    sx={{ mt: 1 }}
                    control={
                        <Checkbox
                            checked={checked}
                            onChange={(e) => {
                                setChecked(e.target.checked);
                                onChange(e.target.checked);
                            }}
                        />
                    }
                    label={t`Also delete from connected Karasu devices`}
                />
            )}
        </Stack>
    );
};
