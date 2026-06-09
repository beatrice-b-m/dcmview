# Repository Guidelines

## Project Overview

`dcmview` is a fast, ephemeral DICOM inspection tool for developers, data
scientists, and medical imaging researchers. It starts a temporary local web
server with an embedded browser viewer, exposes image frames, tags, and ROI
annotations through a small HTTP API, and exits cleanly when stopped.

The core workflow is quick inspection of DICOM data where the files already
live, especially on remote servers. It is meant to avoid slow notebook rendering
for multi-frame studies and avoid the setup, firewall, transfer, and annotation
round-trip costs of external viewers when the user only needs research review.

`dcmview` is intended for developer and research inspection, not clinical
diagnosis.

**Status:** Core implementation complete.

**Design axioms**:

- **Ephemeral** - no persistent state, no config files, no database.
- **Fast** - startup, first-frame render, and multi-frame navigation are primary
  performance targets.
- **Self-contained binary** - release builds embed the Svelte frontend with
  `rust-embed`; the Python package is a wrapper/bundling path for the same
  binary on supported platforms.
- **Remote-friendly** - bind to loopback by default and use SSH forwarding for
  remote-server workflows.

---

## Git Commit Policy

Every completed task **MUST** be tracked in a descriptive, granular git commit.
This requirement is **absolutely critical** and must be followed under all
circumstances - no exceptions.

**Rules:**

- Commit after every distinct logical unit of work, not at the end of a session.
- Each commit covers exactly one coherent change (one module, one component, one
  test suite, one docs section). Do not batch unrelated changes into a single
  commit.
- Commit messages must be informative: use `type(scope): subject` format,
  include a blank line, then a body describing *what* changed and *why*.
  - Types: `feat`, `fix`, `test`, `docs`, `refactor`, `chore`
  - Scope: the module, file, or subsystem affected, such as `backend`,
    `frontend`, `pixels`, `server`, `types`, or `tests`
  - Subject: imperative mood, 72 characters or fewer
  - Body: explain the design decision, the invariant being established, or the
    behavior being changed, not a restatement of the diff
- Stage files selectively (`git add <file>`) rather than `git add -A`. Only
  commit files that belong to the current logical unit.
- Never amend or force-push commits that have been logged here.

**Verification:** After each task, run `git log --oneline -3` to confirm the
commit was recorded before moving to the next task.

## Architecture & Data Flow

```text
CLI / Python wrapper
  -> src/main.rs
       -> loader.rs       walkdir + rayon inside spawn_blocking
       -> annotations.rs  optional EMBED-style ROI CSV load/export
       -> server.rs       Axum + Tokio HTTP server
            GET /api/files
            GET /api/file/:i/info
            GET /api/file/:i/tags
            GET /api/file/:i/frame/:n
            GET /api/file/:i/frame/:n/raw
            GET /api/file/:i/annotations
            PUT /api/file/:i/annotations
            GET /api/annotations/export.csv
       -> pixels.rs       display PNGs, raw sample transport, LRU caches
       -> tunnel.rs       optional ssh -L subprocess and readiness polling

Frontend (Svelte 5, compiled into the binary via rust-embed):
  App.svelte
    -> FileTabs | ViewerToolbar | ImageViewport | TagPanel | FrameSlider | StatusBar
    -> api.ts typed fetch wrappers
```

### Key data structures

`types.rs` owns the shared backend/frontend contract:

```rust
pub struct FileEntry {
    pub index: usize,
    pub path: PathBuf,
    pub label: String,
    pub has_pixels: bool,
    pub frame_count: u32,
    pub rows: u32,
    pub columns: u32,
    pub bits_allocated: u32,
    pub pixel_representation: u32,
    pub samples_per_pixel: u32,
    pub photometric_interpretation: String,
    pub rescale_slope: f64,
    pub rescale_intercept: f64,
    pub transfer_syntax_uid: String,
    pub default_window: Option<WindowPreset>,
}
```

`server.rs` owns shared Axum state. `Clone` is cheap because the large/shared
members are behind `Arc`:

```rust
pub struct AppState {
    pub files: Arc<Vec<FileEntry>>,
    pub file_summaries: Arc<Vec<FileSummary>>,
    pub pixel_cache: Arc<Mutex<FrameCache>>,
    pub raw_cache: Arc<Mutex<RawFrameCache>>,
    pub tag_cache: Arc<Mutex<HashMap<usize, Vec<TagNode>>>>,
    pub annotations: AnnotationStore,
    pub tunnel_info: Option<Arc<TunnelInfo>>,
    pub tunnel_handle: Option<Arc<TunnelHandle>>,
    pub server_start: Instant,
    pub server_start_ms: u64,
    pub last_request: Arc<AtomicU64>,
}
```

### Pixel pipeline

Display-frame endpoints return PNG for every supported image transfer syntax.
Do not rely on browser-native DICOM fragment decoding for viewer correctness.

| Class | Transfer syntaxes | Display action |
|---|---|---|
| JPEG Baseline / Extended | `1.2.840.10008.1.2.4.50`, `.51` | Decode server-side with `dicom-pixeldata`; PNG encode |
| JPEG Lossless | `1.2.840.10008.1.2.4.57`, `.70` | Decode server-side with `dicom-pixeldata`; PNG encode |
| JPEG 2000 | `1.2.840.10008.1.2.4.90`, `.91` | Read encapsulated fragment with `DicomCollector`; decode via `jpeg2k`; PNG encode |
| Uncompressed | Implicit LE, Explicit LE, Explicit BE | Read decoded/native samples, rescale/window, PNG encode |
| JPEG-LS / RLE | `.80`, `.81`, `.5` | HTTP 422 unsupported transfer syntax |
| Other | anything else | HTTP 422 unsupported transfer syntax |

Raw-frame endpoints return decoded sample bytes plus metadata headers for
uncompressed, JPEG Baseline/Extended, JPEG Lossless, and grayscale JPEG 2000
paths. JPEG-LS, RLE, unsupported syntaxes, and unsupported raw component layouts
return 422 or a decode error.

Both display and raw frame endpoints must include `X-Cache: HIT` or
`X-Cache: MISS`.

---

## Key Directories

```text
dcmview/
|-- src/
|   |-- lib.rs          Library exports used by integration tests
|   |-- main.rs         CLI entry point; clap struct; startup orchestration
|   |-- annotations.rs  EMBED-style ROI CSV parsing, validation, in-memory store
|   |-- loader.rs       DICOM discovery and FileEntry construction
|   |-- pixels.rs       Display PNG and raw-frame decode paths; LRU caches
|   |-- server.rs       Axum router, AppState, handlers, graceful shutdown
|   |-- tunnel.rs       SSH subprocess management and cleanup
|   `-- types.rs        Shared structs and API contract types
|-- frontend/
|   |-- src/
|   |   |-- App.svelte
|   |   |-- api.ts
|   |   `-- lib/
|   |       |-- FileTabs.svelte
|   |       |-- ViewerToolbar.svelte
|   |       |-- ImageViewport.svelte
|   |       |-- TagPanel.svelte
|   |       |-- FrameSlider.svelte
|   |       |-- StatusBar.svelte
|   |       |-- annotationGeometry.ts
|   |       |-- viewerTools.ts
|   |       `-- workers/wlRenderer.worker.ts
|   |-- dist/           Build output consumed by rust-embed
|   |-- package.json
|   |-- svelte.config.js
|   `-- vite.config.ts
|-- python/dcmview_py/  Python subprocess wrapper and package entrypoint
|-- tests/
|   |-- integration.rs  Integration test module root
|   |-- integration/    Axum and pixel-path integration tests
|   `-- fixtures/       Small generated DICOM fixtures
|-- examples/generate_test_fixtures.rs
|-- build.rs
|-- Cargo.toml
`-- pyproject.toml
```

---

## Development Commands

```bash
# First-time frontend dependency install
npm --prefix frontend ci

# Build everything; build.rs builds frontend/dist first
cargo build
cargo build --release

# Skip frontend rebuild only when frontend/dist/index.html already exists
DCMVIEW_SKIP_FRONTEND_BUILD=1 cargo build

# Install binary to $CARGO_HOME/bin
cargo install --path .

# Run all Rust tests
cargo test

# Run integration tests only
cargo test --test integration

# Run ignored remote-fixture tests explicitly when network/cache is available
cargo test --features remote-fixtures --test integration -- --ignored

# Frontend-only workflows
npm --prefix frontend run build
npm --prefix frontend run dev

# Python wrapper tests
python3 -m unittest python.tests.test_wrapper
```

**Prerequisites:**

- Rust stable 1.75+
- Node.js 18+ and npm at build time
- `ssh` on `PATH` only when using `--tunnel`

`build.rs` runs `npm ci` only when `frontend/package-lock.json` changes since
the last successful install stamp, then runs `npm run build`. `DCMVIEW_NODE_PATH`
and `DCMVIEW_NPM_PATH` may point to absolute tool paths. `DCMVIEW_SKIP_FRONTEND_BUILD=1`
requires an existing `frontend/dist/index.html`.

---

## Code Conventions & Common Patterns

### Rust

**Async / blocking boundary**

- `loader.rs` discovery uses `tokio::task::spawn_blocking`; keep rayon work out
  of the async executor.
- Pixel decode/encode and tag tree construction use `spawn_blocking` where they
  can do filesystem, codec, or CPU-heavy work.
- Display and raw LRU cache locks are held only for lookup/insert. Never hold a
  cache lock while decoding, encoding, reading DICOM files, or serializing tags.

**Error handling**

- Use `anyhow` for fallible non-API internals.
- Convert pixel errors through `pixel_error_to_api_error` in `server.rs`.
- Frame decode errors return HTTP 500 JSON and the server continues.
- Unsupported transfer syntax returns HTTP 422 JSON and must never panic.
- Missing pixel data returns 404 for frame endpoints.
- Tag serialization errors for individual values should emit `TagValue::Error`
  and continue serializing the response where possible.
- Zero valid files after scan is a non-zero CLI error.

**Caches**

- `FrameCacheKey` uses `f64::to_bits()` for window center/width because those
  values come directly from UI/query/DICOM inputs.
- Display cache entries are budgeted by `FRAME_CACHE_MAX_BYTES`; raw cache
  entries are budgeted by `RAW_CACHE_MAX_BYTES`.
- Tag trees are cached per file index in `AppState::tag_cache`.

**Windowing**

Window resolution order is:

1. `mode=full_dynamic`, which uses current-frame min/max and ignores explicit
   and DICOM window values.
2. Explicit `?wc=&ww=` query parameters.
3. DICOM Window Center/Width from loader metadata.
4. 1st/99th percentile fallback from current-frame samples.

The display pipeline applies rescale slope/intercept before windowing for
uncompressed paths. The frontend raw-frame renderer receives rescale metadata in
headers and applies the same convention client-side.

**DICOM collector use**

JPEG 2000 display decoding reads encapsulated fragments through
`DicomCollector`. The current implementation reads fragments sequentially up to
the requested frame. Do not document or rely on a cached BOT/frame-offset index
unless one is actually implemented.

**Annotations**

- `--annotations` loads EMBED-style CSV rows into memory only.
- The input CSV and DICOM files must not be modified.
- API edits replace the in-memory annotations for one file and are validated
  against image bounds and frame count.
- Export writes a fresh EMBED-style CSV from the current in-memory store.

### Svelte 5 / TypeScript frontend

- Use Svelte 5 runes (`$state`, `$derived`, `$effect`); avoid legacy `$:`
  reactive declarations.
- Shared root state lives in `App.svelte`: active file/frame, window settings,
  active tool, selected preset, orientation, reset count, and tag panel layout.
- All backend calls go through `frontend/src/api.ts`; do not add raw `fetch`
  calls in components when a typed wrapper belongs there.
- The viewport supports two render paths: display PNG blobs for cine mode and
  raw-frame client-side rendering for interactive diagnostic/window-level work.
- Window/level interactions should avoid flooding requests; prefer local raw
  rendering or debounced/networked updates depending on the mode being changed.
- Zoom and pan use canvas/CSS transform state and should not refetch frames.
- Zoom/pan state is per file. Switching frames preserves viewport transform;
  switching files resets to identity.
- Orientation state is per file and supports horizontal flip, vertical flip, and
  90-degree rotation.
- ROI editing lives in `ImageViewport.svelte` with geometry helpers in
  `annotationGeometry.ts`; keep frame-scoping semantics consistent with backend
  validation.
- No external CSS frameworks. Use scoped Svelte styles.
- Dark theme palette remains centered on `#1a1a1a`, `#242424`, `#e0e0e0`, and
  `#4a9eff`.
- Use monospace (`JetBrains Mono` / `ui-monospace`) for tag values and
  `system-ui` for viewer chrome.

### CLI

```text
dcmview [OPTIONS] <PATH> [PATH ...]
  -p, --port <u16>          default: 0 (auto-assign)
  --host <str>              default: 127.0.0.1
  --no-browser
  --tunnel
  --tunnel-host <str>
  --tunnel-port <u16>       default: 0
  --timeout <u64>           seconds; no timeout if absent
  --no-recursive
  --annotations <csv>
```

The server is unauthenticated. Keep loopback binding as the default and prefer
SSH forwarding for remote use. If a public bind is added or changed, preserve
the warning path in `server.rs`.

---

## Important Files

| File | Role |
|---|---|
| `README.md` | Public documentation and PyPI long description |
| `src/main.rs` | CLI struct and startup orchestration |
| `src/server.rs` | Axum router, API handlers, `AppState`, shutdown |
| `src/loader.rs` | DICOM discovery and metadata extraction |
| `src/pixels.rs` | Pixel decode, display PNGs, raw frames, LRU caches |
| `src/annotations.rs` | ROI CSV import/export, validation, in-memory store |
| `src/types.rs` | Shared backend/frontend contract types |
| `src/tunnel.rs` | SSH subprocess lifecycle |
| `build.rs` | Frontend build integration and Cargo fingerprints |
| `frontend/src/api.ts` | Typed frontend fetch wrappers |
| `frontend/src/App.svelte` | Root frontend state and layout |
| `frontend/src/lib/ImageViewport.svelte` | Viewer rendering, tools, ROI editing |
| `python/dcmview_py/wrapper.py` | Python subprocess wrapper |
| `examples/generate_test_fixtures.rs` | Synthetic fixture generator |

---

## Runtime / Tooling

- **Runtime:** Rust stable 1.75+, Tokio async runtime (`features = ["full"]`).
- **Frontend toolchain:** Vite + Svelte 5 + TypeScript; Node 18+, npm.
- **Rust package manager:** Cargo.
- **Frontend package manager:** npm. Do not switch to bun or pnpm because
  `build.rs` calls npm.
- **Build integration:** `build.rs` builds `frontend/dist/`; release binaries
  embed those assets through `rust-embed`.
- **Python package:** `dcmview-py` exposes `dcmview` and `dcmview-py` console
  scripts and resolves a bundled binary, `DCMVIEW_BINARY`, or `PATH`.

### Cargo feature flags

- `debug-embed`: enables `rust-embed/debug-embed` so development builds can
  serve `frontend/dist/` from disk.
- `remote-fixtures`: enables tests that use the `dicom-test-files` crate.

---

## Testing & QA

**Framework:** `cargo test` plus `axum-test` for HTTP integration tests.

**Committed fixtures:**

- `golden-uncompressed-u16-multiframe.dcm`
- `golden-jpeg-baseline-single-frame.dcm`
- `golden-jpeg-baseline-multiframe-bot.dcm`
- `golden-no-pixels-sr.dcm`

Fixtures are generated by:

```bash
cargo run --example generate_test_fixtures
```

Remote JPEG 2000 coverage is behind the `remote-fixtures` feature and ignored
by default because it may download/cache files through `dicom-test-files`.

**Key integration test assertions:**

- `X-Cache: MISS` on first frame request; `X-Cache: HIT` on identical repeat.
- Cache misses when window parameters or window mode change.
- Display frames for supported image syntaxes return `Content-Type: image/png`.
- JPEG 2000 display paths decode server-side rather than returning raw
  compressed fragments.
- Raw-frame endpoints return decoded samples with metadata headers.
- Uncompressed pixel values match fixture expectations after windowing.
- Files without pixel data appear with `has_pixels: false`; frame requests for
  them return 404.
- Port `0` auto-assign reports the actual listener port.
- `--timeout` exits after the configured idle period.
- Mixed DICOM/non-DICOM discovery reports valid files and skip counts.
- Annotation load, edit, validation, and CSV export preserve the EMBED-style
  contract.
- Tunnel setup degrades gracefully when SSH is unavailable or forwarding cannot
  become ready.

Do not mock the DICOM layer for integration coverage. Use generated fixtures or
feature-gated remote fixtures so codec and metadata behavior stay exercised.

**Performance targets** should be verified with timing instrumentation, not
mocks:

- Startup for a small file set should stay well under interactive latency
  thresholds.
- First decoded frame should be fast enough for iterative inspection when codec
  cost permits.
- Memory usage should remain bounded across sequential multi-frame requests by
  cache budgets and one-frame decode behavior.
