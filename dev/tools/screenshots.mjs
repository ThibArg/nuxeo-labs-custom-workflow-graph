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
 * Renders the demo (dev/demo/index.html) in headless Chrome for every sample, theme and direction, fails on
 * any console error, and writes the screenshots to dev/out/demo/.
 *     CWG_NODE_MODULES=... CHROME_PATH=... node dev/tools/screenshots.mjs [filter]
 * The optional filter keeps the cases whose name contains it (e.g. "serial-default").
 */
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, outDir, projectDir, startServer } from './common.mjs';

const filter = process.argv[2] || '';
const target = path.join(outDir, 'demo');
fs.mkdirSync(target, { recursive: true });

const cases = [];
for (const wf of ['serial', 'parallel', 'subWorkflow', 'contract']) {
  for (const theme of ['default', 'dark', 'hyland-light', 'hyland-dark']) {
    for (const dir of ['TB', 'LR']) {
      cases.push({ name: `${wf}-${theme}-${dir}`, query: { wf, theme, dir, layout: 'auto' } });
    }
    // the studio layout has no direction
    cases.push({ name: `${wf}-${theme}-studio`, query: { wf, theme, layout: 'studio' } });
  }
}
cases.push({
  name: 'contract-default-TB-selected',
  query: { wf: 'contract', theme: 'default', dir: 'TB', layout: 'auto', select: 'n-decision' },
});
cases.push({
  name: 'serial-default-studio-selected',
  query: { wf: 'serial', theme: 'default', layout: 'studio', select: 'Task6d8' },
});
cases.push({
  name: 'serial-dark-TB-fr',
  query: { wf: 'serial', theme: 'dark', dir: 'TB', layout: 'auto', lang: 'fr' },
});
cases.push({
  name: 'contract-default-TB-small',
  query: { wf: 'contract', theme: 'default', dir: 'TB', layout: 'auto' },
  width: 760,
  height: 520,
});

const { server, baseUrl } = await startServer({ '/': projectDir });
const browser = await launchBrowser();
let failures = 0;
try {
  for (const c of cases.filter((x) => x.name.includes(filter))) {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        errors.push(`${msg.type()}: ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    await page.setViewport({ width: c.width || 1400, height: c.height || 900, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const query = new URLSearchParams(c.query).toString();
    await page.goto(`${baseUrl}/dev/demo/index.html?${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.ready || document.body.dataset.error, { timeout: 10000 });
    const error = await page.evaluate(() => document.body.dataset.error);
    if (error) {
      errors.push(error);
    }
    // let the animated transforms settle
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: path.join(target, `${c.name}.png`) });
    const stats = await page.evaluate(() => ({
      nodes: document.querySelectorAll('.cwg-node').length,
      edges: document.querySelectorAll('.cwg-edge').length,
      scale: window.renderer.transform.scale,
      layout: window.renderer.layoutName,
      fallback: window.renderer.layout.fallback ? window.renderer.layout.fallback.reason : '',
    }));
    if (c.query.layout && stats.layout !== c.query.layout) {
      errors.push(`layout ${stats.layout} used instead of ${c.query.layout}`);
    }
    if (stats.fallback) {
      errors.push(`fallback to auto: ${stats.fallback}`);
    }
    if (errors.length) {
      failures++;
      console.log(`FAIL ${c.name}\n  ${errors.join('\n  ')}`);
    } else {
      console.log(
        `ok   ${c.name} (${stats.nodes} nodes, ${stats.edges} edges, zoom ${Math.round(stats.scale * 100)}%)`,
      );
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failures) {
  process.exitCode = 1;
}
