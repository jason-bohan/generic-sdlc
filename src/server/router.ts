import http from 'node:http';

export function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => resolve(body));
    });
}

export function json(res: http.ServerResponse, data: unknown, status = 200) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    if (!res.getHeader('Access-Control-Allow-Origin')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.end(JSON.stringify(data));
}

export function cors(res: http.ServerResponse, methods = 'GET, POST, OPTIONS') {
    if (!res.getHeader('Access-Control-Allow-Origin')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

export function createRouter() {
    const routes: Array<{ path: string; handler: Handler }> = [];
    function use(path: string, handler: Handler) { routes.push({ path, handler }); }
    function dispatch(req: http.IncomingMessage, res: http.ServerResponse) {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
            res.end(); return;
        }
        const urlPath = (req.url ?? '/').split('?')[0];
        for (const route of routes) {
            if (urlPath === route.path || urlPath.startsWith(route.path + '/') || urlPath.startsWith(route.path + '?')) {
                try { const r = route.handler(req, res); if (r instanceof Promise) r.catch((e) => json(res, { error: String(e) }, 500)); } catch (e) { json(res, { error: String(e) }, 500); }
                return;
            }
        }
        json(res, { error: 'Not found' }, 404);
    }
    return { use, dispatch };
}
