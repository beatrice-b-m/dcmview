# Releasing `dcmview`

Release automation is split across two workflows:

- `.github/workflows/ci.yml` runs Linux-only tests on pushes and pull requests
- `.github/workflows/release.yml` builds tagged release artifacts for Linux and macOS

## Release channels

- **GitHub Releases** are the canonical binary artifacts
- **PyPI wheels** are the preferred Linux/server install path when `PUBLISH_PYPI=1`
- **VSIX files** are built for closed VS Code extension testing and are attached
  to GitHub Releases
- **Homebrew** formula generation is always part of the release job, and tap publication is enabled when `HOMEBREW_TAP_REPOSITORY` is configured

## Required repository configuration

Optional release publishing is gated behind repository settings:

- `PUBLISH_PYPI=1` enables the PyPI publish job
- `HOMEBREW_TAP_REPOSITORY` points to the separate tap repo, for example `your-org/homebrew-tap`
- `HOMEBREW_TAP_TOKEN` is a token with push access to the tap repo

For PyPI, prefer GitHub trusted publishing on the `pypi` environment. The workflow already requests `id-token: write`.

## Standard release flow

1. Regenerate fixtures if they changed:
   `cargo run --example generate_test_fixtures`
2. Run the local checks:
   `python3 scripts/check_versions.py`
   `cargo fmt --all -- --check`
   `cargo test`
   `python3 -m unittest python.tests.test_wrapper`
   `npm --prefix vscode run compile`
3. Tag the exact version declared in `Cargo.toml`, `pyproject.toml`, and
   `vscode/package.json`:
   `VERSION="$(python3 scripts/check_versions.py --print-version)"`
   `git tag "v${VERSION}"`
   `git push origin "v${VERSION}"`

The release workflow will:

- build `dcmview` on Ubuntu 22.04, macOS Intel, and macOS Apple Silicon
- fail before release builds if the pushed tag does not match the checked-in package versions
- build the Linux PyPI wheel inside a `manylinux_2_28_x86_64` container so the published wheel is PyPI-compatible
- smoke test each built binary against the committed fixture corpus
- validate the Linux release artifact on Ubuntu 22.04 and Ubuntu 24.04
- build bundled `dcmview-py` wheels
- stage Linux x64, macOS x64, and macOS arm64 binaries into
  `vscode/resources/bin/**` and package one universal closed-test VSIX
- publish release tarballs and wheels to GitHub Releases
- publish the VSIX to GitHub Releases for closed testing
- render `packaging/homebrew/dcmview.rb`
- optionally publish to PyPI and the configured tap repo

## VS Code closed-test package

The VSIX packaging job downloads the same platform archives produced by the
release build matrix and runs:

```bash
npm --prefix vscode ci
npm --prefix vscode run package:release
```

`package:release` stages binaries into these extension paths before invoking
`vsce package`:

- `vscode/resources/bin/linux-x64/dcmview`
- `vscode/resources/bin/darwin-x64/dcmview`
- `vscode/resources/bin/darwin-arm64/dcmview`

Closed testers install the attached `.vsix` with `Extensions: Install from
VSIX...`. `dcmview.binaryPath` remains the override for unsupported platforms,
local debug binaries, and troubleshooting bundled-binary issues.
