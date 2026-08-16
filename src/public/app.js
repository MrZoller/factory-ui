export const PEER_FETCH_TIMEOUT_MS = 5_000;
export const MAX_CONCURRENT_PEER_FETCHES = 4;

const API_SCHEMA_VERSION = 1;
const MAX_FLEET_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_REPOSITORIES = 32;
const MAX_PEERS = 32;
const MAX_ROUTING_AGENTS = 64;
const MAX_AGENT_NAME_LENGTH = 128;
const MAX_ROUTING_STRING_LENGTH = 1024;
const MAX_ROUTING_STEPS = 1_000_000;
const loadGenerations = new WeakMap();
const tabControllers = new WeakMap();
const machineViews = new WeakMap();

function textElement(documentRoot, tag, text, className) {
  const element = documentRoot.createElement(tag);
  if (className) element.className = className;
  element.textContent = String(text ?? "");
  return element;
}

function appendText(parent, tag, text, className) {
  const element = textElement(parent.ownerDocument, tag, text, className);
  parent.append(element);
  return element;
}

function readerData(result) {
  return result && result.status !== "unavailable" ? result.data : undefined;
}

function displayOptional(value) {
  return value === undefined ? "Unknown" : value === null ? "None" : value;
}

function displayBoolean(value, trueText, falseText) {
  return value === undefined ? "Unknown" : value ? trueText : falseText;
}

function displayTime(value) {
  if (typeof value !== "string") return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function displayAge(value, now) {
  if (typeof value !== "string") return "Unknown";
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) return "Unknown";
  const seconds = Math.max(0, Math.floor((now.valueOf() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function displayDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "Unknown";
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function addPanel(card, title, className) {
  const section = card.ownerDocument.createElement("section");
  section.className = `panel ${className}`;
  appendText(section, "h4", title);
  card.append(section);
  return section;
}

function addDefinition(list, term, value) {
  appendText(list, "dt", term);
  appendText(list, "dd", value);
}

function safePullRequestUrl(value) {
  if (
    typeof value !== "string" ||
    !/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/.test(
      value,
    )
  ) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function renderCurrent(card, repository) {
  const panel = addPanel(card, "Current", "current-panel");
  const state = readerData(repository.state);
  const list = panel.ownerDocument.createElement("dl");
  list.className = "facts";
  addDefinition(
    list,
    "Project",
    repository.project ?? state?.project ?? "Unknown",
  );
  addDefinition(list, "Phase", repository.phase ?? state?.phase ?? "Unknown");
  addDefinition(list, "Task", displayOptional(state?.currentTask));
  addDefinition(list, "Branch", displayOptional(state?.branch));

  appendText(list, "dt", "Pull request");
  const prValue =
    state?.pr === undefined
      ? "Unknown"
      : state.pr === null
        ? "None"
        : `PR #${state.pr}`;
  const prUrl = safePullRequestUrl(repository.prUrl);
  const prDefinition = list.ownerDocument.createElement("dd");
  if (prUrl && state?.pr != null) {
    const link = textElement(list.ownerDocument, "a", prValue);
    link.href = prUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    prDefinition.append(link);
  } else {
    prDefinition.textContent = prValue;
  }
  list.append(prDefinition);

  addDefinition(list, "Hold", displayBoolean(state?.hold, "HELD", "No"));
  addDefinition(
    list,
    "Gates",
    `spec ${displayBoolean(state?.specApproved, "approved", "not approved")}; plan ${displayBoolean(state?.planApproved, "approved", "not approved")}`,
  );
  addDefinition(list, "State updated", displayTime(state?.updated));
  panel.append(list);
}

const TASK_GROUPS = [
  ["Active", "active", "active-work"],
  ["In review", "review", "review-work"],
  ["Next runnable", "nextRunnable", "runnable-work"],
  ["Blocked", "blocked", "blocked-work"],
  ["Completed", "completed", "completed-work"],
];

function renderTask(panel, task) {
  const item = panel.ownerDocument.createElement("li");
  item.className = "task";
  appendText(item, "span", task?.id ?? "?", "task-id");
  appendText(item, "span", task?.title ?? "Untitled task", "task-title");
  appendText(item, "span", task?.size ?? "unknown", "task-size");
  if (Array.isArray(task?.dependencies) && task.dependencies.length > 0) {
    appendText(
      item,
      "span",
      `deps: ${task.dependencies.join(", ")}`,
      "task-deps",
    );
  }
  panel.append(item);
}

function renderTasks(card, repository) {
  const plan = readerData(repository.plan);
  for (const [title, key, className] of TASK_GROUPS) {
    const panel = addPanel(card, title, className);
    if (!plan) {
      appendText(panel, "p", "Unavailable", "unavailable");
      continue;
    }
    const tasks = Array.isArray(plan?.[key]) ? plan[key] : [];
    if (tasks.length === 0) {
      appendText(panel, "p", "None", "empty");
      continue;
    }
    const list = panel.ownerDocument.createElement("ul");
    list.className = "task-list";
    tasks.forEach((task) => renderTask(list, task));
    panel.append(list);
  }
}

function renderQuestions(card, repository) {
  const panel = addPanel(card, "Open questions", "questions-panel");
  const open = readerData(repository.questions)?.open;
  if (!open) {
    appendText(panel, "p", "Unavailable", "unavailable");
    return;
  }
  if (!Array.isArray(open) || open.length === 0) {
    appendText(panel, "p", "None", "empty");
    return;
  }
  for (const question of open) {
    const item = panel.ownerDocument.createElement("article");
    item.className = "text-entry question";
    appendText(
      item,
      "h5",
      `${question?.id ?? "?"} · ${question?.taskId ?? "?"}`,
    );
    appendText(
      item,
      "p",
      question?.title ?? "Untitled question",
      "entry-title",
    );
    appendText(item, "pre", question?.text ?? "", "verbatim");
    panel.append(item);
  }
}

function renderWorklog(card, repository) {
  const panel = addPanel(card, "Recent worklog", "worklog-panel");
  const entries = readerData(repository.worklog)?.entries;
  if (entries === undefined) {
    appendText(panel, "p", "Unavailable", "unavailable");
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    appendText(panel, "p", "None", "empty");
    return;
  }
  for (const entry of entries) {
    const item = panel.ownerDocument.createElement("article");
    item.className = "text-entry";
    const date = entry?.date ?? "Unknown date";
    const heading = entry?.time ? `${date} ${entry.time} UTC` : date;
    appendText(item, "h5", heading);
    appendText(item, "pre", entry?.text ?? "", "verbatim");
    panel.append(item);
  }
}

function renderLogs(card, repository, now) {
  const panel = addPanel(card, "Driver activity", "logs-panel");
  const logs = readerData(repository.logs);
  const status = appendText(
    panel,
    "p",
    repository.liveness?.state ?? "CANNOT_VERIFY",
    "liveness",
  );
  const liveness = repository.liveness?.state;
  status.classList.add(
    liveness === "RUNNING"
      ? "running"
      : liveness === "STOPPED"
        ? "stopped"
        : "unknown",
  );
  appendText(
    panel,
    "p",
    `Checked ${displayAge(repository.liveness?.checkedAt, now)}`,
    "age",
  );

  const list = panel.ownerDocument.createElement("dl");
  list.className = "facts timing";
  for (const [label, key] of [
    ["Driver", "driver"],
    ["Cycle", "cycle"],
    ["Shepherd", "shepherd"],
  ]) {
    const timing = logs?.[key];
    addDefinition(
      list,
      label,
      timing
        ? `${displayTime(timing.startedAt)} → ${displayTime(timing.lastActivityAt)}${timing.durationMs === undefined ? "" : ` (${displayDuration(timing.durationMs)})`}`
        : "Unknown",
    );
  }
  addDefinition(list, "Source age", displayAge(logs?.asOf?.overall, now));
  panel.append(list);
  appendText(
    panel,
    "pre",
    logs === undefined ? "Unavailable" : logs.narration || "No narration",
    "verbatim narration",
  );
}

function renderWarnings(card, repository) {
  const warnings = [];
  if (typeof repository.warning === "string") warnings.push(repository.warning);
  for (const [label, result] of [
    ["state", repository.state],
    ["plan", repository.plan],
    ["questions", repository.questions],
    ["worklog", repository.worklog],
    ["logs", repository.logs],
    ["routing", repository.routing],
  ]) {
    if (!Array.isArray(result?.warnings)) continue;
    for (const warning of result.warnings) {
      warnings.push(
        `${label}: ${warning?.code ?? "WARNING"} — ${warning?.message ?? "source warning"}`,
      );
    }
  }
  if (warnings.length === 0) return;
  const panel = addPanel(card, "Warnings", "warnings-panel");
  const list = panel.ownerDocument.createElement("ul");
  warnings.forEach((warning) => appendText(list, "li", warning));
  panel.append(list);
}

function providerCategory(provider) {
  if (provider === "openai") return "openai";
  if (provider === "opencode") return "opencode";
  if (provider === "amazon-bedrock") return "amazon-bedrock";
  return "other";
}

function renderRoutingStrip(fleet, documentRoot) {
  const strip = documentRoot.createElement("section");
  strip.className = "routing-strip";
  appendText(strip, "h3", "Routing");
  const routing = fleet?.repositories?.find(
    (repository) => repository.routing?.status === "available",
  )?.routing.data;
  if (!routing) {
    appendText(strip, "p", "Unavailable", "unavailable");
    return strip;
  }

  appendText(
    strip,
    "p",
    `Default ${routing.model} · Small ${routing.smallModel}`,
    "routing-defaults",
  );
  const list = documentRoot.createElement("ul");
  list.className = "routing-agents";
  for (const [name, agent] of Object.entries(routing.agents ?? {})) {
    const item = documentRoot.createElement("li");
    appendText(item, "span", name, "routing-agent");
    appendText(item, "span", "→", "routing-arrow");
    appendText(
      item,
      "span",
      agent?.provider ?? "other",
      `routing-provider provider-${providerCategory(agent?.provider)}`,
    );
    appendText(item, "span", `/${agent?.model ?? "Unknown"}`, "routing-model");
    if (agent?.steps !== null && agent?.steps !== undefined) {
      appendText(item, "span", `steps ≤ ${agent.steps}`, "routing-steps");
    }
    list.append(item);
  }
  if (list.childElementCount === 0) {
    appendText(strip, "p", "No agent overrides", "empty");
  } else {
    strip.append(list);
  }
  return strip;
}

function renderRepository(repository, documentRoot, now) {
  const card = documentRoot.createElement("article");
  card.className = "repository";
  const header = documentRoot.createElement("header");
  appendText(header, "h3", repository?.name ?? "Unknown repository");
  appendText(
    header,
    "p",
    repository?.status === "available" ? "AVAILABLE" : "UNAVAILABLE",
    repository?.status === "available"
      ? "status available"
      : "status unavailable",
  );
  card.append(header);
  renderCurrent(card, repository ?? {});
  renderTasks(card, repository ?? {});
  renderQuestions(card, repository ?? {});
  renderWorklog(card, repository ?? {});
  renderLogs(card, repository ?? {}, now);
  renderWarnings(card, repository ?? {});
  return card;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isReaderResult(value) {
  if (!isRecord(value) || !Array.isArray(value.warnings)) return false;
  if (!["available", "partial", "unavailable"].includes(value.status)) {
    return false;
  }
  return value.status === "unavailable" || isRecord(value.data);
}

function isBoundedRoutingString(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ROUTING_STRING_LENGTH
  );
}

function isRoutingModelId(value) {
  if (!isBoundedRoutingString(value)) return false;
  const separator = value.indexOf("/");
  return separator > 0 && separator < value.length - 1;
}

function isRoutingTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) return false;
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) =>
    fraction === undefined ? ".000Z" : `.${fraction.padEnd(3, "0")}Z`,
  );
  return timestamp.toISOString() === normalized;
}

function isRoutingData(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRoutingTimestamp(value.recordedAt) ||
    !isRoutingModelId(value.model) ||
    !isRoutingModelId(value.smallModel) ||
    !isRecord(value.agents)
  ) {
    return false;
  }
  const agents = Object.entries(value.agents);
  return (
    agents.length <= MAX_ROUTING_AGENTS &&
    agents.every(
      ([name, agent]) =>
        name.length > 0 &&
        name.length <= MAX_AGENT_NAME_LENGTH &&
        isRecord(agent) &&
        isBoundedRoutingString(agent.provider) &&
        isBoundedRoutingString(agent.model) &&
        (agent.steps === null ||
          (typeof agent.steps === "number" &&
            Number.isSafeInteger(agent.steps) &&
            agent.steps >= 0 &&
            agent.steps <= MAX_ROUTING_STEPS)),
    )
  );
}

function isRoutingResult(value) {
  return (
    isReaderResult(value) &&
    (value.status === "unavailable" || isRoutingData(value.data))
  );
}

function isPeer(value) {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > 128 ||
    typeof value.origin !== "string"
  ) {
    return false;
  }
  try {
    const origin = new URL(value.origin);
    return (
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      origin.origin === value.origin &&
      origin.username === "" &&
      origin.password === ""
    );
  } catch {
    return false;
  }
}

function isRepository(value) {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 128 &&
    (value.status === "available" || value.status === "unavailable") &&
    isReaderResult(value.state) &&
    isReaderResult(value.plan) &&
    isReaderResult(value.questions) &&
    isReaderResult(value.worklog) &&
    isReaderResult(value.logs) &&
    (value.routing === undefined || isRoutingResult(value.routing)) &&
    isRecord(value.liveness) &&
    ["RUNNING", "STOPPED", "CANNOT_VERIFY"].includes(value.liveness.state) &&
    isTimestamp(value.liveness.checkedAt)
  );
}

function validateFleet(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== API_SCHEMA_VERSION ||
    typeof value.hostname !== "string" ||
    value.hostname.length === 0 ||
    value.hostname.length > 128 ||
    !isTimestamp(value.generatedAt) ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > MAX_REPOSITORIES ||
    !value.repositories.every(isRepository) ||
    !Array.isArray(value.peers) ||
    value.peers.length > MAX_PEERS ||
    !value.peers.every(isPeer)
  ) {
    throw new Error("Invalid fleet response");
  }
  const names = new Set();
  const origins = new Set();
  for (const peer of value.peers) {
    if (names.has(peer.name) || origins.has(peer.origin)) {
      throw new Error("Invalid fleet response");
    }
    names.add(peer.name);
    origins.add(peer.origin);
  }
  return value;
}

async function readBoundedBody(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_FLEET_RESPONSE_BYTES
  ) {
    throw new Error("Fleet response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FLEET_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Fleet response is too large");
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function readFleetResponse(response) {
  if (!response?.ok) {
    throw new Error(`Request failed (${response?.status ?? "unknown"})`);
  }
  const body = await readBoundedBody(response);
  return validateFleet(JSON.parse(body));
}

function unavailableSummary(name) {
  return {
    name,
    liveness: "Unavailable",
    currentTask: "Unavailable",
    pullRequest: "Unavailable",
    hold: false,
    questions: "Unavailable",
    age: "Unavailable",
  };
}

function aggregateCurrent(repositories, key, format) {
  if (repositories.length === 0) return "Unknown";
  const concrete = [];
  let everyNull = true;
  for (const repository of repositories) {
    const state = readerData(repository.state);
    const value = state?.[key];
    if (value !== null) everyNull = false;
    if (value !== undefined && value !== null) {
      concrete.push({ name: repository.name, value: format(value) });
    }
  }
  if (concrete.length === 1) return concrete[0].value;
  if (concrete.length > 1) {
    return concrete.map(({ name, value }) => `${name}: ${value}`).join(", ");
  }
  return everyNull ? "None" : "Unknown";
}

function summarizeMachine(name, fleet, now) {
  if (!fleet) return unavailableSummary(name);
  const repositories = fleet.repositories;
  const states = repositories.map((repository) => readerData(repository.state));
  const liveness = repositories.some(
    (repository) => repository.liveness.state === "RUNNING",
  )
    ? "RUNNING"
    : repositories.length === 0 ||
        repositories.some(
          (repository) => repository.liveness.state === "CANNOT_VERIFY",
        )
      ? "CANNOT_VERIFY"
      : "STOPPED";
  const questionLists = repositories.map(
    (repository) => readerData(repository.questions)?.open,
  );
  const questions =
    repositories.length > 0 && questionLists.every(Array.isArray)
      ? String(questionLists.reduce((total, open) => total + open.length, 0))
      : "Unknown";
  return {
    name,
    liveness,
    currentTask: aggregateCurrent(repositories, "currentTask", String),
    pullRequest: aggregateCurrent(
      repositories,
      "pr",
      (value) => `PR #${value}`,
    ),
    hold: states.some((state) => state?.hold === true),
    questions,
    age: displayAge(fleet.generatedAt, now),
  };
}

function livenessClass(liveness) {
  if (liveness === "RUNNING") return "running";
  if (liveness === "STOPPED") return "stopped";
  if (liveness === "Unavailable") return "unavailable";
  return "unknown";
}

function renderSummaryRow(row, summary) {
  const documentRoot = row.ownerDocument;
  const livenessCell = documentRoot.createElement("td");
  appendText(
    livenessCell,
    "span",
    summary.liveness,
    `liveness ${livenessClass(summary.liveness)}`,
  );
  const holdCell = documentRoot.createElement("td");
  if (summary.hold) appendText(holdCell, "span", "HELD", "badge held-badge");
  row.replaceChildren(
    textElement(documentRoot, "th", summary.name),
    livenessCell,
    textElement(documentRoot, "td", summary.currentTask),
    textElement(documentRoot, "td", summary.pullRequest),
    holdCell,
    textElement(documentRoot, "td", summary.questions),
    textElement(documentRoot, "td", summary.age, "age"),
  );
  row.firstElementChild.scope = "row";
}

function renderTabLabel(tab, summary) {
  const documentRoot = tab.ownerDocument;
  const children = [
    textElement(documentRoot, "span", summary.name, "tab-name"),
  ];
  if (summary.hold) {
    children.push(
      textElement(documentRoot, "span", "HELD", "badge held-badge"),
    );
  }
  children.push(
    textElement(
      documentRoot,
      "span",
      `Questions ${summary.questions}`,
      "badge question-badge",
    ),
  );
  tab.replaceChildren(...children);
}

function createMachineView(identity, index, documentRoot, isPeer) {
  const row = documentRoot.createElement("tr");
  const tab = documentRoot.createElement("button");
  const panel = documentRoot.createElement("section");
  const grid = documentRoot.createElement("div");
  const tabId = `machine-tab-${index}`;
  const panelId = `machine-panel-${index}`;
  tab.type = "button";
  tab.id = tabId;
  tab.className = "machine-tab";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-controls", panelId);
  tab.setAttribute("aria-selected", "false");
  tab.tabIndex = -1;
  panel.id = panelId;
  panel.className = `machine${isPeer ? " peer-machine" : " local-machine"}`;
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", tabId);
  panel.hidden = true;
  grid.className = `repository-grid${isPeer ? " peer-repositories" : ""}`;
  const routing = renderRoutingStrip(null, documentRoot);
  panel.append(routing, grid);
  return { identity, row, tab, panel, routing, grid };
}

function updateMachineView(view, summary, fleet, now, unreachable = false) {
  renderSummaryRow(view.row, summary);
  renderTabLabel(view.tab, summary);
  const routing = renderRoutingStrip(fleet, view.grid.ownerDocument);
  view.routing.replaceWith(routing);
  view.routing = routing;
  if (unreachable) {
    view.grid.replaceChildren(
      textElement(view.grid.ownerDocument, "p", "UNREACHABLE", "unreachable"),
    );
    return;
  }
  if (!fleet) {
    view.grid.replaceChildren(
      textElement(view.grid.ownerDocument, "p", "Unavailable", "unavailable"),
    );
    return;
  }
  view.grid.replaceChildren(
    ...fleet.repositories.map((repository) =>
      renderRepository(repository, view.grid.ownerDocument, now),
    ),
  );
}

function machineHash(identity) {
  return `#${new URLSearchParams({ machine: identity }).toString()}`;
}

function hashMachine(windowRoot) {
  return new URLSearchParams(windowRoot?.location?.hash?.slice(1) ?? "").get(
    "machine",
  );
}

function installTabs(documentRoot, views) {
  tabControllers.get(documentRoot)?.cleanup();
  const windowRoot = documentRoot.defaultView;
  const listeners = [];

  function select(index, updateHash = false, focus = false) {
    views.forEach((view, viewIndex) => {
      const selected = viewIndex === index;
      view.tab.setAttribute("aria-selected", String(selected));
      view.tab.tabIndex = selected ? 0 : -1;
      view.panel.hidden = !selected;
    });
    if (focus) views[index].tab.focus();
    if (updateHash && windowRoot?.location) {
      windowRoot.location.hash = machineHash(views[index].identity);
    }
  }

  function selectFromHash(canonicalize) {
    const identity = hashMachine(windowRoot);
    const index = views.findIndex((view) => view.identity === identity);
    select(index >= 0 ? index : 0);
    if (canonicalize && index < 0 && windowRoot?.history) {
      windowRoot.history.replaceState(null, "", machineHash(views[0].identity));
    }
  }

  views.forEach((view, index) => {
    const onClick = () => select(index, true);
    const onKeyDown = (event) => {
      let targetIndex;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        targetIndex = (index + 1) % views.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        targetIndex = (index - 1 + views.length) % views.length;
      } else if (event.key === "Enter" || event.key === " ") {
        targetIndex = index;
      } else {
        return;
      }
      event.preventDefault();
      select(targetIndex, true, true);
    };
    view.tab.addEventListener("click", onClick);
    view.tab.addEventListener("keydown", onKeyDown);
    listeners.push(
      [view.tab, "click", onClick],
      [view.tab, "keydown", onKeyDown],
    );
  });
  const onHashChange = () => selectFromHash(true);
  windowRoot?.addEventListener("hashchange", onHashChange);
  selectFromHash(true);

  tabControllers.set(documentRoot, {
    cleanup() {
      for (const [target, type, listener] of listeners) {
        target.removeEventListener(type, listener);
      }
      windowRoot?.removeEventListener("hashchange", onHashChange);
    },
  });
}

function ensureFleetShell(documentRoot, repositories) {
  let summaryBody = documentRoot.querySelector("#fleet-summary tbody");
  if (!summaryBody) {
    const table = documentRoot.createElement("table");
    table.id = "fleet-summary";
    summaryBody = documentRoot.createElement("tbody");
    table.append(summaryBody);
    repositories.parentNode?.insertBefore(table, repositories);
  }
  let tabs = documentRoot.querySelector("#machine-tabs");
  if (!tabs) {
    tabs = documentRoot.createElement("div");
    tabs.id = "machine-tabs";
    tabs.setAttribute("role", "tablist");
    repositories.parentNode?.insertBefore(tabs, repositories);
  }
  return { summaryBody, tabs };
}

export function renderFleet(fleet, documentRoot = document, now = new Date()) {
  const machine = documentRoot.querySelector("#machine");
  const repositories = documentRoot.querySelector("#repositories");
  const generated = documentRoot.querySelector("#generated");
  const error = documentRoot.querySelector("#error");
  if (!machine || !repositories || !generated || !error) return;
  const { summaryBody, tabs } = ensureFleetShell(documentRoot, repositories);

  machine.textContent = fleet?.hostname ?? "Local machine";
  generated.textContent = `Snapshot ${displayAge(fleet?.generatedAt, now)} · ${displayTime(fleet?.generatedAt)}`;
  error.textContent = "";
  const machines = [
    { identity: fleet.hostname, fleet, isPeer: false },
    ...(Array.isArray(fleet.peers) ? fleet.peers : []).map((peer) => ({
      identity: peer.name,
      fleet: null,
      isPeer: true,
    })),
  ];
  const views = machines.map((item, index) =>
    createMachineView(item.identity, index, documentRoot, item.isPeer),
  );
  views.forEach((view, index) => {
    updateMachineView(
      view,
      machines[index].fleet
        ? summarizeMachine(view.identity, machines[index].fleet, now)
        : unavailableSummary(view.identity),
      machines[index].fleet,
      now,
    );
  });
  summaryBody.replaceChildren(...views.map((view) => view.row));
  tabs.replaceChildren(...views.map((view) => view.tab));
  repositories.replaceChildren(...views.map((view) => view.panel));
  installTabs(documentRoot, views);
  machineViews.set(documentRoot, views);
}

async function fetchPeerFleet(peer, fetcher, dependencies) {
  const controller = new AbortController();
  let timeout;
  const timeoutFailure = new Promise((_, reject) => {
    timeout = dependencies.setTimeout(() => {
      controller.abort();
      reject(new Error("Peer request timed out"));
    }, PEER_FETCH_TIMEOUT_MS);
  });
  try {
    const request = (async () => {
      const response = await fetcher(new URL("/api/fleet", peer.origin).href, {
        signal: controller.signal,
      });
      return readFleetResponse(response);
    })();
    return await Promise.race([request, timeoutFailure]);
  } finally {
    dependencies.clearTimeout(timeout);
  }
}

async function fanOutToPeers(
  peers,
  views,
  documentRoot,
  fetcher,
  dependencies,
  generation,
) {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < peers.length) {
      const index = nextIndex++;
      const peer = peers[index];
      try {
        const fleet = await fetchPeerFleet(peer, fetcher, dependencies);
        if (loadGenerations.get(documentRoot) === generation) {
          const now = dependencies.now();
          updateMachineView(
            views[index + 1],
            summarizeMachine(peer.name, fleet, now),
            fleet,
            now,
          );
        }
      } catch {
        if (loadGenerations.get(documentRoot) === generation) {
          updateMachineView(
            views[index + 1],
            unavailableSummary(peer.name),
            null,
            dependencies.now(),
            true,
          );
        }
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_PEER_FETCHES, peers.length) },
      () => worker(),
    ),
  );
}

export async function loadFleet(
  documentRoot = document,
  fetcher = fetch,
  dependencyOverrides = {},
) {
  const machine = documentRoot.querySelector("#machine");
  const repositories = documentRoot.querySelector("#repositories");
  const generated = documentRoot.querySelector("#generated");
  const error = documentRoot.querySelector("#error");
  const dependencies = {
    setTimeout: dependencyOverrides.setTimeout ?? globalThis.setTimeout,
    clearTimeout: dependencyOverrides.clearTimeout ?? globalThis.clearTimeout,
    now: dependencyOverrides.now ?? (() => new Date()),
  };
  const generation = (loadGenerations.get(documentRoot) ?? 0) + 1;
  loadGenerations.set(documentRoot, generation);
  tabControllers.get(documentRoot)?.cleanup();
  tabControllers.delete(documentRoot);
  machineViews.delete(documentRoot);
  if (machine) machine.textContent = "Loading local machine…";
  if (generated) generated.textContent = "Waiting for snapshot…";
  if (error) error.textContent = "";
  documentRoot.querySelector("#fleet-summary tbody")?.replaceChildren();
  documentRoot.querySelector("#machine-tabs")?.replaceChildren();
  repositories?.replaceChildren();
  try {
    const response = await fetcher("/api/fleet");
    const fleet = await readFleetResponse(response);
    if (loadGenerations.get(documentRoot) !== generation) return;
    renderFleet(fleet, documentRoot, dependencies.now());
    const views = machineViews.get(documentRoot);
    if (!views) return;
    await fanOutToPeers(
      fleet.peers,
      views,
      documentRoot,
      fetcher,
      dependencies,
      generation,
    );
  } catch (cause) {
    if (loadGenerations.get(documentRoot) !== generation) return;
    if (machine) machine.textContent = "Local machine unavailable";
    repositories?.replaceChildren();
    if (error) {
      error.textContent =
        cause instanceof Error ? cause.message : "Request failed";
    }
  }
}

// Auto-load when running in a real browser with a dashboard
if (
  typeof window !== "undefined" &&
  window.document?.querySelector("#repositories")
) {
  void loadFleet();
}
