from __future__ import annotations

import argparse
import re
import subprocess
import sys
from importlib import metadata
from pathlib import Path
from typing import Optional, Sequence

from .wrapper import view


def _package_version() -> str:
	try:
		return metadata.version("dcmview-py")
	except metadata.PackageNotFoundError:
		pyproject = Path(__file__).resolve().parents[2] / "pyproject.toml"
		if not pyproject.is_file():
			return "unknown"
		match = re.search(
			r'(?m)^\[project\]\s*(?:\n(?!\[).*)*?\nversion\s*=\s*"([^"]+)"',
			pyproject.read_text(encoding="utf-8"),
		)
		return match.group(1) if match else "unknown"


def _build_parser() -> argparse.ArgumentParser:
	parser = argparse.ArgumentParser(prog="python -m dcmview_py")
	parser.add_argument("--version", action="version", version=f"dcmview {_package_version()}")
	parser.add_argument("paths", nargs="+", help="One or more DICOM file or directory paths")
	parser.add_argument("-p", "--port", type=int, default=0)
	parser.add_argument("--host", default="127.0.0.1")
	parser.add_argument("--no-browser", action="store_true")
	parser.add_argument("--tunnel", action="store_true")
	parser.add_argument("--tunnel-host")
	parser.add_argument("--tunnel-port", type=int, default=0)
	parser.add_argument("--timeout", type=int)
	parser.add_argument("--no-recursive", action="store_true")
	parser.add_argument("--annotations")
	parser.add_argument("--filter", action="append", default=[])
	return parser


def run_cli(argv: Optional[Sequence[str]] = None) -> int:
	parser = _build_parser()
	args = parser.parse_args(argv)

	try:
		view_kwargs = {
			"port": args.port,
			"host": args.host,
			"browser": not args.no_browser,
			"tunnel": args.tunnel,
			"tunnel_host": args.tunnel_host,
			"tunnel_port": args.tunnel_port,
			"recursive": not args.no_recursive,
			"timeout": args.timeout,
			"annotations": args.annotations,
			"block": True,
		}
		if args.filter:
			view_kwargs["filters"] = args.filter
		view(args.paths, **view_kwargs)
	except subprocess.CalledProcessError as error:
		return int(error.returncode)
	except (RuntimeError, ValueError, TypeError) as error:
		print(str(error), file=sys.stderr)
		return 1

	return 0


def main() -> None:
	raise SystemExit(run_cli())


if __name__ == "__main__":
	main()
