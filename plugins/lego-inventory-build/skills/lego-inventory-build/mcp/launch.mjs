#!/usr/bin/env node
// Entry point for plugin / desktop installs: installs dependencies on first run, then starts
// the MCP server. Everything is logged to stderr, stdout belongs to the MCP protocol.
//   node mcp/launch.mjs [--http ...]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};

if (!fs.existsSync(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk'))) {
  console.error('[lego-mcp] first run: npm install ...');
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund']);
}
const marker = path.join(ROOT, 'node_modules/.chromium-ok');
if (!fs.existsSync(marker)) {
  console.error('[lego-mcp] first run: npx playwright install chromium ...');
  try {
    run('npx', ['playwright', 'install', 'chromium']);
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (e) {
    console.error('[lego-mcp] ' + e.message + '. Previews and renders will fail until Chromium is installed.');
  }
}
await import('./server.mjs');
