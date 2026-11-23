# Testes E2E (Playwright) contra o servidor mock

Valida as telas do Karasu sem o Suwayomi-Server real. O mock (`tests/e2e/mock-server/`, só `node:http`) serve o build da
WebUI (`build/`, com fallback SPA) e implementa em memória o GraphQL `/api/graphql` e as rotas `/api/v1/karasu/*`
(contrato v1 + log de operações v2 de `karasu-sync-contract.md`).

```sh
pnpm build                 # gera build/ (o mock serve esse diretório)
pnpm exec playwright install chromium   # uma vez
pnpm test:e2e              # sobe o mock sozinho (ou reutiliza um já rodando) e roda tudo
pnpm test:e2e:mock         # só o mock (PORT, HOST e WEBUI_BUILD_DIR configuráveis; o Playwright usa a porta 4580)
```

`PW_CHROMIUM_PATH=/caminho/chrome` usa um Chromium já instalado (útil sem acesso à rede). `pnpm tsc:e2e` checa os tipos.
O mock mantém estado em memória: os testes rodam em série e o fixture `mock` (automático) faz `reset` antes de cada um.

## Endpoints de controle do mock

| Rota                     | O que faz                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `GET /__mock/requests`   | Todas as requisições recebidas em `/api/**` (imagens ficam de fora)                    |
| `POST /__mock/reset`     | Volta ao estado inicial (zera dados, log de requisições e de operações)                |
| `POST /__mock/seed`      | Substitui partes do estado (ver abaixo); chaves ausentes não mudam                     |
| `GET /__mock/operations` | Log de operações (igual a `GET /api/v1/karasu/operations`, mas sem ser registrado)     |
| `GET /__mock/state`      | Estado atual (categorias, mangás, capítulos, política, vínculos, backups sem os bytes) |
| `GET /__mock/unhandled`  | Campos GraphQL que a UI pediu e o mock não implementa (o fixture exige a lista vazia)  |

Cada requisição registrada: `{ seq, method, path (com query), body (json/texto), status, graphql?: { operationName, variables } }`.
Multipart aparece como `{ multipart: true, bytes }`. O texto da query GraphQL não é guardado.

## Formato dos dados semeados (`POST /__mock/seed`)

Espelha o servidor real: ids `Int`, `sourceId` **sempre string** (Long de 64 bits), `createdAt`/`ts` em ms, `lastReadAt`
em segundos (o GraphQL devolve como string).

```jsonc
{
  "health": { "status": "ok", "serverVersion": "v2.1.0", "apiVersion": 1,
              "database": { "type": "H2" | "POSTGRESQL" },
              "storage": { "type": "local" | "nfs", "path": "/data/downloads", "freeBytes": 1, "totalBytes": 2 } },
  // "health": null => servidor SEM as rotas karasu (todas devolvem 404, como o upstream)
  "policy": "SERVER_ONLY" | "SERVER_AND_CLIENTS",
  "backups": [{ "name": "x.tachibk", "device": "Pixel 8", "sizeBytes": 2048, "createdAt": 1700000000000 }],
  // bytes: `contentBase64`, ou determinísticos (`deterministicBytes(id, sizeBytes)` em mock-server/state.ts)
  "merged": { "1": [{ "sourceId": "6247824327199706550", "url": "/manga/x", "priority": 0, "updatesEnabled": true }] },
  "sources": [{ "id": "2499283573021220255", "name": "Mock Source A", "lang": "en", "displayName": "Mock Source A (EN)", ... }],
  "categories": [{ "id": 0, "name": "Default", "order": 0, "default": true, ... }],
  "mangas": [{ "id": 1, "sourceId": "2499283573021220255", "url": "/manga/mock-manga-one", "title": "...", "categoryIds": [1], ... }],
  "chapters": [{ "id": 1, "mangaId": 1, "url": "...", "chapterNumber": 1, "isRead": false, "isDownloaded": true, ... }],
  "faults": [{ "method": "PUT", "path": "/api/v1/karasu/policy", "status": 500, "error": "mensagem" }]
}
```

Estado inicial: fontes A e B; categorias Default(0), Action(1), Favorites(2); mangás 1 (fonte A, categoria Action) e 2
(fonte B) com 5 capítulos cada (1 a 3 baixados; só o capítulo 1 do mangá 1 lido); política `SERVER_ONLY`; H2 + storage
local; 2 backups. `seed({ mangas })` substitui a lista inteira (use `mock.addMangas()` para acrescentar).

## Log de operações (contrato v2)

Mudanças feitas pela UI viram operações com `deviceId: "web"` (ou o header `X-Karasu-Device`), `ts` do relógio do mock e
`seq` crescente, só quando o valor realmente muda: categoria criada/renomeada/apagada (`CATEGORY`), obra em categoria
(`CATEGORY_LINK`), lido/não lido (`PROGRESS`), `lastPageRead` e `PUT /history` (`HISTORY`), fontes mescladas (`MERGED`),
exclusão remota (`DELETION`), política (`POLICY`) e backups (`BACKUP`). `POST /operations` só registra (idempotente por `id`).

## Divergências assumidas

- Lido/não lido usa a mutação `updateChapters` (`ids` + `patch.isRead`), não `updateChapter`: é o que a WebUI envia.
- Apagar uma categoria registra só `CATEGORY` (REMOVE); os vínculos somem em cascata sem gerar `CATEGORY_LINK`.
- `POST /deletions` ignora ids inexistentes e `queued` conta só os conhecidos; com `deleteFromServer` o capítulo deixa de estar baixado.
- `PUT /manga/{id}/merged` guarda as fontes ordenadas por `priority`; a agregação/deduplicação de capítulos do servidor real não é simulada.
- 404 de servidor sem o fork é `{"error":"Not found"}` em JSON (o upstream real pode devolver outro corpo; a WebUI só olha o status).
