/*
 * Copyright (C) Contributors to the Suwayomi project
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useMemo, useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import DragHandleIcon from '@mui/icons-material/DragHandle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { DragEndEvent } from '@dnd-kit/core';
import { closestCenter, DndContext } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useLingui } from '@lingui/react/macro';
import { requestManager } from '@/lib/requests/RequestManager.ts';
import { DndKitUtil } from '@/lib/dnd-kit/DndKitUtil.ts';
import { DndSortableItem } from '@/lib/dnd-kit/DndSortableItem.tsx';
import { CustomTooltip } from '@/base/components/CustomTooltip.tsx';
import { Select } from '@/base/components/inputs/Select.tsx';
import { Notifications } from '@/base/notification/Notifications.ts';
import { FetchSourceMangaType } from '@/lib/graphql/generated/graphql-base.types.ts';
import { getErrorMessage } from '@/lib/HelperFunctions.ts';
import { Sources } from '@/features/source/services/Sources.ts';
import { KarasuRequests } from '@/features/karasu/Karasu.requests.ts';
import type { KarasuMergedSource } from '@/features/karasu/Karasu.types.ts';
import type { KarasuSearchSourceMangasMutation } from '@/features/karasu/Karasu.graphql.ts';
import { KARASU_SEARCH_SOURCE_MANGAS } from '@/features/karasu/Karasu.graphql.ts';
import { useKarasuAvailability, useKarasuMangaMerged } from '@/features/karasu/hooks/useKarasu.ts';
import type { MangaIdInfo, MangaTitleInfo } from '@/features/manga/Manga.types.ts';

type SourceOption = { id: string; displayName: string };
type SearchResult = KarasuSearchSourceMangasMutation['fetchSourceManga']['mangas'][number];

const getMergedSourceKey = ({ sourceId, url }: Pick<KarasuMergedSource, 'sourceId' | 'url'>) => `${sourceId}|${url}`;

const AddMergedSourceDialog = ({
    open,
    initialQuery,
    sources,
    existingKeys,
    onClose,
    onAdd,
}: {
    open: boolean;
    initialQuery: string;
    sources: SourceOption[];
    existingKeys: Set<string>;
    onClose: () => void;
    onAdd: (source: Pick<KarasuMergedSource, 'sourceId' | 'url'>) => void;
}) => {
    const { t } = useLingui();

    const [sourceId, setSourceId] = useState('');
    const [query, setQuery] = useState(initialQuery);
    const [url, setUrl] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const [results, setResults] = useState<SearchResult[] | null>(null);

    const trimmedUrl = url.trim();
    const isDuplicate = !!sourceId && existingKeys.has(getMergedSourceKey({ sourceId, url: trimmedUrl }));

    const search = async () => {
        setIsSearching(true);
        setResults(null);

        try {
            const response = await requestManager.graphQLClient.client.mutate<KarasuSearchSourceMangasMutation>({
                mutation: KARASU_SEARCH_SOURCE_MANGAS,
                variables: { input: { source: sourceId, query, page: 1, type: FetchSourceMangaType.Search } },
            });

            setResults(response.data?.fetchSourceManga.mangas ?? []);
        } catch (e) {
            Notifications.error(t`Search failed`, getErrorMessage(e));
        } finally {
            setIsSearching(false);
        }
    };

    return (
        <Dialog open={open} onClose={onClose} fullWidth>
            <DialogTitle>{t`Add source`}</DialogTitle>
            <DialogContent>
                <Stack sx={{ gap: 2, pt: 1 }}>
                    <FormControl fullWidth>
                        <InputLabel id="karasu-merged-source-label">{t`Source`}</InputLabel>
                        <Select
                            labelId="karasu-merged-source-label"
                            label={t`Source`}
                            value={sourceId}
                            onChange={(e) => {
                                setSourceId(e.target.value as string);
                                setResults(null);
                            }}
                        >
                            {sources.map((source) => (
                                <MenuItem key={source.id} value={source.id}>
                                    {source.displayName}
                                </MenuItem>
                            ))}
                        </Select>
                    </FormControl>
                    <Stack sx={{ flexDirection: 'row', gap: 1 }}>
                        <TextField
                            fullWidth
                            label={t`Search title`}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && sourceId && !isSearching) {
                                    search();
                                }
                            }}
                        />
                        <Button
                            variant="outlined"
                            disabled={!sourceId || isSearching}
                            onClick={search}
                            sx={{ flexShrink: 0 }}
                        >
                            {isSearching ? <CircularProgress size={20} /> : t`Search`}
                        </Button>
                    </Stack>
                    {results && (
                        <List dense sx={{ maxHeight: 220, overflowY: 'auto', border: 1, borderColor: 'divider' }}>
                            {!results.length && <ListItemText sx={{ px: 2 }} primary={t`No results`} />}
                            {results.map((result) => (
                                <ListItemButton
                                    key={result.id}
                                    selected={result.url === trimmedUrl}
                                    onClick={() => setUrl(result.url)}
                                >
                                    <ListItemText
                                        primary={result.title}
                                        secondary={result.url}
                                        slotProps={{ secondary: { sx: { wordBreak: 'break-all' } } }}
                                    />
                                </ListItemButton>
                            ))}
                        </List>
                    )}
                    <TextField
                        fullWidth
                        label={t`Entry URL in the source`}
                        helperText={
                            isDuplicate
                                ? t`This source is already linked`
                                : t`Select a search result or paste the entry URL as stored by the source (e.g. /manga/some-title)`
                        }
                        error={isDuplicate}
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                    />
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>{t`Cancel`}</Button>
                <Button
                    disabled={!sourceId || !trimmedUrl || isDuplicate}
                    onClick={() => onAdd({ sourceId, url: trimmedUrl })}
                >
                    {t`Add`}
                </Button>
            </DialogActions>
        </Dialog>
    );
};

const MergedSourceRow = ({
    source,
    name,
    onToggleReserve,
    onRemove,
    disabled,
}: {
    source: KarasuMergedSource;
    name: string;
    onToggleReserve: (reserve: boolean) => void;
    onRemove: () => void;
    disabled: boolean;
}) => {
    const { t } = useLingui();

    return (
        <Stack
            sx={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 1,
                py: 0.5,
                backgroundColor: 'background.paper',
            }}
        >
            <DragHandleIcon sx={{ cursor: 'grab', flexShrink: 0 }} color="action" />
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack sx={{ flexDirection: 'row', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant="body1">{name}</Typography>
                    {!source.updatesEnabled && <Chip size="small" label={t`Backup`} />}
                </Stack>
                <Typography variant="caption" color="textSecondary" sx={{ wordBreak: 'break-all' }}>
                    {source.url}
                </Typography>
            </Box>
            <CustomTooltip title={t`Backup mode: only used as a fallback, does not provide chapter updates`}>
                <FormControlLabel
                    sx={{ mr: 0, flexShrink: 0 }}
                    disabled={disabled}
                    control={
                        <Switch
                            size="small"
                            checked={!source.updatesEnabled}
                            onChange={(e) => onToggleReserve(e.target.checked)}
                        />
                    }
                    label={t`Backup`}
                />
            </CustomTooltip>
            <CustomTooltip title={t`Remove`}>
                <span>
                    <IconButton disabled={disabled} onClick={onRemove}>
                        <DeleteIcon />
                    </IconButton>
                </span>
            </CustomTooltip>
        </Stack>
    );
};

const MergedSourcesContent = ({ manga }: { manga: MangaIdInfo & MangaTitleInfo }) => {
    const { t } = useLingui();
    const dndSensors = DndKitUtil.useSensorsForDevice();

    const { data: group, loading, error, setData } = useKarasuMangaMerged(manga.id);
    const { data: sourcesData } = requestManager.useGetSourceList();

    const [isSaving, setIsSaving] = useState(false);
    const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

    const installedSources = useMemo<SourceOption[]>(
        () =>
            (sourcesData?.sources.nodes ?? [])
                .filter((source) => !Sources.isLocalSource(source))
                .map(({ id, displayName }) => ({ id, displayName })),
        [sourcesData],
    );
    const sourceIdToName = useMemo(
        () => new Map((sourcesData?.sources.nodes ?? []).map((source) => [source.id, source.displayName])),
        [sourcesData],
    );
    const getSourceName = (sourceId: string) => sourceIdToName.get(sourceId) ?? t`Unknown source (${sourceId})`;

    const mergedSources = useMemo(
        () => [...(group?.sources ?? [])].sort((a, b) => a.priority - b.priority),
        [group?.sources],
    );
    const existingKeys = useMemo(
        () =>
            new Set([...mergedSources.map(getMergedSourceKey), ...(group ? [getMergedSourceKey(group.primary)] : [])]),
        [mergedSources, group],
    );

    const save = async (sources: KarasuMergedSource[]) => {
        setIsSaving(true);

        try {
            setData(await KarasuRequests.setMangaMerged(manga.id, sources));
        } catch (e) {
            Notifications.error(t`Failed to save changes`, getErrorMessage(e));
        } finally {
            setIsSaving(false);
        }
    };

    const onDragEnd = ({ active, over }: DragEndEvent) => {
        if (!over || active.id === over.id) {
            return;
        }

        const oldIndex = mergedSources.findIndex((source) => getMergedSourceKey(source) === active.id);
        const newIndex = mergedSources.findIndex((source) => getMergedSourceKey(source) === over.id);
        if (oldIndex < 0 || newIndex < 0) {
            return;
        }

        save(arrayMove(mergedSources, oldIndex, newIndex));
    };

    if (loading && !group) {
        return <CircularProgress size={24} />;
    }

    if (error) {
        return (
            <Typography variant="body2" color="textSecondary" sx={{ wordBreak: 'break-word' }}>
                {t`Could not load the merged sources`}: {getErrorMessage(error)}
            </Typography>
        );
    }

    return (
        <Stack sx={{ gap: 1 }}>
            <Typography variant="body2" color="textSecondary">
                {t`Chapters from all linked sources are combined. When the same chapter exists in several sources, the one from the source with the highest priority (top of the list) is used. Drag to change the priority.`}
            </Typography>
            <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={mergedSources.map(getMergedSourceKey)} strategy={verticalListSortingStrategy}>
                    {mergedSources.map((source) => (
                        <DndSortableItem key={getMergedSourceKey(source)} id={getMergedSourceKey(source)}>
                            <MergedSourceRow
                                source={source}
                                name={getSourceName(source.sourceId)}
                                disabled={isSaving}
                                onToggleReserve={(reserve) =>
                                    save(
                                        mergedSources.map((item) =>
                                            item === source ? { ...item, updatesEnabled: !reserve } : item,
                                        ),
                                    )
                                }
                                onRemove={() => save(mergedSources.filter((item) => item !== source))}
                            />
                        </DndSortableItem>
                    ))}
                </SortableContext>
            </DndContext>
            {!mergedSources.length && (
                <Typography variant="body2">{t`No additional sources linked to this entry`}</Typography>
            )}
            <Box>
                <Button startIcon={<AddIcon />} disabled={isSaving} onClick={() => setIsAddDialogOpen(true)}>
                    {t`Add source`}
                </Button>
            </Box>
            {isAddDialogOpen && (
                <AddMergedSourceDialog
                    open
                    initialQuery={manga.title}
                    sources={installedSources}
                    existingKeys={existingKeys}
                    onClose={() => setIsAddDialogOpen(false)}
                    onAdd={(source) => {
                        setIsAddDialogOpen(false);
                        save([...mergedSources, { ...source, priority: mergedSources.length, updatesEnabled: true }]);
                    }}
                />
            )}
        </Stack>
    );
};

/**
 * Seção "Fontes mescladas" da página de detalhes do mangá.
 * Não é renderizada em servidores sem a API do Karasu.
 */
export const KarasuMergedSources = ({ manga }: { manga: MangaIdInfo & MangaTitleInfo }) => {
    const { t } = useLingui();
    const { isAvailable } = useKarasuAvailability();

    if (!isAvailable) {
        return null;
    }

    return (
        <Accordion disableGutters variant="outlined">
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle1">{t`Merged sources`}</Typography>
            </AccordionSummary>
            <AccordionDetails>
                <MergedSourcesContent key={manga.id} manga={manga} />
            </AccordionDetails>
        </Accordion>
    );
};
