export const PEER_FETCH_TIMEOUT_MS = 5_000;
export const MAX_CONCURRENT_PEER_FETCHES = 4;

const API_SCHEMA_VERSION = 1;
const MAX_FLEET_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_REPOSITORIES = 32;
const MAX_PEERS = 32;
const loadGenerations = new WeakMap();

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
    appendText(item, "h5", entry?.date ?? "Unknown date");
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

function createPeerSlot(peer, documentRoot) {
  const slot = documentRoot.createElement("section");
  slot.className = "machine peer-machine";
  const header = documentRoot.createElement("header");
  appendText(header, "h2", peer.name);
  appendText(header, "p", "LOADING", "peer-status loading");
  slot.append(header);
  const repositories = documentRoot.createElement("div");
  repositories.className = "repository-grid peer-repositories";
  slot.append(repositories);
  return slot;
}

function renderPeerFleet(slot, peer, fleet, now) {
  const header = slot.ownerDocument.createElement("header");
  appendText(header, "h2", peer.name);
  appendText(header, "p", "AVAILABLE", "peer-status available");
  appendText(
    header,
    "p",
    `Remote ${fleet.hostname} · Snapshot ${displayAge(fleet.generatedAt, now)}`,
    "age",
  );
  const repositories = slot.ownerDocument.createElement("div");
  repositories.className = "repository-grid peer-repositories";
  repositories.append(
    ...fleet.repositories.map((repository) =>
      renderRepository(repository, slot.ownerDocument, now),
    ),
  );
  slot.replaceChildren(header, repositories);
}

function renderPeerUnavailable(slot, peer) {
  const header = slot.ownerDocument.createElement("header");
  appendText(header, "h2", peer.name);
  appendText(header, "p", "UNREACHABLE", "peer-status unreachable");
  slot.replaceChildren(header);
}

export function renderFleet(fleet, documentRoot = document, now = new Date()) {
  const machine = documentRoot.querySelector("#machine");
  const repositories = documentRoot.querySelector("#repositories");
  const generated = documentRoot.querySelector("#generated");
  const error = documentRoot.querySelector("#error");
  if (!machine || !repositories || !generated || !error) return;

  machine.textContent = fleet?.hostname ?? "Local machine";
  generated.textContent = `Snapshot ${displayAge(fleet?.generatedAt, now)} · ${displayTime(fleet?.generatedAt)}`;
  error.textContent = "";
  const cards = Array.isArray(fleet?.repositories)
    ? fleet.repositories.map((repository) =>
        renderRepository(repository, documentRoot, now),
      )
    : [];
  const peerSlots = Array.isArray(fleet?.peers)
    ? fleet.peers.map((peer) => createPeerSlot(peer, documentRoot))
    : [];
  repositories.replaceChildren(...cards, ...peerSlots);
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
  slots,
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
          renderPeerFleet(slots[index], peer, fleet, dependencies.now());
        }
      } catch {
        if (loadGenerations.get(documentRoot) === generation) {
          renderPeerUnavailable(slots[index], peer);
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
  if (machine) machine.textContent = "Loading local machine…";
  if (generated) generated.textContent = "Waiting for snapshot…";
  if (error) error.textContent = "";
  repositories?.replaceChildren();
  try {
    const response = await fetcher("/api/fleet");
    const fleet = await readFleetResponse(response);
    if (loadGenerations.get(documentRoot) !== generation) return;
    renderFleet(fleet, documentRoot, dependencies.now());
    const slots = Array.from(documentRoot.querySelectorAll(".peer-machine"));
    await fanOutToPeers(
      fleet.peers,
      slots,
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
