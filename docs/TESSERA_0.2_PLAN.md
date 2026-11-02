# Tessera 0.2 implementation plan

## Audit

- Baseline branch: `codex/tessera-foundation`; clean worktree before the audit.
- Local foundation tree matches the remote `fec1f399` source tree. The new work is on `codex/tessera-0.2-foldable-intelligence`.
- Baseline verification: 7 tests pass; `npm run build` succeeds.
- Existing strengths: browser-local CSV/TSV/JSON parsing and analysis, basic XLSX parsing, SVG charts, IndexedDB, a pointer-event canvas, responsive layouts, and server-side OpenAI/Anthropic adapters.
- Main gaps: global rather than project-scoped persistence, a single workspace record without revisions, state and persistence logic concentrated in `main.js`, fixed chart/table/assistant arrangements, pixel-coordinate strokes that drift after resize, and prose-only AI requests without deterministic tools.
- The Node server binds to localhost by default and the README warns against public exposure without authentication. XLSX is size limited, but the server is still a single-user local service rather than a hardened public deployment.

## Implementation sequence

1. Add a central workspace state module and an IndexedDB migration with project-scoped workspaces, dataset ownership, debounced saves, revisions, and visible quota/save errors.
2. Preserve project context when switching projects, restore each project's dataset, conversation, chart, layout, and notebook, and add user-controlled compact/focus/studio behavior.
3. Make notebook strokes resize-stable and structured, with pressure-aware input, multiple tools, undo/redo, shapes, zoom/pan, and explicit chart/point context.
4. Add a shared validated analysis-tool registry. Keep dataset calculations in the browser; adapt OpenAI Responses function calls and Anthropic Messages tool-use blocks through a bounded, normalized provider loop.
5. Improve chart selection and filtering, accessibility, responsive panel controls, visual tokens, and continuity across viewport changes.
6. Add focused regression coverage, update the README with implemented behavior and remaining limits, and run the full test suite, production build, and diff checks.

## Constraints

- Keep IndexedDB as the primary store and preserve the v0.1 import/export behavior.
- Never execute model-generated code or accept model-authored SQL.
- Do not claim native PencilKit, handwriting recognition, physical fold-angle sensing, or cloud sync.
- Keep the local server's public-deployment limitations explicit.
