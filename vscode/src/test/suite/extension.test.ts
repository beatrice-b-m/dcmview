import * as assert from 'assert';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import {
  binaryCandidates,
  collectFileSystemPaths,
  parseStartupLine,
  waitForStartup,
  waitForStartupOrTerminate,
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

  test('registers public commands', async () => {
    const extension = vscode.extensions.getExtension('dcmview.dcmview-vscode');
    assert.ok(extension, 'development extension should be available');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('dcmview.openPath'));
    assert.ok(commands.includes('dcmview.openWorkspaceSelection'));
    assert.ok(commands.includes('dcmview.stopAll'));
  });
});
