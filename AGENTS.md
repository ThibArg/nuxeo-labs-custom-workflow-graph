# AGENTS.md - nuxeo-labs-custom-workflow-graph

Notes for coding agents. This file is committed to the public repository: keep it free of secrets, personal data
and machine-specific paths.

## Project

Nuxeo LTS 2025 Web UI plugin, **front end only**: it replaces the "View Graph" dialog of Web UI (the
`nuxeo-workflow-graph` element, jsPlumb) by patching `nuxeo-workflow-graph.show()` once the element is defined
(`common/cwg-override.js`). The default `show()` is kept as a fallback (plugin disabled, layout failure...).
No server-side code: the data comes from the existing REST endpoints
(`GET /api/v1/workflow/{id}/graph`, `GET /api/v1/workflow/{id}`, `GET /api/v1/task?workflowInstanceId={id}`).

- Maven modules: `nuxeo-labs-custom-workflow-graph-web` (JAR with the web resources, OSGI-INF contributions,
  i18n) and `nuxeo-labs-custom-workflow-graph-package` (marketplace package). Version `2025.1.0-SNAPSHOT`,
  parent `org.nuxeo:nuxeo-parent:2025.24`.
- Web files: `nuxeo-labs-custom-workflow-graph-web/src/main/resources/web/nuxeo.war/ui/nuxeo-labs-custom-workflow-graph/`
  - `nuxeo-labs-custom-workflow-graph-bundle.html`: entry point, script order.
  - `common/`: shared by all layouts. `cwg-core.js` (namespace `NuxeoLabs.CustomWorkflowGraph`, settings,
    i18n, layout registry `registerLayout`/`resolveLayoutName`, text measuring, `buildModel`), `cwg-geometry.js`
    (paths, self-loops, bounds, `normalize`, fit/zoom), `cwg-icons.js`, `cwg-renderer-styles.js`,
    `cwg-renderer.js` (framework-free `CWG.Renderer`), the Polymer viewer and dialog, `cwg-override.js`.
  - `layouts/`: one file per layout, registered with `registerLayout(name, def)`. `cwg-layout-auto.js`
    ("auto", dagre 3.1.3 in `vendor/`, TB/LR) and `cwg-layout-studio.js` ("studio", positions and paths drawn
    in Nuxeo Studio, falls back to "auto" when they are unusable).
- Settings: `org.nuxeo.web.ui.customWorkflowGraph.*` configuration properties (`OSGI-INF/cwg-properties-contrib.xml`),
  read from `Nuxeo.UI.config.customWorkflowGraph` at each opening: `enabled` (true), `layout` (auto),
  `direction` (TB), `allowLayoutSwitch` (true).
- Plain JavaScript + HTML imports, **no JS build**: Maven only packages the files. Files must run as classic
  scripts (IIFE on `window`/`globalThis`), no ES modules, no npm dependency at runtime.
- Layout contract: `compute(model, { direction })` returns node centers and edge routes
  (`points`, `curve: 'basis' | 'rounded'`, `labelPos`), coordinates starting at (0, 0) (use
  `CWG.geometry.normalize`). See the README "Layouts" section.

### Studio coordinates (verified in the Nuxeo, Web UI and Studio sources)

- Node `x`/`y` (`rnode:taskX/taskY`, integers): **top-left corner** of the Studio box, CSS px, 20 px grid.
  Studio boxes: 80x80 (step, multi-task, sub-workflow), 40x40 (start, end, fork, merge).
- Transition `path`: segment ends of jsPlumb's Flowchart connector, **relative** to the top-left corner of the
  box spanned by the two anchors. First point = source anchor (bottom edge of the source, at a fraction of its
  width), last point = target anchor (top center of the target). Absolute origin = top center of the target
  minus the last point. Web UI only uses paths of 3 points or more.

## Conventions

- Apache 2.0 header `(C) Copyright 2026 Hyland (http://hyland.com/) and others.` with
  `Contributors: Thibaud Arguillere` on every new file (JS, HTML, XML, MJS).
- `@since 2025.1` on new public API / new files.
- JavaScript comments: `//` for 1 to 3 lines, `/* ... */` for 4+ lines or for section separators such as
  `/* ==================== Layout ==================== */`.
- ~120 characters per line, 2-space indentation in JS/HTML (existing style), single quotes, trailing commas.
- Never use `innerHTML` with data coming from the server (titles, labels): `textContent` only.
- No Nuxeo or Web UI source file is modified. Nuxeo LTS 2025, Web UI and Studio sources are read-only references.
- Third-party code: unmodified files in `vendor/` with their license, listed in the README.
- When a change only touches README / AGENTS.md / .gitignore, do not run the build.

## Tests and tools

`dev/` is not packaged. Nothing is installed by the project: the browser tools reuse an existing `node_modules`
and an existing Chrome. Do NOT use the local Nuxeo server unless explicitly asked.

```bash
# unit tests (Node 20+, no dependency): core, geometry, auto and studio layouts on the samples
node --test dev/test

# environment of the browser tools (details in the README, "dev tools" variables table)
export CWG_NODE_MODULES=/path/to/node_modules   # puppeteer-core, esbuild, @polymer/*, @nuxeo/*, nuxeo, ...
export CHROME_PATH=/path/to/chrome-headless-shell   # optional, defaults to Google Chrome on macOS

# demo screenshots (dev/out/demo/*.png), fails on console errors/warnings; optional name filter
node dev/tools/screenshots.mjs [filter]

# integration harness: real Polymer + nuxeo-elements, bundle loaded through importHref, mocked REST API
# optional CWG_NUXEO_ELEMENTS_DIR: nuxeo-elements sources (core/ and ui/) to test against a given Web UI version
CWG_NUXEO_ELEMENTS_DIR=/path/to/nuxeo-elements node dev/tools/harness.mjs

# build (Java 21, Maven 3.8+)
mvn clean install
```

Demo: `python3 -m http.server 8765` at the project root, then
`http://localhost:8765/dev/demo/index.html?wf=serial&layout=studio`.

Fixtures: `dev/demo/samples.js` (SerialDocumentReview, ParallelDocumentReview and MainWF rebuilt from the Nuxeo
sources, plus a synthetic "contract" workflow). All persons are fictitious; anonymise any real graph before
adding it.

Postponed work for very large workflows: see `Possible-Improvements.md`.
