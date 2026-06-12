# VS Code extension local testing

The VS Code extension is a local development wrapper around the existing
`dcmview` binary. Marketplace VSIX builds are target-specific and bundle release
binaries for Linux x64, macOS x64, macOS arm64, and Windows x64.

## One-time setup

```bash
npm --prefix vscode install
cargo build
```

The extension resolves binaries in this order:

1. `dcmview.binaryPath` VS Code setting.
2. `target/debug/dcmview` from this repository, or `target/debug/dcmview.exe`
   on Windows.
3. `vscode/resources/bin/<platform>-<arch>/dcmview` bundled in Marketplace VSIX
   builds, where supported platform directories are `linux-x64`, `darwin-x64`,
   `darwin-arm64`, and `win32-x64`. Windows uses `dcmview.exe`.
4. `dcmview` on `PATH`.

When `dcmview.terminalInterception.enabled` is true, the extension starts a
private loopback bridge and prepends generated shims to new integrated
terminals. Open a fresh terminal after the Extension Development Host starts so
the terminal receives the bridge environment.

The bridge is also published through a short-lived registry file on the remote
host so direct `dcmview` binaries launched inside the active workspace and
`dcmview_py.view(...)` calls from VS Code Jupyter kernels can route into the VS
Code webview even when they did not inherit the integrated-terminal environment.
The extension refreshes the registry hourly; entries expire after 3 hours so
crash leftovers do not affect future sessions indefinitely. Direct Rust CLI
registry discovery requires the current working directory to be inside a VS Code
workspace root. The Python wrapper intentionally accepts any live bridge on the
host for notebook kernels whose cwd may be outside the workspace; pass
`vscode_bridge=False` to `dcmview_py.view(...)` or set
`DCMVIEW_VSCODE_BYPASS=1` to opt out. Set
`DCMVIEW_VSCODE_BRIDGE_REGISTRY_DIR` only for testing custom registry locations.

## Run in an Extension Development Host

1. Open this repository in VS Code.
2. Run the `Run dcmview VS Code Extension` launch configuration.
3. In the Extension Development Host, right-click a fixture such as
   `tests/fixtures/golden-uncompressed-u16-multiframe.dcm`.
4. Choose `Open with dcmview`.
5. Confirm the dcmview panel opens, frame navigation works, and closing the
   panel stops the spawned server.
6. Open the same fixture with `Reopen With...` and choose `dcmview`.
7. Confirm the readonly editor tab opens, frame navigation works, and closing
   the tab stops the spawned server.

Folder testing uses the same context menu action. Use `tests/fixtures/` to
verify multi-file discovery.

## Terminal interception testing

In a fresh integrated terminal in the Extension Development Host:

```bash
dcmview tests/fixtures/golden-uncompressed-u16-multiframe.dcm
python -m dcmview_py --no-browser tests/fixtures/golden-uncompressed-u16-multiframe.dcm
dcmview-py --no-browser tests/fixtures/golden-uncompressed-u16-multiframe.dcm
```

Each command should open a `dcmview` webview panel instead of opening an
external browser. Closing the panel should unblock the terminal command. Pressing
Ctrl+C in the terminal should stop the extension-managed session.

Python API calls inherit the same bridge when run from a fresh integrated
terminal:

```bash
python - <<'PY'
from dcmview_py import view
with view(["tests/fixtures/golden-uncompressed-u16-multiframe.dcm"], block=False) as handle:
    print(handle.url)
PY
```

Set `DCMVIEW_VSCODE_BYPASS=1` in the terminal to run the normal local CLI or
Python wrapper path without extension interception.

## Command testing checklist

- `dcmview: Open with dcmview` opens selected files and folders.
- `dcmview: Open Workspace with dcmview` opens the selected workspace folder.
- `dcmview: Stop All dcmview Sessions` terminates all running child processes.
- `Reopen With...` offers `dcmview` for `*.dcm`, `*.dicom`, and `*.ima` files.
- Setting `dcmview` as the default editor for matching DICOM extensions makes
  double-click open those files in a dcmview editor tab.
- Extensionless DICOM files still open through the explicit context menu
  command.
- Annotation export from the iframe downloads or prompts correctly in the local
  VS Code build.
- `dcmview.binaryPath` overrides the repo debug binary.
- `dcmview.defaultRecursive=false` passes `--no-recursive`.
- `dcmview.extraArgs` are appended before selected paths.
- Fresh integrated terminal `dcmview ...` opens a webview panel and blocks until
  the extension-managed session exits.
- Fresh integrated terminal `python -m dcmview_py ...` and `dcmview-py ...` open
  webview panels.
- VS Code Jupyter kernels connected to the same remote workspace discover the
  bridge registry and open webview panels for `dcmview_py.view(...)` calls.
- Python `dcmview_py.view(..., block=False)` returns a handle whose `stop()`
  closes the extension-managed session.
- `DCMVIEW_VSCODE_BYPASS=1` disables interception for the current command.

## Automated checks

```bash
npm --prefix vscode run compile
npm --prefix vscode test
```

`npm --prefix vscode test` uses `@vscode/test-electron` and may download a VS
Code test build into `vscode/.vscode-test/`.

## Target-specific VSIX packaging

Release automation stages one binary at a time from the platform release
archives into `vscode/resources/bin/**` and packages target-specific VSIX
artifacts:

```bash
npm --prefix vscode run package:release
```

That command expects downloaded release artifacts under `artifacts/`. For local
packaging experiments, create matching `dcmview-*-<target>.tar.gz` archives for
`x86_64-unknown-linux-gnu`, `x86_64-apple-darwin`, and
`aarch64-apple-darwin`, plus a `dcmview-*-x86_64-pc-windows-msvc.zip` archive
containing `dcmview.exe`, or use `dcmview.binaryPath` to test a local binary
without bundling.

Install or update a target VSIX from VS Code with `Extensions: Install from
VSIX...`. If the bundled binary is not right for the host, set
`dcmview.binaryPath` to an absolute path and reload the extension host.
