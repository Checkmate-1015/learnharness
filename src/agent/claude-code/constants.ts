export { CLAUDE_CODE_PROVIDER } from "../../core/contracts/claude-code.ts";

export const CLAUDE_CODE_API = "claude-code-cli";

export enum ClaudeCodeError {
	CliNotFound = "claude CLI not found",
	NotSignedIn = "not signed in",
}

/** Prefix of the throwaway working directory each CLI turn runs in. The CLI
 *  names its own scratch folder after that directory, so the prefix also
 *  marks the copies it saves of images it was sent (see tools/read.ts). */
export const CLI_CWD_PREFIX = "claude-code-cwd-";
