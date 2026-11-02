import { describe, expect, it } from "vite-plus/test";
import {
  APP_BUNDLE_CLI,
  checkedArgument,
  cliArgs,
  PaseoCli,
  resolveCliPath,
  type ExecFileFunction,
} from "../server/cli";

describe("cliArgs", () => {
  it("builds the stop command", () => {
    expect(cliArgs.stop("0b95b862-1c4e")).toEqual(["stop", "0b95b862-1c4e"]);
  });

  it("builds the thinking command", () => {
    expect(cliArgs.setThinking("0b95b862", "high")).toEqual([
      "agent",
      "update",
      "0b95b862",
      "--thinking",
      "high",
    ]);
  });

  it("builds the daemon status command", () => {
    expect(cliArgs.daemonStatus()).toEqual(["daemon", "status", "--json"]);
  });

  it("refuses values that the CLI would read as options or that hold control characters", () => {
    expect(() => cliArgs.stop("--all")).toThrow('cannot start with "-"');
    expect(() => cliArgs.setThinking("a1", "-x")).toThrow("thinking option");
    expect(() => cliArgs.stop("")).toThrow("empty");
    expect(() => cliArgs.stop("a\nb")).toThrow("control characters");
    expect(() => checkedArgument("x".repeat(513), "agent ID")).toThrow("too long");
  });

  it("keeps spaces and shell characters inside one argument", () => {
    expect(cliArgs.setThinking("a1", "max; rm -rf ~")).toEqual([
      "agent",
      "update",
      "a1",
      "--thinking",
      "max; rm -rf ~",
    ]);
  });
});

describe("resolveCliPath", () => {
  const only =
    (...paths: string[]) =>
    async (path: string) =>
      paths.includes(path);

  it("uses the configured absolute path when it is executable", async () => {
    expect(
      await resolveCliPath({
        configured: "/opt/paseo/bin/paseo",
        isExecutable: only("/opt/paseo/bin/paseo"),
      }),
    ).toBe("/opt/paseo/bin/paseo");
  });

  it("refuses a configured path that is relative or not executable", async () => {
    expect(await resolveCliPath({ configured: "paseo", isExecutable: only("paseo") })).toBeNull();
    expect(await resolveCliPath({ configured: "/missing/paseo", isExecutable: only() })).toBeNull();
  });

  it("searches PATH in order, skipping relative entries", async () => {
    const env = { PATH: "relative:/usr/bin:/Users/me/.local/bin:/opt/bin" };
    expect(
      await resolveCliPath({
        configured: "",
        env,
        isExecutable: only("/Users/me/.local/bin/paseo", "/opt/bin/paseo", "relative/paseo"),
      }),
    ).toBe("/Users/me/.local/bin/paseo");
  });

  it("falls back to the app bundle", async () => {
    expect(
      await resolveCliPath({
        configured: "",
        env: { PATH: "/usr/bin" },
        isExecutable: only(APP_BUNDLE_CLI),
      }),
    ).toBe(APP_BUNDLE_CLI);
  });

  it("returns null when nothing is found", async () => {
    expect(await resolveCliPath({ configured: "", env: {}, isExecutable: only() })).toBeNull();
  });
});

describe("PaseoCli", () => {
  function recorder() {
    const calls: { file: string; args: readonly string[] }[] = [];
    const exec: ExecFileFunction = async (file, args) => {
      calls.push({ file, args });
      return { stdout: JSON.stringify({ serverId: "srv_test" }), stderr: "" };
    };
    return { calls, exec };
  }

  it("runs the resolved binary with an argument list", async () => {
    const { calls, exec } = recorder();
    const cli = new PaseoCli({
      configuredPath: () => "",
      exec,
      resolve: async () => "/usr/local/bin/paseo",
    });
    await cli.stop("a1");
    await cli.setThinking("a1", "low");
    expect(calls).toEqual([
      { file: "/usr/local/bin/paseo", args: ["stop", "a1"] },
      { file: "/usr/local/bin/paseo", args: ["agent", "update", "a1", "--thinking", "low"] },
    ]);
  });

  it("reads the server ID from the daemon status", async () => {
    const { exec } = recorder();
    const cli = new PaseoCli({ configuredPath: () => "", exec, resolve: async () => "/bin/paseo" });
    expect(await cli.serverId()).toBe("srv_test");
  });

  it("explains a missing CLI", async () => {
    const cli = new PaseoCli({ configuredPath: () => "", resolve: async () => null });
    await expect(cli.stop("a1")).rejects.toThrow("not on PATH");
  });

  it("runs a real executable without a shell", async () => {
    const cli = new PaseoCli({ configuredPath: () => "/bin/echo" });
    const result = await cli.run(["stop", "$HOME; echo injected"]);
    expect(result.stdout).toBe("stop $HOME; echo injected\n");
  });

  it("kills a running command when its signal aborts, and starts none after", async () => {
    const cli = new PaseoCli({ configuredPath: () => "/bin/sleep" });
    const abort = new AbortController();
    const started = Date.now();
    const running = cli.run(["5"], abort.signal);
    setTimeout(() => abort.abort(new Error("the plugin stopped")), 20);
    await expect(running).rejects.toThrow("the plugin stopped");
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(cli.run(["5"], abort.signal)).rejects.toThrow("the plugin stopped");
  });
});
