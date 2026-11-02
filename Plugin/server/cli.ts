import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/** Where the Paseo app bundles its CLI on macOS. */
export const APP_BUNDLE_CLI = "/Applications/Paseo.app/Contents/Resources/bin/paseo";

const MAX_ARGUMENT_LENGTH = 512;

/**
 * Checks a value that becomes one CLI argument.
 * IDs come from the daemon, but a value that starts with "-" would read as an option.
 */
export function checkedArgument(value: string, what: string): string {
  if (value.length === 0) throw new Error(`The ${what} is empty`);
  if (value.length > MAX_ARGUMENT_LENGTH) throw new Error(`The ${what} is too long`);
  if (value.startsWith("-")) throw new Error(`The ${what} cannot start with "-"`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`The ${what} has control characters`);
  return value;
}

/** Argument lists for the CLI commands that the plugin runs. */
export const cliArgs = {
  /** `paseo stop <id>`: interrupts the agent's turn; does nothing to an idle agent. */
  stop(agentId: string): string[] {
    return ["stop", checkedArgument(agentId, "agent ID")];
  },
  /** `paseo agent update <id> --thinking <option>` */
  setThinking(agentId: string, optionId: string): string[] {
    return [
      "agent",
      "update",
      checkedArgument(agentId, "agent ID"),
      "--thinking",
      checkedArgument(optionId, "thinking option"),
    ];
  },
  /** `paseo daemon status --json` */
  daemonStatus(): string[] {
    return ["daemon", "status", "--json"];
  },
};

export interface ResolveCliOptions {
  /** The path from the settings; empty to search. */
  configured: string;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (path: string) => Promise<boolean>;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the `paseo` CLI: the configured path, else `paseo` on PATH,
 * else the copy in the Paseo app bundle. Returns null when none is executable.
 */
export async function resolveCliPath(options: ResolveCliOptions): Promise<string | null> {
  const isExecutable = options.isExecutable ?? executable;
  const configured = options.configured.trim();
  if (configured !== "") {
    if (!isAbsolute(configured)) return null;
    return (await isExecutable(configured)) ? configured : null;
  }
  const path = (options.env ?? process.env).PATH ?? "";
  for (const directory of path.split(delimiter)) {
    if (directory === "" || !isAbsolute(directory)) continue;
    const candidate = join(directory, "paseo");
    if (await isExecutable(candidate)) return candidate;
  }
  return (await isExecutable(APP_BUNDLE_CLI)) ? APP_BUNDLE_CLI : null;
}

export interface CliResult {
  stdout: string;
  stderr: string;
}

export type ExecFileFunction = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; signal?: AbortSignal },
) => Promise<CliResult>;

const execFileAsync: ExecFileFunction = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error?.name === "AbortError" && options.signal?.aborted) {
        reject(options.signal.reason as Error);
      } else if (error) {
        const detail = stderr.trim() || error.message;
        reject(new Error(`paseo ${args.join(" ")} failed: ${detail}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });

export interface PaseoCliOptions {
  /** Returns the configured CLI path; empty to search. */
  configuredPath: () => string;
  timeoutMs?: number;
  exec?: ExecFileFunction;
  resolve?: (options: ResolveCliOptions) => Promise<string | null>;
}

/** Runs the `paseo` CLI with an argument list, never through a shell. */
export class PaseoCli {
  private readonly options: PaseoCliOptions;

  constructor(options: PaseoCliOptions) {
    this.options = options;
  }

  /** Runs the CLI. Aborting `signal` stops a command that has not started and kills one that has. */
  async run(args: readonly string[], signal?: AbortSignal): Promise<CliResult> {
    signal?.throwIfAborted();
    const configured = this.options.configuredPath();
    const path = await (this.options.resolve ?? resolveCliPath)({ configured });
    signal?.throwIfAborted();
    if (path === null) {
      throw new Error(
        configured === ""
          ? `The paseo CLI is not on PATH or at ${APP_BUNDLE_CLI}`
          : `The configured paseo CLI is not an executable absolute path: ${configured}`,
      );
    }
    return (this.options.exec ?? execFileAsync)(path, args, {
      timeout: this.options.timeoutMs ?? 15_000,
      maxBuffer: 1 << 20,
      ...(signal ? { signal } : {}),
    });
  }

  stop(agentId: string, signal?: AbortSignal): Promise<CliResult> {
    return this.run(cliArgs.stop(agentId), signal);
  }

  setThinking(agentId: string, optionId: string, signal?: AbortSignal): Promise<CliResult> {
    return this.run(cliArgs.setThinking(agentId, optionId), signal);
  }

  /** The daemon's server ID from `paseo daemon status --json`. */
  async serverId(signal?: AbortSignal): Promise<string> {
    const { stdout } = await this.run(cliArgs.daemonStatus(), signal);
    const status: unknown = JSON.parse(stdout);
    const serverId = (status as { serverId?: unknown } | null)?.serverId;
    if (typeof serverId !== "string" || serverId === "") {
      throw new Error("paseo daemon status reported no server ID");
    }
    return serverId;
  }
}
