/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { KarasuApiError, KarasuRequests } from '@/features/karasu/Karasu.requests.ts';
import type {
    KarasuBackupInfo,
    KarasuDownloadPolicyResponse,
    KarasuHealth,
    KarasuMergedGroup,
} from '@/features/karasu/Karasu.types.ts';

type KarasuResource<Data> = {
    data: Data | undefined;
    error: unknown;
    loading: boolean;
    refetch: () => Promise<void>;
    /** atualiza os dados localmente (ex.: com a resposta de um PUT) sem refazer a requisição */
    setData: (data: Data) => void;
};

/**
 * Hook mínimo de dados para as rotas REST do Karasu (a WebUI não usa SWR/React Query).
 * Refaz a requisição quando `deps` mudam e ignora respostas de requisições obsoletas.
 */
const useKarasuResource = <Data>(
    fetcher: (signal: AbortSignal) => Promise<Data>,
    deps: unknown[],
    enabled: boolean = true,
): KarasuResource<Data> => {
    const [data, setData] = useState<Data>();
    const [error, setError] = useState<unknown>();
    const [loading, setLoading] = useState(enabled);
    const requestIdRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const fetcherRef = useRef(fetcher);
    fetcherRef.current = fetcher;

    const load = useCallback(async () => {
        abortRef.current?.abort();
        const abortController = new AbortController();
        abortRef.current = abortController;
        requestIdRef.current += 1;
        const requestId = requestIdRef.current;

        setLoading(true);
        setError(undefined);

        try {
            const result = await fetcherRef.current(abortController.signal);
            if (requestId === requestIdRef.current) {
                setData(result);
            }
        } catch (e) {
            if (requestId === requestIdRef.current && !abortController.signal.aborted) {
                setError(e);
            }
        } finally {
            if (requestId === requestIdRef.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        if (!enabled) {
            setLoading(false);
            return () => {};
        }

        load();

        return () => abortRef.current?.abort();
    }, [enabled, load, ...deps]);

    return { data, error, loading, refetch: load, setData };
};

// ---- disponibilidade (detecção de servidor fork) ----

type HealthCacheEntry = { promise: Promise<KarasuHealth>; fetchedAt: number };
const HEALTH_CACHE_TTL_MS = 60 * 1000;
let healthCache: HealthCacheEntry | null = null;

/**
 * Compartilha uma única requisição de `/health` entre todos os componentes (a página de mangá, as configurações etc.).
 * Falhas não ficam em cache, exceto "rota inexistente" (servidor upstream), que não muda durante a sessão.
 */
const getCachedHealth = (force: boolean = false): Promise<KarasuHealth> => {
    const isFresh = healthCache && Date.now() - healthCache.fetchedAt < HEALTH_CACHE_TTL_MS;
    if (!force && healthCache && isFresh) {
        return healthCache.promise;
    }

    const promise = KarasuRequests.getHealth();
    healthCache = { promise, fetchedAt: Date.now() };

    promise.catch((e) => {
        const isUnsupported = e instanceof KarasuApiError && e.isUnsupported;
        if (!isUnsupported && healthCache?.promise === promise) {
            healthCache = null;
        }
    });

    return promise;
};

export type KarasuAvailability = {
    /** `undefined` enquanto a verificação ainda está em andamento */
    isAvailable: boolean | undefined;
    health: KarasuHealth | undefined;
    /** erro que não significa "servidor não-fork" (ex.: falha de rede, 500); `/health` ausente nunca vira erro */
    error: unknown;
    refetch: () => Promise<void>;
};

/**
 * Indica se o servidor atual expõe a API do Karasu (fork). Em servidores upstream (404) `isAvailable` é `false`
 * e nenhum erro é reportado, permitindo que a UI esconda os recursos silenciosamente.
 */
export const useKarasuAvailability = (): KarasuAvailability => {
    const [state, setState] = useState<{
        health?: KarasuHealth;
        error?: unknown;
        isUnsupported: boolean;
        done: boolean;
    }>({ isUnsupported: false, done: false });
    const mountedRef = useRef(true);

    const load = useCallback(async (force: boolean = false) => {
        try {
            const health = await getCachedHealth(force);
            if (mountedRef.current) {
                setState({ health, isUnsupported: false, done: true });
            }
        } catch (e) {
            if (!mountedRef.current) {
                return;
            }

            const isUnsupported = e instanceof KarasuApiError && e.isUnsupported;
            setState({ error: isUnsupported ? undefined : e, isUnsupported, done: true });
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        load();

        return () => {
            mountedRef.current = false;
        };
    }, [load]);

    const isAvailable = (() => {
        if (!state.done) {
            return undefined;
        }

        return !!state.health && !state.isUnsupported;
    })();

    return {
        isAvailable,
        health: state.health,
        error: state.error,
        refetch: useCallback(() => load(true), [load]),
    };
};

// ---- recursos ----

export const useKarasuBackups = (enabled: boolean = true) =>
    useKarasuResource<KarasuBackupInfo[]>((signal) => KarasuRequests.getBackups(signal), [], enabled);

export const useKarasuMangaMerged = (mangaId: number, enabled: boolean = true) =>
    useKarasuResource<KarasuMergedGroup>(
        (signal) => KarasuRequests.getMangaMerged(mangaId, signal),
        [mangaId],
        enabled,
    );

export const useKarasuDownloadPolicy = (enabled: boolean = true) =>
    useKarasuResource<KarasuDownloadPolicyResponse>((signal) => KarasuRequests.getDownloadPolicy(signal), [], enabled);
