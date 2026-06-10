#!/usr/bin/env python3
from __future__ import annotations

import argparse
import pathlib
import shutil
import stat
import tarfile

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]

TARGETS = {
	"linux-x64": "x86_64-unknown-linux-gnu",
	"darwin-x64": "x86_64-apple-darwin",
	"darwin-arm64": "aarch64-apple-darwin",
}


def find_archive(artifacts_dir: pathlib.Path, suffix: str) -> pathlib.Path:
	candidates = sorted(artifacts_dir.glob(f"**/dcmview-*-{suffix}.tar.gz"))
	if len(candidates) != 1:
		found = ", ".join(str(candidate) for candidate in candidates) or "none"
		raise RuntimeError(f"expected one release archive for {suffix}, found {found}")
	return candidates[0]


def extract_binary(archive: pathlib.Path, destination: pathlib.Path) -> None:
	with tarfile.open(archive, "r:gz") as tar:
		member = next((member for member in tar.getmembers() if pathlib.PurePosixPath(member.name).name == "dcmview"), None)
		if member is None:
			raise RuntimeError(f"{archive} does not contain a dcmview binary")
		source = tar.extractfile(member)
		if source is None:
			raise RuntimeError(f"{archive} contains an unreadable dcmview binary")
		destination.parent.mkdir(parents=True, exist_ok=True)
		with destination.open("wb") as output:
			shutil.copyfileobj(source, output)
	mode = destination.stat().st_mode
	destination.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def main() -> int:
	parser = argparse.ArgumentParser(description="Stage release binaries into the VS Code extension")
	parser.add_argument(
		"--artifacts-dir",
		type=pathlib.Path,
		default=REPO_ROOT / "artifacts",
		help="Directory containing release-* artifact folders downloaded from GitHub Actions",
	)
	parser.add_argument(
		"--extension-root",
		type=pathlib.Path,
		default=REPO_ROOT / "vscode",
		help="VS Code extension root",
	)
	args = parser.parse_args()

	for platform, suffix in TARGETS.items():
		archive = find_archive(args.artifacts_dir, suffix)
		destination = args.extension_root / "resources" / "bin" / platform / "dcmview"
		extract_binary(archive, destination)
		print(f"staged {destination} from {archive}")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
