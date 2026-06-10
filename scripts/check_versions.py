#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]


def read_toml_version(path: pathlib.Path, section: str) -> str:
	try:
		import tomllib
	except ModuleNotFoundError:
		return read_toml_version_fallback(path, section)

	with path.open("rb") as file:
		data = tomllib.load(file)
	version = data.get(section, {}).get("version")
	if not isinstance(version, str) or not version:
		raise ValueError(f"{path.name} does not define [{section}].version")
	return version


def read_toml_version_fallback(path: pathlib.Path, section: str) -> str:
	in_section = False
	version_pattern = re.compile(r'^version\s*=\s*"([^"]+)"\s*$')

	for raw_line in path.read_text(encoding="utf-8").splitlines():
		line = raw_line.strip()
		if not line or line.startswith("#"):
			continue
		if line.startswith("[") and line.endswith("]"):
			in_section = line == f"[{section}]"
			continue
		if in_section:
			match = version_pattern.match(line)
			if match:
				return match.group(1)

	raise ValueError(f"{path.name} does not define [{section}].version")


def normalize_tag(tag: str) -> str:
	if not tag.startswith("v"):
		raise ValueError(f"release tag must start with 'v': {tag}")
	version = tag[1:]
	if not version:
		raise ValueError("release tag is missing a version after 'v'")
	return version


def read_package_json_version(path: pathlib.Path) -> str:
	data = json.loads(path.read_text(encoding="utf-8"))
	version = data.get("version")
	if not isinstance(version, str) or not version:
		raise ValueError(f"{path.name} does not define version")
	return version


def main() -> int:
	parser = argparse.ArgumentParser(description="Validate dcmview release versions")
	parser.add_argument(
		"--tag",
		help="Release tag to compare against Cargo.toml, e.g. v0.1.0",
	)
	parser.add_argument(
		"--print-version",
		action="store_true",
		help="Print only the canonical Cargo version",
	)
	args = parser.parse_args()

	try:
		cargo_version = read_toml_version(REPO_ROOT / "Cargo.toml", "package")
		python_version = read_toml_version(REPO_ROOT / "pyproject.toml", "project")
		vscode_version = read_package_json_version(REPO_ROOT / "vscode" / "package.json")
	except ValueError as error:
		print(str(error), file=sys.stderr)
		return 1

	if cargo_version != python_version or cargo_version != vscode_version:
		print(
			f"version mismatch: Cargo.toml has {cargo_version}, "
			f"pyproject.toml has {python_version}, "
			f"vscode/package.json has {vscode_version}",
			file=sys.stderr,
		)
		return 1

	if args.tag is not None:
		try:
			tag_version = normalize_tag(args.tag)
		except ValueError as error:
			print(str(error), file=sys.stderr)
			return 1
		if tag_version != cargo_version:
			print(
				f"version mismatch: tag {args.tag} resolves to {tag_version}, "
				f"Cargo.toml has {cargo_version}",
				file=sys.stderr,
			)
			return 1

	if args.print_version:
		print(cargo_version)
	else:
		print(f"dcmview version ok: {cargo_version}")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
