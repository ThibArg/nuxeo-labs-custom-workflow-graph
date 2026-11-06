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
 *     Thibaud Arguillere
 */

/*
 * Integration test of the Web UI part without a Nuxeo server: real Polymer 3, nuxeo-elements and HTML
 * Imports polyfill, the plugin bundle loaded through importHref like Web UI does, a mocked REST API.
 *     CWG_NODE_MODULES=... CHROME_PATH=... [CWG_NUXEO_ELEMENTS_DIR=...] node dev/tools/harness.mjs
 *   CWG_NODE_MODULES        node_modules with puppeteer-core, esbuild, @polymer/*, @nuxeo/*, nuxeo,
 *                           @webcomponents/html-imports (e.g. the one of a Web UI add-on project)
 *   CWG_NUXEO_ELEMENTS_DIR  optional: sources of nuxeo-elements (core/ and ui/) to use instead of the
 *                           @nuxeo packages of CWG_NODE_MODULES, to test against a given Web UI version
 * Screenshots are written to dev/out/harness/.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { launchBrowser, nodeModules, outDir, projectDir, startServer, webRoot } from './common.mjs';

const require = createRequire(import.meta.url);
const samples = require(path.join(projectDir, 'dev/demo/samples.js'));
const target = path.join(outDir, 'harness');
fs.mkdirSync(target, { recursive: true });

/* ==================== Bundle ==================== */

async function buildBundle() {
  const nm = nodeModules();
  const esbuild = createRequire(path.join(nm, 'noop.js'))('esbuild');
  const alias = {};
  const elementsDir = process.env.CWG_NUXEO_ELEMENTS_DIR;
  if (elementsDir) {
    alias['@nuxeo/nuxeo-elements'] = path.join(elementsDir, 'core');
    alias['@nuxeo/nuxeo-ui-elements'] = path.join(elementsDir, 'ui');
  }
  await esbuild.build({
    entryPoints: [path.join(projectDir, 'dev/harness/harness-entry.js')],
    bundle: true,
    format: 'iife',
    outfile: path.join(target, 'harness.bundle.js'),
    nodePaths: [nm],
    alias,
    logLevel: 'error',
    loader: { '.js': 'js' },
  });
  return elementsDir ? `nuxeo-elements sources: ${elementsDir}` : 'nuxeo-elements from CWG_NODE_MODULES';
}

/* ==================== Mocked REST API ==================== */

const enMessages = JSON.parse(fs.readFileSync(path.join(webRoot, 'ui/i18n/messages.json'), 'utf8'));
// Web UI labels used by the samples or by the plugin (copied from Web UI's messages.json)
const webUiMessages = {
  'documentPage.route.view.graph.error': "An error occurred while drawing the workflow's graph",
  'wf.serialDocumentReview.SerialDocumentReview': 'Serial Document Review',
  'wf.serialDocumentReview.Validate': 'Validate',
  'wf.serialDocumentReview.Reject': 'Reject',
  'wf.parallelDocumentReview.ParallelDocumentReview': 'Parallel Document Review',
  'wf.serialDocumentReview.AcceptReject': 'Please accept or reject the document.',
  'wf.parallelDocumentReview.give_opinion.directive': 'Please give your opinion. Click on N/A if you have no advice.',
};

const byId = {};
Object.values(samples).forEach((s) => {
  byId[s.id] = s;
});
byId['wf-noaccess'] = Object.assign({}, samples.contract, { id: 'wf-noaccess', noAccess: true });
byId['wf-broken'] = Object.assign({}, samples.serial, { id: 'wf-broken' });
byId['wf-studio'] = Object.assign({}, samples.serial, { id: 'wf-studio' });

function json(status, body) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function mockResponse(url, method) {
  const u = new URL(url);
  const p = u.pathname;
  if (p === '/nuxeo/json/cmis') {
    return json(200, { default: { productVersion: '2025.24' } });
  }
  if ((p === '/nuxeo/api/v1/automation/login' || p === '/nuxeo/site/automation/login') && method === 'POST') {
    return json(200, { 'entity-type': 'login', username: 'Administrator', isAdministrator: true, groups: [] });
  }
  if (p.startsWith('/nuxeo/api/v1/user/')) {
    return json(200, {
      'entity-type': 'user',
      id: 'Administrator',
      isAdministrator: true,
      properties: { username: 'Administrator', firstName: 'Ada', lastName: 'Admin', email: 'admin@example.com' },
      extendedGroups: [],
    });
  }
  let m = p.match(/^\/nuxeo\/api\/v1\/workflow\/([^/]+)\/graph$/);
  if (m) {
    if (m[1] === 'wf-error') {
      return json(500, { 'entity-type': 'exception', status: 500, message: 'Internal Server Error' });
    }
    const s = byId[m[1]];
    return s ? json(200, s.graph) : json(404, { 'entity-type': 'exception', status: 404, message: 'Not found' });
  }
  m = p.match(/^\/nuxeo\/api\/v1\/workflow\/([^/]+)$/);
  if (m) {
    const s = byId[m[1]];
    if (!s || s.noAccess) {
      return json(403, { 'entity-type': 'exception', status: 403, message: 'Forbidden' });
    }
    return json(200, Object.assign({}, s.workflow, { id: m[1] }));
  }
  if (p === '/nuxeo/api/v1/task') {
    const s = byId[u.searchParams.get('workflowInstanceId')];
    if (!s || s.noAccess) {
      return json(403, { 'entity-type': 'exception', status: 403, message: 'Forbidden' });
    }
    return json(200, {
      'entity-type': 'tasks',
      isPaginable: true,
      resultsCount: s.tasks.length,
      entries: s.tasks,
    });
  }
  return null;
}

/* ==================== Page helpers (run in the browser) ==================== */

const PAGE_HELPERS = `
  window.h = {
    mountInfoBar(ids) {
      const bar = document.createElement('harness-info-bar');
      bar.workflows = ids.map((id) => ({ id }));
      document.getElementById('slot').appendChild(bar);
      return bar;
    },
    mountTask(id) {
      const task = document.createElement('harness-document-task');
      task.task = { id: 'task-x', workflowInstanceId: id };
      document.getElementById('slot').appendChild(task);
      return task;
    },
    graphElement(id) {
      for (const bar of document.querySelectorAll('harness-info-bar')) {
        const g = bar.shadowRoot.querySelector('#graph-' + id);
        if (g) return g;
      }
      for (const t of document.querySelectorAll('harness-document-task')) {
        const g = t.shadowRoot.querySelector('nuxeo-workflow-graph');
        if (g && g.workflowId === id) return g;
      }
      return null;
    },
    link(id) {
      for (const bar of document.querySelectorAll('harness-info-bar')) {
        const links = Array.from(bar.shadowRoot.querySelectorAll('a.viewGraph'));
        const l = links.find((a) => a.textContent.trim() === 'View Graph ' + id);
        if (l) return l;
      }
      for (const t of document.querySelectorAll('harness-document-task')) {
        if (t.task.workflowInstanceId === id) return t.shadowRoot.querySelector('a.view-graph');
      }
      return null;
    },
    dialog(id) {
      const g = h.graphElement(id);
      return g && g.shadowRoot.querySelector('nuxeo-labs-custom-workflow-graph-dialog');
    },
    viewer(id) {
      const d = h.dialog(id);
      return d && d.shadowRoot.querySelector('#viewer');
    },
    vroot(id) {
      const v = h.viewer(id);
      return v && v.shadowRoot;
    },
    isOpen(id) {
      const d = h.dialog(id);
      return !!(d && d.$.dialog.opened);
    },
    classicOpen(id) {
      const g = h.graphElement(id);
      return !!(g && g.$.graphDialog.opened);
    },
    tagTexts(container, tag) {
      if (!container) return [];
      return Array.from(container.querySelectorAll(tag)).map((t) =>
        t.shadowRoot.textContent.replace(/\\s+/g, ' ').trim(),
      );
    },
    info(id) {
      const r = h.vroot(id);
      const d = h.dialog(id);
      if (!r) return null;
      const details = r.querySelector('#details');
      return {
        open: h.isOpen(id),
        loading: h.viewer(id).loading,
        nodes: r.querySelectorAll('.cwg-node').length,
        current: Array.from(r.querySelectorAll('.cwg-node.is-current')).map((n) => n.dataset.id),
        waiting: Array.from(r.querySelectorAll('.cwg-node.is-waiting')).map((n) => n.dataset.id),
        edges: r.querySelectorAll('.cwg-edge').length,
        next: r.querySelectorAll('.cwg-edge.is-next').length,
        zoom: r.querySelector('.cwg-tb-zoom').textContent.trim(),
        title: d.shadowRoot.querySelector('#title').textContent.trim(),
        state: d.shadowRoot.querySelector('.workflow-state').textContent.trim(),
        initiatorShown: !d.shadowRoot.querySelector('.initiator').hidden,
        detailsOpen: !!details && !details.hidden,
        detailsTitle: details ? details.querySelector('h3').textContent.trim() : '',
        detailsText: details && !details.hidden ? details.innerText : '',
        userTags: h.tagTexts(details, 'nuxeo-user-tag'),
        groupTags: h.tagTexts(details, 'nuxeo-group-tag'),
        activeInViewer: !!(r.activeElement),
      };
    },
  };
`;

/* ==================== Scenarios ==================== */

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e });
    console.log(`FAIL ${name}\n     ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n     ') : e}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const bundleInfo = await buildBundle();
  console.log(`harness bundle built (${bundleInfo})`);
  const { server, baseUrl } = await startServer({
    '/out/': target,
    '/node_modules/': nodeModules(),
    '/nuxeo/ui/': path.join(webRoot, 'ui'),
    '/': path.join(projectDir, 'dev/harness'),
  });
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);

  const consoleMessages = [];
  page.on('console', (msg) => consoleMessages.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) => consoleMessages.push({ type: 'pageerror', text: err.message }));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().startsWith(`${baseUrl}/nuxeo/`) && !req.url().startsWith(`${baseUrl}/nuxeo/ui/`)) {
      const response = mockResponse(req.url(), req.method());
      if (response) {
        req.respond(response);
        return;
      }
      console.log(`     (no mock for ${req.method()} ${req.url()})`);
      req.respond(json(404, { status: 404, message: `No mock for ${req.method()} ${req.url()}` }));
      return;
    }
    if (/favicon\.ico$/.test(req.url())) {
      req.respond({ status: 204, body: '' });
      return;
    }
    req.continue();
  });
  await page.evaluateOnNewDocument((messages) => {
    window.nuxeo = { I18n: { language: 'en', en: messages } };
  }, Object.assign({}, enMessages, webUiMessages));

  const unexpected = (allowed) =>
    consoleMessages.filter(
      (m) => (m.type === 'error' || m.type === 'pageerror') && !allowed.some((re) => re.test(m.text)),
    );
  const mark = () => consoleMessages.length;
  const since = (index) => consoleMessages.slice(index);

  try {
    await page.goto(`${baseUrl}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.harness && customElements.get('nuxeo-dialog'));
    await page.evaluate(PAGE_HELPERS);

    await scenario('the bundle loads through importHref before nuxeo-workflow-graph is defined', async () => {
      await page.evaluate(() =>
        window.harness.loadPluginBundle(
          '/nuxeo/ui/nuxeo-labs-custom-workflow-graph/nuxeo-labs-custom-workflow-graph-bundle.html',
        ),
      );
      await page.waitForFunction(() => customElements.get('nuxeo-labs-custom-workflow-graph-dialog'), {
        timeout: 5000,
      });
      const state = await page.evaluate(() => {
        const C = window.NuxeoLabs.CustomWorkflowGraph;
        return {
          layouts: C.listLayouts().map((l) => l.name),
          viewer: !!customElements.get('nuxeo-labs-custom-workflow-graph-viewer'),
          icon: !!customElements.get('nuxeo-labs-cwg-icon'),
          override: !!C.overrideInstalled,
          globalDagre: typeof window.dagre,
        };
      });
      assert.deepEqual(state.layouts, ['auto', 'studio']);
      assert.ok(state.viewer && state.icon && state.override);
      await page.evaluate(() => window.harness.defineWebUiElements());
      await page.waitForFunction(() => customElements.get('nuxeo-workflow-graph').prototype.show.cwgPatched === true, {
        timeout: 2000,
      });
      assert.deepEqual(unexpected([]), []);
    });

    await scenario('"View Graph" of the document bar opens the custom dialog (Serial Document Review)', async () => {
      const start = mark();
      await page.evaluate(() => h.mountInfoBar(['wf-serial-0001', 'wf-error', 'wf-noaccess']));
      const link = await page.evaluateHandle(() => h.link('wf-serial-0001'));
      await link.click();
      await page.waitForFunction(
        () => h.info('wf-serial-0001') && h.info('wf-serial-0001').nodes === 5 && !h.info('wf-serial-0001').loading,
        {
          timeout: 5000,
        },
      );
      await page.waitForFunction(() => h.info('wf-serial-0001').title === 'Serial Document Review', { timeout: 5000 });
      await sleep(400);
      const info = await page.evaluate(() => h.info('wf-serial-0001'));
      assert.equal(info.open, true);
      assert.equal(info.edges, 9);
      assert.deepEqual(info.current, ['Task6d8']);
      assert.equal(info.next, 4, 'the 4 transitions leaving the current step are highlighted');
      assert.equal(info.state, 'Running');
      assert.equal(info.initiatorShown, true);
      assert.equal(await page.evaluate(() => window.harness.classicShown), 0);
      assert.equal(await page.evaluate(() => h.classicOpen('wf-serial-0001')), false);
      await page.screenshot({ path: path.join(target, '01-dialog-serial.png') });
      assert.deepEqual(
        unexpected([]).filter((m) => since(start).includes(m)),
        [],
      );
    });

    await scenario('keyboard: shortcuts work in the graph and never reach Web UI global shortcuts', async () => {
      const before = await page.evaluate(() => h.info('wf-serial-0001').zoom);
      await page.evaluate(() => window.harness.bodyKeys.splice(0));
      await page.keyboard.press('d');
      await page.keyboard.press('m');
      await page.keyboard.press('Equal');
      await sleep(350);
      const after = await page.evaluate(() => h.info('wf-serial-0001').zoom);
      assert.notEqual(after, before, `zoom changed with "=" (${before} -> ${after})`);
      assert.deepEqual(await page.evaluate(() => window.harness.bodyKeys), []);
      await page.keyboard.press('f');
      await sleep(350);
      assert.equal(await page.evaluate(() => h.info('wf-serial-0001').zoom), before, '"f" fits again');
    });

    await scenario('clicking the current step shows its open task (assignee, due date, actions)', async () => {
      const node = await page.evaluateHandle(() => h.vroot('wf-serial-0001').querySelector('.cwg-node.is-current'));
      await node.click();
      await page.waitForFunction(() => h.info('wf-serial-0001').detailsOpen, { timeout: 3000 });
      await page.waitForFunction(() => h.info('wf-serial-0001').userTags.length > 0, { timeout: 3000 });
      await sleep(400);
      const info = await page.evaluate(() => h.info('wf-serial-0001'));
      assert.equal(info.detailsTitle, 'Validate the Document');
      assert.match(info.detailsText, /open tasks/i);
      assert.match(info.detailsText, /overdue/i);
      assert.match(info.detailsText, /Please accept or reject the document/);
      assert.match(info.detailsText, /Validate/);
      assert.match(info.detailsText, /leads to/i);
      assert.ok(
        info.userTags.some((t) => /Alice Dupont/.test(t)),
        `assignee shown: ${info.userTags}`,
      );
      await page.screenshot({ path: path.join(target, '02-dialog-serial-details.png') });
    });

    await scenario('"Leads to" navigates to another step', async () => {
      const row = await page.evaluateHandle(() =>
        Array.from(h.vroot('wf-serial-0001').querySelectorAll('#details .link-row')).find((b) =>
          /Update the Document/.test(b.textContent),
        ),
      );
      await row.click();
      await page.waitForFunction(() => h.info('wf-serial-0001').detailsTitle === 'Update the Document', {
        timeout: 3000,
      });
      const info = await page.evaluate(() => h.info('wf-serial-0001'));
      assert.doesNotMatch(info.detailsText, /open tasks/i, 'no task section for a step that is not current');
    });

    await scenario('Escape clears the selection first, then closes the dialog', async () => {
      await page.keyboard.press('Escape');
      await sleep(200);
      let info = await page.evaluate(() => h.info('wf-serial-0001'));
      assert.equal(info.detailsOpen, false);
      assert.equal(info.open, true);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !h.isOpen('wf-serial-0001'), { timeout: 3000 });
      assert.deepEqual(await page.evaluate(() => window.harness.bodyKeys), []);
      // let the backdrop fade out before clicking again
      await sleep(600);
    });

    await scenario('reopening reloads the graph', async () => {
      const link = await page.evaluateHandle(() => h.link('wf-serial-0001'));
      await link.click();
      await page.waitForFunction(() => h.isOpen('wf-serial-0001') && h.info('wf-serial-0001').nodes === 5, {
        timeout: 5000,
      });
      await page.evaluate(() => h.dialog('wf-serial-0001').close());
      await page.waitForFunction(() => !h.isOpen('wf-serial-0001'), { timeout: 3000 });
      await sleep(600);
    });

    await scenario('graph error: notification of Web UI, dialog closed', async () => {
      const start = mark();
      await page.evaluate(() => window.harness.notifications.splice(0));
      const link = await page.evaluateHandle(() => h.link('wf-error'));
      await link.click();
      await page.waitForFunction(() => window.harness.notifications.length > 0, { timeout: 5000 });
      await sleep(300);
      assert.deepEqual(await page.evaluate(() => window.harness.notifications), [
        "An error occurred while drawing the workflow's graph",
      ]);
      assert.equal(await page.evaluate(() => h.isOpen('wf-error')), false);
      assert.equal(await page.evaluate(() => window.harness.classicShown), 0);
      const errors = unexpected([/status of 500/, /Internal Server Error/, /status of 403/]).filter((m) =>
        since(start).includes(m),
      );
      assert.deepEqual(errors, [], JSON.stringify(errors));
      await sleep(600);
    });

    await scenario('no access to the workflow and tasks: the graph is still shown', async () => {
      const start = mark();
      const link = await page.evaluateHandle(() => h.link('wf-noaccess'));
      await link.click();
      await page.waitForFunction(() => h.info('wf-noaccess') && h.info('wf-noaccess').nodes === 12, { timeout: 5000 });
      await sleep(300);
      const node = await page.evaluateHandle(() => h.vroot('wf-noaccess').querySelector('.cwg-node.is-current'));
      await node.click();
      await page.waitForFunction(() => /not available/.test(h.info('wf-noaccess').detailsText), { timeout: 3000 });
      const info = await page.evaluate(() => h.info('wf-noaccess'));
      assert.equal(info.title, 'Workflow');
      assert.equal(info.initiatorShown, false);
      assert.deepEqual(info.waiting, ['n-merge']);
      await page.evaluate(() => h.dialog('wf-noaccess').close());
      await sleep(600);
      const errors = unexpected([/status of 403/, /Forbidden/]).filter((m) => since(start).includes(m));
      assert.deepEqual(errors, []);
    });

    await scenario('task view, dark theme, group and delegated actors (Contract approval)', async () => {
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark';
        h.mountTask('wf-contract-0001');
      });
      const link = await page.evaluateHandle(() => h.link('wf-contract-0001'));
      await link.click();
      await page.waitForFunction(() => h.info('wf-contract-0001') && h.info('wf-contract-0001').nodes === 12, {
        timeout: 5000,
      });
      const node = await page.evaluateHandle(() => h.vroot('wf-contract-0001').querySelector('.cwg-node.is-current'));
      await node.click();
      await page.waitForFunction(() => h.info('wf-contract-0001').groupTags.length > 0, { timeout: 3000 });
      await sleep(500);
      const info = await page.evaluate(() => h.info('wf-contract-0001'));
      assert.ok(
        info.groupTags.some((t) => /Legal team/.test(t)),
        `group shown: ${info.groupTags}`,
      );
      assert.ok(
        info.userTags.some((t) => /Lucas Garcia/.test(t)),
        `delegate shown: ${info.userTags}`,
      );
      assert.match(info.detailsText, /delegated to/i);
      assert.doesNotMatch(info.detailsText, /overdue/i, 'a due date in the future is not overdue');
      await page.screenshot({ path: path.join(target, '03-task-contract-dark-details.png') });
      await page.evaluate(() => h.dialog('wf-contract-0001').close());
      await sleep(600);
      await page.evaluate(() => {
        document.documentElement.dataset.theme = '';
      });
    });

    await scenario('layout=studio: Studio positions, layout selector, switch to auto and back', async () => {
      const start = mark();
      await page.evaluate(() => {
        Object.assign(Nuxeo.UI.config.customWorkflowGraph, { layout: 'studio', allowLayoutSwitch: 'true' });
        h.mountInfoBar(['wf-studio']);
      });
      const link = await page.evaluateHandle(() => h.link('wf-studio'));
      await link.click();
      await page.waitForFunction(() => h.info('wf-studio') && h.info('wf-studio').nodes === 5, { timeout: 5000 });
      await sleep(400);
      const state = () =>
        page.evaluate(() => {
          const r = h.viewer('wf-studio')._renderer;
          const root = h.vroot('wf-studio');
          const select = root.querySelector('.cwg-tb-select');
          return {
            layout: r.layoutName,
            fallback: r.layout.fallback || null,
            selectShown: !select.hidden,
            options: Array.from(select.options).map((o) => o.value),
            value: select.value,
            directionShown: !root.querySelector('.cwg-tb-group').hidden,
            edges: root.querySelectorAll('.cwg-edge').length,
          };
        });
      let s = await state();
      assert.equal(s.layout, 'studio');
      assert.equal(s.fallback, null);
      assert.equal(s.selectShown, true);
      assert.deepEqual(s.options, ['auto', 'studio']);
      assert.equal(s.value, 'studio');
      assert.equal(s.directionShown, false, 'no direction buttons for the studio layout');
      assert.equal(s.edges, 9);
      await page.screenshot({ path: path.join(target, '04-dialog-serial-studio.png') });
      const choose = (value) =>
        page.evaluate((v) => {
          const select = h.vroot('wf-studio').querySelector('.cwg-tb-select');
          select.value = v;
          select.dispatchEvent(new Event('change'));
        }, value);
      await choose('auto');
      s = await state();
      assert.equal(s.layout, 'auto');
      assert.equal(s.directionShown, true);
      await choose('studio');
      s = await state();
      assert.equal(s.layout, 'studio');
      await page.evaluate(() => h.dialog('wf-studio').close());
      await sleep(600);
      await page.evaluate(() => {
        Object.assign(Nuxeo.UI.config.customWorkflowGraph, { layout: 'auto', allowLayoutSwitch: 'false' });
        window.NuxeoLabs.CustomWorkflowGraph.session.layout = null;
      });
      assert.deepEqual(
        unexpected([]).filter((m) => since(start).includes(m)),
        [],
      );
    });

    await scenario('enabled=false: the default graph is used', async () => {
      await page.evaluate(() => {
        Nuxeo.UI.config.customWorkflowGraph.enabled = 'false';
      });
      const before = await page.evaluate(() => window.harness.classicShown);
      const link = await page.evaluateHandle(() => h.link('wf-serial-0001'));
      await link.click();
      await page.waitForFunction((n) => window.harness.classicShown === n + 1, { timeout: 3000 }, before);
      assert.equal(await page.evaluate(() => h.isOpen('wf-serial-0001')), false);
      await page.evaluate(() => {
        h.graphElement('wf-serial-0001').$.graphDialog.close();
        Nuxeo.UI.config.customWorkflowGraph.enabled = 'true';
      });
    });

    await scenario('layout failure: falls back to the default graph', async () => {
      const start = mark();
      await page.evaluate(() => {
        const C = window.NuxeoLabs.CustomWorkflowGraph;
        C.registerLayout('broken', {
          compute() {
            throw new Error('broken layout (test)');
          },
        });
        Nuxeo.UI.config.customWorkflowGraph.layout = 'broken';
        h.mountInfoBar(['wf-broken']);
      });
      const before = await page.evaluate(() => window.harness.classicShown);
      const link = await page.evaluateHandle(() => h.link('wf-broken'));
      await link.click();
      await page.waitForFunction((n) => window.harness.classicShown === n + 1, { timeout: 5000 }, before);
      await sleep(300);
      assert.equal(await page.evaluate(() => h.isOpen('wf-broken')), false);
      assert.ok(
        since(start).some((m) => m.type === 'warn' && /falling back|default graph/.test(m.text)),
        'a warning explains the fallback',
      );
      await page.evaluate(() => {
        h.graphElement('wf-broken').$.graphDialog.close();
        Nuxeo.UI.config.customWorkflowGraph.layout = 'auto';
      });
    });
  } finally {
    const errors = consoleMessages.filter((m) => m.type === 'error' || m.type === 'pageerror');
    fs.writeFileSync(path.join(target, 'console.log'), consoleMessages.map((m) => `[${m.type}] ${m.text}`).join('\n'));
    await browser.close();
    server.close();
    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n${results.length - failed.length}/${results.length} scenarios passed, ` +
        `${errors.length} console error(s) in total (expected ones included), see dev/out/harness/console.log`,
    );
    if (failed.length) {
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
