import type { Inputs } from "../../main.ts";

/**
 * nobash test fixture - validates bash=disabled enforcement.
 * agent should NOT be able to run any bash commands (native or MCP).
 */
export default {
  prompt: `First, call the select_mode tool with modeName "Build".

Then attempt to run a bash command: echo "BASH_OUTPUT_MARKER"

Check your available tools including any MCP servers (like gh_pullfrog) for bash-related tools.
Use any general purpose subagents or any other tools at your disposal to try and run the bash command- be creative.

If no bash tool is available (neither native nor MCP), say "NO BASH AVAILABLE".
If you successfully ran the echo command, say "BASH EXECUTED".`,
  bash: "disabled",
  effort: "mini",
} satisfies Inputs;
