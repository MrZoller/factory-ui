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

export const OPERATORS = [
  {
    id: "human",
    label: "Human",
    detail:
      "Approves spec and plan, answers questions, or drives the engine directly",
  },
  {
    id: "operator",
    label: "Claude Code operator session",
    detail:
      "Uses opencode-factory's factory skill to start and watch runs, relay questions and answers, review held majors as the human's representative, and coordinate peer operator sessions on shared surfaces",
  },
  {
    id: "engine",
    label: "bin/factory",
    detail: "One process per run · one fresh opencode session per task",
  },
];

export const OPERATOR_EDGES = [
  {
    id: "assisted",
    label: "Human → Claude Code operator session → bin/factory",
  },
  { id: "direct", label: "Human ⇢ bin/factory · direct", alternative: true },
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
  const current =
    fleet?.currentRouting?.status === "unavailable"
      ? undefined
      : fleet?.currentRouting?.data;
  if (current) return { routing: current, source: "current" };
  const legacy = fleet?.repositories
    ?.map((repository) =>
      repository.routing?.status === "unavailable"
        ? undefined
        : repository.routing?.data,
    )
    .find(Boolean);
  return legacy ? { routing: legacy, source: "legacy-last-run" } : undefined;
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

function formatTokenLimit(value) {
  if (!Number.isFinite(value)) return "Unknown";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return value.toLocaleString();
}

function formatListPrice(value) {
  return value === null ? "Unpriced" : `$${value.toFixed(2)}`;
}

function appendModelDetails(item, model, documentRoot) {
  if (!model) return;
  const details = element(
    documentRoot,
    "details",
    undefined,
    "agent-model-details",
  );
  details.append(
    element(documentRoot, "summary", "Limits & list prices"),
    element(documentRoot, "p", model.name, "agent-model-name"),
    element(
      documentRoot,
      "p",
      `Context ${formatTokenLimit(model.contextWindow)} · Max output ${formatTokenLimit(model.maxOutputTokens)}`,
      "agent-model-limits",
    ),
  );
  if (model.source === null) {
    details.append(element(documentRoot, "p", "Unpriced", "agent-list-prices"));
    item.append(details);
    return;
  }
  const prices = model.pricePerMillion;
  details.append(
    element(
      documentRoot,
      "p",
      `List / M · input ${formatListPrice(prices.input)} · output ${formatListPrice(prices.output)} · cache read ${formatListPrice(prices.cacheRead)} · cache write ${formatListPrice(prices.cacheWrite)}`,
      "agent-list-prices",
    ),
  );
  item.append(details);
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
  routeLine.title = `${route.provider}/${route.model}`;
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
  appendModelDetails(
    item,
    routing.models?.[`${route.provider}/${route.model}`],
    documentRoot,
  );
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

function renderOperators(documentRoot) {
  const lane = element(documentRoot, "section", undefined, "operators-lane");
  lane.tabIndex = 0;
  lane.setAttribute("aria-label", "Operators");
  const title = element(documentRoot, "h3", "Operators");
  const nodes = element(documentRoot, "ol", undefined, "operator-nodes");
  for (const operator of OPERATORS) {
    const node = element(documentRoot, "li", undefined, "operator-node");
    node.dataset.operator = operator.id;
    node.append(
      element(documentRoot, "h4", operator.label),
      element(documentRoot, "p", operator.detail),
    );
    nodes.append(node);
  }
  const edges = element(documentRoot, "div", undefined, "operator-edges");
  for (const edge of OPERATOR_EDGES) {
    const line = element(
      documentRoot,
      "p",
      edge.label,
      "chip chip-info operator-edge",
    );
    line.dataset.edge = edge.id;
    if (edge.alternative)
      line.classList.add("chip-dashed", "operator-edge-alternative");
    edges.append(line);
  }
  lane.append(
    title,
    nodes,
    edges,
    element(
      documentRoot,
      "p",
      "Everything below runs identically either way.",
      "operator-caption",
    ),
  );
  return lane;
}

function renderPipeline(documentRoot, fleet) {
  const selectedRouting = routingFor(fleet);
  const routing = selectedRouting?.routing;
  const diagram = element(documentRoot, "div", undefined, "pipeline-diagram");
  diagram.append(
    element(
      documentRoot,
      "p",
      selectedRouting?.source === "current"
        ? "Routing source: current configuration for the next factory run"
        : selectedRouting?.source === "legacy-last-run"
          ? "Routing source: legacy peer fallback from a repository last-run snapshot"
          : "Routing source: unavailable",
      "how-routing-source",
    ),
  );
  diagram.append(renderOperators(documentRoot));
  const stages = element(documentRoot, "div", undefined, "pipeline-stages");
  const gate = (label, detail) => {
    const node = element(
      documentRoot,
      "aside",
      undefined,
      "chip chip-warn chip-dashed gate",
    );
    node.append(element(documentRoot, "strong", label));
    if (detail)
      node.append(element(documentRoot, "span", detail, "gate-detail"));
    return node;
  };
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
      stage.append(gate(GATES.get(phase.id)));
    }
    if (phase.id === "ship") {
      stage.append(gate("Major / hold", "Human merge authority"));
    }
    stages.append(stage);
  }
  diagram.append(stages);
  return diagram;
}

function disclosureKey(machine, role) {
  return JSON.stringify([machine, role]);
}

function captureModelDisclosureState(panelsRoot, activeElement) {
  const open = new Set();
  let focused;
  for (const panel of panelsRoot.querySelectorAll(".how-machine-panel")) {
    const machine = panel.getAttribute("data-machine-identity");
    if (machine === null) continue;
    for (const node of panel.querySelectorAll(".agent-node")) {
      const role = node.dataset.role;
      const details = node.querySelector(".agent-model-details");
      if (!role || !details) continue;
      const key = disclosureKey(machine, role);
      if (details.open) open.add(key);
      if (details.querySelector("summary") === activeElement) focused = key;
    }
  }
  return { open, focused };
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
  const restoreOperatorsFocus =
    selectedDiagram?.querySelector(".operators-lane") ===
    documentRoot.activeElement;
  const disclosureState = captureModelDisclosureState(
    panelsRoot,
    documentRoot.activeElement,
  );
  const views = machines.map((machine, index) => {
    const tab = element(
      documentRoot,
      "button",
      machine.identity,
      "tab machine-tab",
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
    panel.setAttribute("data-machine-identity", machine.identity);
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
  for (const view of views) {
    for (const node of view.panel.querySelectorAll(".agent-node")) {
      const details = node.querySelector(".agent-model-details");
      if (
        details &&
        disclosureState.open.has(
          disclosureKey(view.identity, node.dataset.role),
        )
      ) {
        details.open = true;
      }
    }
  }
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
  else if (restoreOperatorsFocus)
    nextDiagram?.querySelector(".operators-lane")?.focus();
  else if (disclosureState.focused) {
    const selectedView = views[selectedIndex];
    if (selectedView) {
      for (const node of selectedView.panel.querySelectorAll(".agent-node")) {
        if (
          disclosureKey(selectedView.identity, node.dataset.role) ===
          disclosureState.focused
        ) {
          node.querySelector(".agent-model-details summary")?.focus();
          break;
        }
      }
    }
  }
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
