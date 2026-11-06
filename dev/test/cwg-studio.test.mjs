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

// Unit tests of the "studio" layout (layouts/cwg-layout-studio.js), run with:
// node --test dev/test
// The production files are loaded as is into a VM context, no npm dependency is needed.
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

const ALL_FILES = [
  'common/cwg-core.js',
  'common/cwg-geometry.js',
  'vendor/dagre.min.js',
  'layouts/cwg-layout-auto.js',
  'layouts/cwg-layout-studio.js',
];

function load(files) {
  const ctx = { structuredClone, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  (files || ALL_FILES).forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(webDir, f), 'utf8'), ctx, { filename: f }),
  );
  return ctx.NuxeoLabs.CustomWorkflowGraph;
}

const CWG = load();
const studio = CWG.getLayout('studio');
const I = studio._internals;

function rect(center, size, margin) {
  const m = margin || 0;
  return {
    x1: center.x - size.width / 2 - m,
    y1: center.y - size.height / 2 - m,
    x2: center.x + size.width / 2 + m,
    y2: center.y + size.height / 2 + m,
  };
}

// True when the segment a-b goes through the interior of r (touching the border is allowed).
function segmentCrosses(a, b, r) {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return maxX > r.x1 + 0.5 && minX < r.x2 - 0.5 && maxY > r.y1 + 0.5 && minY < r.y2 - 0.5;
}

function node(id, x, y, extra) {
  return Object.assign({ id, title: id, x, y, state: 'ready' }, extra || {});
}

/* ==================== Studio coordinates ==================== */

test('studio paths: relative to the anchors box, first point on the bottom edge of the source', () => {
  const model = CWG.buildModel(samples.serial.graph);
  const items = new Map(I.studioItems(model).map((it) => [it.id, it]));
  const withPath = model.edges.filter((e) => e.studioPath.length >= 3);
  assert.equal(withPath.length, 7);
  withPath.forEach((e) => {
    const src = items.get(e.source);
    const tgt = items.get(e.target);
    const abs = I.absoluteStudioPath(e, tgt);
    const first = abs[0];
    const last = abs[abs.length - 1];
    assert.equal(first.y, src.y + src.size, `${e.id} starts on the bottom edge of ${e.source}`);
    assert.ok(first.x >= src.x && first.x <= src.x + src.size, `${e.id} starts within the width of the source`);
    assert.deepEqual({ ...last }, { x: tgt.x + tgt.size / 2, y: tgt.y }, `${e.id} ends at the top center`);
  });
  // "Review Start" of SerialDocumentReview, checked by hand against the Studio drawing
  const review = model.edges.find((e) => e.label === 'Review Start');
  assert.deepEqual(
    I.absoluteStudioPath(review, items.get(review.target)).map((p) => ({ ...p })),
    [
      { x: 460, y: 180 },
      { x: 460, y: 204 },
      { x: 280, y: 204 },
      { x: 280, y: 280 },
    ],
  );
  // MainWF was drawn by an older Studio (taller boxes): x matches, the source end is 30px lower
  const main = CWG.buildModel(samples.subWorkflow.graph);
  const mainItems = new Map(I.studioItems(main).map((it) => [it.id, it]));
  main.edges
    .filter((e) => e.studioPath.length >= 3)
    .forEach((e) => {
      const src = mainItems.get(e.source);
      const first = I.absoluteStudioPath(e, mainItems.get(e.target))[0];
      assert.ok(first.x >= src.x && first.x <= src.x + src.size);
      assert.ok(Math.abs(first.y - (src.y + src.size)) <= 30);
    });
  // paths of less than 3 points are ignored, as in Web UI
  assert.equal(I.absoluteStudioPath({ studioPath: [{ x: 0, y: 0 }, { x: 0, y: 10 }] }, items.get('Task542')), null);
});

/* ==================== Fallback ==================== */

test('fallback to auto: all nodes at the same position, overlapping boxes', () => {
  const graph = {
    nodes: [node('a', 0, 0, { isStartNode: true }), node('b', 0, 0), node('c', 0, 0, { isEndNode: true })],
    transitions: [
      { nodeSourceId: 'a', nodeTargetId: 'b', label: 'go' },
      { nodeSourceId: 'b', nodeTargetId: 'c', label: 'end' },
    ],
  };
  const model = CWG.buildModel(graph);
  const r = studio.compute(model, { direction: 'TB' });
  assert.deepEqual({ ...r.fallback }, { layout: 'auto', reason: 'same-position' });
  model.nodes.forEach((n) => assert.ok(Number.isFinite(r.nodes[n.id].x) && Number.isFinite(r.nodes[n.id].y)));

  graph.nodes[1] = node('b', 10, 100);
  graph.nodes[2] = node('c', 30, 130, { isEndNode: true });
  const overlap = studio.compute(CWG.buildModel(graph), { direction: 'TB' });
  assert.equal(overlap.fallback.layout, 'auto');
  assert.match(overlap.fallback.reason, /^overlapping-boxes: b, c$/);

  // coordinates missing from the JSON: buildModel puts them at 0, which is the same-position case
  const missing = CWG.buildModel({ nodes: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], transitions: [] });
  assert.equal(studio.compute(missing, {}).fallback.reason, 'same-position');
});

test('no fallback for a single node or an empty graph', () => {
  const one = studio.compute(CWG.buildModel({ nodes: [node('a', 120, 40)], transitions: [] }), {});
  assert.equal(one.fallback, undefined);
  assert.deepEqual({ ...one.nodes.a }, { x: CWG.METRICS.card.width / 2, y: CWG.METRICS.card.minHeight / 2 });
  const empty = studio.compute(CWG.buildModel({ nodes: [], transitions: [] }), {});
  assert.equal(empty.width, 0);
  assert.equal(empty.height, 0);
});

test('fallback impossible without dagre: the layout throws (Web UI default graph is then used)', () => {
  const C = load(['common/cwg-core.js', 'common/cwg-geometry.js', 'layouts/cwg-layout-auto.js',
    'layouts/cwg-layout-studio.js']);
  assert.deepEqual([...C.listLayouts().map((l) => l.name)], ['studio']);
  const model = C.buildModel({ nodes: [node('a', 0, 0), node('b', 0, 0)], transitions: [] });
  assert.throws(() => C.getLayout('studio').compute(model, {}), /auto layout is not available/);
  // usable Studio positions do not need dagre
  const ok = C.buildModel(samples.serial.graph);
  assert.equal(C.getLayout('studio').compute(ok, {}).fallback, undefined);
});

/* ==================== Samples ==================== */

// Checks shared by every graph: no overlapping cards, Studio order kept, orthogonal routes from the bottom of
// the source to the top of the target that cross no card, labels covering neither cards nor other labels.
function checkLayout(model, layout, name) {
  assert.equal(layout.fallback, undefined, `${name}: no fallback`);
  assert.ok(layout.width > 0 && layout.height > 0);
  const items = new Map(I.studioItems(model).map((it) => [it.id, it]));
  const cards = new Map();
  model.nodes.forEach((n) => {
    const p = layout.nodes[n.id];
    const r = rect(p, n);
    assert.ok(r.x1 >= -0.5 && r.y1 >= -0.5 && r.x2 <= layout.width + 0.5 && r.y2 <= layout.height + 0.5);
    cards.set(n.id, r);
  });
  const ids = [...cards.keys()];
  ids.forEach((a, i) =>
    ids.slice(i + 1).forEach((b) => {
      assert.ok(!CWG.geometry.rectsOverlap(cards.get(a), cards.get(b), -8), `${name}: ${a} and ${b} 8px apart`);
      const sa = items.get(a);
      const sb = items.get(b);
      const pa = layout.nodes[a];
      const pb = layout.nodes[b];
      if (Math.abs(sa.cx - sb.cx) > 20) {
        assert.equal(sa.cx < sb.cx, pa.x < pb.x, `${name}: left/right order of ${a} and ${b} kept`);
      }
      if (Math.abs(sa.cy - sb.cy) > 20) {
        assert.equal(sa.cy < sb.cy, pa.y < pb.y, `${name}: above/below order of ${a} and ${b} kept`);
      }
    }),
  );
  const labels = [];
  model.edges.forEach((e) => {
    const route = layout.edges[e.id];
    const pts = route.points;
    assert.equal(route.curve, 'rounded');
    assert.ok(pts.length >= 2 && pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      assert.ok(Math.abs(a.x - b.x) < 0.5 || Math.abs(a.y - b.y) < 0.5, `${name}: ${e.id} is orthogonal`);
      cards.forEach((r, id) => assert.ok(!segmentCrosses(a, b, r), `${name}: ${e.id} does not cross ${id}`));
    }
    const src = cards.get(e.source);
    const tgt = cards.get(e.target);
    const first = pts[0];
    const last = pts[pts.length - 1];
    assert.ok(Math.abs(first.y - src.y2) < 0.5 && first.x > src.x1 && first.x < src.x2, `${e.id} leaves the bottom`);
    assert.ok(Math.abs(last.y - tgt.y1) < 0.5 && last.x > tgt.x1 && last.x < tgt.x2, `${e.id} enters the top`);
    assert.ok(pts[1].y > first.y && pts[pts.length - 2].y < last.y, `${e.id} leaves and enters vertically`);
    if (e.labelWidth) {
      assert.ok(route.labelPos, `${name}: ${e.id} has a label position`);
      labels.push({ id: e.id, r: rect(route.labelPos, { width: e.labelWidth, height: e.labelHeight }) });
    } else {
      assert.equal(route.labelPos, null);
    }
  });
  labels.forEach((l, i) => {
    cards.forEach((c, id) => {
      assert.ok(!CWG.geometry.rectsOverlap(l.r, c, 1), `${name}: label ${l.id} does not cover ${id}`);
    });
    labels.slice(i + 1).forEach((m) => {
      assert.ok(!CWG.geometry.rectsOverlap(l.r, m.r, 1), `${name}: labels ${l.id} and ${m.id} do not overlap`);
    });
  });
}

for (const [name, sample] of Object.entries(samples)) {
  test(`studio layout: ${name}`, () => {
    const model = CWG.buildModel(sample.graph);
    checkLayout(model, studio.compute(model, { direction: 'TB' }), name);
    // the direction has no effect
    const lr = studio.compute(model, { direction: 'LR' });
    assert.deepEqual(JSON.parse(JSON.stringify(lr)), JSON.parse(JSON.stringify(studio.compute(model, {}))));
  });
}

test('studio layout: the paths drawn in Studio are followed', () => {
  const expected = { serial: 4, subWorkflow: 3 };
  Object.entries(expected).forEach(([name, count]) => {
    const model = CWG.buildModel(samples[name].graph);
    const layout = studio.compute(model, {});
    const items = new Map(I.studioItems(model).map((it) => [it.id, it]));
    const followed = model.edges.filter((e) => layout.edges[e.id].routing === 'studio');
    assert.ok(followed.length >= count, `${name}: ${followed.length} Studio paths followed`);
    followed.forEach((e) => {
      const drawn = I.turnSequence(I.simplify(I.absoluteStudioPath(e, items.get(e.target))));
      const seq = I.turnSequence(layout.edges[e.id].points);
      // a small jog of the Studio path may be straightened
      assert.ok(seq === drawn || (seq === 'D' && drawn.length === 3), `${name} ${e.id}: ${seq} follows ${drawn}`);
    });
  });
});

test('studio layout: self-loops drawn as in Studio, on the Studio side, nested', () => {
  const model = CWG.buildModel(samples.serial.graph);
  const layout = studio.compute(model, {});
  const n = model.nodes.find((x) => x.id === 'Task6d8');
  const card = rect(layout.nodes.Task6d8, n);
  const loops = model.edges.filter((e) => e.isSelfLoop).map((e) => layout.edges[e.id]);
  assert.equal(loops.length, 2);
  loops.forEach((l) => {
    assert.equal(l.routing, 'loop');
    assert.equal(I.turnSequence(l.points), 'DLURD', 'down, left, up, right, down into the top');
    assert.ok(l.labelPos.x < card.x1, 'label on the left side, outside the card');
  });
  const outerX = loops.map((l) => Math.min(...l.points.map((p) => p.x)));
  assert.notEqual(outerX[0], outerX[1], 'nested loops do not share their outer line');

  const contract = CWG.buildModel(samples.contract.graph);
  const reminder = contract.edges.find((e) => e.isSelfLoop);
  assert.equal(I.turnSequence(studio.compute(contract, {}).edges[reminder.id].points), 'DRULD', 'right side');
});

test('studio layout: a generated workflow of 60 steps is laid out quickly', () => {
  const nodes = [node('start', 300, 0, { isStartNode: true })];
  const transitions = [];
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 4; c++) {
      nodes.push(node(`n${r}-${c}`, 40 + c * 200, 100 + r * 140, { title: `Step ${r}.${c} of the workflow` }));
      if (r === 0) {
        transitions.push({ nodeSourceId: 'start', nodeTargetId: `n0-${c}`, label: `Branch ${c}` });
      } else {
        transitions.push({ nodeSourceId: `n${r - 1}-${c}`, nodeTargetId: `n${r}-${c}`, label: 'Next' });
        transitions.push({ nodeSourceId: `n${r - 1}-${c}`, nodeTargetId: `n${r}-${(c + 1) % 4}`, label: 'Other' });
      }
      if (r > 1 && c === 0) {
        transitions.push({ nodeSourceId: `n${r}-0`, nodeTargetId: `n${r - 2}-3`, label: 'Back' });
      }
    }
  }
  const model = CWG.buildModel({ nodes, transitions });
  const start = Date.now();
  const layout = studio.compute(model, {});
  assert.ok(Date.now() - start < 5000, `laid out in ${Date.now() - start} ms`);
  checkLayout(model, layout, 'generated');
});
