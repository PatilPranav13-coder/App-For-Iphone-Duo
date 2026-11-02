# Tessera

Tessera is a local-first data analysis studio for turning datasets into clear, interactive findings. Its layout adapts from a quick outer-screen workspace to a roomy studio view, with one saved workspace across both.

## Current release

- Import CSV, TSV and JSON datasets in the browser, plus basic XLSX workbooks through the local Node service.
- Inspect columns, missing cells, duplicate rows, distributions and IQR outliers.
- Parse uploads and profile datasets in a Web Worker when the browser supports it (up to 250,000 rows, 100 columns and 2.5 million cells per import).
- Explore data in a searchable, sortable table and build bar, line, area, scatter, histogram and donut charts.
- Ask for deterministic calculations locally, or send a compact analysis summary to OpenAI or Anthropic through the server.
- Keep projects, data, chat, notes and touch/Pencil drawings in IndexedDB.
- Export filtered data, chart SVGs and a structured HTML report.
- Install as a PWA and adapt to compact, focus and studio layouts.

This is an honest first product slice. User accounts, cloud sync, collaboration, advanced statistical tests, presentation editing and native PencilKit are not implemented. The current server is intended for a trusted single-user/local deployment; do not expose it publicly without adding authentication, persistent cloud storage and deployment hardening.

## Run locally

Requires Node.js 20.19+.

1. Copy .env.example to .env and add the provider key and model ID you want to use. AI keys stay on the server.
2. Run npm run dev.
3. Open http://127.0.0.1:8787.

The application has no third-party runtime dependencies. Node.js 20.19+ is required for built-in fetch and timeout APIs.

No AI key is needed for uploads, profiling, charts, notes, exports or local analysis. There are no fake AI answers: when the selected provider is not configured, the assistant reports that clearly.

## Privacy

CSV, TSV and JSON parsing, profiling, charting, notes and deterministic answers run in the browser. An XLSX file is sent to the local Node process for parsing and is not written to disk. The default AI request contains the question, dataset profile, computed findings, chart context and a small number of prior turns. It does not include raw rows. Settings has an opt-in control to include up to five sample rows. Provider requests go from the Node server to the selected provider; review each provider's API terms before sending sensitive data.

IndexedDB data is stored in the current browser profile and is not encrypted. Clearing browser storage deletes local projects. Server-side API usage shown in the health endpoint is a process-local request count, not provider billing.

## Configuration

See .env.example. Select auto, openai or anthropic in the app. auto uses OpenAI when configured, then Anthropic. Model IDs are configured in .env so they can match models enabled for your API account. ChatGPT and Claude subscriptions do not provide API access by themselves.

## Deployment notes

npm run build copies the static PWA to dist/ and checks JavaScript syntax; npm start serves that build and the API from Node. Set HOST=0.0.0.0 only behind a trusted HTTPS reverse proxy. Before public deployment, add user authentication, per-user access control, database/object storage, secret management, request audit controls, CSRF strategy and production rate limits. A PostgreSQL schema starter is in server/db/schema.sql.

## Product identity

Tessera refers to one small tile in a larger mosaic. The name fits the product's work of bringing records, calculations and visual evidence together into a readable picture. The mark is a four-cell analytical tile with a rising data trace; indigo carries focus, while mint is reserved for measured positive movement.

## Foldable and Pencil support

The interface uses viewport width as the dependable fallback and detects emerging multi-segment screen APIs when available. It never assumes a physical hinge or a specific two-panel device. The notebook uses Pointer Events and therefore accepts mouse, finger and supported stylus input. Browser Pencil input does not provide PencilKit features such as native pressure workflows or system handwriting recognition.
