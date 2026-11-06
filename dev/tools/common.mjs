/*
 * (C) Copyright 2026 Hyland (http://hyland.com/) and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Contributors:
 *     Thibaud Arguillere (with the help of opencode/Claude Opus 5.5)
 */

/*
 * Shared helpers of the dev tools (NOT packaged): static HTTP server of the project, puppeteer-core loading
 * and Chrome launching. Nothing is installed by the project: point to an existing installation with
 *   CWG_NODE_MODULES  a node_modules folder containing puppeteer-core (and, for the harness, the Web UI
 *                     dependencies: @polymer, @nuxeo/nuxeo-elements, @nuxeo/nuxeo-ui-elements, esbuild...)
 *   CHROME_PATH       a Chrome or chrome-headless-shell executable (default: Google Chrome on macOS)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const outDir = path.join(projectDir, 'dev', 'out');
export const webRoot = path.join(projectDir, 'nuxeo-labs-custom-workflow-graph-web/src/main/resources/web/nuxeo.war');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json',
};

export function nodeModules() {
  const dir = process.env.CWG_NODE_MODULES;
  if (!dir || !fs.existsSync(dir)) {
    throw new Error('Set CWG_NODE_MODULES to a node_modules folder containing puppeteer-core');
  }
  return dir;
}

export function loadPuppeteer() {
  const require = createRequire(path.join(nodeModules(), 'noop.js'));
  return require('puppeteer-core');
}

export function chromePath() {
  return process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

export async function launchBrowser() {
  const puppeteer = loadPuppeteer();
  return puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--no-sandbox', '--font-render-hinting=none', '--force-color-profile=srgb'],
  });
}

// Serves `mounts` ({ urlPrefix: directory }) on a random local port. Returns { server, baseUrl }.
export function startServer(mounts) {
  const entries = Object.entries(mounts).sort((a, b) => b[0].length - a[0].length);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const mount = entries.find(([prefix]) => pathname.startsWith(prefix));
    if (!mount) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const [prefix, dir] = mount;
    const file = path.normalize(path.join(dir, pathname.slice(prefix.length)));
    if (!file.startsWith(path.normalize(dir))) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}
