# Releasing `dcmview`

Release automation is split across two workflows:

- `.github/workflows/ci.yml` runs Linux-only tests on pushes and pull requests
- `.github/workflows/release.yml` builds tagged release artifacts for Linux and macOS

## Release channels

- **GitHub Releases** are the canonical binary artifacts
- **PyPI wheels** are the preferred Linux/server install path when `PUBLISH_PYPI=1`
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
3. Tag the exact version declared in `Cargo.toml` and `pyproject.toml`:
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
- publish release tarballs and wheels to GitHub Releases
- render `packaging/homebrew/dcmview.rb`
- optionally publish to PyPI and the configured tap repo
