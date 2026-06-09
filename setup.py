from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path

from setuptools import Distribution, setup
from setuptools.command.build_py import build_py as _build_py

try:
	from wheel.bdist_wheel import bdist_wheel as _bdist_wheel
except ImportError as exc:  # pragma: no cover - build backend requirement should prevent this
	raise RuntimeError("wheel is required to build dcmview-py wheels") from exc


_BUNDLE_ENV = "DCMVIEW_PY_BUNDLE_BINARY"
_PLAT_NAME_ENV = "DCMVIEW_PY_WHEEL_PLAT_NAME"
_REQUIRE_BUNDLE_ENV = "DCMVIEW_PY_REQUIRE_BUNDLED_BINARY"


class BinaryDistribution(Distribution):
	def has_ext_modules(self) -> bool:
		return True


class build_py(_build_py):
	def run(self) -> None:
		super().run()
		self._copy_bundled_binary()

	def _copy_bundled_binary(self) -> None:
		bundle_path = os.environ.get(_BUNDLE_ENV)
		require_bundle = os.environ.get(_REQUIRE_BUNDLE_ENV) == "1"
		if not bundle_path:
			if require_bundle:
				raise RuntimeError(f"{_BUNDLE_ENV} must be set when {_REQUIRE_BUNDLE_ENV}=1")
			return

		source = Path(bundle_path).resolve()
		if not source.is_file():
			raise RuntimeError(f"bundled binary does not exist: {source}")

		target_dir = Path(self.build_lib) / "dcmview_py" / "bin"
		target_dir.mkdir(parents=True, exist_ok=True)
		target = target_dir / source.name
		shutil.copy2(source, target)

		mode = target.stat().st_mode
		target.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class bdist_wheel(_bdist_wheel):
	def finalize_options(self) -> None:
		super().finalize_options()
		self.root_is_pure = False

		plat_name = os.environ.get(_PLAT_NAME_ENV)
		if plat_name:
			self.plat_name_supplied = True
			self.plat_name = plat_name

	def get_tag(self) -> tuple[str, str, str]:
		_, _, plat = super().get_tag()
		return ("py3", "none", plat)


setup(
	distclass=BinaryDistribution,
	cmdclass={
		"build_py": build_py,
		"bdist_wheel": bdist_wheel,
	},
)
