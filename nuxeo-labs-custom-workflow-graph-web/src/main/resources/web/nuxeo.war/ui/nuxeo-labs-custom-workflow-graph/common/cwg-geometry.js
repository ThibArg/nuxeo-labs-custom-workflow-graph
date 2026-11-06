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

// Geometry helpers shared by the layouts and the renderer: SVG path builders, self-loop routing,
// bounding boxes, fit and zoom computations. Pure functions, no DOM.
// @since 2025.1
(function (root) {
  'use strict';

  const CWG = root.NuxeoLabs && root.NuxeoLabs.CustomWorkflowGraph;
  if (!CWG || CWG.geometry) {
    return;
  }

  function fmt(n) {
    return Math.round(n * 10) / 10;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function distance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  // Smooth curve through dagre's control points: uniform B-spline, same algorithm as d3.curveBasis (the
  // curve dagre-d3 uses). It starts at the first point, ends at the last one, and its last tangent follows
  // the last segment, so the arrow marker is correctly oriented.
  function basisPath(points) {
    if (!points || points.length === 0) {
      return '';
    }
    if (points.length === 1) {
      return `M${fmt(points[0].x)},${fmt(points[0].y)}`;
    }
    let d = '';
    let x0 = NaN;
    let y0 = NaN;
    let x1 = NaN;
    let y1 = NaN;
    let state = 0;
    const bezier = (x, y) => {
      d +=
        `C${fmt((2 * x0 + x1) / 3)},${fmt((2 * y0 + y1) / 3)} ` +
        `${fmt((x0 + 2 * x1) / 3)},${fmt((y0 + 2 * y1) / 3)} ` +
        `${fmt((x0 + 4 * x1 + x) / 6)},${fmt((y0 + 4 * y1 + y) / 6)}`;
    };
    points.forEach((p) => {
      const { x, y } = p;
      switch (state) {
        case 0:
          state = 1;
          d += `M${fmt(x)},${fmt(y)}`;
          break;
        case 1:
          state = 2;
          break;
        case 2:
          state = 3;
          d += `L${fmt((5 * x0 + x1) / 6)},${fmt((5 * y0 + y1) / 6)}`;
          bezier(x, y);
          break;
        default:
          bezier(x, y);
          break;
      }
      x0 = x1;
      x1 = x;
      y0 = y1;
      y1 = y;
    });
    if (state === 3) {
      bezier(x1, y1);
    }
    d += `L${fmt(x1)},${fmt(y1)}`;
    return d;
  }

  // Polyline whose corners are rounded with the given radius (used for self-loops).
  function roundedPath(points, radius) {
    if (!points || points.length === 0) {
      return '';
    }
    let d = `M${fmt(points[0].x)},${fmt(points[0].y)}`;
    for (let i = 1; i < points.length - 1; i++) {
      const prev = points[i - 1];
      const cur = points[i];
      const next = points[i + 1];
      const l1 = distance(prev, cur);
      const l2 = distance(cur, next);
      const r = Math.min(radius, l1 / 2, l2 / 2);
      if (r <= 0.01 || l1 === 0 || l2 === 0) {
        d += `L${fmt(cur.x)},${fmt(cur.y)}`;
        continue;
      }
      const a = { x: cur.x - ((cur.x - prev.x) / l1) * r, y: cur.y - ((cur.y - prev.y) / l1) * r };
      const b = { x: cur.x + ((next.x - cur.x) / l2) * r, y: cur.y + ((next.y - cur.y) / l2) * r };
      d += `L${fmt(a.x)},${fmt(a.y)}Q${fmt(cur.x)},${fmt(cur.y)} ${fmt(b.x)},${fmt(b.y)}`;
    }
    const last = points[points.length - 1];
    d += `L${fmt(last.x)},${fmt(last.y)}`;
    return d;
  }

  // Moves the last point back by `length` px along the last segment (room for the arrow head).
  function shortenEnd(points, length) {
    if (!points || points.length < 2 || !(length > 0)) {
      return points ? points.slice() : [];
    }
    const result = points.map((p) => ({ x: p.x, y: p.y }));
    const end = result[result.length - 1];
    const prev = result[result.length - 2];
    const len = distance(prev, end);
    if (len === 0) {
      return result;
    }
    const cut = Math.min(length, len * 0.5);
    end.x -= ((end.x - prev.x) / len) * cut;
    end.y -= ((end.y - prev.y) / len) * cut;
    return result;
  }

  /*
   * Route of a transition looping on its own node. dagre reserves room for it (a dummy node next to the
   * node, as wide as the label) but its own self-edge points are not usable, so the loop is drawn here:
   * it leaves the node on the side of the dummy, goes around the dummy's center line (where the label is
   * centered) and comes back into the node. `index` (0 = closest loop) spreads nested loops apart.
   * Returns { points, labelPos }.
   */
  function selfLoop(node, dummy, index) {
    const i = index || 0;
    const dx = dummy.x - node.x;
    const dy = dummy.y - node.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const side = dx >= 0 ? 1 : -1;
      const edgeX = node.x + (side * node.width) / 2;
      const spread = Math.max(6, Math.min(node.height / 2 - 8, 16 + 10 * i));
      const outerX = dummy.x;
      return {
        points: [
          { x: edgeX, y: node.y - spread },
          { x: outerX, y: node.y - spread },
          { x: outerX, y: node.y + spread },
          { x: edgeX, y: node.y + spread },
        ],
        labelPos: { x: outerX, y: node.y },
      };
    }
    const side = dy >= 0 ? 1 : -1;
    const edgeY = node.y + (side * node.height) / 2;
    const spread = Math.max(6, Math.min(node.width / 2 - 8, 22 + 14 * i));
    const outerY = dummy.y;
    return {
      points: [
        { x: node.x + spread, y: edgeY },
        { x: node.x + spread, y: outerY },
        { x: node.x - spread, y: outerY },
        { x: node.x - spread, y: edgeY },
      ],
      labelPos: { x: node.x, y: outerY },
    };
  }

  // Bounding box of a layout result: nodes (center + size from the model), edge points and label boxes.
  // Returns { minX, minY, maxX, maxY } (Infinity values for an empty graph).
  function bounds(model, layout) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (x1, y1, x2, y2) => {
      minX = Math.min(minX, x1);
      minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2);
      maxY = Math.max(maxY, y2);
    };
    model.nodes.forEach((n) => {
      const p = layout.nodes[n.id];
      if (p) {
        add(p.x - n.width / 2, p.y - n.height / 2, p.x + n.width / 2, p.y + n.height / 2);
      }
    });
    model.edges.forEach((e) => {
      const r = layout.edges[e.id];
      if (!r) {
        return;
      }
      (r.points || []).forEach((p) => add(p.x, p.y, p.x, p.y));
      if (r.labelPos && e.labelWidth) {
        add(
          r.labelPos.x - e.labelWidth / 2,
          r.labelPos.y - e.labelHeight / 2,
          r.labelPos.x + e.labelWidth / 2,
          r.labelPos.y + e.labelHeight / 2,
        );
      }
    });
    return { minX, minY, maxX, maxY };
  }

  // Shifts a layout result so its bounding box starts at (0, 0) and sets width/height. Mutates and returns it.
  function normalize(model, layout) {
    const b = bounds(model, layout);
    if (!Number.isFinite(b.minX)) {
      layout.width = 0;
      layout.height = 0;
      return layout;
    }
    const dx = -b.minX;
    const dy = -b.minY;
    Object.keys(layout.nodes).forEach((id) => {
      layout.nodes[id].x += dx;
      layout.nodes[id].y += dy;
    });
    Object.keys(layout.edges).forEach((id) => {
      const r = layout.edges[id];
      (r.points || []).forEach((p) => {
        p.x += dx;
        p.y += dy;
      });
      if (r.labelPos) {
        r.labelPos.x += dx;
        r.labelPos.y += dy;
      }
    });
    layout.width = b.maxX - b.minX;
    layout.height = b.maxY - b.minY;
    return layout;
  }

  // Transform (scale + translation, in screen px) showing a content of contentWidth x contentHeight
  // centered in a viewport of viewWidth x viewHeight. Returns null when the viewport has no size yet.
  function fitTransform(contentWidth, contentHeight, viewWidth, viewHeight, options) {
    const o = Object.assign({ padding: 32, minScale: 0.2, maxScale: 1 }, options || {});
    if (!(viewWidth > 0) || !(viewHeight > 0)) {
      return null;
    }
    const cw = Math.max(1, contentWidth);
    const ch = Math.max(1, contentHeight);
    const availW = Math.max(1, viewWidth - o.padding * 2 - (o.insetRight || 0));
    const availH = Math.max(1, viewHeight - o.padding * 2);
    const scale = clamp(Math.min(availW / cw, availH / ch), o.minScale, o.maxScale);
    return {
      scale,
      x: (viewWidth - (o.insetRight || 0) - cw * scale) / 2,
      y: (viewHeight - ch * scale) / 2,
    };
  }

  // New transform with the given scale, keeping the screen point (cx, cy) fixed.
  function zoomAround(transform, scale, cx, cy) {
    const worldX = (cx - transform.x) / transform.scale;
    const worldY = (cy - transform.y) / transform.scale;
    return { scale, x: cx - worldX * scale, y: cy - worldY * scale };
  }

  function rectsOverlap(a, b, margin) {
    const m = margin || 0;
    return a.x1 < b.x2 - m && b.x1 < a.x2 - m && a.y1 < b.y2 - m && b.y1 < a.y2 - m;
  }

  CWG.geometry = {
    clamp,
    distance,
    basisPath,
    roundedPath,
    shortenEnd,
    selfLoop,
    bounds,
    normalize,
    fitTransform,
    zoomAround,
    rectsOverlap,
  };
})(typeof window !== 'undefined' ? window : globalThis);
