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
 * CWG.Renderer: draws a workflow graph in a container element and handles the interactions (pan, zoom,
 * hover, selection, keyboard, toolbar, legend). Framework-free on purpose: the Polymer viewer only feeds
 * it with data and displays the details of the selected node.
 *
 *   const renderer = new CWG.Renderer(containerElement, { onSelect(selection) {...}, selectionInset: 360 });
 *   renderer.setGraph(jsonOfWorkflowGraphEndpoint);   // throws if the layout fails
 *
 * Nodes are HTML elements (crisp text, focusable), edges are SVG paths below them. Every position comes
 * from the layout, nothing is read back from the DOM, so the graph can be built while hidden.
 *
 * @since 2025.1
 */
(function (root) {
  'use strict';

  const CWG = root.NuxeoLabs && root.NuxeoLabs.CustomWorkflowGraph;
  if (!CWG || CWG.Renderer) {
    return;
  }
  const G = CWG.geometry;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Margin around the content, inside the stage (room for the badges, rings and shadows).
  const PAD = 28;
  // The path stops before the node so the arrow head (9px, refX 3) ends exactly on the border.
  const ARROW_SHORTEN = 6.3;
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 2.5;
  const READABLE_SCALE = 0.5;
  const FOCUS_SCALE = 0.8;
  const DRAG_THRESHOLD = 4;
  const KEY_PAN = 60;
  const VIEW_MARGIN = 16;
  const TOOLBAR_CLEARANCE = 60;
  let instanceCount = 0;

  // Resolves when the web fonts are loaded (text is measured with them), at most after 1.5s.
  CWG.fontsReady = function () {
    const fonts = root.document && root.document.fonts;
    if (!fonts || !fonts.ready) {
      return Promise.resolve();
    }
    return Promise.race([fonts.ready, new Promise((resolve) => setTimeout(resolve, 1500))]).catch(() => {});
  };

  CWG.kindLabel = function (kind) {
    return CWG.t(`customWorkflowGraph.kind.${kind}`);
  };

  // 'current' | 'waiting' | 'canceled' | 'inactive'
  CWG.nodeStateKey = function (node) {
    if (node.isCurrent) {
      return 'current';
    }
    if (node.isWaiting) {
      return 'waiting';
    }
    if (node.isCanceled) {
      return 'canceled';
    }
    return 'inactive';
  };

  function prefersReducedMotion() {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function injectStyles(container) {
    const doc = root.document;
    const rootNode = container.getRootNode ? container.getRootNode() : doc;
    const target = rootNode && rootNode !== doc && rootNode.nodeType === 11 ? rootNode : doc.head;
    if (target.querySelector('style[data-cwg-renderer]')) {
      return;
    }
    const style = doc.createElement('style');
    style.setAttribute('data-cwg-renderer', CWG.VERSION);
    style.textContent = CWG.RENDERER_CSS;
    target.appendChild(style);
  }

  function el(tag, className, attrs) {
    const e = root.document.createElement(tag);
    if (className) {
      e.className = className;
    }
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    return e;
  }

  function svgEl(tag, attrs) {
    const e = root.document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k]));
    return e;
  }

  class Renderer {
    constructor(container, options) {
      this.container = container;
      this.options = Object.assign(
        { onSelect: null, onViewChange: null, onLayoutChange: null, selectionInset: 0, config: null },
        options || {},
      );
      this._uid = `cwg${++instanceCount}`;
      this.config = Object.assign(CWG.getConfig(), this.options.config || {});
      this.direction = CWG.normalizeDirection(CWG.session.direction || this.config.direction);
      this.layoutName = CWG.resolveLayoutName(CWG.session.layout || this.config.layout);
      this.transform = { scale: 1, x: 0, y: 0 };
      this.model = null;
      this.layout = null;
      this._graph = null;
      this._autoFit = true;
      this._pendingInitialView = false;
      this._selectedId = null;
      this._hoverId = null;
      this._currentCycle = 0;
      this._nodeEls = new Map();
      this._edgeEls = new Map();
      this._nodesById = new Map();
      this._pointers = new Map();
      this._drag = null;
      this._pinch = null;
      this._suppressClick = false;
      injectStyles(container);
      this._build();
      this._bind();
    }

    /* ==================== Public API ==================== */

    // Builds the model, computes the layout and draws. Throws when the layout cannot be computed.
    setGraph(graph) {
      this._graph = graph;
      const family = root.getComputedStyle ? root.getComputedStyle(this.container).fontFamily : '';
      const measure = CWG.createMeasurer(family || CWG.DEFAULT_FONT_FAMILY);
      const model = CWG.buildModel(graph, { measure });
      if (model.warnings.length) {
        console.warn('[nuxeo-labs-custom-workflow-graph]', model.warnings.join('; '));
      }
      const layout = this._computeLayout(model, this.layoutName, this.direction);
      this.model = model;
      this.layout = layout;
      this._nodesById = new Map(model.nodes.map((n) => [n.id, n]));
      if (this._selectedId && !this._nodesById.has(this._selectedId)) {
        this._selectedId = null;
      }
      this._hoverId = null;
      this._currentCycle = 0;
      this._render();
      this._autoFit = true;
      this._applyInitialView(false);
    }

    setDirection(direction) {
      const dir = CWG.normalizeDirection(direction);
      if (dir === this.direction) {
        return;
      }
      this._relayout(this.layoutName, dir);
    }

    setLayout(name) {
      const resolved = CWG.resolveLayoutName(name);
      if (!resolved || resolved === this.layoutName) {
        return;
      }
      this._relayout(resolved, this.direction);
    }

    select(id, options) {
      const o = options || {};
      const nextId = id && this._nodesById.has(id) ? id : null;
      if (nextId === this._selectedId && !o.force) {
        return;
      }
      this._selectedId = nextId;
      this._applyStates();
      this._updateToolbar();
      if (nextId && o.reveal !== false) {
        this.ensureVisible(nextId, true);
      }
      if (!o.silent && typeof this.options.onSelect === 'function') {
        this.options.onSelect(this.getSelection());
      }
    }

    // Selects a node and gives it the keyboard focus (used by the details panel links).
    focusNode(id) {
      this.select(id);
      const elem = this._nodeEls.get(id);
      if (elem) {
        elem.focus({ preventScroll: true });
      }
    }

    getSelection() {
      const id = this._selectedId;
      if (!id || !this.model) {
        return null;
      }
      const { incoming, outgoing } = CWG.connectedEdges(this.model, id);
      return {
        node: this._nodesById.get(id),
        incoming: incoming.map((e) => ({ edge: e, node: this._nodesById.get(e.source) })),
        outgoing: outgoing.map((e) => ({ edge: e, node: this._nodesById.get(e.target) })),
      };
    }

    fit(animate) {
      const fitted = this._fit(animate);
      if (fitted) {
        this._autoFit = true;
      }
      return fitted;
    }

    zoomBy(factor, point, animate) {
      this.zoomTo(this.transform.scale * factor, point, animate);
    }

    zoomTo(scale, point, animate) {
      const p = point || this._visibleCenter();
      const s = G.clamp(scale, MIN_SCALE, MAX_SCALE);
      this._autoFit = false;
      this._setTransform(G.zoomAround(this.transform, s, p.x, p.y), animate);
    }

    panBy(dx, dy, animate) {
      this._autoFit = false;
      const t = this.transform;
      this._setTransform({ scale: t.scale, x: t.x + dx, y: t.y + dy }, animate);
    }

    centerOn(id, scale, animate) {
      const p = this.layout && this.layout.nodes[id];
      if (!p) {
        return;
      }
      const s = G.clamp(scale || this.transform.scale, MIN_SCALE, MAX_SCALE);
      const view = this._viewSize();
      const visibleWidth = view.width - this._insetRight();
      this._setTransform(
        { scale: s, x: visibleWidth / 2 - (p.x + PAD) * s, y: view.height / 2 - (p.y + PAD) * s },
        animate,
      );
    }

    // Centers on the current step; repeated calls cycle through the current steps of parallel branches.
    centerOnCurrent(animate) {
      const ids = (this.model && this.model.currentNodeIds) || [];
      if (!ids.length) {
        return false;
      }
      const id = ids[this._currentCycle % ids.length];
      this._currentCycle++;
      this._autoFit = false;
      this.centerOn(id, Math.max(this.transform.scale, FOCUS_SCALE), animate);
      return true;
    }

    // Pans just enough to show the node entirely (taking the toolbar and the details panel into account).
    ensureVisible(id, animate) {
      const p = this.layout && this.layout.nodes[id];
      const n = this._nodesById.get(id);
      if (!p || !n) {
        return;
      }
      const t = this.transform;
      const view = this._viewSize();
      if (!(view.width > 0) || !(view.height > 0)) {
        return;
      }
      const x1 = t.x + (p.x + PAD - n.width / 2) * t.scale;
      const x2 = t.x + (p.x + PAD + n.width / 2) * t.scale;
      const y1 = t.y + (p.y + PAD - n.height / 2) * t.scale;
      const y2 = t.y + (p.y + PAD + n.height / 2) * t.scale;
      const left = VIEW_MARGIN;
      const right = view.width - this._insetRight() - VIEW_MARGIN;
      const top = TOOLBAR_CLEARANCE;
      const bottom = view.height - VIEW_MARGIN;
      let dx = 0;
      let dy = 0;
      if (x1 < left || x2 - x1 > right - left) {
        dx = left - x1;
      } else if (x2 > right) {
        dx = right - x2;
      }
      if (y1 < top || y2 - y1 > bottom - top) {
        dy = top - y1;
      } else if (y2 > bottom) {
        dy = bottom - y2;
      }
      if (dx || dy) {
        this.panBy(dx, dy, animate);
      }
    }

    destroy() {
      if (this._resizeObserver) {
        this._resizeObserver.disconnect();
      }
      clearTimeout(this._animTimer);
      this.container.textContent = '';
      this.container.classList.remove('cwg-root', 'has-focus-node', 'is-animating');
      this._nodeEls.clear();
      this._edgeEls.clear();
    }

    /* ==================== Layout ==================== */

    _computeLayout(model, layoutName, direction) {
      const def = CWG.getLayout(layoutName);
      if (!def) {
        throw new Error(`No usable layout (requested: ${layoutName})`);
      }
      const result = def.compute(model, { direction });
      if (!result || !result.nodes || !result.edges) {
        throw new Error(`The layout ${layoutName} returned no result`);
      }
      model.nodes.forEach((n) => {
        const p = result.nodes[n.id];
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          throw new Error(`The layout ${layoutName} did not position the node ${n.id}`);
        }
      });
      if (!Number.isFinite(result.width) || !Number.isFinite(result.height)) {
        G.normalize(model, result);
      }
      return result;
    }

    _relayout(layoutName, direction) {
      if (!this.model) {
        this.layoutName = layoutName;
        this.direction = direction;
        this._updateToolbar();
        return;
      }
      let layout;
      try {
        layout = this._computeLayout(this.model, layoutName, direction);
      } catch (e) {
        console.error('[nuxeo-labs-custom-workflow-graph] Layout failed', e);
        this._updateToolbar();
        return;
      }
      this.layoutName = layoutName;
      this.direction = direction;
      CWG.session.layout = layoutName;
      CWG.session.direction = direction;
      this.layout = layout;
      this._render();
      this._autoFit = true;
      this._applyInitialView(false);
      if (this._selectedId) {
        this.ensureVisible(this._selectedId, false);
      }
      if (typeof this.options.onLayoutChange === 'function') {
        this.options.onLayoutChange({ layout: layoutName, direction });
      }
    }

    /* ==================== DOM ==================== */

    _build() {
      const c = this.container;
      c.textContent = '';
      c.classList.add('cwg-root');

      this.viewport = el('div', 'cwg-viewport', {
        tabindex: '0',
        role: 'region',
        'aria-label': CWG.t('customWorkflowGraph.graph.ariaLabel'),
      });
      this.stage = el('div', 'cwg-stage', { dir: 'ltr' });
      this.svg = svgEl('svg', { class: 'cwg-edges', 'aria-hidden': 'true' });
      const defs = svgEl('defs');
      ['default', 'related', 'next'].forEach((kind) => {
        const marker = svgEl('marker', {
          id: `${this._uid}-arrow-${kind}`,
          viewBox: '0 0 10 10',
          refX: '3',
          refY: '5',
          markerWidth: '9',
          markerHeight: '9',
          markerUnits: 'userSpaceOnUse',
          orient: 'auto',
        });
        marker.appendChild(svgEl('path', { d: 'M0,0.8 L10,5 L0,9.2 L2.6,5 Z', class: `cwg-marker-${kind}` }));
        defs.appendChild(marker);
      });
      this.svg.appendChild(defs);
      this.edgeLayer = svgEl('g', { class: 'cwg-edge-layer' });
      this.svg.appendChild(this.edgeLayer);
      this.labelLayer = el('div', 'cwg-labels');
      this.nodeLayer = el('div', 'cwg-nodes');
      this.stage.append(this.svg, this.labelLayer, this.nodeLayer);
      this.viewport.appendChild(this.stage);

      this.emptyEl = el('div', 'cwg-empty');
      this.emptyEl.textContent = CWG.t('customWorkflowGraph.empty');
      this.emptyEl.hidden = true;

      this.toolbar = this._buildToolbar();
      this.legend = el('div', 'cwg-legend');
      this.legend.hidden = true;

      c.append(this.viewport, this.emptyEl, this.toolbar, this.legend);
    }

    _button(icon, labelKey, onClick, extraClass) {
      const label = CWG.t(labelKey);
      const b = el('button', `cwg-tb-btn${extraClass ? ` ${extraClass}` : ''}`, {
        type: 'button',
        title: label,
        'aria-label': label,
      });
      if (icon) {
        b.appendChild(CWG.createIcon(icon));
      }
      b.addEventListener('click', onClick);
      return b;
    }

    _buildToolbar() {
      const tb = el('div', 'cwg-toolbar', {
        role: 'toolbar',
        'aria-label': CWG.t('customWorkflowGraph.graph.ariaLabel'),
      });
      this._btnZoomOut = this._button('zoomOut', 'customWorkflowGraph.toolbar.zoomOut', () =>
        this.zoomBy(1 / 1.25, null, true),
      );
      this._btnZoomReset = this._button(
        null,
        'customWorkflowGraph.toolbar.resetZoom',
        () => this.zoomTo(1, null, true),
        'cwg-tb-zoom',
      );
      this._btnZoomIn = this._button('zoomIn', 'customWorkflowGraph.toolbar.zoomIn', () =>
        this.zoomBy(1.25, null, true),
      );
      this._btnFit = this._button('fit', 'customWorkflowGraph.toolbar.fit', () => this.fit(true));
      this._btnCenter = this._button('center', 'customWorkflowGraph.toolbar.center', () => this.centerOnCurrent(true));

      this._sepDirection = el('span', 'cwg-tb-sep');
      this._groupDirection = el('span', 'cwg-tb-group', { role: 'group' });
      this._btnDirection = {};
      CWG.DIRECTIONS.forEach((dir) => {
        const b = this._button(`direction${dir}`, `customWorkflowGraph.toolbar.direction.${dir}`, () =>
          this.setDirection(dir),
        );
        this._btnDirection[dir] = b;
        this._groupDirection.appendChild(b);
      });

      this._layoutSelect = el('select', 'cwg-tb-select', {
        'aria-label': CWG.t('customWorkflowGraph.toolbar.layout'),
        title: CWG.t('customWorkflowGraph.toolbar.layout'),
      });
      this._layoutSelect.addEventListener('change', () => this.setLayout(this._layoutSelect.value));

      tb.append(
        this._btnZoomOut,
        this._btnZoomReset,
        this._btnZoomIn,
        el('span', 'cwg-tb-sep'),
        this._btnFit,
        this._btnCenter,
        this._sepDirection,
        this._groupDirection,
        this._layoutSelect,
      );
      return tb;
    }

    _updateToolbar() {
      if (!this.toolbar) {
        return;
      }
      this._btnZoomReset.textContent = `${Math.round(this.transform.scale * 100)}%`;
      const hasCurrent = !!(this.model && this.model.currentNodeIds.length);
      this._btnCenter.hidden = !hasCurrent;
      const def = CWG.getLayout(this.layoutName);
      const showDirection = !!(def && def.supportsDirection);
      this._groupDirection.hidden = !showDirection;
      CWG.DIRECTIONS.forEach((dir) => {
        this._btnDirection[dir].setAttribute('aria-pressed', String(dir === this.direction));
      });
      const layouts = CWG.listLayouts();
      const showLayouts = !!this.config.allowLayoutSwitch && layouts.length > 1;
      this._layoutSelect.hidden = !showLayouts;
      this._sepDirection.hidden = !showDirection && !showLayouts;
      if (showLayouts && this._layoutSelect.options.length !== layouts.length) {
        this._layoutSelect.textContent = '';
        layouts.forEach((l) => {
          const opt = el('option');
          opt.value = l.name;
          opt.textContent = l.labelKey ? CWG.t(l.labelKey) : l.name;
          this._layoutSelect.appendChild(opt);
        });
      }
      if (showLayouts) {
        this._layoutSelect.value = this.layoutName;
      }
    }

    _render() {
      const { model, layout } = this;
      this._nodeEls.clear();
      this._edgeEls.clear();
      this.edgeLayer.textContent = '';
      this.labelLayer.textContent = '';
      this.nodeLayer.textContent = '';

      const width = layout.width + PAD * 2;
      const height = layout.height + PAD * 2;
      this.stage.style.width = `${width}px`;
      this.stage.style.height = `${height}px`;
      this.svg.setAttribute('width', String(width));
      this.svg.setAttribute('height', String(height));
      this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      this.emptyEl.hidden = model.nodes.length > 0;

      const current = new Set(model.currentNodeIds);
      model.edges.forEach((e) => {
        const route = layout.edges[e.id];
        if (!route || !route.points || route.points.length < 2) {
          return;
        }
        const points = G.shortenEnd(
          route.points.map((p) => ({ x: p.x + PAD, y: p.y + PAD })),
          ARROW_SHORTEN,
        );
        const d = route.curve === 'rounded' ? G.roundedPath(points, 10) : G.basisPath(points);
        const g = svgEl('g', { class: 'cwg-edge', 'data-id': e.id });
        const path = svgEl('path', { class: 'cwg-edge-line', d });
        g.appendChild(path);
        this.edgeLayer.appendChild(g);
        const record = { edge: e, g, path, label: null, isNext: current.has(e.source) };
        if (route.labelPos && e.labelWidth) {
          const label = el('div', 'cwg-label', { dir: 'auto' });
          label.textContent = e.labelText;
          label.style.left = `${route.labelPos.x + PAD - e.labelWidth / 2}px`;
          label.style.top = `${route.labelPos.y + PAD - e.labelHeight / 2}px`;
          label.style.width = `${e.labelWidth}px`;
          if (e.labelTruncated) {
            label.title = e.label;
          }
          this.labelLayer.appendChild(label);
          record.label = label;
        }
        this._edgeEls.set(e.id, record);
      });

      // DOM (and so keyboard) order follows the reading order of the layout
      const pos = (n) => layout.nodes[n.id];
      const byReadingOrder =
        this.direction === 'LR'
          ? (a, b) => pos(a).x - pos(b).x || pos(a).y - pos(b).y
          : (a, b) => pos(a).y - pos(b).y || pos(a).x - pos(b).x;
      model.nodes
        .slice()
        .sort(byReadingOrder)
        .forEach((n) => this.nodeLayer.appendChild(this._createNode(n, pos(n))));

      this._applyStates();
      this._renderLegend();
      this._updateToolbar();
    }

    _createNode(n, p) {
      const terminal = CWG.isTerminalKind(n.kind);
      const elem = el('div', `cwg-node cwg-kind-${n.kind}${terminal ? ' cwg-terminal' : ''}`, {
        role: 'button',
        tabindex: '0',
      });
      elem.dataset.id = n.id;
      elem.style.left = `${p.x + PAD - n.width / 2}px`;
      elem.style.top = `${p.y + PAD - n.height / 2}px`;
      elem.style.width = `${n.width}px`;
      elem.style.height = `${n.height}px`;
      elem.classList.toggle('is-current', n.isCurrent);
      elem.classList.toggle('is-waiting', n.isWaiting);
      elem.classList.toggle('is-canceled', n.isCanceled);

      const stateKey = CWG.nodeStateKey(n);
      const caption = CWG.kindLabel(n.kind);
      let aria = `${caption}: ${n.title}`;
      if (stateKey !== 'inactive') {
        aria += `, ${CWG.t(`customWorkflowGraph.stateLong.${stateKey}`)}`;
      }
      elem.setAttribute('aria-label', aria);
      if (n.titleTruncated) {
        elem.title = n.title;
      }

      const icon = el('div', 'cwg-node-icon');
      icon.appendChild(CWG.createIcon(n.kind));
      const body = el('div', 'cwg-node-body');
      if (!terminal) {
        const cap = el('div', 'cwg-node-caption');
        cap.textContent = caption;
        body.appendChild(cap);
      }
      n.lines.forEach((line) => {
        const l = el('div', 'cwg-node-line', { dir: 'auto' });
        l.textContent = line;
        body.appendChild(l);
      });
      elem.append(icon, body);

      if (stateKey !== 'inactive') {
        const badge = el('div', 'cwg-node-badge', { 'aria-hidden': 'true' });
        if (stateKey !== 'current') {
          badge.appendChild(CWG.createIcon(stateKey === 'waiting' ? 'waiting' : 'canceled'));
        }
        badge.appendChild(root.document.createTextNode(CWG.t(`customWorkflowGraph.state.${stateKey}`)));
        elem.appendChild(badge);
      }

      elem.addEventListener('mouseenter', () => this._setHover(n.id));
      elem.addEventListener('mouseleave', () => this._setHover(null));
      elem.addEventListener('focus', () => {
        this._resetScroll();
        // only for keyboard navigation: a click already shows the node, and may start a drag
        let keyboard = true;
        try {
          keyboard = elem.matches(':focus-visible');
        } catch (err) {
          keyboard = true;
        }
        if (keyboard) {
          this.ensureVisible(n.id, true);
          this._setHover(n.id);
        }
      });
      elem.addEventListener('blur', () => this._setHover(null));
      this._nodeEls.set(n.id, elem);
      return elem;
    }

    _setHover(id) {
      if (this._hoverId === id) {
        return;
      }
      this._hoverId = id;
      this._applyStates();
    }

    _applyStates() {
      if (!this.model) {
        return;
      }
      const focusId = this._hoverId || this._selectedId;
      const relatedNodes = new Set();
      const relatedEdges = new Set();
      if (focusId) {
        relatedNodes.add(focusId);
        this.model.edges.forEach((e) => {
          if (e.source === focusId || e.target === focusId) {
            relatedEdges.add(e.id);
            relatedNodes.add(e.source);
            relatedNodes.add(e.target);
          }
        });
      }
      this.container.classList.toggle('has-focus-node', !!focusId);
      this.container.style.setProperty('--cwg-inset-right', `${this._insetRight()}px`);
      this._nodeEls.forEach((elem, id) => {
        elem.classList.toggle('is-related', relatedNodes.has(id));
        elem.classList.toggle('is-selected', id === this._selectedId);
        elem.setAttribute('aria-pressed', String(id === this._selectedId));
      });
      this._edgeEls.forEach((rec, id) => {
        const related = relatedEdges.has(id);
        rec.g.classList.toggle('is-related', related);
        rec.g.classList.toggle('is-next', rec.isNext);
        let marker = 'default';
        if (rec.isNext) {
          marker = 'next';
        } else if (related) {
          marker = 'related';
        }
        rec.path.setAttribute('marker-end', `url(#${this._uid}-arrow-${marker})`);
        if (rec.label) {
          rec.label.classList.toggle('is-related', related);
          rec.label.classList.toggle('is-next', rec.isNext);
        }
      });
    }

    _renderLegend() {
      const legend = this.legend;
      legend.textContent = '';
      const model = this.model;
      if (!model || !model.nodes.length) {
        legend.hidden = true;
        return;
      }
      legend.hidden = false;

      const toggle = el('button', 'cwg-legend-toggle', {
        type: 'button',
        title: CWG.t('customWorkflowGraph.legend.toggle'),
      });
      this._legendToggle = toggle;
      const title = el('span');
      title.textContent = CWG.t('customWorkflowGraph.legend.title');
      toggle.append(title, CWG.createIcon('expand'));
      toggle.addEventListener('click', () => {
        CWG.session.legendCollapsed = !this._isLegendCollapsed();
        this._updateLegendState();
      });

      const items = el('div', 'cwg-legend-items');
      const addItem = (swatchClass, icon, text) => {
        const item = el('div', 'cwg-legend-item');
        const swatch = el('span', `cwg-legend-swatch ${swatchClass}`);
        if (icon) {
          swatch.appendChild(icon);
        }
        const label = el('span');
        label.textContent = text;
        item.append(swatch, label);
        items.appendChild(item);
      };
      const kinds = new Set(model.nodes.map((n) => n.kind));
      CWG.KINDS.filter((k) => kinds.has(k)).forEach((k) =>
        addItem(`cwg-kind-${k}`, CWG.createIcon(k), CWG.kindLabel(k)),
      );
      ['current', 'waiting', 'canceled'].forEach((state) => {
        if (model.nodes.some((n) => CWG.nodeStateKey(n) === state)) {
          addItem(`is-${state}`, null, CWG.t(`customWorkflowGraph.stateLong.${state}`));
        }
      });
      if (model.currentNodeIds.length && model.edges.some((e) => model.currentNodeIds.indexOf(e.source) >= 0)) {
        const svg = svgEl('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' });
        svg.appendChild(svgEl('path', { d: 'M1,10 L19,10' }));
        addItem('is-next', svg, CWG.t('customWorkflowGraph.legend.nextTransition'));
      }
      legend.append(toggle, items);
      this._updateLegendState();
    }

    // Collapsed when the user chose so, otherwise when the canvas is too small to spare the room.
    _isLegendCollapsed() {
      if (typeof CWG.session.legendCollapsed === 'boolean') {
        return CWG.session.legendCollapsed;
      }
      const v = this._viewSize();
      return v.width > 0 && (v.width < 900 || v.height < 600);
    }

    _updateLegendState() {
      if (!this._legendToggle) {
        return;
      }
      const collapsed = this._isLegendCollapsed();
      this.legend.classList.toggle('is-collapsed', collapsed);
      this._legendToggle.setAttribute('aria-expanded', String(!collapsed));
    }

    /* ==================== View transform ==================== */

    _viewSize() {
      return { width: this.viewport.clientWidth, height: this.viewport.clientHeight };
    }

    _insetRight() {
      return this._selectedId ? this.options.selectionInset || 0 : 0;
    }

    _visibleCenter() {
      const v = this._viewSize();
      return { x: (v.width - this._insetRight()) / 2, y: v.height / 2 };
    }

    _stageSize() {
      if (!this.layout) {
        return { width: 0, height: 0 };
      }
      return { width: this.layout.width + PAD * 2, height: this.layout.height + PAD * 2 };
    }

    _fit(animate) {
      const v = this._viewSize();
      const s = this._stageSize();
      const t = G.fitTransform(s.width, s.height, v.width, v.height, {
        padding: VIEW_MARGIN,
        minScale: MIN_SCALE,
        maxScale: 1,
        insetRight: this._insetRight(),
      });
      if (!t) {
        this._pendingInitialView = true;
        return false;
      }
      this._setTransform(t, animate);
      return true;
    }

    // Fits the graph; when the result is too small to be read and a step is current, zooms on it instead.
    _applyInitialView(animate) {
      if (!this.model || !this._fit(animate)) {
        return;
      }
      this._pendingInitialView = false;
      if (this.transform.scale < READABLE_SCALE && this.model.currentNodeIds.length) {
        this.centerOn(this.model.currentNodeIds[0], FOCUS_SCALE, animate);
      }
    }

    _setTransform(t, animate) {
      const scale = G.clamp(t.scale, MIN_SCALE, MAX_SCALE);
      this.transform = { scale, x: t.x, y: t.y };
      if (animate && !prefersReducedMotion()) {
        this.container.classList.add('is-animating');
        clearTimeout(this._animTimer);
        this._animTimer = setTimeout(() => this.container.classList.remove('is-animating'), 320);
      } else {
        this.container.classList.remove('is-animating');
      }
      this.stage.style.transform = `translate(${t.x}px, ${t.y}px) scale(${scale})`;
      let grid = 20 * scale;
      while (grid < 10) {
        grid *= 2;
      }
      this.viewport.style.backgroundSize = `${grid}px ${grid}px`;
      this.viewport.style.backgroundPosition = `${t.x}px ${t.y}px`;
      this._updateToolbar();
      if (typeof this.options.onViewChange === 'function') {
        this.options.onViewChange(this.transform);
      }
    }

    _resetScroll() {
      // focus() may scroll an overflow:hidden element, positions are only driven by the transform
      if (this.viewport.scrollTop || this.viewport.scrollLeft) {
        this.viewport.scrollTop = 0;
        this.viewport.scrollLeft = 0;
      }
    }

    /* ==================== Events ==================== */

    _bind() {
      const vp = this.viewport;
      vp.addEventListener('pointerdown', (e) => this._onPointerDown(e));
      vp.addEventListener('pointermove', (e) => this._onPointerMove(e));
      vp.addEventListener('pointerup', (e) => this._onPointerUp(e));
      vp.addEventListener('pointercancel', (e) => this._onPointerUp(e));
      vp.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      vp.addEventListener('scroll', () => this._resetScroll());
      vp.addEventListener(
        'click',
        (e) => {
          if (this._suppressClick) {
            this._suppressClick = false;
            e.stopPropagation();
            e.preventDefault();
          }
        },
        true,
      );
      vp.addEventListener('click', (e) => {
        const nodeEl = e.target.closest && e.target.closest('.cwg-node');
        this.select(nodeEl ? nodeEl.dataset.id : null);
      });
      vp.addEventListener('dblclick', (e) => {
        if (e.target.closest && e.target.closest('.cwg-node')) {
          return;
        }
        this.zoomBy(1.6, this._localPoint(e), true);
      });
      this.container.addEventListener('keydown', (e) => this._onKeyDown(e));
      if (root.ResizeObserver) {
        this._resizeObserver = new root.ResizeObserver(() => this._onResize());
        this._resizeObserver.observe(vp);
      }
    }

    _onResize() {
      this._updateLegendState();
      if (this._autoFit || this._pendingInitialView) {
        this._applyInitialView(false);
      }
    }

    _localPoint(e) {
      const r = this.viewport.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    _onPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) {
        return;
      }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 1) {
        this._drag = {
          id: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          origin: Object.assign({}, this.transform),
          moved: false,
        };
      } else if (this._pointers.size === 2) {
        const [a, b] = Array.from(this._pointers.values());
        const r = this.viewport.getBoundingClientRect();
        this._pinch = {
          distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
          middle: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top },
          origin: Object.assign({}, this.transform),
        };
        this._drag = null;
        this._pointers.forEach((p, id) => {
          try {
            this.viewport.setPointerCapture(id);
          } catch (err) {
            // the pointer may already be released
          }
        });
      }
    }

    _onPointerMove(e) {
      if (!this._pointers.has(e.pointerId)) {
        return;
      }
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinch && this._pointers.size >= 2) {
        const [a, b] = Array.from(this._pointers.values());
        const r = this.viewport.getBoundingClientRect();
        const middle = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
        const ratio = Math.hypot(b.x - a.x, b.y - a.y) / this._pinch.distance;
        const scale = G.clamp(this._pinch.origin.scale * ratio, MIN_SCALE, MAX_SCALE);
        const t = G.zoomAround(this._pinch.origin, scale, this._pinch.middle.x, this._pinch.middle.y);
        t.x += middle.x - this._pinch.middle.x;
        t.y += middle.y - this._pinch.middle.y;
        this._autoFit = false;
        this._setTransform(t);
        return;
      }
      const d = this._drag;
      if (!d || d.id !== e.pointerId) {
        return;
      }
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
          return;
        }
        d.moved = true;
        try {
          this.viewport.setPointerCapture(e.pointerId);
        } catch (err) {
          // the pointer may already be released
        }
        this.viewport.classList.add('is-panning');
      }
      this._autoFit = false;
      this._setTransform({ scale: d.origin.scale, x: d.origin.x + dx, y: d.origin.y + dy });
    }

    _onPointerUp(e) {
      this._pointers.delete(e.pointerId);
      if (this._pinch && this._pointers.size < 2) {
        this._pinch = null;
        this._suppressClick = true;
        setTimeout(() => {
          this._suppressClick = false;
        }, 0);
      }
      if (this._drag && this._drag.id === e.pointerId) {
        if (this._drag.moved) {
          this._suppressClick = true;
          setTimeout(() => {
            this._suppressClick = false;
          }, 0);
        }
        this._drag = null;
        this.viewport.classList.remove('is-panning');
      }
    }

    _onWheel(e) {
      e.preventDefault();
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
      } else if (e.deltaMode === 2) {
        const v = this._viewSize();
        dx *= v.width;
        dy *= v.height;
      }
      if (e.ctrlKey || e.metaKey) {
        // pinch on a trackpad (reported as ctrl + wheel) or ctrl/cmd + mouse wheel
        const exponent = G.clamp(-dy * 0.01, -0.5, 0.5);
        this.zoomTo(this.transform.scale * Math.pow(2, exponent), this._localPoint(e), false);
        return;
      }
      if (e.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      this.panBy(-dx, -dy, false);
    }

    _onKeyDown(e) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      const target = e.composedPath ? e.composedPath()[0] : e.target;
      const tag = target && target.tagName;
      if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') {
        return;
      }
      const nodeEl = target && target.closest ? target.closest('.cwg-node') : null;
      switch (e.key) {
        case '+':
        case '=':
          this.zoomBy(1.25, null, true);
          break;
        case '-':
        case '_':
          this.zoomBy(1 / 1.25, null, true);
          break;
        case '0':
          this.zoomTo(1, null, true);
          break;
        case 'f':
        case 'F':
          this.fit(true);
          break;
        case 'c':
        case 'C':
          this.centerOnCurrent(true);
          break;
        case 'ArrowLeft':
          this.panBy(KEY_PAN, 0, true);
          break;
        case 'ArrowRight':
          this.panBy(-KEY_PAN, 0, true);
          break;
        case 'ArrowUp':
          this.panBy(0, KEY_PAN, true);
          break;
        case 'ArrowDown':
          this.panBy(0, -KEY_PAN, true);
          break;
        case 'Enter':
        case ' ':
          if (!nodeEl) {
            return;
          }
          this.select(nodeEl.dataset.id);
          break;
        default:
          return;
      }
      e.preventDefault();
    }
  }

  CWG.Renderer = Renderer;
})(typeof window !== 'undefined' ? window : globalThis);
