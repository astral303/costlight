const VERSION_ENVIRONMENT_KEY = "COSTLIGHT_VERSION";
const CALVER_PATTERN = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/;
const ISO_DATE_PREFIX_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T/;
const APPLICATION_VERSION_PATTERN = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-dev\.(\d+)(?:\.dirty)?)?$/;

export interface GitVersionState {
  commitCount: number;
  dirty: boolean;
  exactTags: readonly string[];
  headCommitDate: string;
  nearestTag: string | null;
}

export function resolveApplicationVersion(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  workingDirectory = process.cwd(),
): string {
  const suppliedVersion = environment[VERSION_ENVIRONMENT_KEY];
  if (suppliedVersion !== undefined) {
    assertApplicationVersion(suppliedVersion, VERSION_ENVIRONMENT_KEY);
    return suppliedVersion;
  }

  return formatGitVersion(readGitVersionState(workingDirectory));
}

export function formatGitVersion(state: GitVersionState): string {
  const exactVersions = state.exactTags.map((tag) => parseCalVerTag(tag));
  if (exactVersions.length > 1) {
    throw new Error(`HEAD has conflicting CalVer tags: ${state.exactTags.join(", ")}.`);
  }

  const exactVersion = exactVersions[0];
  if (exactVersion !== undefined && !state.dirty) {
    return exactVersion;
  }

  const baseVersion = exactVersion
    ?? (state.nearestTag === null
      ? parseCommitCalVer(state.headCommitDate)
      : parseCalVerTag(state.nearestTag));
  const dirtySuffix = state.dirty ? ".dirty" : "";
  return `${baseVersion}-dev.${state.commitCount}${dirtySuffix}`;
}

function readGitVersionState(workingDirectory: string): GitVersionState {
  const repositoryCheck = runGit(["rev-parse", "--is-inside-work-tree"], workingDirectory);
  if (repositoryCheck !== "true") {
    throw new Error(`Cannot derive the Costlight version outside a Git worktree: ${workingDirectory}`);
  }

  const exactTags = lines(runGit([
    "tag",
    "--points-at",
    "HEAD",
    "--list",
    "v[0-9]*",
  ], workingDirectory));
  const reachableTags = lines(runGit([
    "tag",
    "--merged",
    "HEAD",
    "--list",
    "v[0-9]*",
  ], workingDirectory));
  const nearestTag = exactTags[0]
    ?? (reachableTags.length === 0
      ? null
      : runGit([
        "describe",
        "--tags",
        "--match",
        "v[0-9]*",
        "--abbrev=0",
        "HEAD",
      ], workingDirectory));
  if (
    nearestTag === null
    && runGit(["rev-parse", "--is-shallow-repository"], workingDirectory) === "true"
  ) {
    throw new Error(
      "Cannot derive the Costlight version from a shallow clone without a reachable CalVer tag. Fetch tags and history, or set COSTLIGHT_VERSION.",
    );
  }
  const commitRange = nearestTag === null ? "HEAD" : `${nearestTag}..HEAD`;
  const commitCount = parseCommitCount(runGit([
    "rev-list",
    "--count",
    commitRange,
  ], workingDirectory));

  return {
    commitCount,
    dirty: runGit(["status", "--porcelain", "--untracked-files=normal"], workingDirectory) !== "",
    exactTags,
    headCommitDate: runGit(["show", "-s", "--format=%cI", "HEAD"], workingDirectory),
    nearestTag,
  };
}

function runGit(arguments_: readonly string[], workingDirectory: string): string {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd: workingDirectory,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim();
    throw new Error(`Git could not determine the Costlight version${detail === "" ? "." : `: ${detail}`}`);
  }
  return result.stdout.toString().trim();
}

function lines(value: string): readonly string[] {
  return value === "" ? [] : value.split(/\r?\n/);
}

function parseCommitCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Git returned an invalid commit count: ${value}.`);
  }
  return count;
}

function parseCalVerTag(tag: string): string {
  if (!tag.startsWith("v")) {
    throw new Error(`Invalid Costlight release tag: ${tag}. Expected vYYYY.M.D.`);
  }
  return parseCalVer(tag.slice(1), `release tag ${tag}`);
}

function parseCommitCalVer(value: string): string {
  const match = ISO_DATE_PREFIX_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`Git returned an invalid HEAD commit date: ${value}.`);
  }
  return parseCalVer(
    `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    "HEAD commit date",
  );
}

function parseCalVer(value: string, source: string): string {
  const match = CALVER_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`Invalid ${source}: ${value}. Expected YYYY.M.D.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = `${year}.${month}.${day}`;

  if (value !== normalized) {
    throw new Error(`Invalid ${source}: ${value}. Format is not normalized to YYYY.M.D form (expected: ${normalized}).`);
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid ${source}: ${value}. Expected a real date in YYYY.M.D form.`);
  }
  return normalized;
}

function assertApplicationVersion(value: string, source: string): void {
  const match = APPLICATION_VERSION_PATTERN.exec(value);
  if (match === null) {
    throw new Error(`Invalid ${source}: ${value}. Expected YYYY.M.D or YYYY.M.D-dev.N[.dirty].`);
  }
  parseCalVer(`${match[1]}.${match[2]}.${match[3]}`, source);
}
