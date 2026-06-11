import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  BRIDGE_REGISTRY_MAX_AGE_MS,
  BRIDGE_REGISTRY_REFRESH_MS,
  binaryCandidates,
  bridgeRegistryDirectory,
  bridgeRegistryEntry,
  bridgeStopResponse,
  bridgeWaitResponse,
  collectFileSystemPaths,
  isAuthorizedBridgeRequest,
  isExpiredRegistryEntry,
  orderBridgeRegistryEndpoints,
  normalizeInterceptedArgs,
  parseStartupLine,
  posixShim,
  registryDirectoryIsTrusted,
  safeRegistrySegment,
  waitForStartup,
  waitForStartupOrTerminate,
  writeBridgeRegistry,
  windowsShim,
} from '../../extension';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killedSignals: string[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedSignals.push(String(signal ?? 'SIGTERM'));
    return true;
  }
}

const output = {
  append: () => undefined,
  appendLine: () => undefined,
};
const bridgeContract = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../../docs/contracts/bridge-protocol.json'), 'utf8'),
);
const registryContract = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../../docs/contracts/vscode-bridge-registry.json'), 'utf8'),
);

suite('dcmview extension', () => {
  test('parses structured startup events', () => {
    const url = parseStartupLine(
      '{"type":"server_started","url":"http://127.0.0.1:51234","host":"127.0.0.1","port":51234}',
    );

    assert.strictEqual(url, 'http://127.0.0.1:51234');
  });

  test('parses legacy startup lines', () => {
    const url = parseStartupLine('dcmview: server running at http://127.0.0.1:51234');

    assert.strictEqual(url, 'http://127.0.0.1:51234');
  });

  test('ignores unrelated startup output', () => {
    assert.strictEqual(parseStartupLine('dcmview: loaded 2 DICOM file(s)'), undefined);
    assert.strictEqual(parseStartupLine('{"type":"other","url":"http://127.0.0.1:1"}'), undefined);
  });

  test('waits for structured startup events before legacy fallback', async () => {
    const child = new FakeChild();
    const startup = waitForStartup(child as never, 1000, output);

    child.stdout.emit(
      'data',
      Buffer.from(
        '{"type":"server_started","url":"http://127.0.0.1:51234","host":"127.0.0.1","port":51234}\n' +
          'dcmview: server running at http://127.0.0.1:9999\n',
      ),
    );

    assert.strictEqual(await startup, 'http://127.0.0.1:51234');
  });

  test('terminates child process when startup wait fails', async () => {
    const child = new FakeChild();

    await assert.rejects(
      () => waitForStartupOrTerminate(child as never, 1, output),
      /Timed out waiting for dcmview startup/,
    );
    assert.deepStrictEqual(child.killedSignals, ['SIGINT']);
  });

  test('collects only filesystem uris', () => {
    const paths = collectFileSystemPaths([
      vscode.Uri.file('/tmp/a.dcm'),
      vscode.Uri.parse('untitled:Scratch'),
      vscode.Uri.file('/tmp/study'),
    ]);

    assert.deepStrictEqual(paths, ['/tmp/a.dcm', '/tmp/study']);
  });

  test('orders binary candidates for local development', () => {
    const candidates = binaryCandidates('/repo/vscode', '/custom/dcmview');

    assert.deepStrictEqual(candidates[0], { kind: 'path', value: '/custom/dcmview' });
    assert.ok(candidates.some((candidate) => candidate.value.includes('target/debug/dcmview')));
    assert.strictEqual(candidates[candidates.length - 1].kind, 'path-name');
  });

  test('generates Windows x64 binary candidates', () => {
    const candidates = binaryCandidates('C:\\repo\\vscode', '', 'win32', 'x64');

    assert.ok(candidates.some((candidate) => candidate.value.includes('target/debug/dcmview.exe')));
    assert.ok(
      candidates.some((candidate) =>
        candidate.value.includes(path.join('resources', 'bin', 'win32-x64', 'dcmview.exe')),
      ),
    );
    assert.deepStrictEqual(candidates[candidates.length - 1], {
      kind: 'path-name',
      value: 'dcmview.exe',
    });
  });

  test('normalizes terminal-intercepted args without clobbering explicit host and port', () => {
    assert.deepStrictEqual(normalizeInterceptedArgs(['/tmp/scan.dcm']), [
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--startup-json',
      '--no-browser',
      '/tmp/scan.dcm',
    ]);

    assert.deepStrictEqual(
      normalizeInterceptedArgs(['--host', 'localhost', '-p', '8888', '--no-browser', '/tmp/scan.dcm']),
      ['--startup-json', '--host', 'localhost', '-p', '8888', '--no-browser', '/tmp/scan.dcm'],
    );
  });

  test('generates shims that route through the bridge client with bypass fallback', () => {
    const posix = posixShim('/repo/target/debug/dcmview', 'dcmview-py');
    assert.ok(posix.includes('DCMVIEW_VSCODE_BYPASS'));
    assert.ok(posix.includes('--vscode-bridge-client'));
    assert.ok(posix.includes("'dcmview-py'"));

    const windows = windowsShim('C:\\repo\\target\\debug\\dcmview.exe', 'dcmview');
    assert.ok(windows.includes('DCMVIEW_VSCODE_BYPASS'));
    assert.ok(windows.includes('--vscode-bridge-client dcmview'));
  });

  test('matches shared bridge auth and response fixture', () => {
    const token = bridgeContract.auth.bearerToken;

    assert.strictEqual(
      isAuthorizedBridgeRequest({ headers: { authorization: `Bearer ${token}` } }, token),
      true,
    );
    assert.strictEqual(
      isAuthorizedBridgeRequest({ headers: { 'x-dcmview-token': token } }, token),
      true,
    );
    assert.strictEqual(isAuthorizedBridgeRequest({ headers: { authorization: 'Bearer wrong' } }, token), false);
    assert.deepStrictEqual(bridgeStopResponse(), bridgeContract.stop.response);
    assert.deepStrictEqual(bridgeWaitResponse(bridgeContract.wait.response.exitCode), bridgeContract.wait.response);
  });

  test('builds deterministic bridge registry locations', () => {
    assert.strictEqual(
      bridgeRegistryDirectory({ DCMVIEW_VSCODE_BRIDGE_REGISTRY_DIR: '/custom/bridges' }, '/tmp'),
      '/custom/bridges',
    );
    assert.strictEqual(
      bridgeRegistryDirectory({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/tmp'),
      path.join('/run/user/1000', 'dcmview', 'vscode-bridges'),
    );
    assert.strictEqual(
      bridgeRegistryDirectory({ USER: 'remote user' }, '/tmp'),
      path.join('/tmp', 'dcmview-vscode-bridges-remote_user'),
    );
  });

  test('matches shared bridge registry contract', () => {
    assert.strictEqual(BRIDGE_REGISTRY_MAX_AGE_MS, registryContract.ttlMs);
    assert.strictEqual(BRIDGE_REGISTRY_REFRESH_MS, registryContract.refreshMs);

    for (const testCase of registryContract.registryDirs) {
      assert.strictEqual(bridgeRegistryDirectory(testCase.env, testCase.tmpDir), testCase.expected);
    }
    for (const testCase of registryContract.safeSegments) {
      assert.strictEqual(safeRegistrySegment(testCase.input), testCase.expected);
    }
    for (const testCase of registryContract.expiry.cases) {
      assert.strictEqual(
        isExpiredRegistryEntry(testCase.createdAtMs, registryContract.expiry.nowMs),
        testCase.expired,
      );
    }

    const entries = registryContract.ordering.entries.map((item: { entry: unknown }) => item.entry) as Parameters<
      typeof orderBridgeRegistryEndpoints
    >[1];
    assert.deepStrictEqual(
      orderBridgeRegistryEndpoints(
        registryContract.ordering.cwd,
        entries,
        false,
        registryContract.ordering.nowMs,
      ),
      registryContract.ordering.expectedAllowAny,
    );
    assert.deepStrictEqual(
      orderBridgeRegistryEndpoints(
        registryContract.ordering.cwd,
        entries,
        true,
        registryContract.ordering.nowMs,
      ),
      registryContract.ordering.expectedRequireWorkspace,
    );
  });

  test('serializes bridge registry entries for out-of-band discovery', () => {
    const entry = bridgeRegistryEntry(
      { id: 'instance-1', url: 'http://127.0.0.1:4567', token: 'secret' },
      ['/workspace'],
      12345,
    );

    assert.deepStrictEqual(entry, {
      version: 1,
      instanceId: 'instance-1',
      bridgeUrl: 'http://127.0.0.1:4567',
      token: 'secret',
      workspaceRoots: ['/workspace'],
      createdAtMs: 12345,
    });
  });

  test('refresh rewrites the same bridge registry entry with a new timestamp', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcmview-registry-'));
    const registryDir = path.join(root, 'bridges');
    const bridge = { id: 'instance-1', url: 'http://127.0.0.1:4567', token: 'secret' };
    try {
      const firstPath = await writeBridgeRegistry(bridge, registryDir, ['/workspace'], 1000);
      let entry = JSON.parse(fs.readFileSync(firstPath, 'utf8'));
      assert.strictEqual(entry.instanceId, 'instance-1');
      assert.strictEqual(entry.createdAtMs, 1000);

      const secondPath = await writeBridgeRegistry(bridge, registryDir, ['/workspace'], 2000);
      entry = JSON.parse(fs.readFileSync(secondPath, 'utf8'));
      assert.strictEqual(secondPath, firstPath);
      assert.strictEqual(entry.instanceId, 'instance-1');
      assert.strictEqual(entry.createdAtMs, 2000);

      fs.unlinkSync(secondPath);
      const thirdPath = await writeBridgeRegistry(bridge, registryDir, ['/workspace'], 3000);
      entry = JSON.parse(fs.readFileSync(thirdPath, 'utf8'));
      assert.strictEqual(thirdPath, firstPath);
      assert.strictEqual(entry.createdAtMs, 3000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects untrusted unix registry directory metadata', () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') {
      assert.strictEqual(registryDirectoryIsTrusted({ uid: 9999, mode: 0o777 } as fs.Stats), true);
      return;
    }
    const uid = process.getuid();
    assert.strictEqual(registryDirectoryIsTrusted({ uid, mode: 0o700 } as fs.Stats), true);
    assert.strictEqual(registryDirectoryIsTrusted({ uid: uid + 1, mode: 0o700 } as fs.Stats), false);
    assert.strictEqual(registryDirectoryIsTrusted({ uid, mode: 0o722 } as fs.Stats), false);
  });

  test('registers public commands', async () => {
    const extension = vscode.extensions.getExtension('beatricebm.dcmview');
    assert.ok(extension, 'development extension should be available');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('dcmview.openPath'));
    assert.ok(commands.includes('dcmview.openWorkspaceSelection'));
    assert.ok(commands.includes('dcmview.stopAll'));
  });
});
