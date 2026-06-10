import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';

const STARTUP_PREFIX = 'dcmview: server running at ';
const STARTUP_EVENT_TYPE = 'server_started';
const BRIDGE_BYPASS_ENV = 'DCMVIEW_VSCODE_BYPASS';
const BRIDGE_TOKEN_ENV = 'DCMVIEW_VSCODE_BRIDGE_TOKEN';
const BRIDGE_URL_ENV = 'DCMVIEW_VSCODE_BRIDGE_URL';

interface StartupEvent {
  type: string;
  url: string;
  host: string;
  port: number;
}

interface ExtensionSettings {
  binaryPath: string;
  defaultRecursive: boolean;
  extraArgs: string[];
  startupTimeoutSeconds: number;
  terminalInterceptionEnabled: boolean;
}

interface RunningSession {
  readonly id: string;
  readonly panel: vscode.WebviewPanel;
  readonly process: childProcess.ChildProcessWithoutNullStreams;
  readonly output: vscode.OutputChannel;
  readonly name: string;
  readonly url: string;
  readonly exitCode: Promise<number>;
  stopped: boolean;
}

interface BridgeServer {
  readonly server: http.Server;
  readonly url: string;
  readonly token: string;
}

interface BridgeLaunchRequest {
  program?: string;
  args?: string[];
  cwd?: string;
  wait?: boolean;
}

interface BridgeLaunchResponse {
  sessionId: string;
  url: string;
  exitCode?: number;
}

const sessions = new Set<RunningSession>();
const sessionsById = new Map<string, RunningSession>();
let outputChannel: vscode.OutputChannel | undefined;
let bridgeServer: BridgeServer | undefined;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('dcmview');
  context.subscriptions.push(outputChannel);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'dcmview.openPath',
      (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => openPathCommand(context, uri, selectedUris),
    ),
    vscode.commands.registerCommand('dcmview.openWorkspaceSelection', () =>
      openWorkspaceSelectionCommand(context),
    ),
    vscode.commands.registerCommand('dcmview.stopAll', async () => {
      await stopAllSessions();
      vscode.window.showInformationMessage('Stopped all dcmview sessions.');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dcmview')) {
        void configureTerminalInterception(context);
      }
    }),
    { dispose: () => void stopBridge() },
  );

  void configureTerminalInterception(context);
}

export async function deactivate(): Promise<void> {
  await stopBridge();
  await stopAllSessions();
}

async function openPathCommand(
  context: vscode.ExtensionContext,
  uri?: vscode.Uri,
  selectedUris?: vscode.Uri[],
): Promise<void> {
  const uris = selectedUris && selectedUris.length > 0 ? selectedUris : uri ? [uri] : [];
  if (uris.length > 0) {
    await openUris(context, uris);
    return;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: 'Open with dcmview',
  });
  if (picked && picked.length > 0) {
    await openUris(context, picked);
  }
}

async function openWorkspaceSelectionCommand(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('Open a workspace folder before launching dcmview.');
    return;
  }

  if (workspaceFolders.length === 1) {
    await openUris(context, [workspaceFolders[0].uri]);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    workspaceFolders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      uri: folder.uri,
    })),
    { placeHolder: 'Select a workspace folder to open with dcmview' },
  );
  if (picked) {
    await openUris(context, [picked.uri]);
  }
}

async function openUris(context: vscode.ExtensionContext, uris: readonly vscode.Uri[]): Promise<void> {
  const filePaths = collectFileSystemPaths(uris);
  if (filePaths.length === 0) {
    vscode.window.showErrorMessage('dcmview can only open file-system paths.');
    return;
  }

  const settings = readSettings();
  const output = getOutputChannel();

  try {
    const binary = await resolveBinaryPath(context.extensionUri.fsPath, settings.binaryPath);
    await startPathSession(context, binary, filePaths, settings, output);
  } catch (error) {
    output.appendLine(formatError(error));
    vscode.window.showErrorMessage(formatError(error));
  }
}

export function collectFileSystemPaths(uris: readonly vscode.Uri[]): string[] {
  return uris.filter((uri) => uri.scheme === 'file').map((uri) => uri.fsPath);
}

function readSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('dcmview');
  return {
    binaryPath: config.get('binaryPath', '').trim(),
    defaultRecursive: config.get('defaultRecursive', true),
    extraArgs: config.get('extraArgs', []),
    startupTimeoutSeconds: config.get('startupTimeoutSeconds', 20),
    terminalInterceptionEnabled: config.get('terminalInterception.enabled', true),
  };
}

async function resolveBinaryPath(extensionRoot: string, configuredBinary: string): Promise<string> {
  const candidates = binaryCandidates(extensionRoot, configuredBinary);
  for (const candidate of candidates) {
    if (candidate.kind === 'path' && (await isExecutableFile(candidate.value))) {
      return candidate.value;
    }
    if (candidate.kind === 'path-name' && (await findOnPath(candidate.value))) {
      return candidate.value;
    }
  }

  throw new Error(
    'Unable to find dcmview. Set dcmview.binaryPath, run cargo build, install a VSIX with a bundled binary for this platform, or install dcmview on PATH.',
  );
}

export function binaryCandidates(
  extensionRoot: string,
  configuredBinary: string,
): Array<{ kind: 'path' | 'path-name'; value: string }> {
  const executable = process.platform === 'win32' ? 'dcmview.exe' : 'dcmview';
  const candidates: Array<{ kind: 'path' | 'path-name'; value: string }> = [];
  if (configuredBinary.length > 0) {
    candidates.push({ kind: 'path', value: configuredBinary });
  }
  candidates.push(
    { kind: 'path', value: path.resolve(extensionRoot, '..', 'target', 'debug', executable) },
    {
      kind: 'path',
      value: path.resolve(
        extensionRoot,
        'resources',
        'bin',
        `${process.platform}-${process.arch}`,
        executable,
      ),
    },
    { kind: 'path-name', value: executable },
  );
  return candidates;
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function findOnPath(executable: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? '';
  const pathExt = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE').split(';') : [''];
  for (const dir of pathValue.split(path.delimiter)) {
    for (const ext of pathExt) {
      const candidate = path.join(dir, executable.endsWith(ext.toLowerCase()) ? executable : `${executable}${ext}`);
      if (await isExecutableFile(candidate)) {
        return true;
      }
    }
  }
  return false;
}

async function startSession(
  context: vscode.ExtensionContext,
  binary: string,
  args: readonly string[],
  cwd: string,
  title: string,
  settings: ExtensionSettings,
  output: vscode.OutputChannel,
): Promise<RunningSession> {
  output.appendLine(`Launching: ${binary} ${args.map(shellQuote).join(' ')}`);

  const child = childProcess.spawn(binary, args, {
    cwd,
    env: { ...process.env, [BRIDGE_BYPASS_ENV]: '1' },
  });
  const serverUrl = await waitForStartupOrTerminate(
    child,
    settings.startupTimeoutSeconds * 1000,
    output,
  );
  let panel: vscode.WebviewPanel;
  try {
    const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(serverUrl));

    panel = vscode.window.createWebviewPanel('dcmview.viewer', title, vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [context.extensionUri],
    });
    panel.webview.html = webviewHtml(panel.webview, externalUri);
  } catch (error) {
    child.kill('SIGINT');
    throw error;
  }

  let resolveExitCode: (exitCode: number) => void;
  const exitCode = new Promise<number>((resolve) => {
    resolveExitCode = resolve;
  });
  const session: RunningSession = {
    id: crypto.randomUUID(),
    panel,
    process: child,
    output,
    name: title,
    url: serverUrl,
    exitCode,
    stopped: false,
  };

  child.once('exit', (code, signal) => {
    output.appendLine(`dcmview exited (${title}): code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    sessions.delete(session);
    sessionsById.delete(session.id);
    resolveExitCode(Number(code ?? 0));
    if (!session.stopped) {
      panel.dispose();
    }
  });
  panel.onDidDispose(() => {
    void stopSession(session, false);
  });

  sessions.add(session);
  sessionsById.set(session.id, session);
  return session;
}

async function startPathSession(
  context: vscode.ExtensionContext,
  binary: string,
  filePaths: readonly string[],
  settings: ExtensionSettings,
  output: vscode.OutputChannel,
): Promise<RunningSession> {
  return startSession(
    context,
    binary,
    buildDcmviewArgs(filePaths, settings),
    commonWorkingDirectory(filePaths),
    sessionTitle(filePaths),
    settings,
    output,
  );
}

function sessionTitle(filePaths: readonly string[]): string {
  return `dcmview: ${path.basename(filePaths[0])}${filePaths.length > 1 ? ` +${filePaths.length - 1}` : ''}`;
}

function buildDcmviewArgs(filePaths: readonly string[], settings: ExtensionSettings): string[] {
  const args = ['--no-browser', '--port', '0', '--host', '127.0.0.1', '--startup-json'];
  if (!settings.defaultRecursive) {
    args.push('--no-recursive');
  }
  args.push(...settings.extraArgs, ...filePaths);
  return args;
}

export function normalizeInterceptedArgs(args: readonly string[]): string[] {
  const normalized = [...args];
  if (!hasFlag(normalized, '--no-browser')) {
    normalized.unshift('--no-browser');
  }
  if (!hasFlag(normalized, '--startup-json')) {
    normalized.unshift('--startup-json');
  }
  if (!hasOptionValue(normalized, ['--host'])) {
    normalized.unshift('127.0.0.1');
    normalized.unshift('--host');
  }
  if (!hasOptionValue(normalized, ['--port', '-p'])) {
    normalized.unshift('0');
    normalized.unshift('--port');
  }
  return normalized;
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function hasOptionValue(args: readonly string[], options: readonly string[]): boolean {
  for (const option of options) {
    if (args.includes(option)) {
      return true;
    }
    if (args.some((arg) => arg.startsWith(`${option}=`))) {
      return true;
    }
  }
  return false;
}

function commonWorkingDirectory(filePaths: readonly string[]): string {
  const first = filePaths[0];
  try {
    const stats = fs.statSync(first);
    return stats.isDirectory() ? first : path.dirname(first);
  } catch {
    return path.dirname(first);
  }
}

export async function waitForStartupOrTerminate(
  child: Pick<childProcess.ChildProcessWithoutNullStreams, 'stdout' | 'stderr' | 'once' | 'kill'>,
  timeoutMs: number,
  output: Pick<vscode.OutputChannel, 'append' | 'appendLine'>,
): Promise<string> {
  try {
    return await waitForStartup(child, timeoutMs, output);
  } catch (error) {
    child.kill('SIGINT');
    throw error;
  }
}

export function waitForStartup(
  child: Pick<childProcess.ChildProcessWithoutNullStreams, 'stdout' | 'stderr' | 'once'>,
  timeoutMs: number,
  output: Pick<vscode.OutputChannel, 'append' | 'appendLine'>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = '';
    const recentLines: string[] = [];
    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for dcmview startup after ${timeoutMs / 1000}s.`));
    }, timeoutMs);

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        output.appendLine(line);
        recentLines.push(line);
        recentLines.splice(0, Math.max(0, recentLines.length - 20));
        const parsed = parseStartupLine(line);
        if (parsed && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(parsed);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      output.append(chunk.toString('utf8'));
    });

    child.once('error', (error) => {
      fail(error);
    });

    child.once('exit', (code, signal) => {
      if (!settled) {
        fail(
          new Error(
            `dcmview exited before startup (code=${code ?? 'null'}, signal=${signal ?? 'null'}).\n${recentLines.join('\n')}`,
          ),
        );
      }
    });
  });
}

export function parseStartupLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith('{')) {
    try {
      const event = JSON.parse(trimmed) as Partial<StartupEvent>;
      if (event.type === STARTUP_EVENT_TYPE && typeof event.url === 'string') {
        return event.url;
      }
    } catch {
      return undefined;
    }
  }

  if (trimmed.startsWith(STARTUP_PREFIX)) {
    return trimmed.slice(STARTUP_PREFIX.length);
  }
  return undefined;
}

function webviewHtml(webview: vscode.Webview, externalUri: vscode.Uri): string {
  const iframeSrc = escapeHtml(externalUri.toString());
  const frameOrigin = escapeHtml(`${externalUri.scheme}://${externalUri.authority}`);
  const csp = [
    "default-src 'none'",
    `frame-src ${frameOrigin}`,
    `img-src ${webview.cspSource} https: data:`,
    "style-src 'unsafe-inline'",
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>dcmview</title>
  <style>
    html, body, iframe {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      border: 0;
      background: #1a1a1a;
      overflow: hidden;
    }
  </style>
</head>
<body>
  <iframe src="${iframeSrc}" title="dcmview"></iframe>
</body>
</html>`;
}

async function stopAllSessions(): Promise<void> {
  await Promise.all(Array.from(sessions).map((session) => stopSession(session)));
}

async function stopSession(session: RunningSession, disposePanel = true): Promise<void> {
  if (session.stopped) {
    return;
  }
  session.stopped = true;
  sessions.delete(session);
  await terminateProcess(session.process, session.output, session.name);
  if (disposePanel) {
    session.panel.dispose();
  }
}

async function terminateProcess(
  child: childProcess.ChildProcessWithoutNullStreams,
  output: vscode.OutputChannel,
  name: string,
): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  output.appendLine(`Stopping ${name}`);
  child.kill('SIGINT');

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
      }
      resolve();
    }, 2500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('dcmview');
  }
  return outputChannel;
}

async function configureTerminalInterception(context: vscode.ExtensionContext): Promise<void> {
  const settings = readSettings();
  const env = context.environmentVariableCollection;
  env.persistent = false;
  env.clear();

  if (!settings.terminalInterceptionEnabled) {
    await stopBridge();
    return;
  }

  const output = getOutputChannel();
  try {
    const binary = await resolveBinaryPath(context.extensionUri.fsPath, settings.binaryPath);
    const bridge = await ensureBridge(context);
    const shimDir = await ensureShimDirectory(context, binary);

    env.description = 'Routes dcmview terminal commands into the VS Code dcmview viewer.';
    env.prepend('PATH', `${shimDir}${path.delimiter}`);
    env.replace(BRIDGE_URL_ENV, bridge.url);
    env.replace(BRIDGE_TOKEN_ENV, bridge.token);
    output.appendLine(`dcmview terminal interception enabled at ${bridge.url}`);
  } catch (error) {
    env.clear();
    output.appendLine(`dcmview terminal interception disabled: ${formatError(error)}`);
  }
}

async function ensureBridge(context: vscode.ExtensionContext): Promise<BridgeServer> {
  if (bridgeServer) {
    return bridgeServer;
  }

  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((request, response) => {
    void handleBridgeRequest(context, token, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to start dcmview VS Code bridge.');
  }

  bridgeServer = {
    server,
    token,
    url: `http://127.0.0.1:${address.port}`,
  };
  return bridgeServer;
}

async function stopBridge(): Promise<void> {
  const bridge = bridgeServer;
  bridgeServer = undefined;
  if (!bridge) {
    return;
  }

  await new Promise<void>((resolve) => {
    bridge.server.close(() => resolve());
  });
}

async function handleBridgeRequest(
  context: vscode.ExtensionContext,
  token: string,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  try {
    if (!isAuthorizedBridgeRequest(request, token)) {
      writeJson(response, 401, { error: 'unauthorized' });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/launch') {
      const launchRequest = await readJsonBody<BridgeLaunchRequest>(request);
      const launchResponse = await launchFromBridge(context, launchRequest);
      writeJson(response, 200, launchResponse);
      return;
    }

    const stopMatch = /^\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
    if (request.method === 'POST' && stopMatch) {
      const session = sessionsById.get(stopMatch[1]);
      if (!session) {
        writeJson(response, 404, { error: 'session not found' });
        return;
      }
      await stopSession(session);
      writeJson(response, 200, bridgeStopResponse());
      return;
    }

    const waitMatch = /^\/sessions\/([^/]+)\/wait$/.exec(url.pathname);
    if ((request.method === 'GET' || request.method === 'POST') && waitMatch) {
      const session = sessionsById.get(waitMatch[1]);
      if (!session) {
        writeJson(response, 404, { error: 'session not found' });
        return;
      }
      const exitCode = await session.exitCode;
      writeJson(response, 200, bridgeWaitResponse(exitCode));
      return;
    }

    writeJson(response, 404, { error: 'not found' });
  } catch (error) {
    writeJson(response, 500, { error: formatError(error) });
  }
}

export function isAuthorizedBridgeRequest(
  request: Pick<http.IncomingMessage, 'headers'>,
  token: string,
): boolean {
  const auth = request.headers.authorization;
  if (auth === `Bearer ${token}`) {
    return true;
  }
  return request.headers['x-dcmview-token'] === token;
}

export function bridgeStopResponse(): { ok: true } {
  return { ok: true };
}

export function bridgeWaitResponse(exitCode: number): { exitCode: number } {
  return { exitCode };
}

async function launchFromBridge(
  context: vscode.ExtensionContext,
  request: BridgeLaunchRequest,
): Promise<BridgeLaunchResponse> {
  const settings = readSettings();
  const output = getOutputChannel();
  const binary = await resolveBinaryPath(context.extensionUri.fsPath, settings.binaryPath);
  const args = normalizeInterceptedArgs(request.args ?? []);
  const cwd = request.cwd && path.isAbsolute(request.cwd) ? request.cwd : firstWorkspacePath();
  const title = `dcmview: ${request.program ?? 'terminal'}`;
  const session = await startSession(context, binary, args, cwd, title, settings, output);
  const response: BridgeLaunchResponse = {
    sessionId: session.id,
    url: session.url,
  };
  if (request.wait) {
    response.exitCode = await session.exitCode;
  }
  return response;
}

function firstWorkspacePath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > 1024 * 1024) {
      throw new Error('Bridge request body is too large.');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function ensureShimDirectory(context: vscode.ExtensionContext, binary: string): Promise<string> {
  const shimDir = path.join(context.globalStorageUri.fsPath, 'terminal-shims');
  await fs.promises.mkdir(shimDir, { recursive: true });
  await Promise.all([
    writeShim(shimDir, 'dcmview', binary, 'dcmview'),
    writeShim(shimDir, 'dcmview-py', binary, 'dcmview-py'),
  ]);
  return shimDir;
}

async function writeShim(
  shimDir: string,
  name: string,
  binary: string,
  program: string,
): Promise<void> {
  if (process.platform === 'win32') {
    const filePath = path.join(shimDir, `${name}.cmd`);
    await fs.promises.writeFile(filePath, windowsShim(binary, program), 'utf8');
    return;
  }

  const filePath = path.join(shimDir, name);
  await fs.promises.writeFile(filePath, posixShim(binary, program), { encoding: 'utf8', mode: 0o755 });
  await fs.promises.chmod(filePath, 0o755);
}

export function posixShim(binary: string, program: string): string {
  return `#!/bin/sh
if [ "\${${BRIDGE_BYPASS_ENV}:-}" = "1" ]; then
  exec ${shellSingleQuote(binary)} "$@"
fi
exec ${shellSingleQuote(binary)} --vscode-bridge-client ${shellSingleQuote(program)} "$@"
`;
}

export function windowsShim(binary: string, program: string): string {
  return `@echo off\r
if "%${BRIDGE_BYPASS_ENV}%"=="1" (\r
  "${binary}" %*\r
  exit /b %ERRORLEVEL%\r
)\r
"${binary}" --vscode-bridge-client ${program} %*\r
exit /b %ERRORLEVEL%\r
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
