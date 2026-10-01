import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { commandEnvironment, loadTable, readDataFile, runCommand } from "../dataSource";

suite("dataSource", () => {
  const token = new vscode.CancellationTokenSource().token;
  let dir: string;

  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-test-"));
  });

  suiteTeardown(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("commands print numbers with decimal points", () => {
    const env = commandEnvironment({ LC_ALL: "de_DE.UTF-8", HOME: "/home/x" });
    assert.strictEqual(env.LC_ALL, undefined);
    assert.strictEqual(env.LC_NUMERIC, "C");
    assert.strictEqual(env.LC_TIME, "de_DE.UTF-8");
    assert.strictEqual(env.HOME, "/home/x");
  });

  suite("commands", () => {
    suiteSetup(function () {
      if (process.platform === "win32") {
        this.skip();
      }
    });

    test("loads chart data from a command's output", async () => {
      const { table } = await loadTable(
        { type: "pie", command: "printf 'apples 3\\npears 5\\n'" },
        token,
      );
      assert.deepStrictEqual(table.rows, [
        ["apples", 3],
        ["pears", 5],
      ]);
    });

    test("keeps the output of a failed command, with a warning", async () => {
      const result = await runCommand("echo 'a 1'; echo 'no access' >&2; exit 1", token);
      assert.deepStrictEqual(result, {
        output: "a 1\n",
        warning:
          "The command exited with code 1, so its output may be incomplete. Its error output:\nno access",
      });
    });

    test("fails when a command prints nothing", async () => {
      await assert.rejects(
        runCommand("echo oops >&2; exit 3", token),
        /^Error: The command printed nothing to standard output and exited with code 3\. Its error output:\noops$/,
      );
      await assert.rejects(runCommand("true", token), /printed nothing to standard output\.$/);
    });

    test("stops a command that runs too long or prints too much", async () => {
      await assert.rejects(runCommand("sleep 5", token, 100), /timed out after 0.1 s/);
      await assert.rejects(runCommand("head -c 11000000 /dev/zero", token), /more than 10 MB/);
    });

    test("stops the processes a command started", async () => {
      const pidFile = path.join(dir, "pid");
      await assert.rejects(
        runCommand(`sleep 30 & echo $! > '${pidFile}'; wait`, token, 300),
        /timed out/,
      );
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      const alive = () => {
        try {
          return process.kill(pid, 0);
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 50 && alive(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(!alive(), `process ${pid} is still running`);
    });

    test("stops a command when cancelled", async () => {
      const source = new vscode.CancellationTokenSource();
      setTimeout(() => source.cancel(), 50);
      await assert.rejects(runCommand("sleep 5", source.token), vscode.CancellationError);
    });
  });

  test("reads files, explaining why one cannot be read", async () => {
    await assert.rejects(readDataFile(path.join(dir, "missing.csv")), /does not exist/);
    await assert.rejects(readDataFile(dir), /is a directory/);
    const large = path.join(dir, "large.csv");
    fs.writeFileSync(large, Buffer.alloc(10 * 1024 * 1024 + 1));
    await assert.rejects(readDataFile(large), /is larger than the 10 MB limit/);
  });

  test("reads UTF-16 files with a byte order mark", async () => {
    const file = path.join(dir, "utf16.csv");
    fs.writeFileSync(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,1", "utf16le")]),
    );
    assert.strictEqual(await readDataFile(file), "a,1");
  });

  test("reads files that are not UTF-8 as Windows-1252", async () => {
    const file = path.join(dir, "latin1.csv");
    fs.writeFileSync(file, Buffer.from("café,1", "latin1"));
    assert.strictEqual(await readDataFile(file), "café,1");
  });

  test("refuses binary files, such as spreadsheets", async () => {
    const file = path.join(dir, "sales.xlsx");
    fs.writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]));
    await assert.rejects(
      readDataFile(file),
      /is not a text file \(it may be a spreadsheet\)\. Save its data as CSV/,
    );
  });
});
