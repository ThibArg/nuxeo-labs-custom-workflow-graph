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
 * "auto" layout: layered (Sugiyama) layout computed by dagre (vendor/dagre.min.js, MIT), which must be
 * loaded before this file. Ignores the positions drawn in Studio, except for the initial order of the
 * nodes (see CWG.buildModel), and supports both directions (TB and LR).
 *
 * @since 2025.1
 */
(function (root) {
  'use strict';

  const CWG = root.NuxeoLabs && root.NuxeoLabs.CustomWorkflowGraph;
  if (!CWG || CWG.getLayout('auto')) {
    return;
  }

  // Keep our own reference to dagre and give back the global to a previously loaded copy, if any.
  const dagreLib = root.dagre;
  if (dagreLib) {
    CWG.dagre = dagreLib;
    if (CWG._previousDagre && CWG._previousDagre !== dagreLib) {
      root.dagre = CWG._previousDagre;
    }
  }

  const SPACING = {
    TB: { nodesep: 56, ranksep: 60, edgesep: 22 },
    LR: { nodesep: 34, ranksep: 70, edgesep: 18 },
  };

  function finitePoint(p) {
    return p && Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  function compute(model, options) {
    const dagre = CWG.dagre;
    if (!dagre) {
      throw new Error('dagre is not loaded');
    }
    const direction = CWG.normalizeDirection(options && options.direction);
    const spacing = SPACING[direction];
    const labelMetrics = CWG.METRICS.label;

    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({
      rankdir: direction,
      nodesep: spacing.nodesep,
      ranksep: spacing.ranksep,
      edgesep: spacing.edgesep,
      marginx: 0,
      marginy: 0,
      // No "greedy" acyclicer: the default one is a depth-first search starting from the sources (the Start
      // nodes), so only the real back edges (loops to a previous step) are reversed and the flow reads
      // from the start to the end.
      ranker: 'network-simplex',
    });
    g.setDefaultEdgeLabel(() => ({}));

    model.nodes.forEach((n) => {
      g.setNode(n.id, { width: n.width, height: n.height });
    });

    model.edges.forEach((e) => {
      if (e.isSelfLoop) {
        // The dummy dagre puts next to the node must leave room for the loop even without label.
        g.setEdge(
          e.source,
          e.target,
          {
            width: Math.max(e.labelWidth, labelMetrics.minSelfLoopWidth),
            height: Math.max(e.labelHeight, labelMetrics.height),
            labelpos: 'c',
          },
          e.id,
        );
        return;
      }
      g.setEdge(
        e.source,
        e.target,
        { width: e.labelWidth, height: e.labelHeight, labelpos: 'c', minlen: 1, weight: 1 },
        e.id,
      );
    });

    dagre.layout(g);

    const result = { width: 0, height: 0, nodes: {}, edges: {} };
    model.nodes.forEach((n) => {
      const p = g.node(n.id);
      if (!finitePoint(p)) {
        throw new Error(`No position computed for node ${n.id}`);
      }
      result.nodes[n.id] = { x: p.x, y: p.y };
    });

    // Self-loops are routed by us, around the position dagre reserved (the label position).
    const loopsByNode = new Map();
    model.edges.forEach((e) => {
      const label = g.edge({ v: e.source, w: e.target, name: e.id });
      if (!label) {
        throw new Error(`No route computed for transition ${e.id}`);
      }
      if (e.isSelfLoop) {
        if (!finitePoint(label)) {
          throw new Error(`No room reserved for the self-loop ${e.id}`);
        }
        const list = loopsByNode.get(e.source) || [];
        list.push({ edge: e, dummy: { x: label.x, y: label.y } });
        loopsByNode.set(e.source, list);
        return;
      }
      const points = (label.points || []).filter(finitePoint).map((p) => ({ x: p.x, y: p.y }));
      if (points.length < 2) {
        throw new Error(`Invalid route for transition ${e.id}`);
      }
      result.edges[e.id] = {
        points,
        curve: 'basis',
        labelPos: e.labelWidth && finitePoint(label) ? { x: label.x, y: label.y } : null,
      };
    });

    loopsByNode.forEach((loops, nodeId) => {
      const node = model.nodes.find((n) => n.id === nodeId);
      const center = result.nodes[nodeId];
      const box = { x: center.x, y: center.y, width: node.width, height: node.height };
      loops
        .sort((a, b) => CWG.geometry.distance(center, a.dummy) - CWG.geometry.distance(center, b.dummy))
        .forEach((loop, index) => {
          const route = CWG.geometry.selfLoop(box, loop.dummy, index);
          result.edges[loop.edge.id] = {
            points: route.points,
            curve: 'rounded',
            labelPos: loop.edge.labelWidth ? route.labelPos : null,
          };
        });
    });

    return CWG.geometry.normalize(model, result);
  }

  CWG.registerLayout('auto', {
    labelKey: 'customWorkflowGraph.layout.auto',
    supportsDirection: true,
    isAvailable() {
      return !!(CWG.dagre && CWG.dagre.graphlib && typeof CWG.dagre.layout === 'function');
    },
    compute,
  });
})(typeof window !== 'undefined' ? window : globalThis);
