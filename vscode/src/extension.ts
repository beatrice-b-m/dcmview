import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const STARTUP_PREFIX = 'dcmview: server running at ';
const STARTUP_EVENT_TYPE = 'server_started';

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
}

interface RunningSession {
  readonly panel: vscode.WebviewPanel;
  readonly process: childProcess.ChildProcessWithoutNullStreams;
  readonly output: vscode.OutputChannel;
  readonly name: string;
  stopped: boolean;
}

const sessions = new Set<RunningSession>();
let outputChannel: vscode.OutputChannel | undefined;

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
  );
}

export async function deactivate(): Promise<void> {
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
    const session = await startSession(context, binary, filePaths, settings, output);
    sessions.add(session);
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
    'Unable to find dcmview. Set dcmview.binaryPath, run cargo build, or install dcmview on PATH.',
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
  filePaths: readonly string[],
  settings: ExtensionSettings,
  output: vscode.OutputChannel,
): Promise<RunningSession> {
  const args = buildDcmviewArgs(filePaths, settings);
  output.appendLine(`Launching: ${binary} ${args.map(shellQuote).join(' ')}`);

  const child = childProcess.spawn(binary, args, {
    cwd: commonWorkingDirectory(filePaths),
    env: process.env,
  });
  const serverUrl = await waitForStartupOrTerminate(
    child,
    settings.startupTimeoutSeconds * 1000,
    output,
  );
  let panel: vscode.WebviewPanel;
  let title: string;
  try {
    const externalUri = await vscode.env.asExternalUri(vscode.Uri.parse(serverUrl));

    title = `dcmview: ${path.basename(filePaths[0])}${filePaths.length > 1 ? ` +${filePaths.length - 1}` : ''}`;
    panel = vscode.window.createWebviewPanel('dcmview.viewer', title, vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [context.extensionUri],
    });
    panel.webview.html = webviewHtml(panel.webview, externalUri);
  } catch (error) {
    child.kill('SIGINT');
    throw error;
  }

  const session: RunningSession = {
    panel,
    process: child,
    output,
    name: title,
    stopped: false,
  };

  child.once('exit', (code, signal) => {
    output.appendLine(`dcmview exited (${title}): code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    sessions.delete(session);
    if (!session.stopped) {
      panel.dispose();
    }
  });
  panel.onDidDispose(() => {
    void stopSession(session);
  });

  return session;
}

function buildDcmviewArgs(filePaths: readonly string[], settings: ExtensionSettings): string[] {
  const args = ['--no-browser', '--port', '0', '--host', '127.0.0.1', '--startup-json'];
  if (!settings.defaultRecursive) {
    args.push('--no-recursive');
  }
  args.push(...settings.extraArgs, ...filePaths);
  return args;
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

async function stopSession(session: RunningSession): Promise<void> {
  if (session.stopped) {
    return;
  }
  session.stopped = true;
  sessions.delete(session);
  await terminateProcess(session.process, session.output, session.name);
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
