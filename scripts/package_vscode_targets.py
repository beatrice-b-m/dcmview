#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import stat
import subprocess
import tarfile
import zipfile

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


def read_extension_version(extension_root: pathlib.Path) -> str:
	package_json = json.loads((extension_root / "package.json").read_text(encoding="utf-8"))
	version = package_json.get("version")
	if not isinstance(version, str) or not version:
		raise RuntimeError("vscode/package.json does not define a version")
	return version


def clear_staged_binaries(extension_root: pathlib.Path) -> None:
	for binary in (extension_root / "resources" / "bin").glob("*/dcmview"):
		binary.unlink()


def package_target(
	*,
	target: str,
	archive_suffix: str,
	artifacts_dir: pathlib.Path,
	extension_root: pathlib.Path,
	out_dir: pathlib.Path,
	version: str,
) -> pathlib.Path:
	clear_staged_binaries(extension_root)
	archive = find_archive(artifacts_dir, archive_suffix)
	destination = extension_root / "resources" / "bin" / target / "dcmview"
	extract_binary(archive, destination)

	out_dir.mkdir(parents=True, exist_ok=True)
	vsix = out_dir / f"dcmview-{version}-{target}.vsix"
	subprocess.run(
		[
			"npm",
			"exec",
			"--",
			"vsce",
			"package",
			"--target",
			target,
			"--no-dependencies",
			"--out",
			str(vsix),
		],
		cwd=extension_root,
		check=True,
	)
	verify_single_bundled_binary(vsix, target)
	return vsix


def verify_single_bundled_binary(vsix: pathlib.Path, target: str) -> None:
	expected = f"extension/resources/bin/{target}/dcmview"
	with zipfile.ZipFile(vsix) as package:
		bundled = sorted(
			name
			for name in package.namelist()
			if name.startswith("extension/resources/bin/") and pathlib.PurePosixPath(name).name == "dcmview"
		)
	if bundled != [expected]:
		raise RuntimeError(f"{vsix} should contain only {expected}; found {bundled}")


def main() -> int:
	parser = argparse.ArgumentParser(description="Package target-specific dcmview VSIX artifacts")
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
	parser.add_argument(
		"--out-dir",
		type=pathlib.Path,
		default=REPO_ROOT / "dist",
		help="Directory for generated VSIX artifacts",
	)
	parser.add_argument(
		"--target",
		action="append",
		choices=sorted(TARGETS),
		help="Target to package; may be repeated. Defaults to all supported targets.",
	)
	parser.add_argument(
		"--skip-compile",
		action="store_true",
		help="Skip npm compile before packaging",
	)
	args = parser.parse_args()

	extension_root = args.extension_root.resolve()
	targets = args.target or sorted(TARGETS)
	version = read_extension_version(extension_root)

	if not args.skip_compile:
		subprocess.run(["npm", "run", "compile"], cwd=extension_root, check=True)

	try:
		for target in targets:
			vsix = package_target(
				target=target,
				archive_suffix=TARGETS[target],
				artifacts_dir=args.artifacts_dir,
				extension_root=extension_root,
				out_dir=args.out_dir,
				version=version,
			)
			print(f"packaged {vsix}")
	finally:
		clear_staged_binaries(extension_root)

	return 0


if __name__ == "__main__":
	raise SystemExit(main())
