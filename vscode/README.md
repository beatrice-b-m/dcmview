# dcmview VS Code extension

Closed-test builds bundle `dcmview` binaries for Linux x64, macOS x64, and
macOS arm64. Set `dcmview.binaryPath` to an absolute binary path when testing an
unsupported platform or overriding the bundled binary.

Use the Explorer context menu command `Open with dcmview` on DICOM files or
folders. The extension starts a local loopback server and shows it in a VS Code
webview.
