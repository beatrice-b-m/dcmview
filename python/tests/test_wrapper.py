from __future__ import annotations

import os
import json
import shutil
import subprocess
import sys
import time
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from typing import Optional
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[2]
PYTHON_SRC = REPO_ROOT / "python"
if str(PYTHON_SRC) not in sys.path:
	sys.path.insert(0, str(PYTHON_SRC))

from dcmview_py import __main__ as dcmview_main
from dcmview_py import wrapper

FIXTURE_FILE = REPO_ROOT / "FFDM_R_MLO_ComboHD.dcm"
BRIDGE_CONTRACT = REPO_ROOT / "docs" / "contracts" / "bridge-protocol.json"


def _available_dcmview_binary() -> Optional[Path]:
	for candidate in [
		REPO_ROOT / "target" / "debug" / "dcmview",
		REPO_ROOT / "target" / "release" / "dcmview",
	]:
		if candidate.is_file():
			return candidate

	resolved = shutil.which("dcmview")
	if resolved is None:
		return None
	return Path(resolved)


class WrapperTests(unittest.TestCase):
	def test_pyproject_declares_both_console_script_names(self) -> None:
		pyproject = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
		self.assertIn('dcmview = "dcmview_py.__main__:main"', pyproject)
		self.assertIn('dcmview-py = "dcmview_py.__main__:main"', pyproject)

	def test_cli_reports_wrapper_version(self) -> None:
		with mock.patch("dcmview_py.__main__._package_version", return_value="9.8.7"):
			parser = dcmview_main._build_parser()
		output = StringIO()
		with redirect_stdout(output):
			with self.assertRaises(SystemExit) as context:
				parser.parse_args(["--version"])

		self.assertEqual(context.exception.code, 0)
		self.assertEqual(output.getvalue().strip(), "dcmview 9.8.7")

	def test_missing_binary_raises_runtime_error(self) -> None:
		with mock.patch.dict(os.environ, {}, clear=True):
			with mock.patch("dcmview_py.wrapper.shutil.which", return_value=None):
				with self.assertRaisesRegex(RuntimeError, "dcmview binary not found"):
					wrapper.view([FIXTURE_FILE], browser=False)

	def test_explicit_binary_env_var_takes_precedence(self) -> None:
		with mock.patch.dict(os.environ, {"DCMVIEW_BINARY": "/tmp/env-dcmview"}, clear=True):
			with mock.patch.object(wrapper.Path, "is_file", return_value=True):
				with mock.patch("dcmview_py.wrapper._ensure_executable") as ensure_mock:
					command = wrapper._build_command(
						["/tmp/scan.dcm"],
						port=0,
						host="127.0.0.1",
						browser=True,
						tunnel=False,
						tunnel_host=None,
						tunnel_port=0,
						recursive=True,
						timeout=None,
						annotations=None,
					)

		self.assertEqual(command[0], "/tmp/env-dcmview")
		ensure_mock.assert_called_once()

	def test_prefers_bundled_binary_before_path_lookup(self) -> None:
		bundled = (PYTHON_SRC / "dcmview_py" / "bin" / "dcmview").resolve()
		with mock.patch.dict(os.environ, {}, clear=True):
			with mock.patch.object(wrapper.Path, "is_file", return_value=True):
				with mock.patch("dcmview_py.wrapper.shutil.which", return_value="/usr/local/bin/dcmview"):
					with mock.patch("dcmview_py.wrapper._ensure_executable") as ensure_mock:
						resolved = wrapper._resolve_binary()

		self.assertEqual(resolved, str(bundled))
		ensure_mock.assert_called_once()

	def test_missing_explicit_binary_env_var_raises(self) -> None:
		with mock.patch.dict(os.environ, {"DCMVIEW_BINARY": "/tmp/missing-dcmview"}, clear=True):
			with mock.patch.object(wrapper.Path, "is_file", return_value=False):
				with self.assertRaisesRegex(RuntimeError, "points to a missing file"):
					wrapper._resolve_binary()

	def test_tunnel_requires_host_before_spawn(self) -> None:
		with mock.patch("dcmview_py.wrapper.shutil.which", return_value="/tmp/dcmview"):
			with self.assertRaisesRegex(ValueError, "tunnel_host is required"):
				wrapper.view([FIXTURE_FILE], browser=False, tunnel=True)

	def test_non_blocking_launch_captures_url_and_stop(self) -> None:
		binary = _available_dcmview_binary()
		if binary is None:
			self.skipTest("dcmview binary not available")
		if not FIXTURE_FILE.is_file():
			self.skipTest("fixture DICOM file not found")

		with mock.patch.dict(
			os.environ,
			{"PATH": f"{binary.parent}{os.pathsep}{os.environ.get('PATH', '')}"},
			clear=False,
		):
			handle = wrapper.view([FIXTURE_FILE], browser=False, timeout=30, block=False)

			try:
				deadline = time.time() + 10.0
				while handle.url is None and time.time() < deadline:
					time.sleep(0.1)

				self.assertIsNotNone(handle.url)
				assert handle.url is not None
				self.assertTrue(handle.url.startswith("http://"))
			finally:
				exit_code = handle.stop()

			self.assertIsInstance(exit_code, int)
			self.assertIsInstance(handle.stop(), int)

	def test_cli_forwards_no_browser_no_recursive_and_timeout(self) -> None:
		with mock.patch("dcmview_py.__main__.view", return_value=None) as view_mock:
			exit_code = dcmview_main.run_cli(
				[
					"--no-browser",
					"--no-recursive",
					"--timeout",
					"9",
					"-p",
					"1042",
					"--host",
					"0.0.0.0",
					str(FIXTURE_FILE),
				]
			)

		self.assertEqual(exit_code, 0)
		view_mock.assert_called_once_with(
			[str(FIXTURE_FILE)],
			port=1042,
			host="0.0.0.0",
			browser=False,
			tunnel=False,
			tunnel_host=None,
			tunnel_port=0,
			recursive=False,
			timeout=9,
			block=True,
			annotations=None,
		)

	def test_cli_forwards_annotations_path(self) -> None:
		annotations_path = REPO_ROOT / "tests" / "fixtures" / "embed_annotations.csv"
		with mock.patch("dcmview_py.__main__.view", return_value=None) as view_mock:
			exit_code = dcmview_main.run_cli([
				"--annotations",
				str(annotations_path),
				str(FIXTURE_FILE),
			])

		self.assertEqual(exit_code, 0)
		view_mock.assert_called_once_with(
			[str(FIXTURE_FILE)],
			port=0,
			host="127.0.0.1",
			browser=True,
			tunnel=False,
			tunnel_host=None,
			tunnel_port=0,
			recursive=True,
			timeout=None,
			annotations=str(annotations_path),
			block=True,
		)

	def test_build_command_includes_annotations_flag_when_provided(self) -> None:
		with mock.patch("dcmview_py.wrapper.shutil.which", return_value="/tmp/dcmview"):
			command = wrapper._build_command(
				["/tmp/scan.dcm"],
				port=0,
				host="127.0.0.1",
				browser=True,
				tunnel=False,
				tunnel_host=None,
				tunnel_port=0,
				recursive=True,
				timeout=None,
				annotations="/tmp/annotations.csv",
			)

		self.assertIn("--annotations", command)
		flag_index = command.index("--annotations")
		self.assertEqual(command[flag_index + 1], "/tmp/annotations.csv")

	def test_build_command_requests_structured_startup_event(self) -> None:
		with mock.patch("dcmview_py.wrapper.shutil.which", return_value="/tmp/dcmview"):
			command = wrapper._build_command(
				["/tmp/scan.dcm"],
				port=0,
				host="127.0.0.1",
				browser=True,
				tunnel=False,
				tunnel_host=None,
				tunnel_port=0,
				recursive=True,
				timeout=None,
				annotations=None,
			)

		self.assertIn("--startup-json", command)
		self.assertLess(command.index("--startup-json"), command.index("/tmp/scan.dcm"))

	def test_parse_structured_startup_event(self) -> None:
		url = wrapper._parse_startup_url(
			'{"type":"server_started","url":"http://127.0.0.1:51234","host":"127.0.0.1","port":51234}'
		)

		self.assertEqual(url, "http://127.0.0.1:51234")

	def test_parse_legacy_startup_line_as_fallback(self) -> None:
		url = wrapper._parse_startup_url("dcmview: server running at http://127.0.0.1:51234")

		self.assertEqual(url, "http://127.0.0.1:51234")

	def test_parse_startup_url_ignores_malformed_json_lines(self) -> None:
		self.assertIsNone(wrapper._parse_startup_url('{"type":"server_started",'))
		self.assertIsNone(wrapper._parse_startup_url('{"type":"other","url":"http://127.0.0.1:1"}'))
		self.assertIsNone(wrapper._parse_startup_url("dcmview: loaded 1 DICOM file"))

	def test_output_monitor_wait_for_url_times_out_without_startup_line(self) -> None:
		process = mock.Mock()
		process.stdout = StringIO("dcmview: loaded 1 DICOM file\n")
		monitor = wrapper._OutputMonitor(process)

		with redirect_stdout(StringIO()):
			monitor.start()
			self.assertIsNone(monitor.wait_for_url(0.01))
			monitor.join()

	def test_view_relaunches_without_startup_json_for_older_blocking_binary(self) -> None:
		old_process = mock.Mock()
		old_process.stdout = StringIO("error: unexpected argument '--startup-json' found\n")
		old_process.wait.return_value = 2
		old_process.returncode = 2
		new_process = mock.Mock()
		new_process.stdout = StringIO("dcmview: server running at http://127.0.0.1:51234\n")
		new_process.wait.return_value = 0
		new_process.returncode = 0

		with mock.patch("dcmview_py.wrapper.shutil.which", return_value="/tmp/dcmview"):
			with mock.patch("dcmview_py.wrapper.subprocess.Popen", side_effect=[old_process, new_process]) as popen:
				with redirect_stdout(StringIO()):
					result = wrapper.view(["/tmp/scan.dcm"], browser=False, block=True)

		self.assertIsNone(result)
		self.assertIn("--startup-json", popen.call_args_list[0].args[0])
		self.assertNotIn("--startup-json", popen.call_args_list[1].args[0])

	def test_view_relaunches_without_startup_json_for_older_nonblocking_binary(self) -> None:
		old_process = mock.Mock()
		old_process.stdout = StringIO("error: Found argument '--startup-json' which wasn't expected\n")
		old_process.poll.return_value = 2
		old_process.returncode = 2
		new_process = mock.Mock()
		new_process.stdout = StringIO("dcmview: server running at http://127.0.0.1:51234\n")
		new_process.poll.return_value = None
		new_process.returncode = None

		with mock.patch("dcmview_py.wrapper.shutil.which", return_value="/tmp/dcmview"):
			with mock.patch("dcmview_py.wrapper.subprocess.Popen", side_effect=[old_process, new_process]) as popen:
				with redirect_stdout(StringIO()):
					handle = wrapper.view(["/tmp/scan.dcm"], browser=False, block=False)

		self.assertIsNotNone(handle)
		assert handle is not None
		self.assertEqual(handle.url, "http://127.0.0.1:51234")
		self.assertIn("--startup-json", popen.call_args_list[0].args[0])
		self.assertNotIn("--startup-json", popen.call_args_list[1].args[0])

	def test_view_routes_blocking_calls_through_vscode_bridge(self) -> None:
		with mock.patch.dict(
			os.environ,
			{
				"DCMVIEW_VSCODE_BRIDGE_URL": "http://127.0.0.1:4567",
				"DCMVIEW_VSCODE_BRIDGE_TOKEN": "secret",
			},
			clear=True,
		):
			with mock.patch(
				"dcmview_py.wrapper._bridge_json_request",
				side_effect=[
					{"sessionId": "abc", "url": "http://127.0.0.1:9999"},
					{"exitCode": 0},
				],
			) as bridge_mock:
				with mock.patch("dcmview_py.wrapper.subprocess.Popen") as popen_mock:
					with redirect_stdout(StringIO()):
						result = wrapper.view([FIXTURE_FILE], browser=True, block=True)

		self.assertIsNone(result)
		popen_mock.assert_not_called()
		launch_payload = bridge_mock.call_args_list[0].args[2]
		self.assertEqual(launch_payload["program"], "dcmview_py")
		self.assertIn(str(FIXTURE_FILE), launch_payload["args"])
		self.assertFalse(launch_payload["wait"])

	def test_bridge_json_request_matches_shared_launch_fixture(self) -> None:
		fixture = json.loads(BRIDGE_CONTRACT.read_text(encoding="utf-8"))
		launch = fixture["launch"]
		auth = fixture["auth"]
		captured_request = None

		class FakeResponse:
			def __enter__(self) -> "FakeResponse":
				return self

			def __exit__(self, _exc_type, _exc, _tb) -> None:
				return None

			def read(self) -> bytes:
				return json.dumps(launch["response"]).encode("utf-8")

		def fake_urlopen(request, *, timeout):
			nonlocal captured_request
			captured_request = request
			self.assertEqual(timeout, 5.0)
			return FakeResponse()

		with mock.patch.dict(
			os.environ,
			{
				"DCMVIEW_VSCODE_BRIDGE_URL": "http://127.0.0.1:4567/",
				"DCMVIEW_VSCODE_BRIDGE_TOKEN": auth["bearerToken"],
			},
			clear=True,
		):
			with mock.patch("dcmview_py.wrapper.urllib.request.urlopen", side_effect=fake_urlopen):
				response = wrapper._bridge_json_request(
					launch["method"],
					launch["path"],
					launch["request"],
				)

		self.assertEqual(response, launch["response"])
		self.assertIsNotNone(captured_request)
		assert captured_request is not None
		self.assertEqual(captured_request.full_url, "http://127.0.0.1:4567/launch")
		self.assertEqual(captured_request.get_method(), "POST")
		self.assertEqual(captured_request.get_header("Authorization"), f"Bearer {auth['bearerToken']}")
		self.assertEqual(captured_request.get_header("Content-type"), "application/json")
		self.assertEqual(json.loads(captured_request.data.decode("utf-8")), launch["request"])

	def test_bridge_json_request_parses_shared_wait_fixture(self) -> None:
		fixture = json.loads(BRIDGE_CONTRACT.read_text(encoding="utf-8"))
		wait = fixture["wait"]

		class FakeResponse:
			def __enter__(self) -> "FakeResponse":
				return self

			def __exit__(self, _exc_type, _exc, _tb) -> None:
				return None

			def read(self) -> bytes:
				return json.dumps(wait["response"]).encode("utf-8")

		with mock.patch.dict(
			os.environ,
			{
				"DCMVIEW_VSCODE_BRIDGE_URL": "http://127.0.0.1:4567",
				"DCMVIEW_VSCODE_BRIDGE_TOKEN": fixture["auth"]["bearerToken"],
			},
			clear=True,
		):
			with mock.patch("dcmview_py.wrapper.urllib.request.urlopen", return_value=FakeResponse()):
				response = wrapper._bridge_json_request(wait["method"], wait["path"])

		self.assertEqual(response, wait["response"])

	def test_view_returns_bridge_shutdown_handle_for_nonblocking_calls(self) -> None:
		with mock.patch.dict(
			os.environ,
			{
				"DCMVIEW_VSCODE_BRIDGE_URL": "http://127.0.0.1:4567",
				"DCMVIEW_VSCODE_BRIDGE_TOKEN": "secret",
			},
			clear=True,
		):
			with mock.patch(
				"dcmview_py.wrapper._bridge_json_request",
				side_effect=[
					{"sessionId": "abc", "url": "http://127.0.0.1:9999"},
					{"ok": True},
					{"exitCode": 0},
				],
			) as bridge_mock:
				with redirect_stdout(StringIO()):
					handle = wrapper.view([FIXTURE_FILE], browser=False, block=False)
				self.assertIsNotNone(handle)
				assert handle is not None
				self.assertEqual(handle.url, "http://127.0.0.1:9999")
				self.assertEqual(handle.stop(), 0)

		self.assertEqual(bridge_mock.call_args_list[1].args[:2], ("POST", "/sessions/abc/stop"))
		self.assertEqual(bridge_mock.call_args_list[2].args[:2], ("GET", "/sessions/abc/wait"))

	def test_vscode_bridge_bypass_uses_local_subprocess_path(self) -> None:
		with mock.patch.dict(
			os.environ,
			{
				"DCMVIEW_VSCODE_BRIDGE_URL": "http://127.0.0.1:4567",
				"DCMVIEW_VSCODE_BRIDGE_TOKEN": "secret",
				"DCMVIEW_VSCODE_BYPASS": "1",
			},
			clear=True,
		):
			with mock.patch("dcmview_py.wrapper.shutil.which", return_value="/tmp/dcmview"):
				command = wrapper._build_command(
					["/tmp/scan.dcm"],
					port=0,
					host="127.0.0.1",
					browser=True,
					tunnel=False,
					tunnel_host=None,
					tunnel_port=0,
					recursive=True,
					timeout=None,
					annotations=None,
				)

		self.assertEqual(command[0], "/tmp/dcmview")

	def test_cli_returns_child_exit_code(self) -> None:
		with mock.patch(
			"dcmview_py.__main__.view",
			side_effect=subprocess.CalledProcessError(7, ["dcmview"]),
		):
			exit_code = dcmview_main.run_cli([str(FIXTURE_FILE)])

		self.assertEqual(exit_code, 7)


if __name__ == "__main__":
	unittest.main()
