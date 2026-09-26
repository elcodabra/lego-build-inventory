#!/usr/bin/env node
// MCP server for lego-inventory-build: the same engine as the skill, exposed as tools so any
// MCP client can use it (ChatGPT developer mode / Apps, Claude Desktop, Claude.ai connectors,
// Cursor, Codex, ...).
//
//   node mcp/server.mjs                 stdio (Claude Desktop, Claude Code, Cursor, Codex)
//   node mcp/server.mjs --http [--port 8787]   Streamable HTTP at /mcp (ChatGPT, remote clients)
//
// Env:
//   LEGO_DATA_DIR        where inventory.json, models/ and exports/ live (default ~/.lego-build)
//   REBRICKABLE_API_KEY  for inventory_add_set
//   LEGO_MCP_TOKEN       HTTP only: require "Authorization: Bearer <token>" or ?key=<token>
//   PUBLIC_URL           HTTP only: base URL used in links to rendered files (e.g. your tunnel URL)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { buildServer, DATA, EXPORTS, film } from './tools.mjs';

const args = process.argv.slice(2);
const HTTP = args.includes('--http');
const PORT = Number(args[args.indexOf('--port') + 1] || process.env.PORT || 8787);
const log = (...a) => console.error('[lego-mcp]', ...a);
const fileUrl = (file) => (HTTP ? `${(process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '')}/files/${encodeURIComponent(path.basename(file))}` : null);
const build = () => buildServer({ publish: fileUrl });

// ------------------------------------------------------------------ transports

async function main() {
  if (!HTTP) {
    await build().connect(new StdioServerTransport());
    log(`stdio ready, data in ${DATA}`);
    return;
  }
  const token = process.env.LEGO_MCP_TOKEN;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (url.pathname === '/health') return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    if (token) {
      const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('key');
      if (got !== token) return res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
    }
    if (url.pathname.startsWith('/files/') && req.method === 'GET') {
      const f = path.join(EXPORTS, path.basename(decodeURIComponent(url.pathname.slice(7))));
      if (!fs.existsSync(f)) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': f.endsWith('.mp4') ? 'video/mp4' : 'image/png', 'content-length': fs.statSync(f).size });
      return fs.createReadStream(f).pipe(res);
    }
    if (url.pathname !== '/mcp') return res.writeHead(404, { 'content-type': 'text/plain' }).end('MCP endpoint is /mcp');
    if (req.method !== 'POST') return res.writeHead(405, { allow: 'POST' }).end();
    // Stateless: a fresh server and transport per request, nothing to leak between clients.
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { return res.writeHead(400).end('bad json'); }
    const srv = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); srv.close(); });
    try {
      await srv.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log('request failed', e);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  server.listen(PORT, () => log(`HTTP ready on http://localhost:${PORT}/mcp, data in ${DATA}${token ? ', token required' : ''}`));
}

const shutdown = async () => { await film.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main().catch((e) => { log(e); process.exit(1); });
