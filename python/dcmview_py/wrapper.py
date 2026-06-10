from __future__ import annotations

import os
import json
import shutil
import signal
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterable, Optional, Union

_STARTUP_PREFIX = "dcmview: server running at "
_STARTUP_EVENT_TYPE = "server_started"
_URL_WAIT_SECONDS = 5.0
_STOP_TIMEOUT_SECONDS = 5.0
_BINARY_ENV = "DCMVIEW_BINARY"
_VSCODE_BRIDGE_URL_ENV = "DCMVIEW_VSCODE_BRIDGE_URL"
_VSCODE_BRIDGE_TOKEN_ENV = "DCMVIEW_VSCODE_BRIDGE_TOKEN"
_VSCODE_BRIDGE_BYPASS_ENV = "DCMVIEW_VSCODE_BYPASS"

PathInput = Union[str, os.PathLike[str]]


class _OutputMonitor:
	def __init__(self, process: subprocess.Popen[str]) -> None:
		self._process = process
		self._url: Optional[str] = None
		self._url_lock = threading.Lock()
		self._startup_json_unsupported = False
		self._startup_json_unsupported_lock = threading.Lock()
		self._url_ready = threading.Event()
		self._thread = threading.Thread(target=self._run, name="dcmview-py-output", daemon=True)

	def start(self) -> None:
		self._thread.start()

	def join(self) -> None:
		self._thread.join()

	def wait_for_url(self, timeout: float) -> Optional[str]:
		self._url_ready.wait(timeout)
		return self.url

	@property
	def url(self) -> Optional[str]:
		with self._url_lock:
			return self._url

	@property
	def startup_json_unsupported(self) -> bool:
		with self._startup_json_unsupported_lock:
			return self._startup_json_unsupported

	def _set_url(self, url: str) -> None:
		with self._url_lock:
			if self._url is None:
				self._url = url
				self._url_ready.set()

	def _set_startup_json_unsupported(self) -> None:
		with self._startup_json_unsupported_lock:
			self._startup_json_unsupported = True

	def _run(self) -> None:
		stdout = self._process.stdout
		if stdout is None:
			self._url_ready.set()
			return

		try:
			for line in stdout:
				sys.stdout.write(line)
				sys.stdout.flush()
				url = _parse_startup_url(line)
				if url is not None:
					self._set_url(url)
				if _is_startup_json_unsupported_line(line):
					self._set_startup_json_unsupported()
		finally:
			stdout.close()
			self._url_ready.set()


class ShutdownHandle:
	"""Handle for controlling a non-blocking dcmview subprocess."""

	def __init__(self, process: subprocess.Popen[str], monitor: _OutputMonitor) -> None:
		self._process = process
		self._monitor = monitor

	@property
	def url(self) -> Optional[str]:
		return self._monitor.url

	def stop(self, timeout: float = _STOP_TIMEOUT_SECONDS) -> int:
		if self._process.poll() is not None:
			self._monitor.join()
			return int(self._process.returncode or 0)

		try:
			self._process.send_signal(signal.SIGINT)
		except ProcessLookupError:
			self._monitor.join()
			return int(self._process.returncode or 0)
		try:
			return_code = self._process.wait(timeout=timeout)
		except subprocess.TimeoutExpired:
			self._process.terminate()
			try:
				return_code = self._process.wait(timeout=timeout)
			except subprocess.TimeoutExpired:
				self._process.kill()
				return_code = self._process.wait(timeout=timeout)

		self._monitor.join()
		return int(return_code)

	def __enter__(self) -> ShutdownHandle:
		return self

	def __exit__(self, _exc_type, _exc, _tb) -> None:
		self.stop()


class BridgeShutdownHandle:
	"""Handle for controlling a VS Code-managed dcmview session."""

	def __init__(self, session_id: str, url: str) -> None:
		self._session_id = session_id
		self._url = url

	@property
	def url(self) -> Optional[str]:
		return self._url

	def stop(self, timeout: float = _STOP_TIMEOUT_SECONDS) -> int:
		_bridge_json_request("POST", f"/sessions/{self._session_id}/stop", timeout=timeout)
		response = _bridge_json_request("GET", f"/sessions/{self._session_id}/wait", timeout=timeout)
		return int(response.get("exitCode") or 0)

	def __enter__(self) -> BridgeShutdownHandle:
		return self

	def __exit__(self, _exc_type, _exc, _tb) -> None:
		self.stop()


def view(
	files: PathInput | Iterable[PathInput],
	*,
	port: int = 0,
	host: str = "127.0.0.1",
	browser: bool = True,
	tunnel: bool = False,
	tunnel_host: Optional[str] = None,
	tunnel_port: int = 0,
	block: bool = True,
	recursive: bool = True,
	timeout: Optional[int] = None,
	annotations: Optional[PathInput] = None,
) -> Optional[ShutdownHandle | BridgeShutdownHandle]:
	"""Launch dcmview for one or more filesystem paths."""

	paths = _normalize_files(files)
	annotation_path = _normalize_optional_path(annotations, field_name="annotations")
	args = _build_args(
		paths,
		port=port,
		host=host,
		browser=browser,
		tunnel=tunnel,
		tunnel_host=tunnel_host,
		tunnel_port=tunnel_port,
		recursive=recursive,
		timeout=timeout,
		annotations=annotation_path,
	)
	if _bridge_available():
		try:
			return _view_via_vscode_bridge(args, block=block)
		except (RuntimeError, OSError, urllib.error.URLError) as error:
			print(
				f"dcmview: VS Code bridge unavailable ({error}); falling back to local viewer",
				file=sys.stderr,
			)

	for include_startup_json in (True, False):
		command = _build_command(
			paths,
			port=port,
			host=host,
			browser=browser,
			tunnel=tunnel,
			tunnel_host=tunnel_host,
			tunnel_port=tunnel_port,
			recursive=recursive,
			timeout=timeout,
			annotations=annotation_path,
			include_startup_json=include_startup_json,
		)

		process = subprocess.Popen(
			command,
			stdout=subprocess.PIPE,
			stderr=subprocess.STDOUT,
			text=True,
			bufsize=1,
		)
		monitor = _OutputMonitor(process)
		monitor.start()

		if block:
			return_code = process.wait()
			monitor.join()
			if return_code != 0:
				if include_startup_json and monitor.startup_json_unsupported:
					continue
				raise subprocess.CalledProcessError(return_code, command)
			return None

		monitor.wait_for_url(_URL_WAIT_SECONDS)
		if process.poll() is not None and process.returncode not in (0, None):
			monitor.join()
			if include_startup_json and monitor.startup_json_unsupported:
				continue
			raise subprocess.CalledProcessError(int(process.returncode), command)

		return ShutdownHandle(process, monitor)

	raise RuntimeError("dcmview failed to start")


def _view_via_vscode_bridge(
	args: list[str],
	*,
	block: bool,
) -> Optional[BridgeShutdownHandle]:
	response = _bridge_json_request(
		"POST",
		"/launch",
		{
			"program": "dcmview_py",
			"args": args,
			"cwd": os.getcwd(),
			"wait": False,
		},
	)
	session_id = str(response["sessionId"])
	url = str(response["url"])
	print(f"dcmview: opened in VS Code at {url}")

	if not block:
		return BridgeShutdownHandle(session_id, url)

	wait_response = _bridge_json_request("GET", f"/sessions/{session_id}/wait")
	exit_code = int(wait_response.get("exitCode") or 0)
	if exit_code != 0:
		raise subprocess.CalledProcessError(exit_code, ["dcmview-vscode-bridge", *args])
	return None


def _normalize_files(files: PathInput | Iterable[PathInput]) -> list[str]:
	if isinstance(files, (str, os.PathLike)):
		candidates: list[PathInput] = [files]
	else:
		candidates = list(files)

	if not candidates:
		raise ValueError("at least one file path is required")

	normalized: list[str] = []
	for candidate in candidates:
		if not isinstance(candidate, (str, os.PathLike)):
			raise TypeError("files must be path-like values")
		normalized.append(str(Path(candidate)))
	return normalized


def _normalize_optional_path(path: Optional[PathInput], *, field_name: str) -> Optional[str]:
	if path is None:
		return None
	if not isinstance(path, (str, os.PathLike)):
		raise TypeError(f"{field_name} must be a path-like value")
	return str(Path(path))


def _build_command(
	paths: list[str],
	*,
	port: int,
	host: str,
	browser: bool,
	tunnel: bool,
	tunnel_host: Optional[str],
	tunnel_port: int,
	recursive: bool,
	timeout: Optional[int],
	annotations: Optional[str],
	include_startup_json: bool = True,
) -> list[str]:
	return [
		_resolve_binary(),
		*_build_args(
			paths,
			port=port,
			host=host,
			browser=browser,
			tunnel=tunnel,
			tunnel_host=tunnel_host,
			tunnel_port=tunnel_port,
			recursive=recursive,
			timeout=timeout,
			annotations=annotations,
			include_startup_json=include_startup_json,
		),
	]


def _build_args(
	paths: list[str],
	*,
	port: int,
	host: str,
	browser: bool,
	tunnel: bool,
	tunnel_host: Optional[str],
	tunnel_port: int,
	recursive: bool,
	timeout: Optional[int],
	annotations: Optional[str],
	include_startup_json: bool = True,
) -> list[str]:
	if tunnel and not tunnel_host:
		raise ValueError("tunnel_host is required when tunnel=True")

	command = ["--port", str(port), "--host", host]
	if include_startup_json:
		command.append("--startup-json")
	if not browser:
		command.append("--no-browser")
	if tunnel:
		command.append("--tunnel")
		command.extend(["--tunnel-host", str(tunnel_host), "--tunnel-port", str(tunnel_port)])
	if timeout is not None:
		command.extend(["--timeout", str(timeout)])
	if not recursive:
		command.append("--no-recursive")
	if annotations is not None:
		command.extend(["--annotations", annotations])
	command.extend(paths)
	return command


def _parse_startup_url(line: str) -> Optional[str]:
	trimmed = line.strip()
	if trimmed.startswith("{"):
		try:
			event = json.loads(trimmed)
		except json.JSONDecodeError:
			return None
		if (
			isinstance(event, dict)
			and event.get("type") == _STARTUP_EVENT_TYPE
			and isinstance(event.get("url"), str)
			and event["url"]
		):
			return event["url"]
		return None

	if trimmed.startswith(_STARTUP_PREFIX):
		url = trimmed[len(_STARTUP_PREFIX) :].strip()
		return url or None
	return None


def _is_startup_json_unsupported_line(line: str) -> bool:
	normalized = line.lower()
	return "--startup-json" in normalized and any(
		marker in normalized
		for marker in [
			"unexpected",
			"unrecognized",
			"unknown",
			"wasn't expected",
			"was not expected",
			"found argument",
		]
	)


def _bridge_available() -> bool:
	return (
		os.environ.get(_VSCODE_BRIDGE_BYPASS_ENV) != "1"
		and bool(os.environ.get(_VSCODE_BRIDGE_URL_ENV))
		and bool(os.environ.get(_VSCODE_BRIDGE_TOKEN_ENV))
	)


def _bridge_json_request(
	method: str,
	path: str,
	payload: Optional[dict[str, object]] = None,
	*,
	timeout: float = _STOP_TIMEOUT_SECONDS,
) -> dict[str, object]:
	base_url = os.environ[_VSCODE_BRIDGE_URL_ENV].rstrip("/")
	token = os.environ[_VSCODE_BRIDGE_TOKEN_ENV]
	body = None if payload is None else json.dumps(payload).encode("utf-8")
	request = urllib.request.Request(
		f"{base_url}{path}",
		data=body,
		method=method,
		headers={
			"Authorization": f"Bearer {token}",
			"Content-Type": "application/json",
		},
	)
	with urllib.request.urlopen(request, timeout=timeout) as response:
		return json.loads(response.read().decode("utf-8"))


def _resolve_binary() -> str:
	configured = os.environ.get(_BINARY_ENV)
	if configured:
		candidate = Path(configured).expanduser()
		if candidate.is_file():
			_ensure_executable(candidate)
			return str(candidate)
		raise RuntimeError(f"{_BINARY_ENV} points to a missing file: {candidate}")

	bundled_name = "dcmview.exe" if os.name == "nt" else "dcmview"
	bundled = Path(__file__).resolve().parent / "bin" / bundled_name
	if bundled.is_file():
		_ensure_executable(bundled)
		return str(bundled)

	path_binary = shutil.which("dcmview")
	if path_binary is not None:
		return path_binary

	raise RuntimeError(
		"dcmview binary not found — install a bundled wheel or install the Rust binary separately"
	)


def _ensure_executable(path: Path) -> None:
	if os.name == "nt" or os.access(path, os.X_OK):
		return

	mode = path.stat().st_mode
	exec_bits = (mode & 0o444) >> 2
	path.chmod(mode | exec_bits)
