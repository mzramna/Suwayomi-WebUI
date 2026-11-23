# Karasu integration

This fork of Suwayomi-WebUI adds a few features used together with the **Karasu** Android app. They all talk to the
REST API `{server}/api/v1/karasu/*` that is provided by the **Suwayomi-Server fork** (`mzramna`). The WebUI sends the
requests with the same base URL / subpath and the same credentials it already uses for the rest of the server
(see `RequestManager.getValidUrlFor` and `RestClient`).

> **Requires the Suwayomi-Server fork.** Against the upstream Suwayomi-Server the routes do not exist (HTTP 404). The
> WebUI detects this through `GET /api/v1/karasu/health` and silently hides every Karasu feature, so it keeps working
> normally with upstream servers. The API contract (v1) is defined together with the server and is the source of truth
> for the endpoints below.

## Features

| Feature                  | Where in the WebUI                                                                                                | Endpoints                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Merged sources           | Manga details page, section "Merged sources"                                                                      | `GET/PUT /manga/{mangaId}/merged`                                    |
| Download policy          | Settings > Downloads > "Karasu"                                                                                   | `GET/PUT /policy`                                                    |
| Delete on Karasu devices | "Also delete from connected Karasu devices" checkbox in the confirmation dialog when deleting downloaded chapters | `POST /deletions`                                                    |
| Karasu backups manager   | Settings > Karasu                                                                                                 | `GET /backups`, `GET /backups/{id}/download`, `DELETE /backups/{id}` |
| Storage card             | Settings > Karasu                                                                                                 | `GET /health`                                                        |

### Merged sources

A manga can have extra sources linked to it. Chapters from all sources are aggregated by the server and de-duplicated by
chapter number, respecting the priority. In the manga details page you can:

- add a secondary source (pick an installed source, search for the entry or paste its URL in that source);
- reorder the priority by drag and drop (the top of the list has the highest priority, `priority = 0`);
- toggle "Backup" mode (`updatesEnabled = false`): the source is only used as a fallback.

The primary source (the one the manga was added from) is not part of the list. Every change replaces the whole list
(`PUT /manga/{mangaId}/merged`) and the priorities are recalculated from the order shown.

### Download policy and remote deletion

- **Server only (NFS)** (`SERVER_ONLY`): chapters are only downloaded to the server.
- **Server and Karasu devices** (`SERVER_AND_CLIENTS`): chapters are also downloaded to the connected Karasu devices.

When deleting downloaded chapters, the checkbox "Also delete from connected Karasu devices" (only shown when the server
supports Karasu) sends `POST /deletions` with the chapter ids and `deleteFromServer: true` after the normal deletion.
The server stores a tombstone per chapter, which the Karasu devices read to delete the files locally.

### Backups manager

Lists the backups uploaded by the Karasu devices (name, device, size and date), allows downloading them to the computer
and deleting them (with confirmation).

### Storage card

Shows the active database (`H2` is displayed as "Local (H2)", `POSTGRESQL` as "PostgreSQL") and the storage type
(local or NFS) with the free/total space of the downloads directory.

## Code layout

- `src/features/karasu/Karasu.requests.ts`: typed API layer (`KarasuRequests`, `KarasuApiError`).
- `src/features/karasu/Karasu.types.ts`: contract types (`sourceId` is always a string).
- `src/features/karasu/hooks/useKarasu.ts`: data hooks and `useKarasuAvailability` (feature detection via `/health`).
- `src/features/karasu/components`, `src/features/karasu/screens`: UI.

## CI: upstream sync and build

`.github/workflows/upstream_sync_and_build.yml` runs weekly (and on manual dispatch). It:

1. merges `Suwayomi/Suwayomi-WebUI` `master` into the fork's `master` (no force push; it fails explicitly on merge
   conflicts or when the merge changes `.github/workflows`, which `GITHUB_TOKEN` cannot push);
2. runs `pnpm install --frozen-lockfile` and `pnpm build`;
3. zips the content of `build/` as `webui.zip` and attaches it to a release of the fork tagged `r<commit count>`.

The workflow only runs once it exists on the default branch (`master`) of the fork.
