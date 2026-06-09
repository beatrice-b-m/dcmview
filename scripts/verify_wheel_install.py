#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import pathlib
import subprocess
import sys
import tempfile
import venv
import zipfile


def expect(condition: bool, message: str) -> None:
	if not condition:
		raise AssertionError(message)


def run(command: list[str], env: dict[str, str]) -> None:
	subprocess.run(command, check=True, env=env)


def os_name_is_windows() -> bool:
	return sys.platform.startswith("win")


def path_separator() -> str:
	return ";" if os_name_is_windows() else ":"


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("wheel", help="Path to the wheel to validate")
	parser.add_argument("--expected-platform", required=True)
	args = parser.parse_args()

	wheel_path = pathlib.Path(args.wheel).resolve()
	expect(wheel_path.is_file(), f"wheel does not exist: {wheel_path}")
	expect(
		args.expected_platform in wheel_path.name,
		f"expected wheel name to contain {args.expected_platform}, got {wheel_path.name}",
	)
	expect(
		"linux_x86_64" not in wheel_path.name,
		f"generic linux_x86_64 tag is not PyPI-compatible: {wheel_path.name}",
	)

	with zipfile.ZipFile(wheel_path) as archive:
		names = set(archive.namelist())
		expect("dcmview_py/bin/dcmview" in names, "bundled dcmview binary missing from wheel")
		entry_points_name = next(
			name for name in names if name.endswith(".dist-info/entry_points.txt")
		)
		entry_points = archive.read(entry_points_name).decode("utf-8")
		expect("dcmview =" in entry_points, "dcmview console script missing from wheel metadata")
		expect("dcmview-py =" in entry_points, "dcmview-py console script missing from wheel metadata")

	with tempfile.TemporaryDirectory(prefix="dcmview-wheel-verify-") as temp_dir:
		venv_dir = pathlib.Path(temp_dir) / "venv"
		venv.EnvBuilder(with_pip=True).create(venv_dir)
		bin_dir = venv_dir / ("Scripts" if os_name_is_windows() else "bin")
		python = bin_dir / ("python.exe" if os_name_is_windows() else "python")
		env = {
			**os.environ,
			"PATH": f"{bin_dir}{path_separator()}{os.environ.get('PATH', '')}",
		}

		run([str(python), "-m", "pip", "install", str(wheel_path)], env)
		run(["dcmview", "--help"], env)
		run(["dcmview-py", "--help"], env)
		run([str(python), "-m", "dcmview_py", "--help"], env)

	return 0


if __name__ == "__main__":
	raise SystemExit(main())
