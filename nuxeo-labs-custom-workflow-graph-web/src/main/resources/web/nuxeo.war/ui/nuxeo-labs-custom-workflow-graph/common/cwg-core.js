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
 * Core of the custom workflow graph: namespace, settings, translations, layout registry, text measuring
 * and the conversion of the REST graph (GET /api/v1/workflow/{id}/graph) into a layout-neutral model.
 *
 * No dependency on Polymer or on the DOM (the DOM is only used, when present, to measure text), so the
 * file can be unit tested with Node.
 *
 * @since 2025.1
 */
(function (root) {
  'use strict';

  root.NuxeoLabs = root.NuxeoLabs || {};
  const CWG = root.NuxeoLabs.CustomWorkflowGraph || {};
  root.NuxeoLabs.CustomWorkflowGraph = CWG;
  if (CWG.core) {
    return;
  }
  CWG.core = true;
  CWG.VERSION = '2025.1.0';

  // dagre is loaded right after this file and declares a global "dagre". Remember any previous value so
  // the auto layout can restore it and never break another add-on that would ship its own dagre.
  CWG._previousDagre = root.dagre;

  /* ==================== Settings ==================== */

  CWG.DEFAULTS = Object.freeze({
    enabled: true,
    layout: 'auto',
    direction: 'TB',
    allowLayoutSwitch: true,
  });

  CWG.DIRECTIONS = Object.freeze(['TB', 'LR']);

  CWG.normalizeDirection = function (value) {
    const dir = String(value || '')
      .trim()
      .toUpperCase();
    return CWG.DIRECTIONS.indexOf(dir) >= 0 ? dir : CWG.DEFAULTS.direction;
  };

  function toBoolean(value, fallback) {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === 'true') {
        return true;
      }
      if (v === 'false') {
        return false;
      }
    }
    return fallback;
  }

  // Returns the settings, read from Nuxeo.UI.config.customWorkflowGraph (i.e. the
  // org.nuxeo.web.ui.customWorkflowGraph.* configuration properties). Read at each call, never cached.
  CWG.getConfig = function () {
    const uiConfig = root.Nuxeo && root.Nuxeo.UI && root.Nuxeo.UI.config;
    const raw = (uiConfig && uiConfig.customWorkflowGraph) || {};
    return {
      enabled: toBoolean(raw.enabled, CWG.DEFAULTS.enabled),
      layout: (typeof raw.layout === 'string' && raw.layout.trim()) || CWG.DEFAULTS.layout,
      direction: CWG.normalizeDirection(raw.direction),
      allowLayoutSwitch: toBoolean(raw.allowLayoutSwitch, CWG.DEFAULTS.allowLayoutSwitch),
    };
  };

  // Choices made by the user in the toolbar, kept for the page session (not persisted). null: not chosen,
  // for the legend it means "collapsed only when the canvas is small".
  CWG.session = { direction: null, layout: null, legendCollapsed: null };

  /* ==================== Translations ==================== */

  // English fallbacks, used when the Web UI translation bundle does not contain the key (e.g. the i18n
  // files were not merged) so the viewer never displays raw keys.
  CWG.FALLBACK_MESSAGES = {
    'customWorkflowGraph.dialog.close': 'Close',
    'customWorkflowGraph.dialog.defaultTitle': 'Workflow',
    'customWorkflowGraph.dialog.startedBy': 'Started by',
    'customWorkflowGraph.workflowState.running': 'Running',
    'customWorkflowGraph.workflowState.done': 'Done',
    'customWorkflowGraph.workflowState.canceled': 'Canceled',
    'customWorkflowGraph.workflowState.suspended': 'Suspended',
    'customWorkflowGraph.loading': 'Loading the workflow graph…',
    'customWorkflowGraph.empty': 'This workflow has no step.',
    'customWorkflowGraph.graph.ariaLabel': 'Workflow graph',
    'customWorkflowGraph.kind.start': 'Start',
    'customWorkflowGraph.kind.end': 'End',
    'customWorkflowGraph.kind.step': 'Step',
    'customWorkflowGraph.kind.multiTask': 'Multiple tasks',
    'customWorkflowGraph.kind.subWorkflow': 'Sub-workflow',
    'customWorkflowGraph.kind.fork': 'Fork',
    'customWorkflowGraph.kind.merge': 'Merge',
    'customWorkflowGraph.state.current': 'Current',
    'customWorkflowGraph.state.waiting': 'Waiting',
    'customWorkflowGraph.state.canceled': 'Canceled',
    'customWorkflowGraph.state.inactive': 'Not active',
    'customWorkflowGraph.stateLong.current': 'Current step',
    'customWorkflowGraph.stateLong.waiting': 'Waiting for the other branches',
    'customWorkflowGraph.stateLong.canceled': 'Canceled',
    'customWorkflowGraph.stateLong.inactive': 'Not active',
    'customWorkflowGraph.toolbar.zoomIn': 'Zoom in',
    'customWorkflowGraph.toolbar.zoomOut': 'Zoom out',
    'customWorkflowGraph.toolbar.resetZoom': 'Actual size (100%)',
    'customWorkflowGraph.toolbar.fit': 'Fit to screen',
    'customWorkflowGraph.toolbar.center': 'Center on the current step',
    'customWorkflowGraph.toolbar.direction.TB': 'Top to bottom',
    'customWorkflowGraph.toolbar.direction.LR': 'Left to right',
    'customWorkflowGraph.toolbar.layout': 'Layout',
    'customWorkflowGraph.layout.auto': 'Automatic',
    'customWorkflowGraph.layout.studio': 'Studio',
    'customWorkflowGraph.legend.title': 'Legend',
    'customWorkflowGraph.legend.toggle': 'Show or hide the legend',
    'customWorkflowGraph.legend.nextTransition': 'Possible next transition',
    'customWorkflowGraph.details.close': 'Close the details',
    'customWorkflowGraph.details.leadsTo': 'Leads to',
    'customWorkflowGraph.details.comesFrom': 'Comes from',
    'customWorkflowGraph.details.none': 'None',
    'customWorkflowGraph.details.openTasks': 'Open tasks',
    'customWorkflowGraph.details.assignees': 'Assigned to',
    'customWorkflowGraph.details.delegatedTo': 'Delegated to',
    'customWorkflowGraph.details.dueDate': 'Due',
    'customWorkflowGraph.details.created': 'Created',
    'customWorkflowGraph.details.instructions': 'Instructions',
    'customWorkflowGraph.details.actions': 'Possible actions',
    'customWorkflowGraph.details.overdue': 'Overdue',
    'customWorkflowGraph.details.noOpenTask': 'No open task is visible to you for this step.',
    'customWorkflowGraph.details.tasksUnavailable': 'The task details are not available.',
    'customWorkflowGraph.details.loadingTasks': 'Loading the tasks…',
  };

  /*
   * Web UI's translate() reads a plain object (window.nuxeo.I18n[language][key]): a key named like an
   * Object.prototype member ("constructor", "toString"...) returns that member, e.g. a function. Only
   * strings are accepted as translations, anything else is treated as "no translation".
   */
  function rawTranslate(key) {
    const i18n = root.nuxeo && root.nuxeo.I18n;
    if (i18n && typeof i18n.translate === 'function') {
      try {
        const value = i18n.translate(key);
        return typeof value === 'string' ? value : key;
      } catch (e) {
        return key;
      }
    }
    return key;
  }

  // Translates one of the plugin's keys: Web UI bundle first, then the English fallback. Positional
  // parameters ({0}, {1}...) are replaced as Web UI does.
  CWG.t = function (key, ...params) {
    let value = rawTranslate(key);
    if (!value || value === key) {
      value = CWG.FALLBACK_MESSAGES[key] || key;
    }
    params.forEach((p, i) => {
      value = value.replace(`{${i}}`, p);
    });
    return value;
  };

  /**
   * Translates a label coming from the workflow definition (node title, transition label, workflow title).
   * The server already translated it with the server-side messages; Studio projects usually provide
   * their labels in the Web UI bundle, so the client translation is tried as well. Lowercase snake_case
   * keys left untranslated ("automatic_transition") are made readable ("Automatic transition").
   */
  CWG.translateLabel = function (label) {
    if (label === null || label === undefined) {
      return '';
    }
    const text = String(label);
    if (!text) {
      return '';
    }
    const translated = rawTranslate(text);
    if (translated && translated !== text) {
      return String(translated);
    }
    if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(text)) {
      const spaced = text.replace(/_/g, ' ');
      return spaced.charAt(0).toUpperCase() + spaced.slice(1);
    }
    return text;
  };

  /* ==================== Layout registry ==================== */

  const layouts = new Map();

  /**
   * Registers a layout engine.
   *
   * def = {
   *   labelKey: i18n key of the name displayed in the toolbar,
   *   supportsDirection: true if compute() honors options.direction (TB/LR),
   *   isAvailable(): optional, false when a dependency is missing,
   *   compute(model, { direction }): returns {
   *     width, height,
   *     nodes: { [nodeId]: { x, y } },          // center of the node, in px
   *     edges: { [edgeId]: { points: [{x, y}, ...], curve: 'basis' | 'rounded', labelPos: {x, y} | null } }
   *   }
   * }
   * Coordinates must start at (0, 0): the renderer adds the margins.
   *
   * @since 2025.1
   */
  CWG.registerLayout = function (name, def) {
    if (!name || !def || typeof def.compute !== 'function') {
      throw new Error(`Invalid layout definition: ${name}`);
    }
    layouts.set(name, Object.assign({ name, supportsDirection: false, labelKey: '' }, def));
  };

  CWG.getLayout = function (name) {
    return layouts.get(name) || null;
  };

  function isLayoutAvailable(def) {
    if (!def) {
      return false;
    }
    if (typeof def.isAvailable !== 'function') {
      return true;
    }
    try {
      return !!def.isAvailable();
    } catch (e) {
      return false;
    }
  }

  // Available layouts, in registration order.
  CWG.listLayouts = function () {
    return Array.from(layouts.values()).filter(isLayoutAvailable);
  };

  // Returns the name of the layout to use: the requested one if usable, else "auto", else the first one.
  CWG.resolveLayoutName = function (requested) {
    if (requested && isLayoutAvailable(layouts.get(requested))) {
      return requested;
    }
    if (isLayoutAvailable(layouts.get('auto'))) {
      return 'auto';
    }
    const first = CWG.listLayouts()[0];
    return first ? first.name : null;
  };

  /* ==================== Text measuring ==================== */

  CWG.DEFAULT_FONT_FAMILY = "Inter, 'Noto Sans', Arial, sans-serif";

  // Sizes shared by the layouts (to compute node sizes) and the renderer (to draw them). Changing a value
  // here requires the matching change in cwg-renderer-styles.js.
  CWG.METRICS = Object.freeze({
    card: {
      width: 228,
      minHeight: 66,
      padX: 14,
      padY: 12,
      iconSize: 34,
      gap: 12,
      captionHeight: 15,
      lineHeight: 18,
      maxLines: 3,
      titleWeight: 600,
      titleSize: 13,
    },
    terminal: {
      height: 38,
      padX: 16,
      iconSize: 22,
      gap: 8,
      minWidth: 104,
      maxWidth: 220,
      titleWeight: 600,
      titleSize: 13,
    },
    label: {
      height: 22,
      padX: 9,
      maxWidth: 170,
      minSelfLoopWidth: 28,
      weight: 500,
      size: 11,
    },
  });

  // Margin removed from the available width when wrapping: canvas and DOM can disagree by a pixel or two.
  const MEASURE_SAFETY = 4;

  // Returns measure(text, weight, size) -> width in px. Uses a canvas when available (browser), otherwise
  // an approximation (unit tests).
  CWG.createMeasurer = function (fontFamily) {
    const family = fontFamily || CWG.DEFAULT_FONT_FAMILY;
    let ctx = null;
    try {
      if (root.document && typeof root.document.createElement === 'function') {
        const canvas = root.document.createElement('canvas');
        ctx = canvas.getContext && canvas.getContext('2d');
      }
    } catch (e) {
      ctx = null;
    }
    const cache = new Map();
    return function measure(text, weight, size) {
      const key = `${weight}|${size}|${text}`;
      if (cache.has(key)) {
        return cache.get(key);
      }
      let width;
      if (ctx) {
        ctx.font = `${weight} ${size}px ${family}`;
        width = ctx.measureText(text).width;
      } else {
        width = String(text).length * size * 0.56;
      }
      cache.set(key, width);
      return width;
    };
  };

  function truncateToWidth(text, maxWidth, measureFn) {
    const ellipsis = '…';
    if (measureFn(text) <= maxWidth) {
      return text;
    }
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length;
    // binary search on the number of characters kept
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (measureFn(chars.slice(0, mid).join('').trimEnd() + ellipsis) <= maxWidth) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return chars.slice(0, lo).join('').trimEnd() + ellipsis;
  }

  // Wraps text on at most maxLines lines of maxWidth px. Words longer than a line are cut. The last line
  // ends with an ellipsis when the text does not fit.
  // Returns { lines: [string], truncated: boolean, width: widest line in px }.
  CWG.wrapText = function (text, maxWidth, maxLines, measureFn) {
    const words = String(text || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const lines = [];
    let current = '';
    let truncated = false;
    const pushLine = (line) => {
      lines.push(line);
    };
    for (let i = 0; i < words.length; i++) {
      let word = words[i];
      const candidate = current ? `${current} ${word}` : word;
      if (measureFn(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) {
        pushLine(current);
        current = '';
      }
      // the word alone may still be too long: cut it
      while (measureFn(word) > maxWidth) {
        const chars = Array.from(word);
        let n = chars.length - 1;
        while (n > 1 && measureFn(chars.slice(0, n).join('')) > maxWidth) {
          n--;
        }
        pushLine(chars.slice(0, n).join(''));
        word = chars.slice(n).join('');
      }
      current = word;
    }
    if (current) {
      pushLine(current);
    }
    if (lines.length > maxLines) {
      truncated = true;
      const kept = lines.slice(0, maxLines);
      const rest = lines.slice(maxLines - 1).join(' ');
      kept[maxLines - 1] = truncateToWidth(rest, maxWidth, measureFn);
      lines.length = 0;
      kept.forEach((l) => lines.push(l));
    }
    if (lines.length === 0) {
      lines.push('');
    }
    const width = lines.reduce((w, l) => Math.max(w, measureFn(l)), 0);
    return { lines, truncated, width };
  };

  CWG.truncateToWidth = truncateToWidth;

  /* ==================== Model ==================== */

  CWG.KINDS = Object.freeze(['start', 'end', 'step', 'multiTask', 'subWorkflow', 'fork', 'merge']);

  function flag(node, name, alias) {
    if (typeof node[name] === 'boolean') {
      return node[name];
    }
    return alias ? !!node[alias] : false;
  }

  // Same priority as Web UI's original element (start, end, fork, merge, multi-task, sub-workflow).
  CWG.nodeKind = function (node) {
    if (flag(node, 'isStartNode', 'startNode')) {
      return 'start';
    }
    if (flag(node, 'isEndNode', 'endNode')) {
      return 'end';
    }
    if (flag(node, 'isForkNode', 'forkNode')) {
      return 'fork';
    }
    if (flag(node, 'isMerge', 'merge')) {
      return 'merge';
    }
    if (flag(node, 'isMultiTask', 'multiTask')) {
      return 'multiTask';
    }
    if (flag(node, 'hasSubWorkflow', 'subWorkflow')) {
      return 'subWorkflow';
    }
    return 'step';
  };

  CWG.isTerminalKind = function (kind) {
    return kind === 'start' || kind === 'end';
  };

  /*
   * True when a node id is also the name of an Object.prototype member ("__proto__", "constructor",
   * "toString", "hasOwnProperty", ...). The layouts and dagre key plain objects by node id, so such an id
   * would break the layout and, for "__proto__", alter Object.prototype of the whole Web UI page. Studio
   * never generates these ids; only a hand-written workflow model can contain one.
   */
  CWG.isReservedNodeId = function (id) {
    return String(id) in Object.prototype;
  };

  function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function sizeCard(node, title, measure) {
    const m = CWG.METRICS.card;
    const textWidth = m.width - m.padX * 2 - m.iconSize - m.gap - MEASURE_SAFETY;
    const wrapped = CWG.wrapText(title, textWidth, m.maxLines, (s) => measure(s, m.titleWeight, m.titleSize));
    node.lines = wrapped.lines;
    node.titleTruncated = wrapped.truncated;
    node.width = m.width;
    node.height = Math.max(m.minHeight, m.padY * 2 + m.captionHeight + wrapped.lines.length * m.lineHeight);
  }

  function sizeTerminal(node, title, measure) {
    const m = CWG.METRICS.terminal;
    const chrome = m.padX * 2 + m.iconSize + m.gap;
    const fn = (s) => measure(s, m.titleWeight, m.titleSize);
    const text = truncateToWidth(title, m.maxWidth - chrome - MEASURE_SAFETY, fn);
    node.lines = [text];
    node.titleTruncated = text !== title;
    node.width = Math.round(Math.min(m.maxWidth, Math.max(m.minWidth, chrome + fn(text) + MEASURE_SAFETY)));
    node.height = m.height;
  }

  function sizeLabel(edge, measure) {
    const m = CWG.METRICS.label;
    if (!edge.label) {
      edge.labelText = '';
      edge.labelWidth = 0;
      edge.labelHeight = 0;
      return;
    }
    const fn = (s) => measure(s, m.weight, m.size);
    const text = truncateToWidth(edge.label, m.maxWidth - m.padX * 2 - MEASURE_SAFETY, fn);
    edge.labelText = text;
    edge.labelTruncated = text !== edge.label;
    edge.labelWidth = Math.round(Math.min(m.maxWidth, fn(text) + m.padX * 2 + MEASURE_SAFETY));
    edge.labelHeight = m.height;
  }

  /**
   * Converts the JSON of GET /api/v1/workflow/{id}/graph into the model used by the layouts and the renderer.
   *
   * options = { measure: function from createMeasurer(), translate: label translation function }
   *
   * Returns {
   *   nodes: [{ id, title, lines, titleTruncated, kind, state, isCurrent, isWaiting, isCanceled,
   *             isFork, isMerge, isMultiTask, hasSubWorkflow, width, height, studio: {x, y}, index }],
   *   edges: [{ id, source, target, label, labelText, labelWidth, labelHeight, isSelfLoop,
   *             studioPath: [{x, y}], index }],
   *   currentNodeIds: [ids], warnings: [strings]
   * }
   * Nodes are sorted by their Studio position (top to bottom, then left to right) so the automatic layout
   * starts from the order chosen by the designer.
   *
   * Throws when a node id is a reserved name (see CWG.isReservedNodeId): the renderer then fails and the
   * viewer falls back to Web UI's default graph.
   */
  CWG.buildModel = function (graph, options) {
    const opts = options || {};
    const measure = opts.measure || CWG.createMeasurer();
    const translate = opts.translate || CWG.translateLabel;
    const warnings = [];
    const rawNodes = (graph && Array.isArray(graph.nodes) && graph.nodes) || [];
    const rawTransitions = (graph && Array.isArray(graph.transitions) && graph.transitions) || [];

    const nodes = [];
    const byId = new Map();
    rawNodes.forEach((raw, index) => {
      if (!raw || raw.id === undefined || raw.id === null || raw.id === '') {
        warnings.push(`Node #${index} has no id, ignored`);
        return;
      }
      const id = String(raw.id);
      if (CWG.isReservedNodeId(id)) {
        throw new Error(`Node id "${id}" is a reserved name, the custom graph cannot draw this workflow`);
      }
      if (byId.has(id)) {
        warnings.push(`Duplicate node id ${id}, ignored`);
        return;
      }
      const kind = CWG.nodeKind(raw);
      const title = translate(raw.title) || id;
      const state = raw.state ? String(raw.state) : '';
      const node = {
        id,
        title,
        kind,
        state,
        isCurrent: state === 'suspended',
        isWaiting: state === 'waiting',
        isCanceled: state === 'canceled',
        isFork: flag(raw, 'isForkNode', 'forkNode'),
        isMerge: flag(raw, 'isMerge', 'merge'),
        isMultiTask: flag(raw, 'isMultiTask', 'multiTask'),
        hasSubWorkflow: flag(raw, 'hasSubWorkflow', 'subWorkflow'),
        studio: { x: toNumber(raw.x), y: toNumber(raw.y) },
        index,
      };
      if (CWG.isTerminalKind(kind)) {
        sizeTerminal(node, title, measure);
      } else {
        sizeCard(node, title, measure);
      }
      byId.set(id, node);
      nodes.push(node);
    });

    nodes.sort((a, b) => a.studio.y - b.studio.y || a.studio.x - b.studio.x || a.index - b.index);

    const edges = [];
    rawTransitions.forEach((raw, index) => {
      const source = raw && raw.nodeSourceId !== undefined ? String(raw.nodeSourceId) : '';
      const target = raw && raw.nodeTargetId !== undefined ? String(raw.nodeTargetId) : '';
      if (!byId.has(source) || !byId.has(target)) {
        warnings.push(`Transition #${index} (${source} -> ${target}) references an unknown node, ignored`);
        return;
      }
      const edge = {
        id: `e${index}`,
        source,
        target,
        label: translate(raw.label),
        isSelfLoop: source === target,
        studioPath: Array.isArray(raw.path)
          ? raw.path.map((p) => ({ x: toNumber(p && p.x), y: toNumber(p && p.y) }))
          : [],
        index,
      };
      sizeLabel(edge, measure);
      edges.push(edge);
    });

    return {
      nodes,
      edges,
      currentNodeIds: nodes.filter((n) => n.isCurrent).map((n) => n.id),
      warnings,
    };
  };

  // Returns { incoming: [edge], outgoing: [edge] } for a node of the model.
  CWG.connectedEdges = function (model, nodeId) {
    const incoming = [];
    const outgoing = [];
    model.edges.forEach((e) => {
      if (e.source === nodeId) {
        outgoing.push(e);
      }
      if (e.target === nodeId && e.source !== nodeId) {
        incoming.push(e);
      }
    });
    return { incoming, outgoing };
  };
})(typeof window !== 'undefined' ? window : globalThis);
