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
 * Styles of the graph canvas (CWG.Renderer). Injected once in the root (shadow root or document) holding
 * the canvas. Colors derive from the Web UI theme variables (--nuxeo-*), so the default, dark and Hyland
 * themes are supported, and every --cwg-* variable can be overridden from a theme or a Studio style.
 *
 * Sizes must stay in sync with CWG.METRICS (cwg-core.js), used to compute the layout.
 *
 * @since 2025.1
 */
(function (root) {
  'use strict';

  const CWG = root.NuxeoLabs && root.NuxeoLabs.CustomWorkflowGraph;
  if (!CWG || CWG.RENDERER_CSS) {
    return;
  }

  CWG.RENDERER_CSS = `
.cwg-root, .cwg-theme {
  --cwg-font: var(--nuxeo-app-font, Inter, 'Noto Sans', Arial, sans-serif);
  --cwg-text: var(--nuxeo-text-default, #3a3a54);
  --cwg-bg: var(--nuxeo-page-background, #f5f5f5);
  --cwg-card-bg: var(--nuxeo-box, #ffffff);
  --cwg-card-border: color-mix(in srgb, var(--cwg-text) 15%, var(--cwg-card-bg));
  --cwg-text-muted: color-mix(in srgb, var(--cwg-text) 66%, var(--cwg-card-bg));
  --cwg-edge: color-mix(in srgb, var(--cwg-text) 40%, var(--cwg-bg));
  --cwg-edge-strong: color-mix(in srgb, var(--cwg-text) 80%, var(--cwg-bg));
  --cwg-label-border: color-mix(in srgb, var(--cwg-text) 18%, var(--cwg-card-bg));
  --cwg-grid: color-mix(in srgb, var(--cwg-text) 16%, var(--cwg-bg));
  --cwg-current: var(--nuxeo-focus-ring-color, var(--nuxeo-primary-color, #0066ff));
  --cwg-accent: var(--nuxeo-focus-ring-color, var(--nuxeo-primary-color, #0066ff));
  --cwg-waiting: #e09b0b;
  --cwg-color-start: #1f9d63;
  --cwg-color-end: #e5484d;
  --cwg-color-step: #3b7ff5;
  --cwg-color-multi: #8b5cf6;
  --cwg-color-sub: #0f9f96;
  --cwg-color-gateway: #e8830c;
  --cwg-shadow: 0 1px 2px rgba(16, 24, 40, 0.06), 0 4px 14px rgba(16, 24, 40, 0.07);
  --cwg-shadow-hover: 0 2px 4px rgba(16, 24, 40, 0.08), 0 10px 24px rgba(16, 24, 40, 0.12);
  --cwg-kind: var(--cwg-color-step);
}

.cwg-root {
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 100%;
  font-family: var(--cwg-font);
  color: var(--cwg-text);
  background: var(--cwg-bg);
  -webkit-font-smoothing: antialiased;
}

.cwg-root *, .cwg-root *::before, .cwg-root *::after {
  box-sizing: border-box;
}

.cwg-viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
  background-image: radial-gradient(circle, var(--cwg-grid) 1px, transparent 1.4px);
  background-size: 20px 20px;
}

.cwg-viewport.is-panning {
  cursor: grabbing;
}

.cwg-viewport:focus-visible {
  box-shadow: inset 0 0 0 2px var(--cwg-accent);
}

.cwg-stage {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  will-change: transform;
}

.cwg-root.is-animating .cwg-stage {
  transition: transform 0.28s cubic-bezier(0.2, 0.7, 0.2, 1);
}

.cwg-root.is-animating .cwg-viewport {
  transition: background-position 0.28s cubic-bezier(0.2, 0.7, 0.2, 1),
    background-size 0.28s cubic-bezier(0.2, 0.7, 0.2, 1);
}

.cwg-edges {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
  pointer-events: none;
}

.cwg-labels, .cwg-nodes {
  position: absolute;
  left: 0;
  top: 0;
}

/* ==================== Edges ==================== */

.cwg-edge {
  transition: opacity 0.15s;
}

.cwg-edge-line {
  fill: none;
  stroke: var(--cwg-edge);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: stroke 0.15s, stroke-width 0.15s;
}

.cwg-edge.is-next .cwg-edge-line {
  stroke: var(--cwg-current);
  stroke-width: 2;
  stroke-dasharray: 7 5;
  animation: cwg-dash 0.9s linear infinite;
}

.cwg-edge.is-related .cwg-edge-line {
  stroke: var(--cwg-edge-strong);
  stroke-width: 2.2;
}

.cwg-edge.is-next.is-related .cwg-edge-line {
  stroke: var(--cwg-current);
}

.cwg-marker-default { fill: var(--cwg-edge); }
.cwg-marker-related { fill: var(--cwg-edge-strong); }
.cwg-marker-next { fill: var(--cwg-current); }

@keyframes cwg-dash {
  to { stroke-dashoffset: -12; }
}

/* ==================== Transition labels ==================== */

.cwg-label {
  position: absolute;
  height: 22px;
  padding: 0 9px;
  border-radius: 11px;
  border: 1px solid var(--cwg-label-border);
  background: var(--cwg-card-bg);
  color: var(--cwg-text-muted);
  font-size: 11px;
  font-weight: 500;
  line-height: 20px;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05);
  transition: opacity 0.15s, color 0.15s, border-color 0.15s;
}

.cwg-label.is-next {
  border-color: color-mix(in srgb, var(--cwg-current) 55%, var(--cwg-card-bg));
  color: var(--cwg-current);
}

.cwg-label.is-related {
  border-color: var(--cwg-edge-strong);
  color: var(--cwg-text);
}

/* ==================== Nodes ==================== */

.cwg-node {
  --cwg-kind: var(--cwg-color-step);
  position: absolute;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid var(--cwg-card-border);
  background: var(--cwg-card-bg);
  color: var(--cwg-text);
  box-shadow: var(--cwg-shadow);
  cursor: pointer;
  outline: none;
  transition: box-shadow 0.15s, border-color 0.15s, opacity 0.15s, filter 0.15s;
}

.cwg-node:hover {
  box-shadow: var(--cwg-shadow-hover);
  border-color: color-mix(in srgb, var(--cwg-kind) 55%, var(--cwg-card-bg));
}

.cwg-node:focus-visible {
  outline: 2px solid var(--cwg-accent);
  outline-offset: 3px;
}

.cwg-kind-start { --cwg-kind: var(--cwg-color-start); }
.cwg-kind-end { --cwg-kind: var(--cwg-color-end); }
.cwg-kind-step { --cwg-kind: var(--cwg-color-step); }
.cwg-kind-multiTask { --cwg-kind: var(--cwg-color-multi); }
.cwg-kind-subWorkflow { --cwg-kind: var(--cwg-color-sub); }
.cwg-kind-fork, .cwg-kind-merge { --cwg-kind: var(--cwg-color-gateway); }

.cwg-node-icon {
  flex: 0 0 34px;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--cwg-kind);
  background: color-mix(in srgb, var(--cwg-kind) 14%, var(--cwg-card-bg));
}

.cwg-node-icon svg {
  width: 20px;
  height: 20px;
  fill: currentColor;
}

.cwg-kind-fork .cwg-node-icon, .cwg-kind-merge .cwg-node-icon {
  border-radius: 6px;
  transform: rotate(45deg) scale(0.86);
}

.cwg-kind-fork .cwg-node-icon svg, .cwg-kind-merge .cwg-node-icon svg {
  transform: rotate(-45deg);
}

.cwg-node-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.cwg-node-caption {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  line-height: 15px;
  color: var(--cwg-kind);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cwg-node-line {
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cwg-node.cwg-terminal {
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  border-radius: 999px;
  border-color: color-mix(in srgb, var(--cwg-kind) 45%, var(--cwg-card-bg));
  background: color-mix(in srgb, var(--cwg-kind) 9%, var(--cwg-card-bg));
}

.cwg-terminal .cwg-node-icon {
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--cwg-kind);
  color: #ffffff;
}

.cwg-terminal .cwg-node-icon svg {
  width: 14px;
  height: 14px;
}

.cwg-terminal .cwg-node-body {
  flex: 0 1 auto;
}

.cwg-node-badge {
  position: absolute;
  top: -10px;
  right: 12px;
  height: 20px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  white-space: nowrap;
  pointer-events: none;
}

.cwg-node-badge svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}

.cwg-node.is-current {
  border-color: var(--cwg-current);
  box-shadow: 0 0 0 1px var(--cwg-current), 0 0 0 5px color-mix(in srgb, var(--cwg-current) 18%, transparent),
    var(--cwg-shadow-hover);
}

.cwg-node.is-current::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  pointer-events: none;
  animation: cwg-pulse 2.4s ease-out infinite;
}

@keyframes cwg-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--cwg-current) 45%, transparent); }
  70% { box-shadow: 0 0 0 16px color-mix(in srgb, var(--cwg-current) 0%, transparent); }
  100% { box-shadow: 0 0 0 16px color-mix(in srgb, var(--cwg-current) 0%, transparent); }
}

.cwg-node.is-current .cwg-node-badge {
  background: color-mix(in srgb, var(--cwg-current) 16%, var(--cwg-card-bg));
  border: 1px solid color-mix(in srgb, var(--cwg-current) 60%, var(--cwg-card-bg));
  color: var(--cwg-current);
}

.cwg-node.is-waiting {
  border: 1.5px dashed var(--cwg-waiting);
}

.cwg-node.is-waiting .cwg-node-badge {
  background: color-mix(in srgb, var(--cwg-waiting) 16%, var(--cwg-card-bg));
  border: 1px solid color-mix(in srgb, var(--cwg-waiting) 60%, var(--cwg-card-bg));
  color: color-mix(in srgb, var(--cwg-waiting) 75%, var(--cwg-text));
}

.cwg-node.is-canceled {
  opacity: 0.55;
  filter: grayscale(1);
}

.cwg-node.is-canceled .cwg-node-badge {
  background: var(--cwg-card-bg);
  border: 1px solid var(--cwg-card-border);
  color: var(--cwg-text-muted);
}

.cwg-node.is-selected {
  outline: 2px solid color-mix(in srgb, var(--cwg-text) 70%, var(--cwg-bg));
  outline-offset: 3px;
}

/* Hover or selection: emphasize a node and its neighborhood, dim the rest. */
.cwg-root.has-focus-node .cwg-node:not(.is-related),
.cwg-root.has-focus-node .cwg-label:not(.is-related) {
  opacity: 0.4;
}

.cwg-root.has-focus-node .cwg-edge:not(.is-related) {
  opacity: 0.22;
}

/* ==================== Toolbar ==================== */

.cwg-toolbar {
  position: absolute;
  top: 12px;
  right: calc(12px + var(--cwg-inset-right, 0px));
  transition: right 0.2s ease;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border-radius: 12px;
  border: 1px solid var(--cwg-card-border);
  background: var(--cwg-card-bg);
  box-shadow: var(--cwg-shadow);
}

.cwg-tb-btn {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
  padding: 0;
  border: none;
  min-width: 32px;
  height: 32px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--cwg-text);
  font: inherit;
  cursor: pointer;
}

.cwg-tb-btn svg {
  width: 20px;
  height: 20px;
  fill: currentColor;
}

.cwg-tb-btn:hover {
  background: color-mix(in srgb, var(--cwg-text) 9%, var(--cwg-card-bg));
}

.cwg-tb-btn:focus-visible {
  outline: 2px solid var(--cwg-accent);
  outline-offset: 1px;
}

.cwg-tb-btn[aria-pressed='true'] {
  background: color-mix(in srgb, var(--cwg-accent) 16%, var(--cwg-card-bg));
  color: var(--cwg-accent);
}

.cwg-tb-btn[hidden], .cwg-tb-sep[hidden], .cwg-tb-group[hidden] {
  display: none;
}

.cwg-tb-zoom {
  min-width: 52px;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.cwg-tb-sep {
  width: 1px;
  height: 20px;
  margin: 0 4px;
  background: var(--cwg-card-border);
}

.cwg-tb-group {
  display: inline-flex;
  gap: 2px;
}

.cwg-tb-select {
  height: 32px;
  margin: 0 2px;
  padding: 0 8px;
  border-radius: 8px;
  border: 1px solid var(--cwg-card-border);
  background: var(--cwg-card-bg);
  color: var(--cwg-text);
  font: inherit;
  font-size: 12px;
}

/* ==================== Legend ==================== */

.cwg-legend {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 2;
  min-width: 150px;
  max-width: min(420px, calc(100% - 24px));
  border-radius: 12px;
  border: 1px solid var(--cwg-card-border);
  background: var(--cwg-card-bg);
  box-shadow: var(--cwg-shadow);
  font-size: 12px;
}

.cwg-legend-toggle {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  margin: 0;
  padding: 8px 10px 8px 12px;
  border: none;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: transparent;
  color: var(--cwg-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.cwg-legend-toggle:focus-visible {
  outline: 2px solid var(--cwg-accent);
  outline-offset: -2px;
}

.cwg-legend-toggle svg {
  width: 18px;
  height: 18px;
  fill: currentColor;
  transition: transform 0.2s;
}

.cwg-legend.is-collapsed .cwg-legend-toggle svg {
  transform: rotate(180deg);
}

.cwg-legend-items {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, auto));
  gap: 6px 16px;
  padding: 0 12px 10px;
}

.cwg-legend.is-collapsed .cwg-legend-items {
  display: none;
}

.cwg-legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--cwg-text-muted);
  white-space: nowrap;
}

.cwg-legend-swatch {
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--cwg-kind);
  background: color-mix(in srgb, var(--cwg-kind) 14%, var(--cwg-card-bg));
}

.cwg-legend-swatch svg {
  width: 13px;
  height: 13px;
  fill: currentColor;
}

.cwg-legend-swatch.cwg-kind-start, .cwg-legend-swatch.cwg-kind-end {
  border-radius: 50%;
  background: var(--cwg-kind);
  color: #ffffff;
}

.cwg-legend-swatch.is-current {
  background: var(--cwg-card-bg);
  border: 1px solid var(--cwg-current);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cwg-current) 20%, transparent);
}

.cwg-legend-swatch.is-waiting {
  background: var(--cwg-card-bg);
  border: 1.5px dashed var(--cwg-waiting);
}

.cwg-legend-swatch.is-canceled {
  background: var(--cwg-card-bg);
  border: 1px solid var(--cwg-card-border);
  opacity: 0.55;
}

.cwg-legend-swatch.is-next {
  background: none;
}

.cwg-legend-swatch.is-next svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: var(--cwg-current);
  stroke-width: 2;
  stroke-dasharray: 4 3;
}

/* ==================== Empty state ==================== */

.cwg-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--cwg-text-muted);
  font-size: 14px;
  pointer-events: none;
}

.cwg-empty[hidden] {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  .cwg-node.is-current::after, .cwg-edge.is-next .cwg-edge-line {
    animation: none;
  }
  .cwg-root.is-animating .cwg-stage, .cwg-root.is-animating .cwg-viewport {
    transition: none;
  }
}
`;
})(typeof window !== 'undefined' ? window : globalThis);
