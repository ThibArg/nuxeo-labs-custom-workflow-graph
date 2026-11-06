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
 * Integration harness entry (NOT packaged), bundled by dev/tools/harness.mjs with esbuild.
 *
 * Reproduces what Web UI provides to add-on bundles (legacy globals of legacy.js, nuxeo-elements) and the
 * two Web UI elements the plugin interacts with:
 *   - nuxeo-workflow-graph: same public API as Web UI's (workflowId + show()), the jsPlumb drawing being
 *     replaced by a marker (window.harness.classicShown) so the fallback can be checked;
 *   - harness-info-bar / harness-document-task: call show() exactly like nuxeo-document-info-bar and
 *     nuxeo-document-task do (nested shadow roots).
 * As in Web UI, the plugin bundle is loaded BEFORE nuxeo-workflow-graph is defined (lazy "elements" chunk).
 */
import '@polymer/polymer/polymer-legacy.js';
import { Polymer } from '@polymer/polymer/lib/legacy/polymer-fn.js';
import { dom } from '@polymer/polymer/lib/legacy/polymer.dom.js';
import { html } from '@polymer/polymer/lib/utils/html-tag.js';
import { PolymerElement } from '@polymer/polymer/polymer-element.js';
import { mixinBehaviors } from '@polymer/polymer/lib/legacy/class.js';
import { importHref } from '@nuxeo/nuxeo-ui-elements/import-href.js';
import { NotifyBehavior } from '@nuxeo/nuxeo-elements/nuxeo-notify-behavior.js';
import { I18nBehavior } from '@nuxeo/nuxeo-ui-elements/nuxeo-i18n-behavior.js';
import { FormatBehavior } from '@nuxeo/nuxeo-ui-elements/nuxeo-format-behavior.js';
import '@nuxeo/nuxeo-elements/nuxeo-connection.js';
import '@nuxeo/nuxeo-elements/nuxeo-resource.js';
import '@nuxeo/nuxeo-ui-elements/widgets/nuxeo-dialog.js';
import '@nuxeo/nuxeo-ui-elements/widgets/nuxeo-user-tag.js';
import '@nuxeo/nuxeo-ui-elements/widgets/nuxeo-group-tag.js';
import '@nuxeo/nuxeo-ui-elements/widgets/nuxeo-date.js';

// Same globals as Web UI's legacy.js
Object.assign(Polymer, { dom, html, importHref, mixinBehaviors });
window.Polymer = Polymer;
window.PolymerElement = PolymerElement;
window.importHref = importHref;
window.Nuxeo = window.Nuxeo || {};
Object.assign(window.Nuxeo, { NotifyBehavior, I18nBehavior, FormatBehavior });

const harness = {
  classicShown: 0,
  notifications: [],
  bodyKeys: [],
};
window.harness = harness;

// Like nuxeo-app: collects the notifications; like nuxeo-keys: listens to the keys reaching the body.
document.addEventListener('notify', (e) => harness.notifications.push(e.detail && e.detail.message));
document.body.addEventListener('keydown', (e) => harness.bodyKeys.push(e.key));

harness.loadPluginBundle = (url) =>
  new Promise((resolve, reject) => {
    importHref(url, resolve, reject);
  });

// Equivalent of Web UI's nuxeo-workflow-graph (public API only).
harness.defineWebUiElements = () => {
  Polymer({
    _template: html`
      <style>
        :host {
          display: block;
        }
      </style>
      <nuxeo-dialog id="graphDialog" with-backdrop>
        <div class="classic">Default (jsPlumb) graph of [[workflowId]]</div>
      </nuxeo-dialog>
    `,
    is: 'nuxeo-workflow-graph',
    behaviors: [NotifyBehavior, I18nBehavior],
    properties: {
      workflowId: String,
    },
    show() {
      harness.classicShown++;
      this.$.graphDialog.toggle();
      return Promise.resolve();
    },
  });

  Polymer({
    _template: html`
      <template is="dom-repeat" items="[[workflows]]" as="workflow">
        <nuxeo-workflow-graph id="graph-[[workflow.id]]" workflow-id="[[workflow.id]]"></nuxeo-workflow-graph>
        <a class="viewGraph" href="#" on-tap="_toggleGraphDialog">View Graph [[workflow.id]]</a>
      </template>
    `,
    is: 'harness-info-bar',
    properties: {
      workflows: { type: Array, value: () => [] },
    },
    _toggleGraphDialog(e) {
      e.preventDefault();
      this.$$(`#graph-${e.model.workflow.id}`).show();
    },
  });

  Polymer({
    _template: html`
      <style>
        nuxeo-workflow-graph {
          position: relative;
        }
      </style>
      <nuxeo-workflow-graph id="graph" workflow-id="[[task.workflowInstanceId]]"></nuxeo-workflow-graph>
      <a href="#" on-tap="_toggleGraphDialog" class="view-graph">View Graph</a>
    `,
    is: 'harness-document-task',
    properties: {
      task: Object,
    },
    _toggleGraphDialog(e) {
      e.preventDefault();
      this.$.graph.show();
    },
  });
};
