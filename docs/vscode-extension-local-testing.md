# VS Code extension local testing

The VS Code extension is a local development wrapper around the existing
`dcmview` binary. It does not include Marketplace publishing or bundled release
binary packaging yet.

## One-time setup

```bash
npm --prefix vscode install
cargo build
```

The extension resolves binaries in this order:

1. `dcmview.binaryPath` VS Code setting.
2. `target/debug/dcmview` from this repository.
3. `dcmview` on `PATH`.

## Run in an Extension Development Host

1. Open this repository in VS Code.
2. Run the `Run dcmview VS Code Extension` launch configuration.
3. In the Extension Development Host, right-click a fixture such as
   `tests/fixtures/golden-uncompressed-u16-multiframe.dcm`.
4. Choose `Open with dcmview`.
5. Confirm the dcmview panel opens, frame navigation works, and closing the
   panel stops the spawned server.

Folder testing uses the same context menu action. Use `tests/fixtures/` to
verify multi-file discovery.

## Command testing checklist

- `dcmview: Open with dcmview` opens selected files and folders.
- `dcmview: Open Workspace with dcmview` opens the selected workspace folder.
- `dcmview: Stop All dcmview Sessions` terminates all running child processes.
- Annotation export from the iframe downloads or prompts correctly in the local
  VS Code build.
- `dcmview.binaryPath` overrides the repo debug binary.
- `dcmview.defaultRecursive=false` passes `--no-recursive`.
- `dcmview.extraArgs` are appended before selected paths.

## Automated checks

```bash
npm --prefix vscode run compile
npm --prefix vscode test
```

`npm --prefix vscode test` uses `@vscode/test-electron` and may download a VS
Code test build into `vscode/.vscode-test/`.
