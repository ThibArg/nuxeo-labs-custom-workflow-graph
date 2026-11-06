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
 * "studio" layout: keeps the drawing made in Nuxeo Studio (positions of the steps, paths of the transitions),
 * adapted to the cards of the viewer, which are much bigger than Studio's boxes:
 *   - positions: the Studio centers are grouped in columns and rows (Studio uses a 20 px grid), the Studio
 *     distances are kept as a minimum and only the cards that would overlap are pushed apart, on the axis
 *     that needs the smallest push. Left/right and above/below relations are kept;
 *   - transitions: the path drawn in Studio is followed (orthogonal, rounded corners) when it can be mapped
 *     on the new positions without crossing a card, otherwise an orthogonal route is computed. As in Studio,
 *     edges leave a card by its bottom and enter it by its top;
 *   - self-loops are drawn as in Studio: out of the bottom, around one side, into the top;
 *   - labels are placed along the routes, without covering a card or another label.
 * Falls back to the "auto" layout when the Studio coordinates are unusable (all at the same place, overlapping
 * boxes...). The result then has a `fallback: { layout: 'auto', reason }` property (ignored by the renderer).
 *
 * Studio coordinates (Nuxeo route_node schema, Web UI nuxeo-workflow-graph, Studio workflow editor):
 *   - node x/y: top-left corner of the Studio box, in CSS px. Boxes are 80x80 (step, multiple tasks,
 *     sub-workflow) or 40x40 (start, end, fork, merge);
 *   - transition path: ends of the segments of jsPlumb's Flowchart connector, relative to the top-left corner
 *     of the box spanned by both anchors. The first point is on the bottom edge of the source, the last one is
 *     the top center of the target, so the absolute origin is "top center of the target minus the last point".
 *     Like Web UI, only paths of 3 points or more are used.
 *
 * @since 2025.1
 */
(function (root) {
  'use strict';

  const CWG = root.NuxeoLabs && root.NuxeoLabs.CustomWorkflowGraph;
  if (!CWG || CWG.getLayout('studio')) {
    return;
  }

  /* ==================== Settings ==================== */

  const STUDIO = Object.freeze({ box: 80, smallBox: 40, grid: 20 });
  const SMALL_KINDS = Object.freeze(['start', 'end', 'fork', 'merge']);

  const S = Object.freeze({
    // minimum gaps between two cards
    gapX: 56,
    gapY: 56,
    // longest distance kept between two consecutive columns (or rows): huge Studio gaps are reduced
    maxStep: 400,
    // no port closer than this to a corner of a card
    portPad: 18,
    // length of the first and last segments (an edge leaves and enters a card vertically)
    stub: 18,
    // computed routes keep this distance to the cards
    obstacleMargin: 12,
    // cost of a bend for the router, in px of length
    bendCost: 40,
    // self-loops: distance below/above the card, distance from its side, increments for nested loops
    loopDepth: 16,
    loopDepthStep: 12,
    loopOffset: 26,
    loopOffsetStep: 14,
    // free space around a label
    labelGap: 6,
    // a mapped Studio path may not come closer than this to a card it does not connect
    pathClearance: 4,
  });

  /* ==================== Helpers ==================== */

  const EPS = 0.5;

  function finite(n) {
    return typeof n === 'number' && Number.isFinite(n);
  }

  function finitePoint(p) {
    return !!p && finite(p.x) && finite(p.y);
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function studioSize(kind) {
    return SMALL_KINDS.indexOf(kind) >= 0 ? STUDIO.smallBox : STUDIO.box;
  }

  // Rectangle { x1, y1, x2, y2 } around a center.
  function boxAround(cx, cy, width, height, margin) {
    const m = margin || 0;
    return { x1: cx - width / 2 - m, y1: cy - height / 2 - m, x2: cx + width / 2 + m, y2: cy + height / 2 + m };
  }

  function inflate(r, margin) {
    return { x1: r.x1 - margin, y1: r.y1 - margin, x2: r.x2 + margin, y2: r.y2 + margin };
  }

  function overlaps(a, b) {
    return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
  }

  // True when the segment a-b goes through the interior of the rectangle (touching its border is allowed).
  function segmentHits(a, b, r) {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    if (Math.abs(a.x - b.x) < EPS) {
      return a.x > r.x1 && a.x < r.x2 && maxY > r.y1 && minY < r.y2;
    }
    if (Math.abs(a.y - b.y) < EPS) {
      return a.y > r.y1 && a.y < r.y2 && maxX > r.x1 && minX < r.x2;
    }
    // not orthogonal (never produced here): conservative test on the bounding box
    return maxX > r.x1 && minX < r.x2 && maxY > r.y1 && minY < r.y2;
  }

  function isOrthogonal(points) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (Math.abs(a.x - b.x) >= EPS && Math.abs(a.y - b.y) >= EPS) {
        return false;
      }
    }
    return true;
  }

  // Removes repeated points and the middle points of straight runs.
  function simplify(points) {
    const out = [];
    points.forEach((p) => {
      const last = out[out.length - 1];
      if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS) {
        return;
      }
      out.push({ x: p.x, y: p.y });
    });
    for (let i = out.length - 2; i >= 1; i--) {
      const a = out[i - 1];
      const b = out[i];
      const c = out[i + 1];
      const vertical = Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS;
      const horizontal = Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS;
      if (vertical || horizontal) {
        out.splice(i, 1);
      }
    }
    return out;
  }

  // Sequence of directions of an orthogonal path, e.g. "DRD" (Down, Right, Down). Used by the tests.
  function turnSequence(points) {
    let seq = '';
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      let d;
      if (Math.abs(a.x - b.x) < EPS) {
        d = b.y > a.y ? 'D' : 'U';
      } else {
        d = b.x > a.x ? 'R' : 'L';
      }
      if (seq[seq.length - 1] !== d) {
        seq += d;
      }
    }
    return seq;
  }

  function pathLength(points) {
    let len = 0;
    for (let i = 1; i < points.length; i++) {
      len += Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
    }
    return len;
  }

  /* ==================== Studio data ==================== */

  // Studio box (top-left corner and size) and center of every node of the model.
  function studioItems(model) {
    return model.nodes.map((n) => {
      const size = studioSize(n.kind);
      const x = n.studio ? n.studio.x : NaN;
      const y = n.studio ? n.studio.y : NaN;
      return { node: n, id: n.id, size, x, y, cx: x + size / 2, cy: y + size / 2 };
    });
  }

  function studioBox(item) {
    return { x1: item.x, y1: item.y, x2: item.x + item.size, y2: item.y + item.size };
  }

  // Returns null when the Studio positions can be used, otherwise the reason of the fallback.
  function unusableReason(items) {
    if (items.some((it) => !finite(it.x) || !finite(it.y))) {
      return 'invalid-coordinates';
    }
    if (items.length < 2) {
      return null;
    }
    const first = items[0];
    if (items.every((it) => it.x === first.x && it.y === first.y)) {
      return 'same-position';
    }
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (overlaps(studioBox(items[i]), studioBox(items[j]))) {
          return `overlapping-boxes: ${items[i].id}, ${items[j].id}`;
        }
      }
    }
    return null;
  }

  /**
   * Absolute Studio coordinates of the path drawn for a transition, or null when there is no usable path.
   * The points are relative to the box spanned by the two anchors; the last point is the target anchor, which
   * is always the top center of the target box.
   */
  function absoluteStudioPath(edge, target) {
    const path = edge.studioPath;
    if (!Array.isArray(path) || path.length < 3 || !path.every(finitePoint)) {
      return null;
    }
    const last = path[path.length - 1];
    const ox = target.cx - last.x;
    const oy = target.y - last.y;
    return path.map((p) => ({ x: p.x + ox, y: p.y + oy }));
  }

  /* ==================== Positions ==================== */

  // Groups the values that are less than one grid step apart. Returns the centers of the groups (ascending)
  // and the index of the group of a value.
  function clusterAxis(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const groups = [];
    sorted.forEach((v) => {
      const g = groups[groups.length - 1];
      if (g && v - g.first <= STUDIO.grid) {
        g.values.push(v);
      } else {
        groups.push({ first: v, values: [v] });
      }
    });
    const lookup = new Map();
    const centers = groups.map((g, i) => {
      g.values.forEach((v) => lookup.set(v, i));
      return g.values.reduce((sum, v) => sum + v, 0) / g.values.length;
    });
    return { centers, indexOf: (v) => lookup.get(v) };
  }

  function squareMatrix(n) {
    return Array.from({ length: n }, () => new Array(n).fill(0));
  }

  // Positions along one axis: consecutive groups keep their Studio distance (capped), and every separation
  // constraint sep[a][b] (a < b) is honored. Constraints only go forward, so one pass is enough.
  function solveAxis(centers, sep) {
    const pos = [];
    centers.forEach((c, i) => {
      if (i === 0) {
        pos.push(0);
        return;
      }
      let v = pos[i - 1] + Math.min(c - centers[i - 1], S.maxStep);
      for (let a = 0; a < i; a++) {
        if (sep[a][i]) {
          v = Math.max(v, pos[a] + sep[a][i]);
        }
      }
      pos.push(v);
    });
    return pos;
  }

  /*
   * Computes the center of every card. `item.room` is the room needed around the card (card size plus the
   * self-loops), { left, right, top, bottom } from the center. Two cards that could overlap are separated on
   * the axis that needs the smallest relative push: same column => vertically, same row => horizontally. Cards
   * linked by a transition going down are always separated vertically: the edge leaves the bottom of the source
   * and enters the top of the target, so it needs that room. `links` holds "sourceId|targetId" keys and
   * `minGaps` (Map(row -> px)) the minimum free space below a row, see crowdedGaps().
   * Returns { X, Y, cols, rows } and sets item.col, item.row, item.px, item.py.
   */
  function placeNodes(items, links, minGaps) {
    const cols = clusterAxis(items.map((it) => it.cx));
    const rows = clusterAxis(items.map((it) => it.cy));
    items.forEach((it) => {
      it.col = cols.indexOf(it.cx);
      it.row = rows.indexOf(it.cy);
    });
    const sepX = squareMatrix(cols.centers.length);
    const sepY = squareMatrix(rows.centers.length);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        const [l, r] = a.col <= b.col ? [a, b] : [b, a];
        const [t, u] = a.row <= b.row ? [a, b] : [b, a];
        const needX = l.room.right + r.room.left + S.gapX;
        const needY = t.room.bottom + u.room.top + S.gapY;
        let horizontal;
        if (a.col === b.col) {
          horizontal = false;
        } else if (a.row === b.row) {
          horizontal = true;
        } else if (links.has(`${t.id}|${u.id}`)) {
          horizontal = false;
        } else {
          const dx = cols.centers[r.col] - cols.centers[l.col];
          const dy = rows.centers[u.row] - rows.centers[t.row];
          horizontal = needX / dx <= needY / dy;
        }
        if (horizontal) {
          sepX[l.col][r.col] = Math.max(sepX[l.col][r.col], needX);
        } else {
          sepY[t.row][u.row] = Math.max(sepY[t.row][u.row], needY);
        }
      }
    }
    minGaps.forEach((gap, r) => {
      if (r + 1 >= rows.centers.length) {
        return;
      }
      const bottom = Math.max(...items.filter((it) => it.row === r).map((it) => it.room.bottom));
      const top = Math.max(...items.filter((it) => it.row === r + 1).map((it) => it.room.top));
      sepY[r][r + 1] = Math.max(sepY[r][r + 1], bottom + top + gap);
    });
    const X = solveAxis(cols.centers, sepX);
    const Y = solveAxis(rows.centers, sepY);
    items.forEach((it) => {
      it.px = X[it.col];
      it.py = Y[it.row];
    });
    return { X, Y, cols, rows };
  }

  /* ==================== Ports and self-loops ==================== */

  // Side of a self-loop (-1 left, 1 right): the side drawn in Studio when the path is known, otherwise the
  // right side, unless only the right side has a neighbor on the same row.
  function loopSide(edge, item, items) {
    const path = absoluteStudioPath(edge, item);
    if (path) {
      const left = item.x - Math.min(...path.map((p) => p.x));
      const right = Math.max(...path.map((p) => p.x)) - (item.x + item.size);
      if (left > 0 || right > 0) {
        return left > right ? -1 : 1;
      }
    }
    const sameRow = items.filter((o) => o !== item && Math.abs(o.cy - item.cy) < STUDIO.box);
    const rightBusy = sameRow.some((o) => o.cx > item.cx);
    const leftBusy = sameRow.some((o) => o.cx < item.cx);
    return rightBusy && !leftBusy ? -1 : 1;
  }

  /*
   * Plans the self-loops of every node: side, nesting index (0 = closest to the card), distance from the side
   * (far enough for the label, centered on the outer vertical line, not to cover the card or the previous loop)
   * and depth below/above the card. Sets item.loops and item.room (room needed around the center).
   */
  function planLoops(model, items, byId) {
    items.forEach((it) => {
      const n = it.node;
      it.loops = [];
      it.room = { left: n.width / 2, right: n.width / 2, top: n.height / 2, bottom: n.height / 2 };
    });
    model.edges
      .filter((e) => e.isSelfLoop)
      .forEach((e) => {
        const it = byId.get(e.source);
        it.loops.push({ edge: e, side: loopSide(e, it, items) });
      });
    items.forEach((it) => {
      [-1, 1].forEach((side) => {
        let prevOffset = 0;
        let prevHalf = 0;
        it.loops
          .filter((l) => l.side === side)
          .forEach((loop, i) => {
            const half = loop.edge.labelWidth ? loop.edge.labelWidth / 2 : 0;
            let offset = Math.max(S.loopOffset, half + S.labelGap);
            if (i > 0) {
              offset = Math.max(offset, prevOffset + S.loopOffsetStep, prevOffset + prevHalf + half + S.labelGap);
            }
            loop.index = i;
            loop.offset = offset;
            loop.half = half;
            loop.depth = S.loopDepth + i * S.loopDepthStep;
            prevOffset = offset;
            prevHalf = half;
            const key = side < 0 ? 'left' : 'right';
            it.room[key] = Math.max(it.room[key], it.node.width / 2 + offset + half);
            it.room.top = Math.max(it.room.top, it.node.height / 2 + loop.depth);
            it.room.bottom = Math.max(it.room.bottom, it.node.height / 2 + loop.depth);
          });
      });
    });
  }

  // Card rectangle of a placed item.
  function cardRect(it, margin) {
    return boxAround(it.px, it.py, it.node.width, it.node.height, margin);
  }

  /*
   * Ports of the edges, spread on the cards so that edges do not cross when they leave or enter a card.
   *   - Bottom ports (outgoing): ordered by the direction the edge heads to in Studio (x reached after the
   *     first turn of the Studio path, else x of the target). Self-loops take the ports closest to their side,
   *     the innermost loop the outermost port, so nested loops do not cross.
   *   - Top ports (incoming): ordered by the direction the edge comes from in Studio (x before the last turn of
   *     the path, else x of the source), spread around the center of the card (where Studio attaches them all).
   * Returns { out: Map(edgeId -> x), in: Map(edgeId -> x) }.
   */
  function assignPorts(model, items, byId) {
    const out = new Map();
    const inPorts = new Map();
    const outgoing = new Map(items.map((it) => [it.id, []]));
    const incoming = new Map(items.map((it) => [it.id, []]));
    const loopOf = new Map();
    items.forEach((it) => it.loops.forEach((l) => loopOf.set(l.edge.id, l)));
    model.edges.forEach((e) => {
      const src = byId.get(e.source);
      const tgt = byId.get(e.target);
      const loop = loopOf.get(e.id);
      if (loop) {
        outgoing.get(e.source).push({ e, key: loop.side * 1e9 - loop.side * loop.index, tie: 0 });
        return;
      }
      const abs = absoluteStudioPath(e, tgt);
      const sp = abs && simplify(abs);
      const usable = sp && sp.length >= 4 && isOrthogonal(sp);
      outgoing.get(e.source).push({
        e,
        key: usable ? sp[2].x : tgt.cx,
        tie: usable ? sp[0].x : tgt.cx,
      });
      incoming.get(e.target).push({
        e,
        key: usable ? sp[sp.length - 3].x : src.cx,
        tie: src.cx,
      });
    });
    const byKey = (a, b) => a.key - b.key || a.tie - b.tie || a.e.index - b.e.index;
    items.forEach((it) => {
      const n = it.node;
      const outs = outgoing.get(it.id).sort(byKey);
      const usable = Math.max(0, n.width - S.portPad * 2);
      const left = it.px - n.width / 2 + Math.min(S.portPad, n.width / 2);
      outs.forEach((w, j) => out.set(w.e.id, left + ((j + 0.5) / outs.length) * usable));
      const ins = incoming.get(it.id).sort(byKey);
      const half = Math.max(0, Math.min(n.width / 2 - S.portPad, 60));
      ins.forEach((w, j) => inPorts.set(w.e.id, it.px - half + ((j + 0.5) / ins.length) * 2 * half));
    });
    return { out, in: inPorts };
  }

  // Studio-style route of a self-loop: out of the bottom, down, around the side, above the card, into the top.
  function loopRoute(loop, it, portX) {
    const n = it.node;
    const side = loop.side;
    const outerX = it.px + side * (n.width / 2 + loop.offset);
    const top = it.py - n.height / 2;
    const bottom = it.py + n.height / 2;
    const topX = it.px + side * Math.max(8, n.width / 2 - S.portPad - loop.index * 10);
    const d = loop.depth;
    return {
      points: [
        { x: portX, y: bottom },
        { x: portX, y: bottom + d },
        { x: outerX, y: bottom + d },
        { x: outerX, y: top - d },
        { x: topX, y: top - d },
        { x: topX, y: top },
      ],
      curve: 'rounded',
      labelPos: loop.edge.labelWidth ? { x: outerX, y: it.py } : null,
      routing: 'loop',
    };
  }

  // Area taken by the self-loops of a side of a card (lines and labels), used as an obstacle by the routes.
  function loopAreas(it) {
    const areas = [];
    [-1, 1].forEach((side) => {
      const loops = it.loops.filter((l) => l.side === side);
      if (!loops.length) {
        return;
      }
      const n = it.node;
      const reach = Math.max(...loops.map((l) => l.offset + l.half));
      const depth = Math.max(...loops.map((l) => l.depth));
      const edgeX = it.px + side * (n.width / 2);
      const outerX = edgeX + side * reach;
      areas.push({
        x1: Math.min(edgeX, outerX),
        x2: Math.max(edgeX, outerX),
        y1: it.py - n.height / 2 - depth,
        y2: it.py + n.height / 2 + depth,
      });
    });
    return areas;
  }

  /* ==================== Studio paths ==================== */

  /*
   * Piecewise-linear map of a Studio coordinate to the new layout, along one axis. For every column (or row),
   * the edges of the Studio boxes are mapped to the edges of the biggest card, so a point drawn beside a box
   * in Studio stays beside the card. Beyond the first/last column, distances are kept as is. When cards of
   * neighbor columns overlap on this axis (they are on different rows), the map is kept increasing and the
   * route check decides whether the mapped path is still usable.
   */
  function axisMap(items, groupKey, centers, positions, cardSize) {
    const groups = centers.map((c, i) => ({ s: c, m: positions[i], sh: 0, ch: 0 }));
    items.forEach((it) => {
      const g = groups[it[groupKey]];
      g.sh = Math.max(g.sh, it.size / 2);
      g.ch = Math.max(g.ch, it.node[cardSize] / 2);
    });
    const raw = [];
    groups.forEach((g) => {
      raw.push({ s: g.s - g.sh, m: g.m - g.ch }, { s: g.s, m: g.m }, { s: g.s + g.sh, m: g.m + g.ch });
    });
    raw.sort((a, b) => a.s - b.s || a.m - b.m);
    const pts = [];
    raw.forEach((p) => {
      const prev = pts[pts.length - 1];
      if (!prev) {
        pts.push({ s: p.s, m: p.m });
      } else if (p.s - prev.s >= EPS) {
        pts.push({ s: p.s, m: Math.max(p.m, prev.m + 0.05 * (p.s - prev.s)) });
      }
    });
    return function map(v) {
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (v <= first.s) {
        return first.m + (v - first.s);
      }
      if (v >= last.s) {
        return last.m + (v - last.s);
      }
      let i = 1;
      while (pts[i].s < v) {
        i++;
      }
      const a = pts[i - 1];
      const b = pts[i];
      return a.m + ((v - a.s) / (b.s - a.s)) * (b.m - a.m);
    };
  }

  function leavesDown(points) {
    const a = points[0];
    const b = points[1];
    return Math.abs(a.x - b.x) < EPS && b.y > a.y;
  }

  function entersDown(points) {
    const a = points[points.length - 2];
    const b = points[points.length - 1];
    return Math.abs(a.x - b.x) < EPS && b.y > a.y;
  }

  /*
   * Maps the absolute Studio path of a transition on the new layout and attaches its ends to the ports (bottom
   * port of the source, top port of the target), keeping the segments horizontal or vertical. Returns the
   * points, or null when the Studio path cannot give a clean route (the edge is then routed by us).
   */
  function mapStudioPath(abs, maps, src, tgt, portX, inX) {
    const sp = simplify(abs);
    if (sp.length < 4 || !isOrthogonal(sp) || !leavesDown(sp) || !entersDown(sp)) {
      return null;
    }
    const m = sp.map((p) => ({ x: maps.x(p.x), y: maps.y(p.y) }));
    const n = m.length;
    const bottom = src.py + src.node.height / 2;
    const top = tgt.py - tgt.node.height / 2;
    const minY = bottom + S.stub;
    const maxY = top - S.stub;
    m[0] = { x: portX, y: bottom };
    m[1].x = portX;
    m[n - 1] = { x: inX, y: top };
    m[n - 2].x = inX;
    if (n === 4) {
      if (minY > maxY) {
        return null;
      }
      m[1].y = clamp(m[1].y, minY, maxY);
      m[2].y = m[1].y;
    } else {
      m[1].y = Math.max(m[1].y, minY);
      m[2].y = m[1].y;
      m[n - 2].y = Math.min(m[n - 2].y, maxY);
      m[n - 3].y = m[n - 2].y;
    }
    const out = simplify(m);
    if (out.length < 2 || !isOrthogonal(out) || !leavesDown(out) || !entersDown(out)) {
      return null;
    }
    return out;
  }

  /*
   * True when the route does not go through a card or a self-loop area. The first segment may touch its source
   * card and the last one its target card; obstacles are { id, rect, loop }.
   */
  function routeIsClear(points, obstacles, sourceId, targetId) {
    const last = points.length - 2;
    for (let i = 0; i <= last; i++) {
      const a = points[i];
      const b = points[i + 1];
      for (const o of obstacles) {
        if (!o.loop && ((i === 0 && o.id === sourceId) || (i === last && o.id === targetId))) {
          continue;
        }
        if (segmentHits(a, b, o.rect)) {
          return false;
        }
      }
    }
    return true;
  }

  /* ==================== Router ==================== */

  // Kinds of grid lines, lower is preferred: port/stub lines, lines halfway between obstacles, obstacle borders.
  const LINE_PORT = 0;
  const LINE_MID = 1;
  const LINE_BORDER = 2;
  // Directions: right, left, down, up (d ^ 1 is the opposite direction).
  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const DOWN = 2;

  function mergeCoords(entries) {
    const sorted = entries.slice().sort((a, b) => a.v - b.v);
    const out = [];
    sorted.forEach((e) => {
      const last = out[out.length - 1];
      if (last && e.v - last.v < EPS) {
        last.kind = Math.min(last.kind, e.kind);
        return;
      }
      out.push({ v: e.v, kind: e.kind });
    });
    return out;
  }

  // Adds lanes (lines) between two border lines that are far enough apart: one every ~28 px, at most 6.
  function withMidLines(coords) {
    const out = [];
    coords.forEach((c, i) => {
      const prev = coords[i - 1];
      if (prev) {
        const gap = c.v - prev.v;
        const count = Math.min(6, Math.floor(gap / 28));
        for (let t = 1; t <= count; t++) {
          out.push({ v: prev.v + (gap * t) / (count + 1), kind: LINE_MID });
        }
      }
      out.push(c);
    });
    return out;
  }

  function nearestIndex(values, v) {
    let lo = 0;
    let hi = values.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[mid] < v) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0 && Math.abs(values[lo - 1] - v) < Math.abs(values[lo] - v)) {
      return lo - 1;
    }
    return lo;
  }

  /*
   * Orthogonal router on a sparse grid. The grid lines are the borders of the obstacles (cards with a margin,
   * self-loop areas), the lines halfway between them and the port/stub lines. Routes follow the grid lines,
   * never cross an obstacle, and minimize length + bends (A*), with an extra cost for running along an
   * obstacle border and for sharing a line already used by another route (`fixedRoutes`: Studio paths and
   * self-loops, then every computed route).
   */
  function createRouter(rects, xPorts, yPorts, fixedRoutes) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    rects.forEach((r) => {
      minX = Math.min(minX, r.x1);
      minY = Math.min(minY, r.y1);
      maxX = Math.max(maxX, r.x2);
      maxY = Math.max(maxY, r.y2);
    });
    const frame = 60;
    const xb = [
      { v: minX - frame, kind: LINE_MID },
      { v: maxX + frame, kind: LINE_MID },
    ];
    const yb = [
      { v: minY - frame, kind: LINE_MID },
      { v: maxY + frame, kind: LINE_MID },
    ];
    rects.forEach((r) => {
      xb.push({ v: r.x1, kind: LINE_BORDER }, { v: r.x2, kind: LINE_BORDER });
      yb.push({ v: r.y1, kind: LINE_BORDER }, { v: r.y2, kind: LINE_BORDER });
    });
    // the lines of the fixed routes are grid lines too, so their use can be recorded
    const fixedX = [];
    const fixedY = [];
    fixedRoutes.forEach((points) =>
      points.forEach((p) => {
        fixedX.push({ v: p.x, kind: LINE_MID });
        fixedY.push({ v: p.y, kind: LINE_MID });
      }),
    );
    const xs = mergeCoords(
      withMidLines(mergeCoords(xb)).concat(
        xPorts.map((v) => ({ v, kind: LINE_PORT })),
        fixedX,
      ),
    );
    const ys = mergeCoords(
      withMidLines(mergeCoords(yb)).concat(
        yPorts.map((v) => ({ v, kind: LINE_PORT })),
        fixedY,
      ),
    );
    const X = xs.map((c) => c.v);
    const Y = ys.map((c) => c.v);
    const nx = X.length;
    const ny = Y.length;
    const blockedP = new Uint8Array(nx * ny);
    const blockedH = new Uint8Array(nx * ny);
    const blockedV = new Uint8Array(nx * ny);
    const useH = new Float32Array(nx * ny);
    const useV = new Float32Array(nx * ny);

    // Records the grid edges covered by a route made of grid lines.
    function markUsed(points) {
      for (let k = 1; k < points.length; k++) {
        const a = points[k - 1];
        const b = points[k];
        const ia = nearestIndex(X, a.x);
        const ib = nearestIndex(X, b.x);
        const ja = nearestIndex(Y, a.y);
        const jb = nearestIndex(Y, b.y);
        if (ia === ib) {
          for (let j = Math.min(ja, jb); j < Math.max(ja, jb); j++) {
            useV[j * nx + ia] += 1;
          }
        } else if (ja === jb) {
          for (let i = Math.min(ia, ib); i < Math.max(ia, ib); i++) {
            useH[ja * nx + i] += 1;
          }
        }
      }
    }
    fixedRoutes.forEach(markUsed);

    rects.forEach((r) => {
      for (let j = 0; j < ny; j++) {
        const yIn = Y[j] > r.y1 + 1e-6 && Y[j] < r.y2 - 1e-6;
        const yMidIn = j < ny - 1 && (Y[j] + Y[j + 1]) / 2 > r.y1 && (Y[j] + Y[j + 1]) / 2 < r.y2;
        if (!yIn && !yMidIn) {
          continue;
        }
        for (let i = 0; i < nx; i++) {
          const xIn = X[i] > r.x1 + 1e-6 && X[i] < r.x2 - 1e-6;
          if (yIn && xIn) {
            blockedP[j * nx + i] = 1;
          }
          if (yIn && i < nx - 1 && (X[i] + X[i + 1]) / 2 > r.x1 && (X[i] + X[i + 1]) / 2 < r.x2) {
            blockedH[j * nx + i] = 1;
          }
          if (yMidIn && xIn) {
            blockedV[j * nx + i] = 1;
          }
        }
      }
    });

    const states = nx * ny * 4;
    const cost = new Float64Array(states);
    const prev = new Int32Array(states);
    const seen = new Uint32Array(states);
    let generation = 0;

    function search(si, sj, gi, gj, pad) {
      generation++;
      const loX = Math.min(X[si], X[gi]) - pad;
      const hiX = Math.max(X[si], X[gi]) + pad;
      const loY = Math.min(Y[sj], Y[gj]) - pad;
      const hiY = Math.max(Y[sj], Y[gj]) + pad;
      const goalX = X[gi];
      const goalY = Y[gj];
      const heapF = [];
      const heapS = [];
      const push = (f, s) => {
        let k = heapF.length;
        heapF.push(f);
        heapS.push(s);
        while (k > 0) {
          const parent = (k - 1) >> 1;
          if (heapF[parent] <= f) {
            break;
          }
          heapF[k] = heapF[parent];
          heapS[k] = heapS[parent];
          k = parent;
        }
        heapF[k] = f;
        heapS[k] = s;
      };
      const pop = () => {
        const top = heapS[0];
        const lastF = heapF.pop();
        const lastS = heapS.pop();
        if (heapF.length) {
          let k = 0;
          const n = heapF.length;
          for (;;) {
            let c = 2 * k + 1;
            if (c >= n) {
              break;
            }
            if (c + 1 < n && heapF[c + 1] < heapF[c]) {
              c++;
            }
            if (heapF[c] >= lastF) {
              break;
            }
            heapF[k] = heapF[c];
            heapS[k] = heapS[c];
            k = c;
          }
          heapF[k] = lastF;
          heapS[k] = lastS;
        }
        return top;
      };
      const start = (sj * nx + si) * 4 + DOWN;
      seen[start] = generation;
      cost[start] = 0;
      prev[start] = -1;
      push(Math.abs(X[si] - goalX) + Math.abs(Y[sj] - goalY), start);
      while (heapF.length) {
        const f = heapF[0];
        const s = pop();
        const dir = s & 3;
        const p = s >> 2;
        const i = p % nx;
        const j = (p - i) / nx;
        const g = cost[s];
        if (f > g + Math.abs(X[i] - goalX) + Math.abs(Y[j] - goalY) + 1e-6) {
          continue;
        }
        if (i === gi && j === gj) {
          return { state: s, nx };
        }
        for (let d = 0; d < 4; d++) {
          if (d === (dir ^ 1)) {
            continue;
          }
          const ni = i + DIRS[d][0];
          const nj = j + DIRS[d][1];
          if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) {
            continue;
          }
          if (X[ni] < loX || X[ni] > hiX || Y[nj] < loY || Y[nj] > hiY) {
            continue;
          }
          const horizontal = d < 2;
          const edgeIndex = horizontal ? j * nx + Math.min(i, ni) : Math.min(j, nj) * nx + i;
          if ((horizontal ? blockedH : blockedV)[edgeIndex]) {
            continue;
          }
          if (blockedP[nj * nx + ni] && !(ni === gi && nj === gj)) {
            continue;
          }
          const len = Math.abs(X[ni] - X[i]) + Math.abs(Y[nj] - Y[j]);
          const line = horizontal ? ys[j].kind : xs[i].kind;
          const used = (horizontal ? useH : useV)[edgeIndex];
          const ng =
            g + len + (line === LINE_BORDER ? len * 0.3 : 0) + used * len * 2.5 + (d !== dir ? S.bendCost : 0);
          const ns = (nj * nx + ni) * 4 + d;
          if (seen[ns] !== generation || ng < cost[ns]) {
            seen[ns] = generation;
            cost[ns] = ng;
            prev[ns] = s;
            push(ng + Math.abs(X[ni] - goalX) + Math.abs(Y[nj] - goalY), ns);
          }
        }
      }
      return null;
    }

    // Route from (sx, sy) to (gx, gy), leaving downwards. Returns the grid points (corners kept) or null.
    function route(sx, sy, gx, gy) {
      const si = nearestIndex(X, sx);
      const sj = nearestIndex(Y, sy);
      const gi = nearestIndex(X, gx);
      const gj = nearestIndex(Y, gy);
      const found = search(si, sj, gi, gj, 360) || search(si, sj, gi, gj, Infinity);
      if (!found) {
        return null;
      }
      const cells = [];
      for (let s = found.state; s >= 0; s = prev[s]) {
        cells.push(s >> 2);
      }
      cells.reverse();
      for (let k = 1; k < cells.length; k++) {
        const a = cells[k - 1];
        const b = cells[k];
        if (Math.abs(a - b) === 1) {
          useH[Math.min(a, b)] += 1;
        } else {
          useV[Math.min(a, b)] += 1;
        }
      }
      return cells.map((c) => ({ x: X[c % nx], y: Y[Math.floor(c / nx)] }));
    }

    return { route };
  }

  /* ==================== Port order ==================== */

  // How a route leaves its source: group 0 turns left, 1 goes straight, 2 turns right; y of the first turn.
  function departure(pts) {
    if (pts.length < 3) {
      return { group: 1, y: 0 };
    }
    return { group: pts[2].x < pts[1].x ? 0 : 2, y: pts[1].y };
  }

  // How a route reaches its target: group 0 comes from the left, 1 from above, 2 from the right; y of the
  // last horizontal segment.
  function arrival(pts) {
    const n = pts.length;
    if (n < 3) {
      return { group: 1, y: 0 };
    }
    return { group: pts[n - 3].x < pts[n - 2].x ? 0 : 2, y: pts[n - 2].y };
  }

  function moveEnd(pts, atStart, x) {
    const n = pts.length;
    const i = atStart ? 0 : n - 1;
    if (Math.abs(pts[i].x - x) < EPS) {
      return;
    }
    if (n === 2) {
      // straight route: add a jog halfway
      const a = pts[0];
      const b = pts[1];
      const midY = (a.y + b.y) / 2;
      const ax = atStart ? x : a.x;
      const bx = atStart ? b.x : x;
      pts.splice(0, 2, { x: ax, y: a.y }, { x: ax, y: midY }, { x: bx, y: midY }, { x: bx, y: b.y });
      return;
    }
    const j = atStart ? 1 : n - 2;
    pts[i].x = x;
    pts[j].x = x;
  }

  /*
   * Reorders the ports of every card from the actual routes, so that routes do not cross next to the card:
   *   - bottom: routes turning left (the one turning closest to the card on the left), straight routes, then
   *     routes turning right (the one turning closest to the card on the right);
   *   - top: routes coming from the left (the closest horizontal on the left), routes coming from above, then
   *     routes coming from the right (the closest horizontal on the right).
   * Only the segments next to the card move. When a moved route would cross a card, the ports of this side of
   * the card are left unchanged. Self-loops keep their ports.
   */
  function untanglePorts(model, items, result, obstacles) {
    const sides = new Map();
    const add = (key, entry) => {
      if (!sides.has(key)) {
        sides.set(key, []);
      }
      sides.get(key).push(entry);
    };
    model.edges.forEach((e) => {
      if (e.isSelfLoop) {
        return;
      }
      const pts = result.edges[e.id].points;
      const out = departure(pts);
      const inn = arrival(pts);
      add(`out:${e.source}`, { e, pts, atStart: true, x: pts[0].x, group: out.group, y: out.y });
      add(`in:${e.target}`, { e, pts, atStart: false, x: pts[pts.length - 1].x, group: inn.group, y: inn.y });
    });
    sides.forEach((entries, key) => {
      if (entries.length < 2) {
        return;
      }
      const incoming = key.startsWith('in:');
      const slots = entries.map((en) => en.x).sort((a, b) => a - b);
      const order = entries.slice().sort((a, b) => {
        if (a.group !== b.group) {
          return a.group - b.group;
        }
        let byY = 0;
        if (a.group === 0) {
          byY = incoming ? b.y - a.y : a.y - b.y;
        } else if (a.group === 2) {
          byY = incoming ? a.y - b.y : b.y - a.y;
        }
        return byY || a.x - b.x || a.e.index - b.e.index;
      });
      const saved = entries.map((en) => en.pts.map((p) => ({ x: p.x, y: p.y })));
      order.forEach((en, j) => moveEnd(en.pts, en.atStart, slots[j]));
      const clear = entries.every(
        (en) => isOrthogonal(en.pts) && routeIsClear(en.pts, obstacles, en.e.source, en.e.target),
      );
      if (!clear) {
        entries.forEach((en, k) => en.pts.splice(0, en.pts.length, ...saved[k]));
      }
    });
    model.edges.forEach((e) => {
      if (!e.isSelfLoop) {
        const r = result.edges[e.id];
        const simple = simplify(r.points);
        r.points.splice(0, r.points.length, ...simple);
      }
    });
  }

  /*
   * Removes the small jogs of the routes going down from one card to another (down, a few px sideways, down):
   * one of the ports is moved in front of the other, when it stays on the card, does not come too close to
   * another port of the card and the straight route is clear.
   */
  function straightenJogs(model, byId, result, obstacles) {
    const portsOf = (id, atStart) =>
      model.edges
        .filter((e) => !e.isSelfLoop && (atStart ? e.source : e.target) === id)
        .map((e) => {
          const pts = result.edges[e.id].points;
          return { id: e.id, x: atStart ? pts[0].x : pts[pts.length - 1].x };
        });
    model.edges.forEach((e) => {
      const pts = result.edges[e.id].points;
      if (e.isSelfLoop || pts.length !== 4 || Math.abs(pts[1].x - pts[2].x) >= 24) {
        return;
      }
      // try to move the end in front of the start, then the start in front of the end
      [false, true].some((atStart) => {
        const node = byId.get(atStart ? e.source : e.target);
        const x = atStart ? pts[3].x : pts[0].x;
        const half = node.node.width / 2 - 8;
        const tooClose = portsOf(node.id, atStart).some((p) => p.id !== e.id && Math.abs(p.x - x) < 12);
        if (Math.abs(x - node.px) > half || tooClose) {
          return false;
        }
        const straight = [
          { x, y: pts[0].y },
          { x, y: pts[3].y },
        ];
        if (!routeIsClear(straight, obstacles, e.source, e.target)) {
          return false;
        }
        pts.splice(0, pts.length, ...straight);
        return true;
      });
    });
  }

  /* ==================== Labels ==================== */

  // Point at a given distance along an orthogonal route.
  function pointAlong(points, distance) {
    let left = distance;
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1];
      const b = points[k];
      const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      if (left <= len || k === points.length - 1) {
        const t = len ? clamp(left / len, 0, 1) : 0;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
      left -= len;
    }
    return { x: points[0].x, y: points[0].y };
  }

  // Number of routes (other than ownId) going through the rectangle. Routes have a precomputed bounding `box`.
  function countCrossedRoutes(rect, routes, ownId) {
    let count = 0;
    routes.forEach((r) => {
      const b = r.box;
      if (r.id === ownId || b.x1 > rect.x2 || b.x2 < rect.x1 || b.y1 > rect.y2 || b.y2 < rect.y1) {
        return;
      }
      for (let k = 1; k < r.points.length; k++) {
        if (segmentHits(r.points[k - 1], r.points[k], rect)) {
          count++;
          return;
        }
      }
    });
    return count;
  }

  function isFree(rect, cards, placed) {
    return !cards.some((c) => overlaps(rect, inflate(c, 2))) && !placed.some((l) => overlaps(rect, inflate(l, 2)));
  }

  /*
   * Position of the label of an edge: candidates along the segments of its route (centered on the line) are
   * scored by their distance to 55% of the route (Web UI puts labels at 60%), with a preference for horizontal
   * segments, a cost on the first and last segments, a high cost when the label is longer than its segment and
   * a cost for every other route the label would hide. A label never covers a card or another label, and keeps
   * away from the arrow head and the start of its own edge. When no position on the route is free, the closest
   * free position around the middle of the route is used.
   */
  function placeLabel(edge, points, cards, placed, routes) {
    const w = edge.labelWidth;
    const h = edge.labelHeight;
    const own = [cards.get(edge.source), cards.get(edge.target)].map((c) => inflate(c, 10));
    const obstacles = Array.from(cards.values()).concat(own);
    const total = pathLength(points);
    const candidates = [];
    let walked = 0;
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1];
      const b = points[k];
      const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      const horizontal = Math.abs(a.y - b.y) < EPS;
      const margin = (horizontal ? w : h) / 2 + 4;
      const fits = len >= 2 * margin;
      const stub = k === 1 || k === points.length - 1;
      [0.5, 0.35, 0.65, 0.2, 0.8].forEach((t) => {
        const dist = fits ? clamp(len * t, margin, len - margin) : len / 2;
        const ratio = len ? dist / len : 0;
        candidates.push({
          x: a.x + (b.x - a.x) * ratio,
          y: a.y + (b.y - a.y) * ratio,
          score:
            Math.abs((walked + dist) / (total || 1) - 0.55) * Math.min(total, 400) +
            (horizontal ? 0 : 16) +
            (fits ? 0 : 120) +
            (stub ? 30 : 0),
        });
      });
      walked += len;
    }
    let best = null;
    candidates.forEach((c) => {
      const rect = boxAround(c.x, c.y, w, h);
      if (!isFree(rect, obstacles, placed)) {
        return;
      }
      const score = c.score + countCrossedRoutes(rect, routes, edge.id) * 40;
      if (!best || score < best.score) {
        best = { x: c.x, y: c.y, score };
      }
    });
    if (best) {
      return { x: best.x, y: best.y };
    }
    const mid = pointAlong(points, total / 2);
    for (let r = 8; r <= 600; r += 8) {
      for (let k = 0; k < 16; k++) {
        const angle = (k / 16) * Math.PI * 2;
        const c = { x: mid.x + r * Math.cos(angle), y: mid.y + r * Math.sin(angle) };
        if (isFree(boxAround(c.x, c.y, w, h), obstacles, placed)) {
          return c;
        }
      }
    }
    return mid;
  }

  /* ==================== Layout ==================== */

  function fallbackToAuto(model, options, reason) {
    const auto = CWG.getLayout('auto');
    if (!auto || (typeof auto.isAvailable === 'function' && !auto.isAvailable())) {
      throw new Error(`The Studio positions cannot be used (${reason}) and the auto layout is not available`);
    }
    const result = auto.compute(model, options);
    result.fallback = { layout: 'auto', reason };
    return result;
  }

  // Routes the edges that have no usable Studio path, avoiding the lines of the fixed routes when possible.
  // Returns their routes, by edge id.
  function routeEdges(edges, items, byId, ports, fixedRoutes) {
    const routes = new Map();
    if (!edges.length) {
      return routes;
    }
    const rects = items.map((it) => cardRect(it, S.obstacleMargin));
    items.forEach((it) => loopAreas(it).forEach((a) => rects.push(inflate(a, S.labelGap))));
    const xPorts = [];
    const yPorts = [];
    edges.forEach((e) => {
      const src = byId.get(e.source);
      const tgt = byId.get(e.target);
      xPorts.push(ports.out.get(e.id), ports.in.get(e.id));
      yPorts.push(src.py + src.node.height / 2 + S.stub, tgt.py - tgt.node.height / 2 - S.stub);
    });
    const router = createRouter(rects, xPorts, yPorts, fixedRoutes);
    // shortest edges first: they have the fewest options
    const span = (e) => {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      return Math.abs(a.px - b.px) + Math.abs(a.py - b.py);
    };
    edges
      .slice()
      .sort((a, b) => span(a) - span(b) || a.index - b.index)
      .forEach((e) => {
        const src = byId.get(e.source);
        const tgt = byId.get(e.target);
        const portX = ports.out.get(e.id);
        const inX = ports.in.get(e.id);
        const bottom = src.py + src.node.height / 2;
        const top = tgt.py - tgt.node.height / 2;
        const grid = router.route(portX, bottom + S.stub, inX, top - S.stub);
        let points;
        if (grid) {
          points = simplify([{ x: portX, y: bottom }].concat(grid, [{ x: inX, y: top }]));
        } else {
          // no free route (should not happen): straight orthogonal connection
          const midY = (bottom + top) / 2;
          points = simplify([
            { x: portX, y: bottom },
            { x: portX, y: midY },
            { x: inX, y: midY },
            { x: inX, y: top },
          ]);
        }
        routes.set(e.id, points);
      });
    return routes;
  }

  /*
   * Gaps between two consecutive rows crossed by many horizontal segments and labels. Returns the new minimum
   * gaps (Map(row -> px), never smaller than the previous ones), or null when every gap is wide enough.
   */
  function crowdedGaps(model, items, result, minGaps) {
    const rowCount = Math.max(...items.map((it) => it.row)) + 1;
    const next = new Map(minGaps);
    let changed = false;
    for (let r = 0; r < rowCount - 1; r++) {
      const y1 = Math.max(...items.filter((it) => it.row === r).map((it) => it.py + it.node.height / 2));
      const y2 = Math.min(...items.filter((it) => it.row === r + 1).map((it) => it.py - it.node.height / 2));
      if (!(y2 > y1)) {
        continue;
      }
      let lines = 0;
      let labels = 0;
      model.edges.forEach((e) => {
        if (e.isSelfLoop) {
          return;
        }
        const route = result.edges[e.id];
        const pts = route.points;
        for (let k = 1; k < pts.length; k++) {
          const y = pts[k].y;
          if (Math.abs(pts[k - 1].y - y) < EPS && y > y1 && y < y2) {
            lines++;
          }
        }
        if (route.labelPos && route.labelPos.y > y1 && route.labelPos.y < y2) {
          labels++;
        }
      });
      const need = 2 * S.stub + lines * 12 + labels * 12;
      if (need > y2 - y1 + 1 && need > (next.get(r) || 0)) {
        next.set(r, need);
        changed = true;
      }
    }
    return changed ? next : null;
  }

  // Lays out the graph, then widens the crowded gaps between rows and lays it out again (3 passes at most, one
  // for big graphs to keep the layout fast).
  function computeStudio(model, items) {
    let minGaps = new Map();
    let result = null;
    const passes = items.length > 80 ? 1 : 3;
    for (let pass = 0; pass < passes; pass++) {
      result = computeOnce(model, items, minGaps);
      const wider = crowdedGaps(model, items, result, minGaps);
      if (!wider) {
        break;
      }
      minGaps = wider;
    }
    return result;
  }

  function computeOnce(model, items, minGaps) {
    const byId = new Map(items.map((it) => [it.id, it]));
    planLoops(model, items, byId);
    const links = new Set(model.edges.filter((e) => !e.isSelfLoop).map((e) => `${e.source}|${e.target}`));
    const grid = placeNodes(items, links, minGaps);
    const ports = assignPorts(model, items, byId);
    const maps = {
      x: axisMap(items, 'col', grid.cols.centers, grid.X, 'width'),
      y: axisMap(items, 'row', grid.rows.centers, grid.Y, 'height'),
    };
    const result = { nodes: {}, edges: {} };
    items.forEach((it) => {
      result.nodes[it.id] = { x: it.px, y: it.py };
    });
    const cards = new Map(items.map((it) => [it.id, cardRect(it)]));
    const obstacles = [];
    items.forEach((it) => {
      obstacles.push({ id: it.id, rect: cardRect(it, S.pathClearance), loop: false });
      loopAreas(it).forEach((rect) => obstacles.push({ id: it.id, rect, loop: true }));
    });

    const routes = [];
    const placed = [];
    items.forEach((it) =>
      it.loops.forEach((loop) => {
        const r = loopRoute(loop, it, ports.out.get(loop.edge.id));
        result.edges[loop.edge.id] = r;
        routes.push({ id: loop.edge.id, points: r.points });
        if (r.labelPos) {
          placed.push(boxAround(r.labelPos.x, r.labelPos.y, loop.edge.labelWidth, loop.edge.labelHeight));
        }
      }),
    );

    // follow the Studio paths that can be mapped without crossing a card, route the other edges
    const pending = [];
    model.edges.forEach((e) => {
      if (e.isSelfLoop) {
        return;
      }
      const src = byId.get(e.source);
      const tgt = byId.get(e.target);
      const abs = absoluteStudioPath(e, tgt);
      const mapped = abs && mapStudioPath(abs, maps, src, tgt, ports.out.get(e.id), ports.in.get(e.id));
      if (mapped && routeIsClear(mapped, obstacles, e.source, e.target)) {
        result.edges[e.id] = { points: mapped, curve: 'rounded', labelPos: null, routing: 'studio' };
        routes.push({ id: e.id, points: mapped });
      } else {
        pending.push(e);
      }
    });
    const fixed = routes.map((r) => r.points);
    routeEdges(pending, items, byId, ports, fixed).forEach((points, id) => {
      result.edges[id] = { points, curve: 'rounded', labelPos: null, routing: 'routed' };
      routes.push({ id, points });
    });
    untanglePorts(model, items, result, obstacles);
    straightenJogs(model, byId, result, obstacles);
    routes.forEach((r) => {
      const xs = r.points.map((p) => p.x);
      const ys = r.points.map((p) => p.y);
      r.box = { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    });

    model.edges
      .filter((e) => !e.isSelfLoop && e.labelWidth)
      .sort((a, b) => pathLength(result.edges[a.id].points) - pathLength(result.edges[b.id].points))
      .forEach((e) => {
        const r = result.edges[e.id];
        r.labelPos = placeLabel(e, r.points, cards, placed, routes);
        placed.push(boxAround(r.labelPos.x, r.labelPos.y, e.labelWidth, e.labelHeight));
      });
    return result;
  }

  function checkFinite(model, result) {
    model.nodes.forEach((n) => {
      if (!finitePoint(result.nodes[n.id])) {
        throw new Error(`No position for node ${n.id}`);
      }
    });
    model.edges.forEach((e) => {
      const r = result.edges[e.id];
      if (!r || r.points.length < 2 || !r.points.every(finitePoint) || (r.labelPos && !finitePoint(r.labelPos))) {
        throw new Error(`No route for transition ${e.id}`);
      }
    });
  }

  function compute(model, options) {
    const items = studioItems(model);
    if (!items.length) {
      return CWG.geometry.normalize(model, { nodes: {}, edges: {} });
    }
    const reason = unusableReason(items);
    if (reason) {
      return fallbackToAuto(model, options, reason);
    }
    let result;
    try {
      result = computeStudio(model, items);
      checkFinite(model, result);
    } catch (e) {
      return fallbackToAuto(model, options, `error: ${e && e.message ? e.message : e}`);
    }
    return CWG.geometry.normalize(model, result);
  }

  CWG.registerLayout('studio', {
    labelKey: 'customWorkflowGraph.layout.studio',
    supportsDirection: false,
    compute,
    // exposed for the unit tests only, not a public API
    _internals: { studioItems, unusableReason, absoluteStudioPath, simplify, turnSequence },
  });
})(typeof window !== 'undefined' ? window : globalThis);
