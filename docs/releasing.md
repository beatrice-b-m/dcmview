# Releasing `dcmview`

Release automation is split across two workflows:

- `.github/workflows/ci.yml` runs Linux-only tests on pushes and pull requests
- `.github/workflows/release.yml` builds tagged release artifacts for Linux and macOS
- `azure-pipelines/vscode-marketplace.yml` publishes VS Code Marketplace
  packages from GitHub Release assets

## Release channels

- **GitHub Releases** are the canonical binary artifacts
- **PyPI wheels** are the preferred Linux/server install path when `PUBLISH_PYPI=1`
- **VSIX files** are target-specific Marketplace packages attached to GitHub
  Releases and published by Azure Pipelines
- **Homebrew** formula generation is always part of the release job, and tap publication is enabled when `HOMEBREW_TAP_REPOSITORY` is configured

## Required repository configuration

Optional release publishing is gated behind repository settings:

- `PUBLISH_PYPI=1` enables the PyPI publish job
- `HOMEBREW_TAP_REPOSITORY` points to the separate tap repo, for example `your-org/homebrew-tap`
- `HOMEBREW_TAP_TOKEN` is a token with push access to the tap repo

For PyPI, prefer GitHub trusted publishing on the `pypi` environment. The workflow already requests `id-token: write`.

VS Code Marketplace publishing is handled in Azure DevOps:

- Azure DevOps organization: `beatricebm`
- Azure DevOps project: `dcmview`
- Visual Studio Marketplace publisher: `beatricebm`
- Service connection: `dcmview-marketplace-publisher`
- Approval environment: `vscode-marketplace`

The Azure pipeline uses Microsoft Entra ID with workload identity federation and
publishes only VSIX assets that already exist on the GitHub Release.

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
- package target-specific VSIX artifacts for Linux x64, macOS x64, and macOS
  arm64
- publish release tarballs and wheels to GitHub Releases
- publish the VSIX artifacts to GitHub Releases
- render `packaging/homebrew/dcmview.rb`
- optionally publish to PyPI and the configured tap repo
- trigger the Azure pipeline, which waits for the GitHub Release VSIX assets and
  publishes them to the VS Code Marketplace after `vscode-marketplace` approval

## VS Code Marketplace packages

The VSIX packaging job downloads the same platform archives produced by the
release build matrix and runs:

```bash
npm --prefix vscode ci
npm --prefix vscode run package:release
```

`package:release` builds these target-specific VSIX artifacts:

- `dist/dcmview-<version>-linux-x64.vsix`
- `dist/dcmview-<version>-darwin-x64.vsix`
- `dist/dcmview-<version>-darwin-arm64.vsix`

Each package contains exactly one bundled binary at
`vscode/resources/bin/<target>/dcmview`. Windows and other platforms are not
published yet. `dcmview.binaryPath` remains the override for unsupported
platforms, local debug binaries, and troubleshooting bundled-binary issues.

The Azure Marketplace pipeline is tag-triggered, but the publish deployment is
bound to the `vscode-marketplace` environment. Its approval check provides the
final manual gate without requiring a separate manually triggered release flow.
