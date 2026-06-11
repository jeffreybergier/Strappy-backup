import { password } from "@inquirer/prompts";
import { importFromGh, resolveToken, saveToken } from "../auth.js";
import { makeOctokit, whoami } from "../github.js";
import { getPaths } from "../paths.js";

export interface AuthOptions {
  token?: string;
  fromGh?: boolean;
}

export async function authCommand(opts: AuthOptions): Promise<void> {
  const paths = getPaths();

  let token = opts.token?.trim();

  if (!token && opts.fromGh) {
    const gh = await importFromGh();
    if (!gh) throw new Error("Could not read a token from `gh auth token` (is the GitHub CLI logged in?).");
    token = gh;
    console.log("Imported token from the GitHub CLI.");
  }

  if (!token) {
    token = (
      await password({
        message: "Paste a GitHub token (fine-grained PAT, read-only Contents+Metadata):",
        mask: "*",
      })
    ).trim();
  }

  if (!token) throw new Error("No token provided.");

  // Validate before persisting so we never store a dead token.
  const login = await whoami(makeOctokit(token));
  await saveToken(paths, token);
  console.log(`✓ Token validated as @${login} and saved to ${paths.tokenFile} (chmod 600).`);
}

/** `strappy auth --check`: report what token (if any) strappy would use. */
export async function authCheck(): Promise<void> {
  const paths = getPaths();
  const resolved = await resolveToken(paths);
  if (!resolved) {
    console.log("No token found. Set STRAPPY_GITHUB_TOKEN, or run `strappy auth`.");
    return;
  }
  try {
    const login = await whoami(makeOctokit(resolved.token));
    console.log(`✓ Using token from ${resolved.source}; authenticates as @${login}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`✗ Token from ${resolved.source} did not authenticate: ${message}`);
  }
}
