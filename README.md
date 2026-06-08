# dcmview

`dcmview` is an ephemeral DICOM inspection tool for developers and data scientists. It scans one or more DICOM files or directories, starts a local browser viewer, exposes a small HTTP API for frames, tags, and annotations, and exits cleanly when stopped.

The main use case is fast multi-frame inspection, such as DBT and cine MR, from a single Rust binary with the Svelte frontend embedded at build time.

## Install

Prerequisites:

- Rust stable 1.75+
- Node.js 18+ and npm at build time
- `ssh` on `PATH` only when using `--tunnel`

Install from a checkout of this repository:

```bash
cargo install --path .
```

Build without installing:

```bash
cargo build --release
./target/release/dcmview --help
```

`build.rs` runs `npm ci` when `frontend/package-lock.json` changes and then builds the frontend. If `node` or `npm` are not on `PATH`, set `DCMVIEW_NODE_PATH` or `DCMVIEW_NPM_PATH` to absolute executable paths.

## Quick Start

```bash
# Open one file in the browser
dcmview ./scan.dcm

# Scan a directory recursively
dcmview ./study_dir

# Run headless on a fixed port and stop after 5 idle minutes
dcmview --host 127.0.0.1 --port 8888 --no-browser --timeout 300 ./study_dir
```

When ready, `dcmview` prints:

```text
dcmview: server running at http://127.0.0.1:<port>
```

Press Ctrl+C to stop the server.

## CLI

```text
dcmview [OPTIONS] <PATH> [PATH ...]
```

| Option | Default | Description |
|---|---:|---|
| `<PATH>...` | required | DICOM files or directories to inspect |
| `-p, --port <u16>` | `0` | Bind port; `0` auto-assigns an available port |
| `--host <addr>` | `127.0.0.1` | Bind address |
| `--no-browser` | false | Do not open the browser automatically |
| `--timeout <seconds>` | none | Exit after this many seconds without API/browser requests |
| `--no-recursive` | false | Scan only the top level of input directories |
| `--tunnel` | false | Start an SSH local port-forward helper |
| `--tunnel-host <host>` | none | SSH target used with `--tunnel` |
| `--tunnel-port <u16>` | `0` | Forwarded local port; `0` uses the server port |
| `--annotations <csv>` | none | Load EMBED-style ROI annotations for overlay and editing |

Examples:

```bash
dcmview ./scan.dcm
dcmview --no-recursive ./study_dir
dcmview --host 0.0.0.0 --port 8888 ./study_dir
dcmview --tunnel --tunnel-host user@host --tunnel-port 9000 ./study_dir
dcmview --annotations ./embed_annotations.csv ./study_dir
```

The server is unauthenticated. It binds to loopback by default; if you bind to a public interface, use your own network access controls.

## Viewer

The embedded Svelte viewer includes:

- File tabs labeled from `PatientID · Modality · StudyDate` when available, otherwise by filename
- Canvas-based frame viewing with pan, zoom, scroll, window/level, reset, flips, and 90-degree rotation
- Window presets: Default, Full Dynamic, and common CT presets
- Multi-frame controls with previous/next, cine playback, FPS selection, loop, and sweep
- Lazy DICOM tag browsing with filter, sequence expansion, binary length display, resizable columns, and click-to-copy
- Rectangular ROI annotation display and editing, including draw, select, move, resize, delete, frame scoping, and CSV export

Input shortcuts:

| Action | Shortcut |
|---|---|
| Frame previous/next | Left/Right arrows or `[` / `]` |
| Play/pause cine | Space |
| Window/level tool | `W` |
| Pan tool | `P` |
| Zoom tool | `Z` |
| Scroll tool | `S` |
| ROI tool | `R` |
| Reset viewport | Double-click |

Mouse behavior depends on the active tool. Right-drag always zooms, middle-drag always pans, the wheel scrolls frames, and Ctrl/Cmd+wheel zooms.

## Annotations

`--annotations` loads an EMBED-style CSV into memory. dcmview never modifies the input CSV or DICOM files. Viewer edits are kept in memory and can be downloaded with **Export ROIs**.

Required columns:

- `anon_dicom_path`
- `ROI_coords`

Optional columns:

- `num_ROI`; when present, it must equal `len(ROI_coords)`
- `ROI_frames`; when omitted or `[]`, ROIs apply to all frames

`ROI_coords` is a JSON array of `[ymin, xmin, ymax, xmax]` boxes. `ROI_frames` is a JSON array of frame-index lists. JSON-valued fields must be CSV-quoted.

```csv
anon_dicom_path,num_ROI,ROI_coords,ROI_frames
/path/to/dbt_case.dcm,2,"[[120,340,220,430],[400,510,480,590]]","[[0,1,2],[5,6]]"
/path/to/ffdm_case.dcm,1,"[[80,150,190,260]]","[]"
```

Behavior:

- Matching uses normalized path equality against loaded DICOM paths
- Rows without a matching loaded file are ignored
- Loaded files without matching rows start with no ROIs
- Duplicate `anon_dicom_path` rows are rejected
- Frame indices are zero-based and must be less than `NumberOfFrames`
- Coordinates are canonicalized to `[ymin, xmin, ymax, xmax]` when edited through the API

## Python Wrapper

The `dcmview-py` package is a thin subprocess wrapper. It does not bundle the Rust binary; `dcmview` must be on `PATH`.

```bash
cargo install --path .
python -m pip install -e .
python -m dcmview_py --help
```

Script usage:

```python
from dcmview_py import view

# Blocking call; returns when dcmview exits.
view(["./scan.dcm"], browser=False, timeout=300)

# Non-blocking call.
handle = view(["./study_dir"], browser=False, annotations="./embed_annotations.csv", block=False)
print(handle.url)
handle.stop()
```

Context manager:

```python
from dcmview_py import view

with view(["./study_dir"], browser=False, block=False) as handle:
    print(handle.url)
```

Module CLI:

```bash
python -m dcmview_py --no-browser --timeout 120 ./study_dir
python -m dcmview_py --annotations ./embed_annotations.csv ./study_dir
```

The module CLI mirrors the Rust options: `--host`, `--port`, `--tunnel`, `--no-recursive`, `--annotations`, and related flags.

## HTTP API

Static frontend assets are served at `/` and `/assets/*`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/files` | File registry and server metadata |
| GET | `/api/file/:index/info` | Frame metadata for one file |
| GET | `/api/file/:index/frame/:frame` | Display frame; supported image transfer syntaxes return PNG |
| GET | `/api/file/:index/frame/:frame/raw` | Decoded frame sample bytes for client-side rendering |
| GET | `/api/file/:index/tags` | Lazy DICOM tag tree |
| GET | `/api/file/:index/annotations` | Current in-memory ROI annotations |
| PUT | `/api/file/:index/annotations` | Replace in-memory ROI annotations for one file |
| GET | `/api/annotations/export.csv` | Download current annotations as EMBED CSV |

### Files

`GET /api/files` returns:

```json
{
  "files": [
    {
      "index": 0,
      "path": "/path/to/scan.dcm",
      "label": "PATIENT · MG · 20240101",
      "has_pixels": true,
      "frame_count": 60,
      "rows": 3000,
      "columns": 2500,
      "transfer_syntax_uid": "1.2.840.10008.1.2.4.50",
      "default_window": { "center": 200.0, "width": 4000.0 }
    }
  ],
  "tunnelled": false,
  "tunnel_host": null,
  "server_start_ms": 1714300000000
}
```

`GET /api/file/:index/info` returns `frame_count`, `rows`, `columns`, `transfer_syntax`, `has_pixels`, and `default_window` for one file.

### Display Frames

`GET /api/file/:index/frame/:frame` returns `image/png` for supported display paths.

Query parameters:

| Param | Description |
|---|---|
| `wc` | Window center; used with `ww` in default mode |
| `ww` | Window width; used with `wc` in default mode |
| `mode` | `default` or `full_dynamic` |

Window selection:

- `default`: explicit `wc` and `ww`, then DICOM Window Center/Width, then 1st/99th percentile fallback
- `full_dynamic`: true min/max of the current frame; ignores DICOM defaults and query window values

Transfer syntax behavior:

| Transfer syntax | Display behavior |
|---|---|
| JPEG Baseline / Extended | Decoded server-side and PNG-encoded |
| JPEG Lossless / Lossless SV1 | Decoded server-side and PNG-encoded |
| JPEG 2000 lossless/lossy | Decoded server-side and PNG-encoded |
| Implicit LE / Explicit LE / Explicit BE | Windowed server-side and PNG-encoded |
| JPEG-LS / RLE / other | `422 {"error": "unsupported transfer syntax: ..."}` |

Response headers include `X-Cache: HIT` or `X-Cache: MISS`.

### Raw Frames

`GET /api/file/:index/frame/:frame/raw` returns `application/octet-stream` plus metadata headers. This is a decoded sample transport for the frontend, not a copy of the original DICOM Pixel Data element for compressed syntaxes.

Supported raw paths:

- Uncompressed frames: native sample bytes, normalized to little-endian by `dicom-object`
- JPEG Baseline / Extended: decoded to 8-bit grayscale samples
- JPEG Lossless: decoded to 8-bit or 16-bit grayscale samples when supported by the codec stack
- Grayscale JPEG 2000: decoded to 8-bit or 16-bit samples

JPEG-LS, RLE, unsupported syntaxes, and multi-component JP2 raw decoding return 422 or a decode error.

Headers:

- `X-Cache`
- `X-Frame-Rows`, `X-Frame-Columns`
- `X-Frame-Bits-Allocated`, `X-Frame-Pixel-Representation`
- `X-Frame-Samples-Per-Pixel`, `X-Frame-Photometric-Interpretation`
- `X-Frame-Rescale-Slope`, `X-Frame-Rescale-Intercept`
- `X-Frame-Default-Wc`, `X-Frame-Default-Ww` when DICOM window tags are available

### Tags

`GET /api/file/:index/tags` returns an array of tag nodes:

```json
[
  {
    "tag": "(0008,0060)",
    "vr": "CS",
    "keyword": "Modality",
    "value": { "type": "string", "value": "MG" }
  }
]
```

Value types are `string`, `number`, `numbers`, `binary`, `sequence`, and `error`. Pixel data and other binary VRs are represented by byte length, not by full values. Long numeric arrays and sequences may be truncated with `truncated` and `total` fields.

### Annotations

`GET /api/file/:index/annotations` returns:

```json
{
  "num_roi": 2,
  "roi_coords": [[120, 340, 220, 430], [400, 510, 480, 590]],
  "roi_frames": [[0, 1, 2], [5, 6]]
}
```

Files without annotations return:

```json
{ "num_roi": 0, "roi_coords": [], "roi_frames": [] }
```

`PUT /api/file/:index/annotations` replaces one file's in-memory annotations and returns the canonicalized payload. Invalid coordinates or frame mappings return `400 {"error": "..."}`.

`GET /api/annotations/export.csv` downloads the current in-memory annotations as `anon_dicom_path,num_ROI,ROI_coords,ROI_frames`.

## Development

Frontend:

```bash
npm --prefix frontend ci
npm --prefix frontend run dev
npm --prefix frontend run build
```

Backend:

```bash
cargo check
cargo build
cargo build --release
```

Tests:

```bash
cargo test
```

Integration tests use real DICOM fixtures and cover discovery, display-frame decoding, raw-frame transport, cache headers, tag serialization, annotations, and tunnel fallback.

Architecture summary:

- Backend: Rust, Axum, Tokio
- DICOM: `dicom-rs`, `dicom-pixeldata`, `jpeg2k`
- Pixel pipeline: server-side display PNGs, raw sample transport for interactive rendering, LRU caches
- Frontend: Svelte 5, Vite, TypeScript, embedded via `rust-embed`
- Distribution: one executable with no runtime frontend assets

## License

MIT
