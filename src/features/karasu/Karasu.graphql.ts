/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import gql from 'graphql-tag';

/**
 * Busca em uma fonte devolvendo também a `url` (relativa à fonte) de cada obra, necessária para vincular fontes mescladas.
 *
 * Fica fora de `src/lib/graphql` de propósito: o codegen só considera aquele diretório e este documento
 * não deve alterar o schema/tipos gerados. Os tipos abaixo são escritos à mão.
 */
export const KARASU_SEARCH_SOURCE_MANGAS = gql`
    mutation KARASU_SEARCH_SOURCE_MANGAS($input: FetchSourceMangaInput!) {
        fetchSourceManga(input: $input) {
            hasNextPage
            mangas {
                id
                title
                url
            }
        }
    }
`;

export type KarasuSearchSourceMangasMutation = {
    fetchSourceManga: {
        hasNextPage: boolean;
        mangas: { id: number; title: string; url: string }[];
    };
};
