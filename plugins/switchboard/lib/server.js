'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const routing = require('./mcp.js');

const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/panel.js': ['panel.js', 'text/javascript; charset=utf-8'],
};

function send(res, status, body, contentType) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': contentType,
  });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (_) { reject(new Error('bad JSON body')); }
    });
    req.on('error', reject);
  });
}

function projectPath(search, body) {
  return (body && body.projectPath) || search.get('projectPath') || undefined;
}

function settings(projectPath) {
  const effective = routing.listCategories({ projectPath });
  return {
    contract: routing.contract(),
    effective,
    global: routing.listCategories({ projectPath, global: true }),
    availability: routing.availableModels({ projectPath }),
    fallback: routing.getFallback({ projectPath }),
    doctor: routing.doctor({ projectPath }),
  };
}

function savedCategory(body) {
  return {
    name: String(body.name || ''),
    description: String(body.description || ''),
    contract: String(body.contract || ''),
    route: body.route,
    fallback: body.fallback === undefined ? null : body.fallback,
    enabled: body.enabled !== false,
  };
}

function mutateCategory(id, action, body) {
  const project = body.scope === 'project';
  const projectPath = body.projectPath;
  if (action === 'detach') return routing.detachCategory({ id, projectPath });
  if (action === 'relink' || action === 'reset') return routing.relinkCategory({ id, projectPath });
  if (action === 'disable') return routing.disableCategory({ id, projectPath, project });
  if (action === 'save') return routing.editCategory({ id, patch: savedCategory(body), projectPath, project });
  throw new Error(`Unknown category action "${action}".`);
}

async function handle(req, res) {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');
  const asset = ASSETS[requestUrl.pathname];
  if (req.method === 'GET' && asset) {
    const [filename, type] = asset;
    try { send(res, 200, fs.readFileSync(path.join(DASHBOARD_DIR, filename)), type); } catch (_) { send(res, 500, 'Switchboard dashboard files are missing.', 'text/plain; charset=utf-8'); }
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
    json(res, 200, { ok: true, name: 'switchboard', host: '127.0.0.1' });
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/api/settings') {
    json(res, 200, settings(projectPath(requestUrl.searchParams)));
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/api/resolve') {
    json(res, 200, routing.resolve({ categoryId: requestUrl.searchParams.get('category'), projectPath: projectPath(requestUrl.searchParams), consumer: requestUrl.searchParams.get('consumer') || undefined }));
    return;
  }
  if (req.method === 'PUT' && requestUrl.pathname === '/api/fallback') {
    const body = await readJson(req);
    const route = body.route === null ? null : body.route;
    json(res, 200, routing.setFallback({ route, projectPath: body.projectPath, project: body.scope === 'project' }));
    return;
  }
  const categoryAction = /^\/api\/categories\/([^/]+)\/(save|detach|relink|reset|disable)$/.exec(requestUrl.pathname);
  if (req.method === 'POST' && categoryAction) {
    const body = await readJson(req);
    const result = mutateCategory(decodeURIComponent(categoryAction[1]), categoryAction[2], body);
    json(res, 200, { result, settings: settings(body.projectPath) });
    return;
  }
  json(res, 404, { error: 'not found' });
}

function listen(server, port, tries = 40) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListen);
      if (error.code === 'EADDRINUSE' && tries) resolve(listen(server, port + 1, tries - 1));
      else reject(error);
    };
    const onListen = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, '127.0.0.1');
  });
}

async function start(requestedPort) {
  const server = http.createServer((req, res) => handle(req, res).catch((error) => json(res, 400, { error: error.message })));
  const port = await listen(server, Number(requestedPort) || Number(process.env.SWITCHBOARD_PORT) || 41750);
  return { server, port, url: `http://127.0.0.1:${port}` };
}

module.exports = { handle, settings, start };
