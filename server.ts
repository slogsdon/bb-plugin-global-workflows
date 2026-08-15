// bb-plugin-global-workflows — run bb workflows from anywhere, not just the
// repo that happens to hold the script.
//
// Why this plugin exists
// ----------------------
// bb's builtin workflows plugin resolves a workflow against the *thread's
// environment*: `resolveWorkflowSource` throws when
// `environment.projectId !== context.projectId`, and a named workflow is read
// from `<environment.path>/.bb/workflows/<name>.js`. That makes every workflow
// project-scoped, and worse, environment-scoped: an isolated worktree only
// checks out tracked files, so an uncommitted workflow silently does not exist.
//
// There is exactly one seam. `resolveWorkflowSource` returns early for
// `mode.kind === "script"`, BEFORE the environment lookup and before the
// projectId equality check. A workflow passed as script text therefore runs in
// any project. Verified: a probe workflow held only in this catalog ran from a
// leadsurface thread and returned its result.
//
// So this plugin owns the catalog and the resolution; the builtin runner still
// owns execution. There is no `bb.sdk.workflows` API — the plugin SDK cannot
// start a run — so the one supported path to the runner is a thread that has
// the `bb_workflow_run` agent tool. We reach it with `threads.send`.
//
// The builtin `workflows` plugin is therefore a hard runtime requirement that
// bb has no way to declare: there is no plugin dependency mechanism in the SDK.
// We degrade with needsConfiguration rather than throwing.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const workflowSummary = z.object({
  name: z.string(),
  file: z.string(),
  description: z.string(),
  phases: z.array(z.string()),
  /** Set when the file could not be parsed; the row still lists so a broken
   *  workflow is visible rather than silently missing. */
  problem: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  list: {
    input: z.null(),
    output: z.object({
      catalogDir: z.string(),
      exists: z.boolean(),
      workflows: z.array(workflowSummary),
    }),
  },
  run: {
    input: z.object({
      threadId: z.string().min(1),
      name: z.string().min(1),
      /** Free-form; the workflow's own inputSchema is what actually validates
       *  it, inside the runner. Sent as written. */
      argsJson: z.string(),
    }),
    output: z.object({ ok: z.boolean(), name: z.string(), detail: z.string() }),
  },
});

/** Same constraint the builtin runner enforces in `workflowNamePath`. Checked
 *  here too so a bad name fails in the UI instead of mid-run. */
const WORKFLOW_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The runner's own allow-list, from `server.js` in the builtin workflows
 * plugin: meta is validated key by key and an unknown one throws
 * `Unknown meta field "..."` BEFORE the script body runs.
 *
 * This is worth checking here because the failure is invisible until dispatch,
 * and the error names the field without saying which file it came from. The
 * Claude Code Workflow tool accepts a `whenToUse` key; bb's runner does not,
 * which is exactly the kind of near-miss that costs a run to discover.
 */
const META_FIELDS = new Set(["name", "description", "inputSchema", "outputSchema", "phases"]);

/**
 * Top-level keys of the `export const meta = {...}` literal, by brace depth.
 *
 * String literals must be skipped, not just brace-counted: a description like
 * "cross-vendor merge gate: no diff merges…" contains `gate:` and reads as a
 * key to any scanner that walks raw characters, which reported unsupported
 * fields on two perfectly valid workflows.
 */
function metaKeys(source: string): string[] {
  const start = source.indexOf("export const meta");
  if (start === -1) return [];
  const open = source.indexOf("{", start);
  if (open === -1) return [];
  const keys: string[] = [];
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      // Walk to the matching close, honouring backslash escapes.
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === char) break;
      }
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && /[A-Za-z_$]/.test(char)) {
      const match = source.slice(index).match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (match !== null) {
        keys.push(match[1]);
        index += match[0].length - 1;
      }
    }
  }
  return keys;
}

/**
 * Pull `name`, `description`, and phase titles out of a workflow's `meta` block
 * without executing it.
 *
 * `meta` is a JS object literal, not JSON, so it cannot simply be parsed — and
 * evaluating a file to list it would run arbitrary code every time the panel
 * opens. Reading the strings is enough for a catalog row, and a file this fails
 * on still lists, carrying its parse problem.
 */
function readMeta(source: string): {
  name: string | null;
  description: string;
  phases: string[];
} {
  const field = (key: string): string | null => {
    const match = source.match(
      new RegExp(`\\b${key}\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`),
    );
    if (match === null) return null;
    const raw = match[1] ?? match[2] ?? "";
    return raw.replace(/\\(["'\\])/g, "$1").replace(/\\n/g, " ").trim();
  };
  const phases: string[] = [];
  for (const match of source.matchAll(/\btitle\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    phases.push(match[1].replace(/\\(["'\\])/g, "$1"));
  }
  return { name: field("name"), description: field("description") ?? "", phases };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    catalogDir: {
      type: "string",
      label: "Catalog directory",
      description:
        "Directory of *.js workflow scripts available in every project. Empty uses <dataDir>/plugins/global-workflows/workflows.",
      default: "",
    },
  });

  /** Resolve once per call rather than caching: the setting is editable and
   *  settings edits never auto-reload the plugin. */
  async function catalogDir(): Promise<string> {
    const { catalogDir: configured } = await settings.get();
    if (configured.trim() !== "") return path.resolve(configured.trim());
    const { dataDir } = await bb.sdk.system.config();
    return path.join(dataDir, "plugins", bb.pluginId, "workflows");
  }

  async function readCatalog() {
    const dir = await catalogDir();
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return { catalogDir: dir, exists: false, workflows: [] };
    }
    const workflows = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".js")) continue;
      const base = entry.slice(0, -3);
      const file = path.join(dir, entry);
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch (error) {
        workflows.push({
          name: base, file, description: "", phases: [],
          problem: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const meta = readMeta(source);
      const unknown = metaKeys(source).filter((key) => !META_FIELDS.has(key));
      // The filename is what `run` uses, so a meta.name that disagrees with it
      // is a real trap: the panel would offer one name and run another.
      const problem =
        !WORKFLOW_NAME.test(base)
          ? "filename is not lowercase kebab-case, so the runner would reject this name"
          : !source.includes("export const meta")
            ? "no `export const meta` block; the runner requires it as the first statement"
            : meta.name !== null && meta.name !== base
              ? `meta.name is "${meta.name}" but the file is "${base}.js" — rename one to match`
              : unknown.length > 0
                ? `meta has unsupported field(s) ${unknown.map((key) => `"${key}"`).join(", ")}; the runner allows only ${[...META_FIELDS].join(", ")}`
                : null;
      workflows.push({
        name: base,
        file,
        description: meta.description,
        phases: meta.phases,
        problem,
      });
    }
    return { catalogDir: dir, exists: true, workflows };
  }

  async function dispatch(input: { threadId: string; name: string; argsJson: string }) {
    const { threadId, name, argsJson } = input;
    {
      if (!WORKFLOW_NAME.test(name)) {
        return { ok: false, name, detail: "name must be lowercase kebab-case, max 64 chars" };
      }
      const dir = await catalogDir();
      const file = path.join(dir, `${name}.js`);
      // Confinement: a name is not a path, but resolve-and-check costs nothing
      // and stops a catalogDir setting with a traversal in it from mattering.
      if (path.dirname(path.resolve(file)) !== path.resolve(dir)) {
        return { ok: false, name, detail: "resolved outside the catalog directory" };
      }
      try {
        await stat(file);
      } catch {
        return { ok: false, name, detail: `no such workflow in ${dir}` };
      }

      // Refuse a workflow the catalog already knows is broken. Without this the
      // check is only advisory: the runner rejects the meta after the thread has
      // taken a turn, so the cost is paid before the error is seen.
      const known = (await readCatalog()).workflows.find((entry) => entry.name === name);
      if (known?.problem != null) {
        return { ok: false, name, detail: known.problem };
      }

      let args: unknown = {};
      const trimmed = argsJson.trim();
      if (trimmed !== "") {
        try {
          args = JSON.parse(trimmed);
        } catch (error) {
          return {
            ok: false, name,
            detail: `args must be JSON: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      // Hand the runner a file path rather than the script text inlined into a
      // prompt. Inlining makes the agent retype the whole script, which is a
      // truncation risk that grows with the workflow; reading a path is exact.
      // This does assume the thread's host can see the catalog directory.
      const instruction = [
        `Call the bb_workflow_run tool exactly once.`,
        `Read ${file} and pass its full contents as the \`script\` parameter (not \`name\` — this workflow lives outside the project).`,
        `Pass this as \`args\`: ${JSON.stringify(args)}`,
        `Then emit the returned previewDirective on its own line so progress renders, and stop. Do not edit anything.`,
      ].join("\n");

      // "auto" starts a turn on an idle thread and queues/steers a running one,
      // so clicking Run mid-turn queues rather than failing.
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text: instruction, visibility: "agent-only", mentions: [] }],
      });
      return { ok: true, name, detail: `dispatched to ${threadId}` };
    }
  }

  bb.rpc.register(rpcContract, {
    list: () => readCatalog(),
    run: (input) => dispatch(input),
  });

  // A CLI surface as well as the panel, so the catalog is reachable from a
  // thread, a terminal, or an agent — and so the dispatch path can be exercised
  // without driving the UI.
  bb.cli.register({
    name: "global-workflows",
    summary: "List and run workflows available in every project",
    commands: [
      { name: "list", summary: "List catalog workflows", usage: "bb global-workflows list [--json]" },
      {
        name: "run",
        summary: "Dispatch a workflow into a thread",
        usage: "bb global-workflows run <name> [--thread <id>] [--args <json>]",
      },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      const flag = (key: string): string | undefined => {
        const at = rest.indexOf(`--${key}`);
        return at === -1 ? undefined : rest[at + 1];
      };

      if (command === "list") {
        const catalog = await readCatalog();
        if (rest.includes("--json")) {
          return { exitCode: 0, stdout: JSON.stringify(catalog, null, 1) };
        }
        if (!catalog.exists) {
          return { exitCode: 1, stderr: `no catalog directory at ${catalog.catalogDir}\n` };
        }
        const lines = catalog.workflows.map((workflow) =>
          `${workflow.name.padEnd(24)} ${workflow.problem ?? workflow.description}`,
        );
        return {
          exitCode: 0,
          stdout: `${catalog.catalogDir}\n\n${lines.join("\n") || "(empty)"}\n`,
        };
      }

      if (command === "run") {
        const name = rest[0];
        if (name === undefined || name.startsWith("--")) {
          return { exitCode: 1, stderr: "usage: bb global-workflows run <name> [--thread <id>] [--args <json>]\n" };
        }
        const threadId = flag("thread") ?? ctx.threadId;
        if (threadId === undefined) {
          return {
            exitCode: 1,
            stderr: "no thread: run this inside a thread or pass --thread <id>\n",
          };
        }
        const result = await dispatch({ threadId, name, argsJson: flag("args") ?? "{}" });
        return result.ok
          ? { exitCode: 0, stdout: `${result.name}: ${result.detail}\n` }
          : { exitCode: 1, stderr: `${result.name}: ${result.detail}\n` };
      }

      return { exitCode: 1, stderr: `unknown command ${command ?? "(none)"}; try list or run\n` };
    },
  });

  const catalog = await readCatalog();
  if (!catalog.exists) {
    bb.status.needsConfiguration(
      `Catalog directory not found: ${catalog.catalogDir}. Create it and add *.js workflow scripts, or set catalogDir.`,
    );
  }
  bb.log.info(
    catalog.exists
      ? `catalog ${catalog.catalogDir}: ${catalog.workflows.length} workflow(s)`
      : `catalog ${catalog.catalogDir}: missing`,
  );

  bb.onDispose(() => bb.log.info("disposed"));
}
