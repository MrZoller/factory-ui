import {
  fetchPeerFleet,
  MAX_CONCURRENT_PEER_FETCHES,
  providerCategory,
  readFleetResponse,
} from "/app.js";

export const PIPELINE = [
  { id: "spec", label: "Spec", detail: "Define the outcome and boundaries" },
  { id: "plan", label: "Plan", detail: "Decompose approved work" },
  { id: "build", label: "Build", detail: "Implement and verify one task" },
  { id: "ship", label: "Ship", detail: "Review and open a pull request" },
  { id: "shepherd", label: "Shepherd", detail: "Converge CI and bot review" },
  { id: "merge", label: "Merge", detail: "Squash, record, and continue" },
];

export const ROLES = [
  { id: "architect", label: "architect", phase: "spec" },
  { id: "mapper", label: "mapper", phase: "spec" },
  { id: "small_model", label: "small_model", phase: "plan" },
  { id: "driver", label: "driver", phase: "build" },
  { id: "test-engineer", label: "test-engineer", phase: "build" },
  { id: "reviewer", label: "reviewer", phase: "ship" },
  { id: "verifier", label: "verifier", phase: "ship" },
  { id: "docsmith", label: "docsmith", phase: "ship" },
  { id: "shepherd", label: "shepherd", phase: "shepherd" },
];

const GATES = new Map([
  ["spec", "Spec approval"],
  ["plan", "Plan approval"],
]);
const hashHandlers = new WeakMap();

function element(documentRoot, tag, text, className) {
  const node = documentRoot.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function availableData(result) {
  return result?.status === "available" ? result.data : undefined;
}

function routingFor(fleet) {
  return fleet?.repositories
    ?.map((repository) => availableData(repository.routing))
    .find(Boolean);
}

function splitModel(value) {
  if (typeof value !== "string") return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return {
    provider: value.slice(0, slash),
    model: value.slice(slash + 1),
    steps: null,
  };
}

function roleRoute(routing, role) {
  if (!routing) return undefined;
  if (role.id === "driver") return splitModel(routing.model);
  if (role.id === "small_model") return splitModel(routing.smallModel);
  return routing.agents?.[role.id];
}

function modelUsage(fleet, modelId) {
  if (!modelId || !Array.isArray(fleet?.repositories)) return undefined;
  let total = 0;
  let tokens = 0;
  let found = false;
  for (const repository of fleet.repositories) {
    const costs = availableData(repository.costs);
    if (!costs || costs.currency !== "USD") return undefined;
    for (const task of Object.values(costs.tasks ?? {})) {
      const counters = task?.byModel?.[modelId];
      const usd = counters?.usd;
      if (usd !== undefined) {
        if (!Number.isFinite(usd) || usd < 0) return undefined;
        found = true;
        total += usd;
        if (!Number.isFinite(total)) return undefined;
        for (const value of Object.values(counters.tokens ?? {})) {
          if (!Number.isFinite(value) || value < 0) return undefined;
          tokens += value;
          if (!Number.isFinite(tokens)) return undefined;
        }
      }
    }
  }
  return found ? { usd: total, tokens } : undefined;
}

function renderRole(documentRoot, role, routing, fleet) {
  const item = element(documentRoot, "li", undefined, "agent-node");
  item.dataset.role = role.id;
  item.append(element(documentRoot, "h4", role.label));
  const route = roleRoute(routing, role);
  if (!route) {
    item.append(element(documentRoot, "p", "Unavailable", "unavailable"));
    return item;
  }
  const routeLine = element(documentRoot, "p", undefined, "agent-route");
  routeLine.append(
    element(
      documentRoot,
      "span",
      route.provider,
      `routing-provider provider-${providerCategory(route.provider)}`,
    ),
    element(documentRoot, "span", `/${route.model}`, "routing-model"),
  );
  item.append(routeLine);
  if (route.steps !== null && route.steps !== undefined) {
    item.append(
      element(documentRoot, "p", `steps ≤ ${route.steps}`, "routing-steps"),
    );
  }
  const usage = modelUsage(fleet, `${route.provider}/${route.model}`);
  if (usage !== undefined) {
    item.append(
      element(
        documentRoot,
        "p",
        usage.usd === 0 && usage.tokens > 0
          ? "sub"
          : `$${usage.usd.toFixed(2)} metered`,
        "agent-cost",
      ),
    );
  }
  return item;
}

function renderPipeline(documentRoot, fleet) {
  const routing = routingFor(fleet);
  const diagram = element(documentRoot, "div", undefined, "pipeline-diagram");
  for (const [index, phase] of PIPELINE.entries()) {
    const stage = element(documentRoot, "section", undefined, "pipeline-stage");
    stage.dataset.phase = phase.id;
    stage.append(
      element(
        documentRoot,
        "p",
        String(index + 1).padStart(2, "0"),
        "stage-number",
      ),
      element(documentRoot, "h3", phase.label),
      element(documentRoot, "p", phase.detail, "stage-detail"),
    );
    const roles = element(documentRoot, "ul", undefined, "agent-nodes");
    for (const role of ROLES.filter(
      (candidate) => candidate.phase === phase.id,
    )) {
      roles.append(renderRole(documentRoot, role, routing, fleet));
    }
    stage.append(roles);
    if (GATES.has(phase.id)) {
      stage.append(
        element(documentRoot, "p", GATES.get(phase.id), "approval-gate"),
      );
    }
    if (phase.id === "ship") {
      const hold = element(documentRoot, "aside", undefined, "hold-branch");
      hold.append(
        element(documentRoot, "strong", "Major / hold"),
        element(documentRoot, "span", "Human merge authority"),
      );
      stage.append(hold);
    }
    diagram.append(stage);
  }
  return diagram;
}

function selectedMachine(windowRoot, machines) {
  const requested = new URLSearchParams(
    windowRoot?.location?.hash.slice(1) ?? "",
  ).get("machine");
  const index = machines.findIndex((machine) => machine.identity === requested);
  return index < 0 ? 0 : index;
}

function setMachineHash(windowRoot, identity) {
  const params = new URLSearchParams();
  params.set("machine", identity);
  const hash = `#${params.toString()}`;
  if (windowRoot.location.hash !== hash)
    windowRoot.history.replaceState(null, "", hash);
}

export function renderHow(machines, documentRoot = document) {
  const tabsRoot = documentRoot.querySelector("#how-machine-tabs");
  const panelsRoot = documentRoot.querySelector("#how-machines");
  if (!tabsRoot || !panelsRoot || machines.length === 0) return;
  const selectedIndex = selectedMachine(documentRoot.defaultView, machines);
  const selectedDiagram = panelsRoot.querySelector(
    ".how-machine-panel:not([hidden]) .pipeline-diagram",
  );
  const diagramScrollLeft = selectedDiagram?.scrollLeft ?? 0;
  const restoreTabFocus = tabsRoot.contains(documentRoot.activeElement);
  const views = machines.map((machine, index) => {
    const tab = element(
      documentRoot,
      "button",
      machine.identity,
      "machine-tab",
    );
    const panel = element(
      documentRoot,
      "section",
      undefined,
      "how-machine-panel",
    );
    const tabId = `how-machine-tab-${index}`;
    const panelId = `how-machine-panel-${index}`;
    tab.type = "button";
    tab.id = tabId;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", panelId);
    panel.id = panelId;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tabId);
    panel.append(
      element(documentRoot, "h2", machine.identity),
      machine.fleet
        ? renderPipeline(documentRoot, machine.fleet)
        : element(
            documentRoot,
            "p",
            "Unavailable",
            "unavailable how-unavailable",
          ),
    );
    return { ...machine, tab, panel };
  });
  const select = (index, updateHash = true) => {
    views.forEach((view, viewIndex) => {
      const active = index === viewIndex;
      view.tab.setAttribute("aria-selected", String(active));
      view.tab.tabIndex = active ? 0 : -1;
      view.panel.hidden = !active;
    });
    if (updateHash)
      setMachineHash(documentRoot.defaultView, views[index].identity);
  };
  views.forEach((view, index) => {
    view.tab.addEventListener("click", () => select(index));
    view.tab.addEventListener("keydown", (event) => {
      let target = index;
      if (event.key === "ArrowRight" || event.key === "ArrowDown")
        target = (index + 1) % views.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
        target = (index - 1 + views.length) % views.length;
      else if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      select(target);
      views[target].tab.focus();
    });
  });
  tabsRoot.replaceChildren(...views.map((view) => view.tab));
  panelsRoot.replaceChildren(...views.map((view) => view.panel));
  select(selectedIndex);
  const nextDiagram =
    views[selectedIndex]?.panel.querySelector(".pipeline-diagram");
  if (nextDiagram) nextDiagram.scrollLeft = diagramScrollLeft;
  if (restoreTabFocus) views[selectedIndex]?.tab.focus();
  const windowRoot = documentRoot.defaultView;
  const previousHandler = hashHandlers.get(documentRoot);
  if (previousHandler)
    windowRoot?.removeEventListener("hashchange", previousHandler);
  const hashHandler = () => select(selectedMachine(windowRoot, views), false);
  windowRoot?.addEventListener("hashchange", hashHandler);
  hashHandlers.set(documentRoot, hashHandler);
}

export async function loadHow(
  documentRoot = document,
  fetcher = fetch,
  dependencies = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  },
) {
  const error = documentRoot.querySelector("#how-error");
  try {
    const local = await readFleetResponse(await fetcher("/api/fleet"));
    const machines = [
      { identity: local.hostname, fleet: local },
      ...local.peers.map((peer) => ({ identity: peer.name, fleet: null })),
    ];
    renderHow(machines, documentRoot);
    let next = 0;
    async function worker() {
      while (next < local.peers.length) {
        const index = next++;
        try {
          machines[index + 1].fleet = await fetchPeerFleet(
            local.peers[index],
            fetcher,
            dependencies,
          );
        } catch {
          machines[index + 1].fleet = null;
        }
        renderHow(machines, documentRoot);
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_PEER_FETCHES, local.peers.length) },
        worker,
      ),
    );
    if (error) error.textContent = "";
    return true;
  } catch (cause) {
    if (error)
      error.textContent =
        cause instanceof Error ? cause.message : "Request failed";
    return false;
  }
}

if (
  typeof window !== "undefined" &&
  window.document?.querySelector("#how-machines")
) {
  void loadHow();
}
