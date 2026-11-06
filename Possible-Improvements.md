# Possible improvements

Work identified for very large or complex workflows, **postponed** (not planned for now). The current viewer
handles the usual workflows (a few to a few dozen steps) well.

A quick in-memory test already showed that the "auto" layout (dagre 3.1.3) lays out a generated workflow of
150 steps and 299 transitions in about 140 ms, with no overlapping steps and no overlapping labels. Layout speed
is therefore not the first concern; navigation and readability are.

## Stress fixtures

- A fixed, generated workflow of about 60 steps (forks, merges, loops, sub-workflows, long titles) added to
  `dev/demo/samples.js`, so the demo, the screenshots and the unit tests cover a large graph. Generated once
  with a seeded generator and committed, so results are reproducible.
- A 150-step workflow used only to measure the layout time (unit test with a generous threshold, to detect a
  regression rather than to benchmark).

## Large-graph navigation

- **Fit that really fits**: the minimum zoom is 20% today, so a very large graph does not fit in the dialog.
  Allow a minimum zoom of about 5% for "fit to screen" (manual zoom can keep a higher limit).
- **Automatic minimap**: shown only when the graph does not fit at a readable zoom, with the visible area as a
  draggable rectangle; click to jump.
- **Transition labels hidden below about 40% zoom**: they cannot be read anyway and clutter the drawing; still
  available on hover and in the details panel.

## "Find a step" search

A search field in the toolbar (and a keyboard shortcut) listing the steps whose title matches; choosing one
selects it and centers the view on it.

## Optional ELK layout module

Only if dagre turns out not to be good enough on real large workflows:

- elkjs 0.12.1, about 1.6 MB, licensed EPL-2.0 (with a GPL-3.0 secondary license): check that the license is
  acceptable before shipping it, keep it in `vendor/` unmodified with its license.
- Asynchronous API (`elk.layout()` returns a promise, optionally in a web worker): the layout contract is
  synchronous today, it would need an asynchronous variant (renderer and viewer changes in `common/`).
- Loaded lazily, only when the "elk" layout is selected, to keep the bundle small.

## Backend options

These need a server-side module (the plugin is front end only today):

- A read-only endpoint returning, for a workflow instance, the steps that already ran and their actors (from
  the audit or the task documents), so finished steps can be told apart from steps that never ran.
- A listener recording the transitions actually taken (the engine does not keep this history), to draw the
  path followed so far.
