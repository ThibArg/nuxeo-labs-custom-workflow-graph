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

// Unit tests of the browser-independent part (core, geometry, auto layout), run with:
// node --test dev/test
// The studio layout has its own file (cwg-studio.test.mjs). The production files are loaded as is into a VM
// context, no npm dependency is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, '..', '..');
const webDir = path.join(
  projectDir,
  'nuxeo-labs-custom-workflow-graph-web/src/main/resources/web/nuxeo.war/ui/nuxeo-labs-custom-workflow-graph',
);
const require = createRequire(import.meta.url);
const samples = require(path.join(projectDir, 'dev/demo/samples.js'));

const FILES = [
  'common/cwg-core.js',
  'common/cwg-geometry.js',
  'vendor/dagre.min.js',
  'layouts/cwg-layout-auto.js',
  'layouts/cwg-layout-studio.js',
];

// Loads the production scripts in a fresh context, the same way the bundle does (classic scripts).
function load(globals) {
  const ctx = Object.assign({ structuredClone, console }, globals || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(webDir, f), 'utf8'), ctx, { filename: f }));
  return ctx;
}

const ctx = load();
const CWG = ctx.NuxeoLabs.CustomWorkflowGraph;

function rect(center, size, margin) {
  const m = margin || 0;
  return {
    x1: center.x - size.width / 2 - m,
    y1: center.y - size.height / 2 - m,
    x2: center.x + size.width / 2 + m,
    y2: center.y + size.height / 2 + m,
  };
}

function distanceToRectBorder(p, r) {
  const dx = Math.max(r.x1 - p.x, 0, p.x - r.x2);
  const dy = Math.max(r.y1 - p.y, 0, p.y - r.y2);
  if (dx > 0 || dy > 0) {
    return Math.hypot(dx, dy);
  }
  return Math.min(p.x - r.x1, r.x2 - p.x, p.y - r.y1, r.y2 - p.y);
}

test('configuration: defaults without Nuxeo', () => {
  assert.deepEqual(
    { ...CWG.getConfig() },
    { enabled: true, layout: 'auto', direction: 'TB', allowLayoutSwitch: true },
  );
});

test('configuration: string values from Nuxeo.UI.config', () => {
  const c = load({
    Nuxeo: {
      UI: {
        config: {
          customWorkflowGraph: { enabled: 'false', layout: ' studio ', direction: 'lr', allowLayoutSwitch: 'true' },
        },
      },
    },
  });
  const conf = c.NuxeoLabs.CustomWorkflowGraph.getConfig();
  assert.equal(conf.enabled, false);
  assert.equal(conf.layout, 'studio');
  assert.equal(conf.direction, 'LR');
  assert.equal(conf.allowLayoutSwitch, true);
  const c2 = load({ Nuxeo: { UI: { config: { customWorkflowGraph: { enabled: 'yes', direction: 'diagonal' } } } } });
  assert.equal(c2.NuxeoLabs.CustomWorkflowGraph.getConfig().enabled, true);
  assert.equal(c2.NuxeoLabs.CustomWorkflowGraph.getConfig().direction, 'TB');
});

test('translations: Web UI bundle first, then English fallback, then key', () => {
  const messages = { 'customWorkflowGraph.kind.step': 'Étape', 'wf.title': 'Mon flux', 'x.params': 'A {0} B {1}' };
  const c = load({
    nuxeo: { I18n: { translate: (key) => messages[key] || key } },
  });
  const C = c.NuxeoLabs.CustomWorkflowGraph;
  assert.equal(C.t('customWorkflowGraph.kind.step'), 'Étape');
  assert.equal(C.t('customWorkflowGraph.kind.end'), 'End');
  assert.equal(C.t('unknown.key'), 'unknown.key');
  assert.equal(C.t('x.params', 1, 2), 'A 1 B 2');
  assert.equal(C.translateLabel('wf.title'), 'Mon flux');
  assert.equal(C.translateLabel('automatic_transition'), 'Automatic transition');
  assert.equal(C.translateLabel('Validate the Document'), 'Validate the Document');
  assert.equal(C.translateLabel('start'), 'start');
  assert.equal(C.translateLabel(null), '');
});

test('wrapText: respects width and line count, adds an ellipsis', () => {
  const measure = (s) => s.length * 7;
  const r = CWG.wrapText('one two three four five six seven eight nine ten eleven twelve', 70, 3, measure);
  assert.equal(r.lines.length, 3);
  r.lines.forEach((l) => assert.ok(measure(l) <= 70, `line too long: ${l}`));
  assert.ok(r.truncated);
  assert.ok(r.lines[2].endsWith('…'));
  const long = CWG.wrapText('Supercalifragilisticexpialidocious', 70, 3, measure);
  long.lines.forEach((l) => assert.ok(measure(l) <= 70));
  const short = CWG.wrapText('Approve', 70, 3, measure);
  assert.deepEqual([...short.lines], ['Approve']);
  assert.equal(short.truncated, false);
  assert.deepEqual([...CWG.wrapText('', 70, 3, measure).lines], ['']);
});

test('buildModel: kinds, states, order, sizes and invalid transitions', () => {
  const model = CWG.buildModel(samples.contract.graph);
  const byId = Object.fromEntries(model.nodes.map((n) => [n.id, n]));
  assert.equal(byId['n-start'].kind, 'start');
  assert.equal(byId['n-stop'].kind, 'end');
  assert.equal(byId['n-fork'].kind, 'fork');
  assert.equal(byId['n-merge'].kind, 'merge');
  assert.equal(byId['n-board'].kind, 'subWorkflow');
  assert.equal(byId['n-sign'].kind, 'multiTask');
  assert.equal(byId['n-prepare'].kind, 'step');
  assert.equal(byId['n-legal'].isCurrent, true);
  assert.equal(byId['n-merge'].isWaiting, true);
  assert.deepEqual([...model.currentNodeIds], ['n-legal']);
  assert.equal(model.nodes[0].id, 'n-start', 'sorted by Studio position');
  assert.ok(byId['n-legal'].lines.length <= CWG.METRICS.card.maxLines);
  assert.ok(byId['n-legal'].height > byId['n-prepare'].height, 'long titles make taller cards');
  assert.equal(byId['n-start'].height, CWG.METRICS.terminal.height);
  const selfLoops = model.edges.filter((e) => e.isSelfLoop);
  assert.equal(selfLoops.length, 1);
  assert.equal(model.edges.find((e) => e.label === '').labelWidth, 0);

  const broken = CWG.buildModel({
    nodes: [{ id: 'a', title: 'A', startNode: true }, { id: 'a', title: 'dup' }, { title: 'no id' }],
    transitions: [{ nodeSourceId: 'a', nodeTargetId: 'missing', label: 'x' }],
  });
  assert.equal(broken.nodes.length, 1);
  assert.equal(broken.nodes[0].kind, 'start', 'Jackson alias startNode is supported');
  assert.equal(broken.edges.length, 0);
  assert.equal(broken.warnings.length, 3);
  assert.equal(CWG.buildModel(null).nodes.length, 0);
});

test('layout registry', () => {
  assert.deepEqual([...CWG.listLayouts().map((l) => l.name)], ['auto', 'studio']);
  assert.equal(CWG.resolveLayoutName('auto'), 'auto');
  assert.equal(CWG.resolveLayoutName('studio'), 'studio');
  assert.equal(CWG.resolveLayoutName('unknown'), 'auto', 'unknown layout falls back to auto');
  assert.equal(CWG.getLayout('studio').supportsDirection, false);
  assert.throws(() => CWG.registerLayout('bad', {}));
  const c = load();
  const C = c.NuxeoLabs.CustomWorkflowGraph;
  C.registerLayout('never', { compute() {}, isAvailable: () => false });
  assert.equal(C.resolveLayoutName('never'), 'auto');
  assert.deepEqual([...C.listLayouts().map((l) => l.name)], ['auto', 'studio']);
});

test('auto layout keeps a previously loaded global dagre', () => {
  const previous = { mine: true };
  const ctx2 = { structuredClone, console, dagre: previous };
  ctx2.window = ctx2;
  vm.createContext(ctx2);
  FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(webDir, f), 'utf8'), ctx2));
  assert.equal(ctx2.dagre, previous);
  assert.ok(ctx2.NuxeoLabs.CustomWorkflowGraph.dagre.layout);
  assert.equal(ctx2.NuxeoLabs.CustomWorkflowGraph.resolveLayoutName('auto'), 'auto');
});

for (const [name, sample] of Object.entries(samples)) {
  for (const direction of ['TB', 'LR']) {
    test(`auto layout: ${name} ${direction}`, () => {
      const model = CWG.buildModel(sample.graph);
      const layout = CWG.getLayout('auto').compute(model, { direction });

      assert.ok(layout.width > 0 && layout.height > 0);
      const nodeRects = model.nodes.map((n) => {
        const p = layout.nodes[n.id];
        assert.ok(p && Number.isFinite(p.x) && Number.isFinite(p.y), `node ${n.id} positioned`);
        const r = rect(p, n);
        assert.ok(r.x1 >= -0.5 && r.y1 >= -0.5, `node ${n.id} inside the bounds`);
        assert.ok(r.x2 <= layout.width + 0.5 && r.y2 <= layout.height + 0.5, `node ${n.id} inside the bounds`);
        return { id: n.id, r };
      });
      for (let i = 0; i < nodeRects.length; i++) {
        for (let j = i + 1; j < nodeRects.length; j++) {
          assert.ok(
            !CWG.geometry.rectsOverlap(nodeRects[i].r, nodeRects[j].r, -8),
            `nodes ${nodeRects[i].id} and ${nodeRects[j].id} are at least 8px apart`,
          );
        }
      }

      const labelRects = [];
      model.edges.forEach((e) => {
        const route = layout.edges[e.id];
        assert.ok(route, `edge ${e.id} routed`);
        assert.ok(route.points.length >= 2, `edge ${e.id} has points`);
        route.points.forEach((p) => assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y)));
        const src = nodeRects.find((n) => n.id === e.source).r;
        const tgt = nodeRects.find((n) => n.id === e.target).r;
        const first = route.points[0];
        const last = route.points[route.points.length - 1];
        assert.ok(Math.abs(distanceToRectBorder(first, src)) < 1.5, `edge ${e.id} starts on its source border`);
        assert.ok(Math.abs(distanceToRectBorder(last, tgt)) < 1.5, `edge ${e.id} ends on its target border`);
        if (e.isSelfLoop) {
          assert.equal(route.curve, 'rounded');
          route.points.slice(1, -1).forEach((p) => {
            assert.ok(
              p.x <= src.x1 || p.x >= src.x2 || p.y <= src.y1 || p.y >= src.y2,
              `self-loop ${e.id} goes around its node`,
            );
          });
        }
        if (e.labelWidth) {
          assert.ok(route.labelPos, `edge ${e.id} has a label position`);
          labelRects.push({ id: e.id, r: rect(route.labelPos, { width: e.labelWidth, height: e.labelHeight }) });
        } else {
          assert.equal(route.labelPos, null);
        }
      });
      labelRects.forEach((l) => {
        nodeRects.forEach((n) => {
          assert.ok(!CWG.geometry.rectsOverlap(l.r, n.r, 1), `label ${l.id} does not cover node ${n.id}`);
        });
      });
      for (let i = 0; i < labelRects.length; i++) {
        for (let j = i + 1; j < labelRects.length; j++) {
          assert.ok(
            !CWG.geometry.rectsOverlap(labelRects[i].r, labelRects[j].r, 1),
            `labels ${labelRects[i].id} and ${labelRects[j].id} do not overlap`,
          );
        }
      }
    });
  }
}

test('geometry: paths', () => {
  const G = CWG.geometry;
  assert.equal(
    G.basisPath([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
    'M0,0L10,0',
  );
  const d = G.basisPath([
    { x: 0, y: 0 },
    { x: 0, y: 30 },
    { x: 30, y: 30 },
    { x: 30, y: 60 },
  ]);
  assert.ok(d.startsWith('M0,0') && d.endsWith('L30,60') && d.includes('C'));
  const r = G.roundedPath(
    [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
    ],
    6,
  );
  assert.equal(r, 'M0,0L14,0Q20,0 20,6L20,20');
  const s = G.shortenEnd(
    [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
    ],
    6,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(s)), [
    { x: 0, y: 0 },
    { x: 0, y: 94 },
  ]);
});

test('geometry: fit and zoom', () => {
  const G = CWG.geometry;
  assert.equal(G.fitTransform(100, 100, 0, 500), null);
  const big = G.fitTransform(2000, 1000, 1000, 600, { padding: 0, minScale: 0.1, maxScale: 1 });
  assert.equal(big.scale, 0.5);
  assert.equal(big.x, 0);
  assert.equal(big.y, 50);
  const small = G.fitTransform(100, 100, 1000, 600, { padding: 0 });
  assert.equal(small.scale, 1, 'small graphs are not enlarged');
  const t = { scale: 1, x: 10, y: 20 };
  const z = G.zoomAround(t, 2, 110, 120);
  assert.equal((110 - z.x) / z.scale, (110 - t.x) / t.scale, 'the point under the cursor does not move');
  assert.equal((120 - z.y) / z.scale, (120 - t.y) / t.scale);
});
