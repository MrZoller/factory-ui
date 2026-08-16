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
    logs?.narration || "No narration",
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
  repositories.replaceChildren(...cards);
}

export async function loadFleet(documentRoot = document, fetcher = fetch) {
  const machine = documentRoot.querySelector("#machine");
  const error = documentRoot.querySelector("#error");
  try {
    const response = await fetcher("/api/fleet");
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    renderFleet(await response.json(), documentRoot);
  } catch (cause) {
    if (machine) machine.textContent = "Local machine unavailable";
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
