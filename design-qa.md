# Dashboard Editor + Git Graph Design QA

## Evidence

- Source visual truth: `/Users/bytedance/.codex/generated_images/019f4ac8-9102-7f31-8d52-1171aeec1246/exec-84e2c97c-ce09-4e7a-adaf-9507d97d3f2f.png`
- Final implementation screenshot: `/tmp/dashboard-editor-git-log-production-v3-1487x1058.png`
- Full-view comparison input: `/tmp/dashboard-design-comparison-pass2.png`
- Focused editor/Git comparison input: `/tmp/dashboard-design-comparison-focus-pass2.png`
- Responsive evidence:
  - `/tmp/dashboard-editor-git-picker-production-960.png`
  - `/tmp/dashboard-editor-git-picker-production-420.png`
  - `/tmp/dashboard-editor-production-420.png`
- Primary viewport: `1487 × 1058`, dark product shell, Files + TypeScript editor + Git Log visible.
- Responsive viewports: `960 × 900` drawer layout and `420 × 820` compact layout.

The Codex in-app Browser runtime was unavailable in this session. The evidence was captured from the local production build with a deterministic native `WKWebView` harness, the same WebKit renderer family used by the Tauri app. The harness recorded viewport geometry, overflow, active drawer state, picker bounds, and JavaScript errors alongside every screenshot.

## Primary Interactions Tested

- Selected a workspace/terminal and opened the persistent Files view.
- Expanded `app/src` and opened a realistic TypeScript file in CodeMirror.
- Exercised editor find, go-to-line, wrap, Markdown preview controls, cursor status, and compact status layout.
- Opened Git without replacing the central editor, switched Files/Log, refreshed the graph, and rendered a real fork/merge topology.
- Opened the comparison-ref combobox and verified current/upstream refs are not offered redundantly.
- Switched HEAD / Current / All scopes and verified All does not expose ineffective comparison controls.
- Verified the Git drawer and branch picker at 960px and 420px without horizontal overflow or clipping.
- Verified compact file selection closes the Files drawer and reveals the editor.
- Checked production-render console errors: none in the 1487px, 960px, or 420px captures.

## Comparison History

### Pass 1 — blocked

Evidence: `/tmp/dashboard-design-comparison-pass1.png` and `/tmp/dashboard-design-comparison-focus-pass1.png`.

- **P1 — Editor palette could diverge from the product shell.** The editor theme resolved colors from the document root, where a light terminal palette can be installed, while the surrounding `.tw-shell` intentionally remains dark. Fixed by resolving runtime variables from the nearest `.tw-shell` and reconfiguring CodeMirror without rebuilding its state.
- **P2 — Preview content did not demonstrate the selected editor direction.** The first capture showed a two-line README, so syntax hierarchy, indentation guides, folding, and realistic density could not be compared. Fixed with a path-aware preview file tree and realistic TypeScript source.
- **P2 — Git scope and picker states had misleading or fragile edges.** All still exposed comparison refs, implicit current/upstream refs could be added without changing the graph, keyboard focus could fall outside a shortened result set, and the picker could clip in a narrow drawer. Fixed the scope semantics, implicit-ref filtering, roving focus, combobox attributes, option scrolling, and right-anchored responsive picker.
- **P2 — Compact editor status prioritized secondary metadata.** Narrow CSS could hide Ln/Col while retaining lower-value encoding badges. Fixed with explicit status item classes that retain cursor, language, and connection state.
- **P2 — Compact file selection left the navigation drawer covering the editor.** Fixed by closing the Files drawer after a successful open below 960px.
- **P2 — Development capture reported an xterm disposal/focus race.** Added cancellation and identity guards around the pending terminal fit/focus frame. Final QA uses the production bundle and reports zero console errors.

### Pass 2 — passed

Evidence: `/tmp/dashboard-design-comparison-pass2.png` and `/tmp/dashboard-design-comparison-focus-pass2.png`.

The post-fix production capture has no actionable P0/P1/P2 differences. The implementation preserves the selected design's three-region hierarchy while intentionally giving more width to the editor and keeping Git compact, matching the user's requirement that the center be either tmux or a genuinely useful editor rather than an expanded Git workspace.

## Required Fidelity Surfaces

- **Fonts and typography:** System UI text and the existing shell monospace stack remain consistent with the source. CodeMirror has a clear syntax hierarchy, stable 12.5px editing scale, readable line height, truncation for long refs/subjects, and compact metadata.
- **Spacing and layout rhythm:** The titlebar, 280px Files sidebar, flexible center, and 420px Git panel align cleanly. Editor tab, breadcrumb, tool row, content, and status bar have distinct but compact rhythm. No app-level horizontal overflow was measured at any tested viewport.
- **Colors and tokens:** The dark shell palette, blue active state, semantic green/amber refs, subdued dividers, focus rings, and selection surfaces map to product tokens. Terminal palette changes cannot leak into the editor chrome or code surface.
- **Image quality and assets:** The screen contains no photographic or generated image assets. It reuses the existing product icon and the established Lucide icon family. Git lanes are a data-driven topology visualization, not a decorative substitute asset, and remain understandable through node shapes and merge labels without color alone.
- **Copy and content:** Labels describe real behavior: Files, Git, Scratch, HEAD, Current, All, Add comparison branch, Find, Preview, and connection state. No unsupported Diff/Compare action is rendered.
- **Responsiveness and accessibility:** Native buttons expose pressed state, the ref picker is a labeled combobox/listbox with complete keyboard paths, commit rows use roving focus, the editor tab controls a labeled tabpanel, reduced motion is respected, and 960px/420px drawer captures show no clipped persistent controls.

## Accepted Constraints / P3 Follow-up

- The reference illustrates multiple editor tabs; the current product contract intentionally keeps one real persisted document rather than showing fake tabs. A future multi-document state model can add genuine tab persistence.
- The reference illustrates commit search and enriched ahead/behind details. They are intentionally omitted from this compact Git scope until a real backend contract exists.
- Extremely large histories stop at 2,000 loaded commits and show an explicit newest-history limit; cursor-based pagination can be added later.

## Findings

- No remaining actionable P0, P1, or P2 findings.

final result: passed
