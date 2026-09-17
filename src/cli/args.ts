/**
 * Minimal argv parser for the CLI.
 *
 * No new dependencies. Handles `--flag`, `--flag value`, `--flag=value`, and
 * bare positional commands. The first positional is the command name; flags
 * may appear before or after positionals.
 */

export type ParsedArgs = {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const isFlag = (arg: string): boolean => arg.startsWith('--');

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (!isFlag(arg)) {
      positionals.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf('=');
    if (eqIndex > -1) {
      const key = arg.slice(2, eqIndex);
      const value = arg.slice(eqIndex + 1);
      flags[camel(key)] = value;
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !isFlag(next)) {
      flags[camel(key)] = next;
      i++;
    } else {
      flags[camel(key)] = true;
    }
  }

  return { command: positionals[0] ?? '', flags, positionals: positionals.slice(1) };
}

function camel(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function getFlag(
  flags: Record<string, string | boolean>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = flags[camel(name)];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export function hasFlag(
  flags: Record<string, string | boolean>,
  ...names: string[]
): boolean {
  return names.some((name) => {
    const value = flags[camel(name)];
    return value === true || typeof value === 'string';
  });
}
