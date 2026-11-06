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
 * Replaces the graph opened by Web UI's "View Graph" links.
 *
 * Web UI's nuxeo-workflow-graph element is used in two places (document workflow bar and task view), and
 * both only call its show() method. Redefining the element is not possible (customElements.define would
 * throw), so its show() is patched once the element is defined: when the plugin is enabled, show() opens
 * nuxeo-labs-custom-workflow-graph-dialog, created inside the element's shadow root; otherwise, or if the
 * custom graph cannot be drawn, the original show() is called. No Web UI file is modified.
 *
 * @since 2025.1
 */
(function (root) {
  'use strict';

  const CWG = root.NuxeoLabs && root.NuxeoLabs.CustomWorkflowGraph;
  if (!CWG || CWG.overrideInstalled || !root.customElements) {
    return;
  }
  CWG.overrideInstalled = true;

  const TARGET = 'nuxeo-workflow-graph';
  const DIALOG = 'nuxeo-labs-custom-workflow-graph-dialog';
  const LOG = '[nuxeo-labs-custom-workflow-graph]';

  function getDialog(host) {
    const shadow = host.shadowRoot || host.root;
    if (!shadow || !root.customElements.get(DIALOG)) {
      return null;
    }
    let dialog = host.__cwgDialog;
    if (!dialog || dialog.getRootNode() !== shadow) {
      dialog = root.document.createElement(DIALOG);
      shadow.appendChild(dialog);
      host.__cwgDialog = dialog;
    }
    return typeof dialog.open === 'function' ? dialog : null;
  }

  function createShow(originalShow) {
    const show = function (...args) {
      if (!CWG.getConfig().enabled) {
        return originalShow.apply(this, args);
      }
      const dialog = getDialog(this);
      if (!dialog) {
        console.warn(LOG, 'The custom graph dialog is not available, using the default graph');
        return originalShow.apply(this, args);
      }
      return dialog.open(this.workflowId).catch((error) => {
        if (error && error.cwgFallback) {
          console.warn(LOG, 'The custom graph cannot be drawn, using the default graph', error.cause || error);
          return originalShow.apply(this, args);
        }
        throw error;
      });
    };
    show.cwgPatched = true;
    show.cwgOriginal = originalShow;
    return show;
  }

  CWG.patchWorkflowGraphElement = function (ctor) {
    const proto = ctor && ctor.prototype;
    if (!proto || typeof proto.show !== 'function') {
      console.warn(LOG, `${TARGET} has no show() method, the default graph is kept`);
      return false;
    }
    if (proto.show.cwgPatched) {
      return true;
    }
    const show = createShow(proto.show);
    proto.show = show;
    // With Polymer's legacyOptimizations (not enabled by Web UI), methods are copied from the element
    // definition at the first instantiation: patch the definition too so the patch is not overwritten.
    const info = ctor.generatedFrom;
    if (info && typeof info.show === 'function' && !info.show.cwgPatched) {
      info.show = show;
    }
    return true;
  };

  root.customElements.whenDefined(TARGET).then(() => {
    CWG.patchWorkflowGraphElement(root.customElements.get(TARGET));
  });
})(typeof window !== 'undefined' ? window : globalThis);
