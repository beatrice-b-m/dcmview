#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path


def build_formula(
	*,
	version: str,
	homepage: str,
	arm_url: str,
	arm_sha256: str,
	x86_url: str,
	x86_sha256: str,
) -> str:
	return f"""class Dcmview < Formula
  desc "Ephemeral DICOM inspection tool for developers and data scientists"
  homepage "{homepage}"
  version "{version}"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "{arm_url}"
      sha256 "{arm_sha256}"
    else
      url "{x86_url}"
      sha256 "{x86_sha256}"
    end
  end

  def install
    bin.install "dcmview"
    prefix.install "LICENSE", "README.md"
  end

  test do
    output = shell_output("#{{bin}}/dcmview --help")
    assert_match "dcmview", output
  end
end
"""


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("--version", required=True)
	parser.add_argument("--homepage", required=True)
	parser.add_argument("--arm-url", required=True)
	parser.add_argument("--arm-sha256", required=True)
	parser.add_argument("--x86-url", required=True)
	parser.add_argument("--x86-sha256", required=True)
	parser.add_argument("--output", required=True)
	args = parser.parse_args()

	output = Path(args.output)
	output.parent.mkdir(parents=True, exist_ok=True)
	output.write_text(
		build_formula(
			version=args.version,
			homepage=args.homepage,
			arm_url=args.arm_url,
			arm_sha256=args.arm_sha256,
			x86_url=args.x86_url,
			x86_sha256=args.x86_sha256,
		),
		encoding="utf-8",
	)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
