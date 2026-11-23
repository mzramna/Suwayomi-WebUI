/**
 * Servidor mock para os testes E2E da WebUI (processo único, apenas `node:http`).
 *
 * - serve o build estático da WebUI (`build/`, com fallback SPA para `index.html`);
 * - implementa em memória o subconjunto do Suwayomi-Server usado pelas telas do Karasu: GraphQL `/api/graphql` e as
 *   rotas REST `/api/v1/karasu/*` (contrato v1 + log de operações v2);
 * - registra cada requisição recebida (`GET /__mock/requests`) para os testes verificarem o que a UI enviou.
 *
 * Controle: `GET /__mock/requests`, `POST /__mock/reset`, `POST /__mock/seed`, `GET /__mock/operations`,
 * `GET /__mock/state`, `GET /__mock/unhandled`. Documentação do formato: tests/e2e/README.md.
 *
 * Variáveis de ambiente: `PORT` (padrão 4567), `HOST` (padrão 127.0.0.1), `WEBUI_BUILD_DIR` (padrão `<repo>/build`).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { executeGraphQL, type GraphQLRequestBody } from './graphql.ts';
import { handleKarasuRequest, KARASU_PREFIX, listOperations, sendJson } from './karasu.ts';
import { applySeed, requestContext, resetState, state, type RecordedRequest, type SeedBody } from './state.ts';

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
};

// PNG 32x32 cinza (válido, com largura > 0 para o cálculo de cor dominante das capas)
const createPlaceholderImage = (): Buffer => {
    const size = 32;
    const buildChunk = (type: Buffer, data: Buffer) => {
        const body = Buffer.concat([type, data]);
        const chunk = Buffer.alloc(body.length + 8);
        chunk.writeUInt32BE(data.length, 0);
        body.copy(chunk, 4);
        chunk.writeUInt32BE(crc32(body), body.length + 4);
        return chunk;
    };

    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB

    // cada linha: filtro 0 + pixels RGB
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x80)]);
    const raw = Buffer.concat(Array.from({ length: size }, () => row));

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        buildChunk(Buffer.from('IHDR'), header),
        buildChunk(Buffer.from('IDAT'), deflateSync(raw)),
        buildChunk(Buffer.from('IEND'), Buffer.alloc(0)),
    ]);
};

const PLACEHOLDER_IMAGE = createPlaceholderImage();

const IMAGE_PATH =
    /^\/api\/v1\/(manga\/\d+\/(thumbnail|chapter\/\d+\/page\/\d+)|extension\/icon\/.+|source\/.+\/icon)$/;
const MAX_BODY_LOG_LENGTH = 20_000;

const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolveBody, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolveBody(Buffer.concat(chunks)));
        req.on('error', reject);
    });

const describeBody = (contentType: string, body: Buffer): unknown => {
    if (!body.length) {
        return null;
    }
    if (contentType.includes('multipart/')) {
        return { multipart: true, bytes: body.length };
    }
    if (contentType.includes('json')) {
        try {
            return JSON.parse(body.toString('utf-8'));
        } catch {
            return body.toString('utf-8');
        }
    }
    return body.subarray(0, MAX_BODY_LOG_LENGTH).toString('utf-8');
};

const sendStatic = (req: IncomingMessage, res: ServerResponse, pathname: string, buildDir: string): void => {
    const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    const candidate = join(buildDir, safePath);
    const isFile = candidate.startsWith(buildDir) && existsSync(candidate) && statSync(candidate).isFile();

    // fallback SPA: qualquer rota sem arquivo correspondente devolve o index.html
    const filePath = isFile ? candidate : join(buildDir, 'index.html');
    if (!existsSync(filePath)) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Build not found in ${buildDir}. Run "pnpm build" first.`);
        return;
    }

    const data = readFileSync(filePath);
    res.writeHead(200, {
        'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
};

const handleControl = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const route = `${req.method} ${url.pathname}`;

    switch (route) {
        case 'GET /__mock/requests':
            return sendJson(res, 200, state.requests);
        case 'GET /__mock/operations':
            return sendJson(res, 200, listOperations(url.searchParams));
        case 'GET /__mock/unhandled':
            return sendJson(res, 200, state.unhandled);
        case 'GET /__mock/state':
            return sendJson(res, 200, {
                health: state.health,
                policy: state.policy,
                merged: state.merged,
                deletions: state.deletions,
                categories: state.categories,
                mangas: state.mangas,
                chapters: state.chapters,
                backups: state.backups.map(({ data: _data, ...backup }) => backup),
            });
        case 'POST /__mock/reset':
            await readBody(req);
            resetState();
            return sendJson(res, 200, { ok: true });
        case 'POST /__mock/seed': {
            const body = await readBody(req);
            applySeed(JSON.parse(body.toString('utf-8') || '{}') as SeedBody);
            return sendJson(res, 200, { ok: true });
        }
        default:
            return sendJson(res, 404, { error: `Unknown mock route ${route}` });
    }
};

const handleRequest = async (req: IncomingMessage, res: ServerResponse, buildDir: string): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://mock.local');
    const { pathname } = url;

    if (pathname.startsWith('/__mock/')) {
        return handleControl(req, res, url);
    }

    if (!pathname.startsWith('/api/')) {
        return sendStatic(req, res, pathname, buildDir);
    }

    if (IMAGE_PATH.test(pathname)) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PLACEHOLDER_IMAGE.length });
        res.end(PLACEHOLDER_IMAGE);
        return;
    }

    const body = await readBody(req);
    const contentType = req.headers['content-type'] ?? '';
    requestContext.deviceId = (req.headers['x-karasu-device'] as string | undefined) || 'web';

    const recorded: RecordedRequest = {
        seq: state.nextRequestSeq++,
        method: req.method ?? 'GET',
        path: `${pathname}${url.search}`,
        body: describeBody(contentType, body),
        status: 0,
    };
    state.requests.push(recorded);

    if (pathname === '/api/graphql' && req.method === 'POST') {
        const request = JSON.parse(body.toString('utf-8') || '{}') as GraphQLRequestBody;
        recorded.graphql = { operationName: request.operationName ?? null, variables: request.variables ?? {} };
        // o texto da query é grande e irrelevante para os testes; o log guarda só operação e variáveis
        recorded.body = { operationName: recorded.graphql.operationName, variables: recorded.graphql.variables };
        recorded.status = 200;
        return sendJson(res, 200, executeGraphQL(request));
    }

    if (pathname === KARASU_PREFIX || pathname.startsWith(`${KARASU_PREFIX}/`)) {
        res.on('finish', () => {
            recorded.status = res.statusCode;
        });
        return handleKarasuRequest(req, res, url, body);
    }

    recorded.status = 404;
    return sendJson(res, 404, { error: `mock server: ${req.method} ${pathname} is not implemented` });
};

// ---- WebSocket mínimo (graphql-ws): confirma a conexão e não emite eventos ----

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const encodeFrame = (opcode: number, payload: Buffer): Buffer => {
    const { length } = payload;
    const header =
        length < 126
            ? Buffer.from([0x80 | opcode, length])
            : Buffer.from([0x80 | opcode, 126, (length >> 8) & 0xff, length & 0xff]);
    return Buffer.concat([header, payload]);
};

const handleUpgrade = (req: IncomingMessage, socket: Duplex): void => {
    const key = req.headers['sec-websocket-key'];
    if (new URL(req.url ?? '/', 'http://mock.local').pathname !== '/api/graphql' || typeof key !== 'string') {
        socket.destroy();
        return;
    }

    const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
    socket.write(
        [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            // graphql-ws exige o subprotocolo negociado
            ...(req.headers['sec-websocket-protocol'] ? ['Sec-WebSocket-Protocol: graphql-transport-ws'] : []),
            '',
            '',
        ].join('\r\n'),
    );

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);

        // frames do cliente são sempre mascarados
        while (buffer.length >= 2) {
            const opcode = buffer[0] & 0x0f;
            let length = buffer[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (buffer.length < 4) {
                    return;
                }
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buffer.length < 10) {
                    return;
                }
                length = Number(buffer.readBigUInt64BE(2));
                offset = 10;
            }
            if (buffer.length < offset + 4 + length) {
                return;
            }

            const mask = buffer.subarray(offset, offset + 4);
            const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
            payload.forEach((byte, index) => (payload[index] = byte ^ mask[index % 4]));
            buffer = buffer.subarray(offset + 4 + length);

            if (opcode === 0x8) {
                socket.end(encodeFrame(0x8, Buffer.alloc(0)));
                return;
            }
            if (opcode === 0x9) {
                socket.write(encodeFrame(0xa, payload));
                continue;
            }
            if (opcode !== 0x1) {
                continue;
            }

            const message = JSON.parse(payload.toString('utf-8')) as { type: string };
            if (message.type === 'connection_init') {
                socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ type: 'connection_ack' }))));
            } else if (message.type === 'ping') {
                socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ type: 'pong' }))));
            }
        }
    });
    socket.on('error', () => socket.destroy());
};

export const startMockServer = (
    port: number,
    host: string = '127.0.0.1',
    buildDir: string = resolve(import.meta.dirname, '../../../build'),
): Promise<Server> =>
    new Promise((resolveStart) => {
        const server = createServer((req, res) => {
            handleRequest(req, res, buildDir).catch((e: unknown) => {
                console.error('[mock] unexpected error', e);
                if (!res.headersSent) {
                    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
                } else {
                    res.end();
                }
            });
        });
        server.on('upgrade', handleUpgrade);
        server.listen(port, host, () => resolveStart(server));
    });

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    const port = Number(process.env.PORT ?? 4567);
    const host = process.env.HOST ?? '127.0.0.1';
    const buildDir = resolve(process.env.WEBUI_BUILD_DIR ?? resolve(import.meta.dirname, '../../../build'));

    startMockServer(port, host, buildDir).then(() => {
        console.log(`[mock] Suwayomi mock listening on http://${host}:${port} (build: ${buildDir})`);
    });
}
