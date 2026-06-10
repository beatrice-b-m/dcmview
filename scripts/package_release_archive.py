#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import pathlib
import tarfile
import zipfile

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]


def normalized_version(version: str) -> str:
	return version[1:] if version.startswith("v") else version


def sha256_file(path: pathlib.Path) -> str:
	digest = hashlib.sha256()
	with path.open("rb") as file:
		for chunk in iter(lambda: file.read(1024 * 1024), b""):
			digest.update(chunk)
	return digest.hexdigest()


def archive_members(binary: pathlib.Path, binary_name: str) -> list[tuple[pathlib.Path, str]]:
	return [
		(binary, binary_name),
		(REPO_ROOT / "README.md", "README.md"),
		(REPO_ROOT / "LICENSE", "LICENSE"),
	]


def write_tar_gz(output: pathlib.Path, members: list[tuple[pathlib.Path, str]]) -> None:
	with tarfile.open(output, "w:gz") as archive:
		for source, name in members:
			archive.add(source, arcname=name)


def write_zip(output: pathlib.Path, members: list[tuple[pathlib.Path, str]]) -> None:
	with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
		for source, name in members:
			archive.write(source, arcname=name)


def main() -> int:
	parser = argparse.ArgumentParser(description="Package a dcmview release binary archive")
	parser.add_argument("--version", required=True, help="Release version, with or without v prefix")
	parser.add_argument("--archive-suffix", required=True)
	parser.add_argument("--binary", type=pathlib.Path, required=True)
	parser.add_argument("--binary-name", required=True)
	parser.add_argument("--format", choices=["tar.gz", "zip"], required=True)
	parser.add_argument("--out-dir", type=pathlib.Path, default=REPO_ROOT / "dist")
	args = parser.parse_args()

	binary = args.binary.resolve()
	if not binary.is_file():
		raise RuntimeError(f"release binary does not exist: {binary}")

	args.out_dir.mkdir(parents=True, exist_ok=True)
	version = normalized_version(args.version)
	archive_name = f"dcmview-{version}-{args.archive_suffix}.{args.format}"
	output = args.out_dir / archive_name
	members = archive_members(binary, args.binary_name)

	if args.format == "tar.gz":
		write_tar_gz(output, members)
	else:
		write_zip(output, members)

	(output.with_name(f"{output.name}.sha256")).write_text(f"{sha256_file(output)}\n", encoding="utf-8")
	print(output)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
