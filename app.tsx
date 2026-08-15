// bb-plugin-global-workflows — frontend.
//
// One surface: a thread-header action that opens the global catalog and
// dispatches a workflow into the thread you are already looking at.
//
// It dispatches into the CURRENT thread rather than spawning a worker, because
// the builtin runner renders its live progress card in the thread that called
// `bb_workflow_run`. Spawning a launcher would put the progress somewhere the
// user is not.
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Derive from the shared contract so the panel cannot drift from the backend.
// `rpc.call` returns the union of every method's output, which is why the
// result needs a concrete type here rather than inference.
type Catalog = z.infer<typeof rpcContract.list.output>;
type Workflow = Catalog["workflows"][number];

function WorkflowsPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [argsJson, setArgsJson] = useState("{}");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    rpc
      .call("list")
      .then((result) => { if (live) setCatalog(result as Catalog); })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { live = false; };
  }, [rpc]);

  const dispatch = useCallback(
    (name: string) => {
      setBusy(true);
      setStatus(null);
      rpc
        .call("run", { threadId, name, argsJson })
        .then((result) => {
          setStatus(result.ok ? `Dispatched ${result.name}.` : `Refused: ${result.detail}`);
        })
        .catch((cause: unknown) => {
          setStatus(`Failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        })
        .finally(() => setBusy(false));
    },
    [rpc, threadId, argsJson],
  );

  if (error !== null) {
    return <p className="text-sm text-destructive">Could not read the catalog: {error}</p>;
  }
  if (catalog === null) {
    return <p className="text-sm text-muted-foreground">Reading catalog…</p>;
  }
  if (!catalog.exists) {
    return (
      <p className="text-sm text-muted-foreground">
        No catalog directory at <code>{catalog.catalogDir}</code>. Create it and add{" "}
        <code>*.js</code> workflow scripts, or point <code>catalogDir</code> elsewhere in settings.
      </p>
    );
  }
  if (catalog.workflows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No <code>*.js</code> workflows in <code>{catalog.catalogDir}</code>.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {catalog.catalogDir} · available in every project
      </p>
      {catalog.workflows.map((workflow: Workflow) => (
        <Card key={workflow.name}>
          <CardHeader>
            <CardTitle className="text-sm">{workflow.name}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <span className="text-muted-foreground">{workflow.description}</span>
            {workflow.phases.length > 0 && (
              <span className="text-xs text-muted-foreground">
                Phases: {workflow.phases.join(" → ")}
              </span>
            )}
            {workflow.problem !== null ? (
              // Listed rather than hidden: a workflow that silently vanishes
              // from the panel is the failure mode this plugin exists to end.
              <span className="text-xs text-destructive">{workflow.problem}</span>
            ) : selected === workflow.name ? (
              <div className="flex flex-col gap-2">
                <textarea
                  className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
                  rows={3}
                  value={argsJson}
                  spellCheck={false}
                  onChange={(event) => setArgsJson(event.target.value)}
                  aria-label={`args for ${workflow.name}`}
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => dispatch(workflow.name)}>
                    {busy ? "Dispatching…" : "Run in this thread"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setSelected(workflow.name); setStatus(null); }}
                >
                  Run…
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      {status !== null && <p className="text-sm text-muted-foreground">{status}</p>}
    </div>
  );
}

/**
 * The visible affordance.
 *
 * `threadPanelAction` alone only adds a row to the side panel's new-tab
 * launcher, which is several clicks deep and easy to miss entirely. The header
 * slot is what puts a control on screen; it opens the same panel component, so
 * there is one implementation and two ways in.
 */
function WorkflowsHeaderButton({ isCompactViewport }: { isCompactViewport: boolean }) {
  const navigate = useBbNavigate();
  return (
    <Button
      size="sm"
      variant="ghost"
      // Icon-only on a phone-width header, but the accessible name stays put:
      // the slot's `title` labels the host's wrapper group, never this control.
      aria-label="Global workflows"
      onClick={() =>
        navigate.openThreadPanel({ actionId: "global-workflows", title: "Global workflows" })
      }
    >
      {isCompactViewport ? "⚙" : "Workflows"}
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "global-workflows",
    title: "Global workflows",
    icon: "Workflow",
    component: WorkflowsPanel,
    // `run` omitted: the documented default is to open a panel tab with
    // defaults, which is exactly the behavior wanted, and one fewer thing that
    // can silently return false.
  });
  app.slots.experimental_threadHeaderAction({
    id: "global-workflows-header",
    title: "Global workflows",
    component: WorkflowsHeaderButton,
  });
});
