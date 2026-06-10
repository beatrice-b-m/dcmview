#!/usr/bin/env python3
from __future__ import annotations

import argparse
import difflib
import pathlib
import re
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
TYPES_RS = REPO_ROOT / "src" / "types.rs"
OUTPUT = REPO_ROOT / "frontend" / "src" / "generated" / "api-types.ts"

STRUCTS = [
	"WindowPreset",
	"FileSummary",
	"FilesResponse",
	"FrameInfo",
	"TagNode",
	"RawFrameMetadata",
	"ErrorResponse",
]


def snake_case(name: str) -> str:
	return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def extract_braced_block(source: str, marker: str) -> str:
	start = source.find(marker)
	if start < 0:
		raise ValueError(f"missing Rust item: {marker}")
	open_brace = source.find("{", start)
	if open_brace < 0:
		raise ValueError(f"missing opening brace for {marker}")

	depth = 0
	for index in range(open_brace, len(source)):
		char = source[index]
		if char == "{":
			depth += 1
		elif char == "}":
			depth -= 1
			if depth == 0:
				return source[open_brace + 1 : index]
	raise ValueError(f"missing closing brace for {marker}")


def split_top_level(value: str, separator: str = ",") -> list[str]:
	parts: list[str] = []
	start = 0
	depth_angle = 0
	depth_bracket = 0
	for index, char in enumerate(value):
		if char == "<":
			depth_angle += 1
		elif char == ">":
			depth_angle -= 1
		elif char == "[":
			depth_bracket += 1
		elif char == "]":
			depth_bracket -= 1
		elif char == separator and depth_angle == 0 and depth_bracket == 0:
			parts.append(value[start:index].strip())
			start = index + 1
	parts.append(value[start:].strip())
	return [part for part in parts if part]


def ts_type(rust_type: str, *, option_as_optional: bool = False) -> str:
	rust_type = rust_type.strip()
	if rust_type.startswith("Option<") and rust_type.endswith(">"):
		inner = ts_type(rust_type[len("Option<") : -1])
		return inner if option_as_optional else f"{inner} | null"
	if rust_type.startswith("Vec<") and rust_type.endswith(">"):
		inner = ts_type(rust_type[len("Vec<") : -1])
		return f"{inner}[]"
	if rust_type.startswith("[") and rust_type.endswith("]"):
		body = rust_type[1:-1]
		inner, length = [part.strip() for part in body.split(";")]
		return "[" + ", ".join([ts_type(inner)] * int(length)) + "]"
	if rust_type in {"usize", "u64", "u32", "u16", "i32", "f64"}:
		return "number"
	if rust_type == "bool":
		return "boolean"
	if rust_type == "String" or rust_type == "&str":
		return "string"
	if rust_type in {"WindowPreset", "FileSummary", "TagNode", "TagValue", "RawFrameMetadata"}:
		return rust_type
	raise ValueError(f"unsupported Rust type: {rust_type}")


def parse_struct(source: str, name: str) -> list[tuple[str, str]]:
	body = extract_braced_block(source, f"pub struct {name}")
	fields: list[tuple[str, str]] = []
	for line in body.splitlines():
		line = line.strip()
		if not line.startswith("pub "):
			continue
		match = re.fullmatch(r"pub\s+([A-Za-z0-9_]+):\s+(.+),", line)
		if not match:
			raise ValueError(f"could not parse field in {name}: {line}")
		fields.append((match.group(1), match.group(2).strip()))
	if not fields:
		raise ValueError(f"no public fields found for {name}")
	return fields


def render_struct(source: str, name: str) -> str:
	lines = [f"export interface {name} {{"]
	for field, rust_type in parse_struct(source, name):
		lines.append(f"\t{field}: {ts_type(rust_type)};")
	lines.append("}")
	return "\n".join(lines)


def render_window_mode(source: str) -> str:
	body = extract_braced_block(source, "pub enum WindowMode")
	variants = []
	for line in body.splitlines():
		line = line.strip().rstrip(",")
		if not line or line.startswith("#"):
			continue
		if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", line):
			variants.append(snake_case(line))
	if not variants:
		raise ValueError("WindowMode variants not found")
	return "export type WindowMode = " + " | ".join(f'"{variant}"' for variant in variants) + ";"


def parse_variant_fields(raw: str) -> list[tuple[str, str, bool]]:
	fields: list[tuple[str, str, bool]] = []
	pending_optional = False
	for line in raw.splitlines():
		line = line.strip()
		if not line:
			continue
		if line.startswith("#[serde(skip_serializing_if"):
			pending_optional = True
			continue
		match = re.fullmatch(r"([A-Za-z0-9_]+):\s+(.+),", line)
		if not match:
			continue
		fields.append((match.group(1), match.group(2).strip(), pending_optional))
		pending_optional = False
	return fields


def render_tag_value(source: str) -> str:
	body = extract_braced_block(source, "pub enum TagValue")
	variants: list[str] = []
	index = 0
	while index < len(body):
		match = re.search(r"\b([A-Z][A-Za-z0-9_]*)\s*\{", body[index:])
		if not match:
			break
		name = match.group(1)
		open_brace = index + match.end() - 1
		depth = 0
		for end in range(open_brace, len(body)):
			if body[end] == "{":
				depth += 1
			elif body[end] == "}":
				depth -= 1
				if depth == 0:
					raw_fields = body[open_brace + 1 : end]
					break
		else:
			raise ValueError(f"unterminated TagValue variant: {name}")

		fields = [f'type: "{snake_case(name)}"']
		for field, rust_type, optional in parse_variant_fields(raw_fields):
			suffix = "?" if optional else ""
			fields.append(f"{field}{suffix}: {ts_type(rust_type, option_as_optional=optional)}")
		variants.append("\t| { " + "; ".join(fields) + " }")
		index = end + 1

	if not variants:
		raise ValueError("TagValue variants not found")
	return "export type TagValue =\n" + "\n".join(variants) + ";"


def render(source: str) -> str:
	sections = [
		"// Generated by scripts/generate_frontend_types.py from src/types.rs.",
		"// Do not edit this file directly.",
		"",
		render_window_mode(source),
	]
	sections.extend(render_struct(source, name) for name in STRUCTS[:4])
	sections.append(render_tag_value(source))
	sections.extend(render_struct(source, name) for name in STRUCTS[4:])
	return "\n\n".join(sections) + "\n"


def main() -> int:
	parser = argparse.ArgumentParser(description="Generate frontend TypeScript API types")
	parser.add_argument("--check", action="store_true", help="Fail if generated types are stale")
	args = parser.parse_args()

	try:
		generated = render(TYPES_RS.read_text(encoding="utf-8"))
	except ValueError as error:
		print(str(error), file=sys.stderr)
		return 1

	if args.check:
		current = OUTPUT.read_text(encoding="utf-8") if OUTPUT.exists() else ""
		if current != generated:
			diff = difflib.unified_diff(
				current.splitlines(),
				generated.splitlines(),
				fromfile=str(OUTPUT),
				tofile="generated",
				lineterm="",
			)
			print("\n".join(diff), file=sys.stderr)
			return 1
		return 0

	OUTPUT.parent.mkdir(parents=True, exist_ok=True)
	OUTPUT.write_text(generated, encoding="utf-8")
	return 0


if __name__ == "__main__":
	raise SystemExit(main())
