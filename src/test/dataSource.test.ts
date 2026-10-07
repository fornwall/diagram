import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  commandEnvironment,
  loadTable,
  printsSiSizes,
  readDataFile,
  runCommand,
} from "../dataSource";
import { afterTest, suiteTempDir } from "./afterTest";

suite("dataSource", () => {
  const token = new vscode.CancellationTokenSource().token;
  const dir = suiteTempDir("diagram-test-");

  test("commands print numbers with decimal points", () => {
    const env = commandEnvironment({ LC_ALL: "de_DE.UTF-8", HOME: "/home/x" });
    assert.strictEqual(env.LC_ALL, undefined);
    assert.strictEqual(env.LC_NUMERIC, "C");
    assert.strictEqual(env.LC_TIME, "de_DE.UTF-8");
    assert.strictEqual(env.HOME, "/home/x");
  });

  test("cancelled requests do not load or parse data", async () => {
    const source = new vscode.CancellationTokenSource();
    source.cancel();
    try {
      await assert.rejects(
        loadTable({ type: "bar", data: "not JSON", format: "json" }, source.token),
        vscode.CancellationError,
      );
      await assert.rejects(
        loadTable({ type: "bar", file: path.join(dir, "missing.csv") }, source.token),
        vscode.CancellationError,
      );
    } finally {
      source.dispose();
    }
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

    test("reads sizes in powers of 1000 from commands with --si, or df -H", async () => {
      const sizes = async (command: string) =>
        (await loadTable({ type: "bar", command }, token)).table.rows.map((row) =>
          row.find((cell) => typeof cell === "number"),
        );
      // Functions stand in for du and df, whose output depends on the machine.
      const du = "du() { printf '1.5M\\tsrc\\n2G\\tdocs\\n'; }; ";
      assert.deepStrictEqual(await sizes(`${du}du -s --si *`), [1.5e6, 2e9]);
      assert.deepStrictEqual(await sizes(`${du}du -sh *`), [1.5 * 1024 ** 2, 2 * 1024 ** 3]);
      const df = "df() { printf 'Filesystem Size\\n/dev/sda1 500G\\n'; }; ";
      assert.deepStrictEqual(await sizes(`${df}df -TH /`), [500e9]);
      assert.deepStrictEqual(await sizes(`${df}df -h /`), [500 * 1024 ** 3]);
    });

    test("tells sizes in powers of 1000 from the options of commands, in linear time", () => {
      for (const command of ["du --si .", "du -s --si=x", "/bin/df -h -TH /", "x;df -a -H"]) {
        assert.strictEqual(printsSiSizes(command), true, command);
      }
      for (const command of ["du --size", "x--si", "df -h /", "df / -H", "mydf -H", "df - -H"]) {
        assert.strictEqual(printsSiSizes(command), false, command);
      }
      const start = Date.now();
      assert.strictEqual(printsSiSizes("-df ".repeat(20_000)), false);
      assert.ok(Date.now() - start < 500);
    });

    test("reads UTF-16 output with a byte order mark, and invalid UTF-8 leniently", async () => {
      const file = path.join(dir, "unicode.txt");
      fs.writeFileSync(file, Buffer.from("﻿a\t1\r\nb\t2\r\n", "utf16le"));
      assert.deepStrictEqual(await runCommand(`cat '${file}'`, token), {
        output: "a\t1\r\nb\t2\r\n",
      });
      assert.deepStrictEqual(await runCommand("printf 'caf\\351 1\\n'", token), {
        output: "caf� 1\n",
      });
    });

    test("keeps the output of a failed command, with a warning", async () => {
      const result = await runCommand("echo 'a 1'; echo 'no access' >&2; exit 1", token);
      assert.deepStrictEqual(result, {
        output: "a 1\n",
        warning:
          "The command exited with code 1, so its output may be incomplete. Its error output:\nno access",
      });
    });

    test("keeps the end of long error output", async () => {
      await assert.rejects(
        runCommand(
          "i=0; while [ $i -lt 2000 ]; do echo 'noise' >&2; i=$((i+1)); done; echo last >&2; exit 2",
          token,
        ),
        (error: Error) => {
          const output = error.message.split("Its error output:\n")[1] ?? "";
          assert.match(output, /^…[a-z]*\n(noise\n)*last$/);
          assert.strictEqual(output.length, 2001);
          return true;
        },
      );
    });

    test("uses the output of a command that exited, while its background process holds the output open", async () => {
      const started = Date.now();
      assert.deepStrictEqual(await runCommand("echo 'a 1'; sleep 30 &", token), {
        output: "a 1\n",
      });
      assert.ok(Date.now() - started < 5000);
    });

    test("fails when a command prints nothing", async () => {
      await assert.rejects(
        runCommand("echo oops >&2; exit 3", token),
        /^Error: The command printed nothing to standard output and exited with code 3\. Its error output:\noops$/,
      );
      await assert.rejects(runCommand("true", token), /printed nothing to standard output\.$/);
    });

    test("stops a command that runs too long or prints too much", async () => {
      await assert.rejects(runCommand("sleep 5", token, 100), /timed out after 0.1 seconds/);
      await assert.rejects(runCommand("head -c 11000000 /dev/zero", token), /more than 10 MiB/);
    });

    test("stops a cancelled command, and the processes it started", async () => {
      const pidFile = path.join(dir, "pid");
      const source = new vscode.CancellationTokenSource();
      const running = runCommand(
        `sleep 30 & echo $! > '${pidFile}.tmp'; mv '${pidFile}.tmp' '${pidFile}'; wait`,
        source.token,
      );
      for (let i = 0; i < 500 && !fs.existsSync(pidFile); i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      source.cancel();
      await assert.rejects(running, vscode.CancellationError);
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      assert.ok(pid > 0);
      const alive = () => {
        try {
          return process.kill(pid, 0);
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 250 && alive(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(!alive(), `process ${pid} is still running`);
    });
  });

  test("reads files, explaining why one cannot be read", async () => {
    await assert.rejects(
      readDataFile(path.join(dir, "missing.csv")),
      /^Error: \/\S+missing\.csv does not exist\.$/,
    );
    await assert.rejects(readDataFile("missing.csv"), {
      message:
        "missing.csv does not exist. Relative paths are read from the workspace folder workspace.",
    });
    await assert.rejects(
      readDataFile(dir),
      /^Error: \S+ is a folder, not a file\. To chart the files in it, use a command such as du\.$/,
    );
    const csv = path.join(dir, "data.csv");
    fs.writeFileSync(csv, "a,1");
    await assert.rejects(
      readDataFile(path.join(csv, "more.csv")),
      /^Error: The path \S+more\.csv goes through a file as if it were a folder\.$/,
    );
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      fs.chmodSync(csv, 0);
      await assert.rejects(
        readDataFile(csv),
        /^Error: You do not have permission to read \S+data\.csv\.$/,
      );
    }
    const large = path.join(dir, "large.csv");
    fs.writeFileSync(large, Buffer.alloc(10 * 1024 * 1024 + 1));
    await assert.rejects(readDataFile(large), {
      message: `The file ${large} is larger than the 10 MiB limit. Use a command that summarizes it instead.`,
    });
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
    // A stray byte in UTF-8 text is left undecoded, as the editor shows it.
    fs.writeFileSync(file, Buffer.concat([Buffer.from("café,€ 東京"), Buffer.from([0xff])]));
    assert.strictEqual(await readDataFile(file), "café,€ 東京\uFFFD");
  });

  test("reads files that are not UTF-8 in the encoding of files.encoding", async () => {
    const files = vscode.workspace.getConfiguration("files");
    await files.update("encoding", "koi8r", vscode.ConfigurationTarget.Global);
    afterTest(() => files.update("encoding", undefined, vscode.ConfigurationTarget.Global));
    const file = path.join(dir, "koi8r.csv");
    fs.writeFileSync(file, Buffer.from([0xc4, 0xc1, 0x2c, 0x31])); // "да,1"
    assert.strictEqual(await readDataFile(file), "да,1");
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
