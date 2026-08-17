export const PEER_FETCH_TIMEOUT_MS = 5_000;
export const MAX_CONCURRENT_PEER_FETCHES = 4;

const API_SCHEMA_VERSION = 1;
const MAX_FLEET_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_REPOSITORIES = 32;
const MAX_PEERS = 32;
const MAX_ROUTING_AGENTS = 64;
const MAX_ROUTING_MODELS = 64;
const MAX_AGENT_NAME_LENGTH = 128;
const MAX_ROUTING_STRING_LENGTH = 1024;
const MAX_ROUTING_MODEL_STRING_LENGTH = 200;
const MAX_ROUTING_STEPS = 1_000_000;
const MAX_COST_TASKS = 256;
const MAX_COST_MODELS_PER_TASK = 64;
const MAX_WARNING_EXCERPT_CODE_POINTS = 200;
const COMPLETED_TASK_LIMIT = 8;
const loadGenerations = new WeakMap();
const tabControllers = new WeakMap();
const machineViews = new WeakMap();
const loadStates = new WeakMap();
const dashboardControllers = new WeakMap();
const disclosureStates = new WeakMap();

function disclosureState(documentRoot, machine, repository) {
  let machines = disclosureStates.get(documentRoot);
  if (!machines) disclosureStates.set(documentRoot, (machines = new Map()));
  let repositories = machines.get(machine);
  if (!repositories) machines.set(machine, (repositories = new Map()));
  let state = repositories.get(repository);
  if (!state) {
    state = { worklogEntries: new Map() };
    repositories.set(repository, state);
  }
  return state;
}

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

function updateSnapshotStatus(documentRoot, state, now) {
  const generated = documentRoot.querySelector("#generated");
  if (generated && state.lastGoodGeneratedAt) {
    const stale =
      now.valueOf() - new Date(state.lastGoodGeneratedAt).valueOf() >
        state.refreshIntervalMilliseconds ||
      state.lastError ||
      state.paused ||
      state.peerTimedOut;
    const reason = state.lastError
      ? "refresh failed"
      : state.paused
        ? "paused"
        : state.peerTimedOut
          ? "peer timed out"
          : "snapshot too old";
    generated.classList.toggle("stale", Boolean(stale));
    generated.textContent = stale
      ? `Stale · last good snapshot ${displayAge(state.lastGoodGeneratedAt, now)} (${displayTime(state.lastGoodGeneratedAt)}) — ${reason}`
      : `Updated ${displayTime(state.lastGoodGeneratedAt)}`;
  }
  if (state.lastError) {
    const error = documentRoot.querySelector("#error");
    if (error) {
      const suffix = state.lastGoodGeneratedAt
        ? ` · Last good snapshot ${displayAge(state.lastGoodGeneratedAt, now)}`
        : "";
      error.textContent = `${state.lastError}${suffix}`;
    }
  }
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

function addPanel(card, title, className, spanClass, titleUrl, titleUrlKind) {
  const section = card.ownerDocument.createElement("section");
  section.className = `panel ${className} ${spanClass}`;
  const heading = section.ownerDocument.createElement("h4");
  if (titleUrlKind) {
    appendExternalOrText(heading, title, titleUrl, titleUrlKind);
  } else {
    heading.textContent = title;
  }
  section.append(heading);
  card.append(section);
  return section;
}

function addDefinition(list, term, value) {
  appendText(list, "dt", term);
  appendText(list, "dd", value);
}

function safeGithubUrl(value, kind) {
  const patterns = {
    repository:
      /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+$/,
    branch:
      /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+\/tree\/([A-Za-z0-9._/-]{1,200})$/,
    pull: /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/,
    issue:
      /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+\/issues\/[1-9][0-9]*$/,
    commit:
      /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+\/commit\/[0-9a-fA-F]{40}$/,
    plan: /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+\/blob\/HEAD\/\.factory\/plan\.md$/,
    spec: /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+\/blob\/HEAD\/\.factory\/spec\.md$/,
    worklog:
      /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+\/blob\/HEAD\/\.factory\/worklog\.md$/,
    questions:
      /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+\/blob\/HEAD\/\.factory\/questions\.md$/,
  };
  const match = typeof value === "string" ? patterns[kind]?.exec(value) : null;
  if (
    !match ||
    (kind === "branch" &&
      (match[1].startsWith("-") ||
        match[1].startsWith("/") ||
        match[1].split("/").includes("..")))
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

function appendExternalOrText(parent, text, value, kind) {
  const href = safeGithubUrl(value, kind);
  if (!href) return appendText(parent, "span", text);
  const link = textElement(parent.ownerDocument, "a", text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  parent.append(link);
  return link;
}

const WORKLOG_EVENT_PATTERNS = [
  [
    "opened PR",
    /\b(?:opened|created)(?: as)?(?: (?:held|major))* (?:PR|pull request)\b|\bPR #\d+ opened\b/i,
  ],
  ["merged", /\bmerged\b|\bmerge completed\b/i],
  [
    "review wait",
    /\breview wait\b|\b(?:awaiting|awaited|waiting for) (?:review|CI|checks?|bots?)\b|\bin review\b/i,
  ],
  ["parked minors", /\bparked? (?:review )?minors?\b/i],
  ["reclassified", /\breclassif(?:ied|y|ication)\b/i],
  ["escalated", /\bescalat(?:ed|ion|ing)\b/i],
  [
    "question filed",
    /\b(?:filed|opened|recorded|asked) (?:a )?question\b|\bquestion (?:filed|opened)\b/i,
  ],
];

function worklogEvent(sentence) {
  return (
    WORKLOG_EVENT_PATTERNS.find(([, pattern]) => pattern.test(sentence))?.[0] ??
    "other"
  );
}

function worklogContent(entry) {
  const raw =
    typeof entry?.text === "string" ? entry.text : String(entry?.text ?? "");
  const date = typeof entry?.date === "string" ? entry.date : "";
  const time = typeof entry?.time === "string" ? entry.time : undefined;
  const validDate = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(
    date,
  );
  const validTime =
    time === undefined || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
  if (!validDate || !validTime) return { raw, content: raw, malformed: true };
  const prefix = `- ${date}${time ? ` ${time}` : ""} UTC - `;
  if (!raw.startsWith(prefix)) return { raw, content: raw, malformed: true };
  return {
    raw,
    content: raw.slice(prefix.length),
    malformed: false,
  };
}

function splitFirstSentence(text) {
  const match = /^([\s\S]*?[.!?])(?:\s+|$)([\s\S]*)$/.exec(text);
  return match
    ? { headline: match[1], remainder: match[2] }
    : { headline: text, remainder: "" };
}

function repositoryGithubBase(repositoryUrl) {
  const safe = safeGithubUrl(repositoryUrl, "repository");
  return safe?.replace(/\/$/, "");
}

function worklogReferenceUrl(repositoryUrl, kind, value) {
  const base = repositoryGithubBase(repositoryUrl);
  if (!base) return undefined;
  if (kind === "task") return `${base}/blob/HEAD/.factory/plan.md`;
  if (kind === "pull") return `${base}/pull/${value}`;
  if (kind === "issue") return `${base}/issues/${value}`;
  if (kind === "commit") return `${base}/commit/${value}`;
  return undefined;
}

function appendWorklogHighlight(parent, text, repositoryUrl) {
  const pattern =
    /(`[^`\n]+`|\bT[1-9][0-9]*\b|\bPR #[1-9][0-9]*\b|(?<![A-Za-z0-9])#[1-9][0-9]*\b|\b[0-9a-fA-F]{40}\b)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset)
      parent.append(
        parent.ownerDocument.createTextNode(text.slice(offset, match.index)),
      );
    const token = match[0];
    if (token.startsWith("`")) {
      appendText(parent, "code", token.slice(1, -1));
    } else {
      const kind = token.startsWith("T")
        ? "task"
        : token.startsWith("PR #")
          ? "pull"
          : token.startsWith("#")
            ? "issue"
            : "commit";
      const value =
        kind === "pull"
          ? token.slice(4)
          : kind === "issue"
            ? token.slice(1)
            : token;
      const label = kind === "commit" ? token.slice(0, 7) : token;
      const url = worklogReferenceUrl(repositoryUrl, kind, value);
      const reference = url
        ? appendExternalOrText(
            parent,
            label,
            url,
            kind === "task" ? "plan" : kind,
          )
        : appendText(parent, "code", label);
      reference.classList.add("worklog-reference");
    }
    offset = match.index + token.length;
  }
  if (offset < text.length)
    parent.append(parent.ownerDocument.createTextNode(text.slice(offset)));
}

function renderCurrent(card, repository) {
  const panel = addPanel(card, "Current", "current-panel", "panel-span-8");
  const state = readerData(repository.state);
  const list = panel.ownerDocument.createElement("dl");
  list.className = "facts";
  appendText(list, "dt", "Project");
  const projectDefinition = list.ownerDocument.createElement("dd");
  appendExternalOrText(
    projectDefinition,
    repository.project ?? state?.project ?? "Unknown",
    repository.repositoryUrl,
    "repository",
  );
  const documentLinks = list.ownerDocument.createElement("p");
  documentLinks.className = "factory-document-links muted";
  const documents = [
    ["spec", repository.specUrl, "spec"],
    ["plan", repository.planUrl, "plan"],
    ["worklog", repository.worklogUrl, "worklog"],
    ["questions", repository.questionsUrl, "questions"],
  ];
  documents.forEach(([label, url, kind], index) => {
    if (index > 0)
      documentLinks.append(documentLinks.ownerDocument.createTextNode(" · "));
    appendExternalOrText(documentLinks, label, url, kind);
  });
  projectDefinition.append(documentLinks);
  list.append(projectDefinition);
  addDefinition(list, "Phase", repository.phase ?? state?.phase ?? "Unknown");
  addDefinition(list, "Task", displayOptional(state?.currentTask));
  appendText(list, "dt", "Branch");
  const branchDefinition = list.ownerDocument.createElement("dd");
  appendExternalOrText(
    branchDefinition,
    displayOptional(state?.branch),
    repository.branchUrl,
    "branch",
  );
  list.append(branchDefinition);

  appendText(list, "dt", "Pull request");
  const prValue =
    state?.pr === undefined
      ? "Unknown"
      : state.pr === null
        ? "None"
        : `PR #${state.pr}`;
  const prUrl = safeGithubUrl(repository.prUrl, "pull");
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
  ["Active", "active", "active-work", "panel-span-4"],
  ["In review", "review", "review-work", "panel-span-4"],
  ["Next runnable", "nextRunnable", "runnable-work", "panel-span-4"],
  ["Blocked", "blocked", "blocked-work", "panel-span-4"],
  ["Completed", "completed", "completed-work", "panel-span-6"],
];

function tokenTotal(counters) {
  const tokens = counters?.tokens;
  if (!tokens) return 0;
  return [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cacheRead,
    tokens.cacheWrite,
  ].reduce((total, value) => total + value, 0);
}

function formatUsd(usd) {
  return `$${usd.toFixed(2)}`;
}

const NOTIONAL_COMPONENTS = ["input", "output", "cacheRead", "cacheWrite"];

function taskNotional(counters, routing) {
  if (!isRecord(counters?.byModel)) return null;
  let usd = 0;
  let priced = false;
  let partial = false;
  const pricesAsOf = new Set();
  for (const [modelId, modelCounters] of Object.entries(counters.byModel)) {
    if (!isCostCounters(modelCounters) || modelCounters.usd !== 0) continue;
    if (tokenTotal(modelCounters) === 0) continue;
    const model = routing?.models?.[modelId];
    if (!model || model.source === null) {
      partial = true;
      continue;
    }
    for (const component of NOTIONAL_COMPONENTS) {
      const tokenCount = modelCounters.tokens[component];
      const price = model.pricePerMillion[component];
      if (price === null) {
        partial = true;
        continue;
      }
      if (tokenCount === 0) continue;
      const componentUsd = (tokenCount * price) / 1_000_000;
      if (!Number.isFinite(componentUsd)) return undefined;
      usd += componentUsd;
      if (!Number.isFinite(usd)) return undefined;
      priced = true;
      pricesAsOf.add(model.pricesAsOf);
    }
  }
  return priced ? { usd, partial, pricesAsOf: [...pricesAsOf].sort() } : null;
}

function notionalLabel(notional) {
  if (!notional) return null;
  const contributors = notional.contributors ?? 1;
  const repositories = notional.repositories ?? 1;
  const missingNames = notional.missingNames ?? [];
  const coverage =
    contributors < repositories
      ? ` (${contributors} of ${repositories} repos)`
      : "";
  const missing = missingNames.length
    ? `; unavailable repositories: ${missingNames.join(", ")}`
    : "";
  return {
    text: `~${formatUsd(notional.usd)} at list${notional.partial ? " (partial)" : ""}${coverage}`,
    title: `notional: subscription lane priced at models.dev list price as of ${notional.pricesAsOf.join(", ")}; not billed${missing}`,
  };
}

function costLabel(counters) {
  if (!isCostCounters(counters)) return null;
  const tokens = tokenTotal(counters);
  return {
    text: counters.usd === 0 && tokens > 0 ? "sub" : formatUsd(counters.usd),
    title: `${tokens.toLocaleString()} tokens`,
  };
}

function renderTask(panel, task, cost, routing) {
  const item = panel.ownerDocument.createElement("li");
  item.className = "task";
  appendText(item, "span", task?.id ?? "?", "task-id");
  appendText(item, "span", task?.title ?? "Untitled task", "task-title");
  appendText(item, "span", task?.size ?? "unknown", "task-size");
  const label = costLabel(cost);
  if (label) {
    const costGroup = item.ownerDocument.createElement("span");
    costGroup.className = "task-cost-group";
    const costNode = appendText(
      costGroup,
      "span",
      cost.usd > 0 ? `${formatUsd(cost.usd)} metered` : label.text,
      "task-cost",
    );
    costNode.title = label.title;
    const notional = notionalLabel(taskNotional(cost, routing));
    if (notional) {
      appendText(costGroup, "span", "·", "task-cost-separator");
      const notionalNode = appendText(
        costGroup,
        "span",
        notional.text,
        "task-notional",
      );
      notionalNode.title = notional.title;
    }
    item.append(costGroup);
    appendText(item, "span", label.title, "task-cost-detail");
  }
  if (Array.isArray(task?.dependencies) && task.dependencies.length > 0) {
    appendText(
      item,
      "span",
      `deps: ${task.dependencies.join(", ")}`,
      "task-deps",
    );
  }
  const references = item.ownerDocument.createElement("span");
  references.className = "task-references";
  if (Number.isSafeInteger(task?.pr) && task.pr > 0)
    appendExternalOrText(references, `PR #${task.pr}`, task.prUrl, "pull");
  if (Array.isArray(task?.issueNumbers)) {
    task.issueNumbers.forEach((issue, index) => {
      if (Number.isSafeInteger(issue) && issue > 0)
        appendExternalOrText(
          references,
          `Fixes #${issue}`,
          Array.isArray(task.issueUrls) ? task.issueUrls[index] : undefined,
          "issue",
        );
    });
  }
  if (references.childNodes.length > 0) item.append(references);
  panel.append(item);
}

function taskIdNumber(task) {
  const match = /^T([1-9][0-9]*)$/.exec(task?.id ?? "");
  if (!match) return -1;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : -1;
}

function mergedAtTime(repository, task) {
  const value = readerData(repository.metrics)?.tasks?.[task?.id]?.pr?.mergedAt;
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function completedTasks(repository, tasks) {
  return [...tasks].sort((left, right) => {
    const leftMergedAt = mergedAtTime(repository, left);
    const rightMergedAt = mergedAtTime(repository, right);
    if (leftMergedAt !== undefined && rightMergedAt !== undefined) {
      if (leftMergedAt !== rightMergedAt) return rightMergedAt - leftMergedAt;
    } else if (leftMergedAt !== undefined) {
      return -1;
    } else if (rightMergedAt !== undefined) {
      return 1;
    }
    return taskIdNumber(right) - taskIdNumber(left);
  });
}

function renderTasks(card, repository, disclosure) {
  const plan = readerData(repository.plan);
  const costs = readerData(repository.costs)?.tasks;
  const routing = readerData(repository.routing);
  for (const [title, key, className, spanClass] of TASK_GROUPS) {
    const panel = addPanel(
      card,
      title,
      className,
      spanClass,
      repository.planUrl,
      "plan",
    );
    if (!plan) {
      appendText(panel, "p", "Unavailable", "unavailable");
      continue;
    }
    const planTasks = Array.isArray(plan?.[key]) ? plan[key] : [];
    const tasks =
      key === "completed" ? completedTasks(repository, planTasks) : planTasks;
    if (tasks.length === 0) {
      panel.classList.add("panel-empty");
      appendText(panel, "p", "None", "empty");
      continue;
    }
    const list = panel.ownerDocument.createElement("ul");
    list.className = "task-list";
    let expanded =
      key === "completed" && (disclosure.completedExpanded ?? false);
    const renderList = () => {
      list.replaceChildren();
      const visible = expanded ? tasks : tasks.slice(0, COMPLETED_TASK_LIMIT);
      visible.forEach((task) =>
        renderTask(list, task, costs?.[task?.id], routing),
      );
      list.classList.toggle("task-list-scroll", expanded);
      if (expanded) list.tabIndex = 0;
      else list.removeAttribute("tabindex");
    };
    renderList();
    panel.append(list);
    if (key === "completed" && tasks.length > COMPLETED_TASK_LIMIT) {
      const toggle = appendText(panel, "button", "", "completed-tasks-toggle");
      toggle.type = "button";
      const updateToggle = () => {
        toggle.textContent = expanded
          ? `Show newest ${COMPLETED_TASK_LIMIT}`
          : `Show all ${tasks.length}`;
        toggle.setAttribute("aria-expanded", String(expanded));
      };
      toggle.addEventListener("click", () => {
        expanded = !expanded;
        disclosure.completedExpanded = expanded;
        updateToggle();
        renderList();
      });
      updateToggle();
    }
  }
}

function renderQuestions(card, repository) {
  const panel = addPanel(
    card,
    "Open questions",
    "questions-panel",
    "panel-span-6",
    repository.questionsUrl,
    "questions",
  );
  const open = readerData(repository.questions)?.open;
  if (!open) {
    appendText(panel, "p", "Unavailable", "unavailable");
    return;
  }
  if (!Array.isArray(open) || open.length === 0) {
    panel.classList.add("panel-empty");
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

function renderWorklog(card, repository, disclosure) {
  const panel = addPanel(
    card,
    "Recent worklog",
    "worklog-panel",
    "panel-span-4",
    repository.worklogUrl,
    "worklog",
  );
  const entries = readerData(repository.worklog)?.entries;
  if (entries === undefined) {
    appendText(panel, "p", "Unavailable", "unavailable");
    return;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    panel.classList.add("panel-empty");
    appendText(panel, "p", "None", "empty");
    return;
  }
  const newestFirst = entries.slice().reverse();
  const visibleCount = 6;
  let expanded = disclosure.worklogExpanded ?? false;
  const entryKey = (entry) => `${entry?.date ?? ""}\u0000${entry?.time ?? ""}`;
  const currentKeys = new Set(newestFirst.map(entryKey));
  for (const key of disclosure.worklogEntries.keys()) {
    if (!currentKeys.has(key)) disclosure.worklogEntries.delete(key);
  }
  const list = panel.ownerDocument.createElement("div");
  list.className = "worklog-list";
  panel.append(list);

  const renderEntries = () => {
    list.replaceChildren();
    let previousDate;
    for (const entry of expanded
      ? newestFirst
      : newestFirst.slice(0, visibleCount)) {
      const date =
        typeof entry?.date === "string" ? entry.date : "Unknown date";
      if (date !== previousDate) {
        appendText(list, "h5", date, "worklog-date");
        previousDate = date;
      }
      const parsed = worklogContent(entry);
      const sentence = parsed.malformed
        ? { headline: parsed.raw, remainder: "" }
        : splitFirstSentence(parsed.content);
      const item = panel.ownerDocument.createElement("article");
      item.className = "worklog-entry";
      const headline = item.ownerDocument.createElement("div");
      headline.className = "worklog-headline";
      appendText(
        headline,
        "time",
        entry?.time ?? "Time unavailable",
        "worklog-time",
      );
      const task = /\bT[1-9][0-9]*\b/.exec(parsed.content)?.[0];
      if (task) {
        const taskChip = appendExternalOrText(
          headline,
          task,
          worklogReferenceUrl(repository.repositoryUrl, "task", task),
          "plan",
        );
        taskChip.classList.add("worklog-chip", "worklog-task-chip");
      }
      appendText(
        headline,
        "span",
        parsed.malformed ? "other" : worklogEvent(sentence.headline),
        "worklog-chip worklog-event-chip",
      );
      const headlineText = item.ownerDocument.createElement("span");
      headlineText.className = "worklog-summary";
      appendWorklogHighlight(
        headlineText,
        sentence.headline,
        repository.repositoryUrl,
      );
      headline.append(headlineText);
      item.append(headline);
      if (sentence.remainder) {
        const body = item.ownerDocument.createElement("p");
        body.className = "worklog-body";
        appendWorklogHighlight(
          body,
          sentence.remainder,
          repository.repositoryUrl,
        );
        item.append(body);
      }
      const details = item.ownerDocument.createElement("details");
      details.className = "worklog-raw";
      const key = entryKey(entry);
      details.open = disclosure.worklogEntries.get(key) ?? false;
      details.addEventListener("toggle", () => {
        disclosure.worklogEntries.set(key, details.open);
      });
      appendText(details, "summary", "Raw entry");
      appendText(details, "pre", parsed.raw, "verbatim");
      item.append(details);
      list.append(item);
    }
  };
  renderEntries();

  if (newestFirst.length > visibleCount) {
    const toggle = appendText(
      panel,
      "button",
      `Show all ${newestFirst.length}`,
      "worklog-toggle",
    );
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      disclosure.worklogExpanded = expanded;
      toggle.textContent = expanded
        ? `Show newest ${visibleCount}`
        : `Show all ${newestFirst.length}`;
      toggle.setAttribute("aria-expanded", String(expanded));
      renderEntries();
    });
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded
      ? `Show newest ${visibleCount}`
      : `Show all ${newestFirst.length}`;
  }
}

function renderLogs(card, repository, now, generatedAt) {
  const panel = addPanel(card, "Driver activity", "logs-panel", "panel-span-4");
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
  const checkedAt = repository.liveness?.checkedAt;
  const checkedMilliseconds = Date.parse(checkedAt);
  const generatedMilliseconds = Date.parse(generatedAt);
  const checkAgeAtSnapshot = generatedMilliseconds - checkedMilliseconds;
  const refreshIntervalMilliseconds =
    loadStates.get(panel.ownerDocument)?.refreshIntervalMilliseconds ?? 30_000;
  const checkIsFresh =
    Number.isFinite(checkAgeAtSnapshot) &&
    Math.abs(checkAgeAtSnapshot) <= refreshIntervalMilliseconds;
  if (!checkIsFresh) {
    appendText(
      panel,
      "p",
      `Liveness checked ${displayAge(checkedAt, now)} — may be stale`,
      "age stale",
    );
  }

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

export const WARNING_EXPLANATIONS = Object.freeze({
  WARNINGS_TRUNCATED:
    "Additional warnings were omitted after the safety limit.",
  PLAN_TOO_MANY_LINES: "The plan has more lines than the reader permits.",
  PLAN_LINE_TOO_LONG: "A plan line exceeds the safe parsing limit.",
  PLAN_MALFORMED_TASK: "A task line does not match the factory plan format.",
  PLAN_TOO_MANY_TASKS: "The plan contains more tasks than the reader permits.",
  PLAN_MALFORMED_PR: "A task has invalid pull-request metadata.",
  PLAN_MALFORMED_ISSUE: "A task has an invalid Fixes issue reference.",
  PLAN_TOO_MANY_ISSUES: "A task has more issue references than are retained.",
  PLAN_MALFORMED_DEPS: "A task dependency line does not match the plan format.",
  PLAN_DUPLICATE_DEP: "A task declares the same dependency more than once.",
  PLAN_TOO_MANY_DEPS: "A task has more dependencies than are retained.",
  PLAN_MISSING_DEPS: "A task has no valid dependency declaration.",
  PLAN_DUPLICATE_TASK: "The same task identifier appears more than once.",
  PLAN_SELF_DEP: "A task declares itself as a dependency.",
  PLAN_UNKNOWN_DEP: "A task depends on an identifier absent from the plan.",
  PLAN_AMBIGUOUS_DEP: "A task depends on a duplicated task identifier.",
  PLAN_INVALID_UTF8: "The plan is not valid UTF-8 text.",
  PLAN_MISSING: "The plan file is missing.",
  PLAN_TOO_LARGE: "The plan file exceeds the safe read limit.",
  PLAN_UNAVAILABLE: "The plan file could not be read safely.",
  WORKLOG_TOO_MANY_LINES: "The worklog has more lines than the reader permits.",
  WORKLOG_LINE_TOO_LONG: "A worklog line exceeds the safe parsing limit.",
  WORKLOG_EMPTY: "The worklog contains no entries.",
  WORKLOG_MALFORMED_ENTRY:
    "A worklog entry does not match the protocol stamp format.",
  WORKLOG_INVALID_UTF8: "The worklog is not valid UTF-8 text.",
  WORKLOG_MISSING: "The worklog file is missing.",
  WORKLOG_TOO_LARGE: "The worklog file exceeds the safe read limit.",
  WORKLOG_UNAVAILABLE: "The worklog file could not be read safely.",
  QUESTIONS_TOO_MANY_LINES:
    "The questions file has more lines than the reader permits.",
  QUESTIONS_LINE_TOO_LONG: "A questions line exceeds the safe parsing limit.",
  QUESTIONS_EMPTY: "The questions file contains no entries.",
  QUESTIONS_TOO_MANY_ENTRIES:
    "The questions file has more entries than are retained.",
  QUESTIONS_MALFORMED_ENTRY:
    "A question heading does not match the protocol format.",
  QUESTIONS_INCOMPLETE_ENTRY:
    "An open question is missing required protocol fields.",
  QUESTIONS_DUPLICATE_ID:
    "The same question identifier appears more than once.",
  QUESTIONS_INVALID_UTF8: "The questions file is not valid UTF-8 text.",
  QUESTIONS_MISSING: "The questions file is missing.",
  QUESTIONS_TOO_LARGE: "The questions file exceeds the safe read limit.",
  QUESTIONS_UNAVAILABLE: "The questions file could not be read safely.",
  STATE_INVALID_FIELD:
    "A state field has an invalid value and was not trusted.",
  STATE_INVALID_UTF8: "The state file is not valid UTF-8 text.",
  STATE_INVALID_JSON: "The state file is not valid JSON.",
  STATE_INVALID_ROOT: "The state file does not contain a JSON object.",
  STATE_MISSING: "The state file is missing.",
  STATE_TOO_LARGE: "The state file exceeds the safe read limit.",
  STATE_UNAVAILABLE: "The state file could not be read safely.",
  LOG_NARRATION_TRUNCATED:
    "Older narration was omitted to keep the log tail bounded.",
  LOG_LINE_TOO_LONG: "A log line was shortened to the safe display limit.",
  LOG_LINES_TRUNCATED: "Older log lines were omitted from the narration tail.",
  LOG_INVALID_UTF8: "A selected log is not valid UTF-8 text.",
  LOG_INVALID_DURATION:
    "A log timestamp could not support a trustworthy duration.",
  LOG_CHANGED_DURING_READ:
    "A selected log changed while its snapshot was read.",
  LOGS_MISSING: "The factory logs directory is missing.",
  LOG_NAME_INVALID: "A log name resembles a factory log but is not recognized.",
  LOG_UNAVAILABLE: "A selected log could not be read safely.",
  DRIVER_LOG_MISSING: "No recognized driver log is available for liveness.",
  LOGS_EMPTY: "No recognized factory logs are available.",
  LOGS_UNAVAILABLE: "The factory logs directory could not be read safely.",
  ROUTING_INVALID_UTF8: "The routing file is not valid UTF-8 text.",
  ROUTING_INVALID_JSON: "The routing file is not valid JSON.",
  ROUTING_INVALID_ROOT: "The routing file does not contain a JSON object.",
  ROUTING_UNSUPPORTED_SCHEMA:
    "The routing file uses an unsupported schema version.",
  ROUTING_INVALID_FIELD: "A required routing field has an invalid value.",
  ROUTING_TOO_MANY_AGENTS:
    "The routing file has more agents than are retained.",
  ROUTING_INVALID_AGENT: "An agent routing entry has an invalid value.",
  ROUTING_TOO_MANY_MODELS:
    "The routing file has more model metadata entries than are retained.",
  ROUTING_INVALID_MODEL: "A routing model metadata entry has an invalid value.",
  ROUTING_MISSING: "The routing file is missing.",
  ROUTING_TOO_LARGE: "The routing file exceeds the safe read limit.",
  ROUTING_UNAVAILABLE: "The routing file could not be read safely.",
  COSTS_INVALID_UTF8: "The costs file is not valid UTF-8 text.",
  COSTS_INVALID_JSON: "The costs file is not valid JSON.",
  COSTS_INVALID_ROOT: "The costs file does not contain a JSON object.",
  COSTS_UNSUPPORTED_SCHEMA:
    "The costs file uses an unsupported schema version.",
  COSTS_INVALID_FIELD: "A required cost field has an invalid value.",
  COSTS_UNSUPPORTED_CURRENCY: "The costs file is not denominated in USD.",
  COSTS_TOO_MANY_TASKS:
    "The costs file has more task entries than are retained.",
  COSTS_INVALID_TASK: "A task cost entry has an invalid value.",
  COSTS_TOO_MANY_MODELS: "A task has more model entries than are retained.",
  COSTS_INVALID_MODEL: "A model cost entry has an invalid value.",
  COSTS_MISSING: "The costs file is missing.",
  COSTS_TOO_LARGE: "The costs file exceeds the safe read limit.",
  COSTS_UNAVAILABLE: "The costs file could not be read safely.",
  REPOSITORY_WARNING: "The repository snapshot is incomplete.",
});

export const UNKNOWN_WARNING_EXPLANATION =
  "This source reported a warning that this dashboard does not yet recognize.";

function boundedWarningExcerpt(value) {
  const codePoints = [...value];
  return codePoints.length <= MAX_WARNING_EXCERPT_CODE_POINTS
    ? value
    : `${codePoints.slice(0, MAX_WARNING_EXCERPT_CODE_POINTS - 1).join("")}…`;
}

function collectWarnings(repository) {
  const warnings = [];
  if (typeof repository.warning === "string") {
    warnings.push({
      source: "repository",
      code: "REPOSITORY_WARNING",
      line: undefined,
      excerpt: boundedWarningExcerpt(repository.warning),
    });
  }
  for (const [source, result] of [
    ["state", repository.state],
    ["plan", repository.plan],
    ["questions", repository.questions],
    ["worklog", repository.worklog],
    ["logs", repository.logs],
    ["routing", repository.routing],
    ["costs", repository.costs],
  ]) {
    if (!Array.isArray(result?.warnings)) continue;
    for (const warning of result.warnings) {
      warnings.push({
        source,
        code: warning.code,
        line: warning.line,
        excerpt: warning.excerpt,
      });
    }
  }
  const grouped = new Map();
  for (const warning of warnings) {
    const key = `${warning.source}\u0000${warning.code}\u0000${warning.line ?? ""}`;
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { ...warning, count: 1 });
  }
  return [...grouped.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      (left.line ?? Number.MAX_SAFE_INTEGER) -
        (right.line ?? Number.MAX_SAFE_INTEGER) ||
      left.code.localeCompare(right.code),
  );
}

function warningsShouldOpen(repository, warnings) {
  if (typeof repository.warning === "string") return true;
  for (const result of [
    repository.state,
    repository.plan,
    repository.questions,
    repository.worklog,
    repository.logs,
    repository.routing,
    repository.costs,
  ]) {
    if (result?.status === "unavailable") return true;
  }
  if (warnings.some((warning) => warning.code.includes("TRUNCATED"))) {
    return true;
  }
  return !warnings.every(
    (warning) =>
      ["plan", "worklog"].includes(warning.source) &&
      WARNING_EXPLANATIONS[warning.code] !== undefined,
  );
}

function renderWarnings(card, repository, disclosure) {
  const warnings = collectWarnings(repository);
  if (warnings.length === 0) return;
  const documentRoot = card.ownerDocument;
  const panel = documentRoot.createElement("section");
  panel.className = "panel warnings-panel panel-span-4";
  const details = documentRoot.createElement("details");
  details.open =
    disclosure.warningsOpen ?? warningsShouldOpen(repository, warnings);
  details.addEventListener("toggle", () => {
    disclosure.warningsOpen = details.open;
  });
  const summary = documentRoot.createElement("summary");
  appendText(
    summary,
    "h4",
    `Warnings · ${warnings.length} · from this snapshot`,
  );
  details.append(summary);
  const list = documentRoot.createElement("ul");
  list.className = "warning-list";
  for (const warning of warnings) {
    const item = documentRoot.createElement("li");
    item.className = "warning-row";
    appendText(item, "span", warning.source, "warning-source");
    appendText(item, "code", warning.code, "warning-code");
    if (warning.line !== undefined) {
      appendText(item, "span", `line ${warning.line}`, "warning-line");
    }
    if (warning.count > 1) {
      appendText(item, "span", `×${warning.count}`, "warning-count");
    }
    appendText(
      item,
      "p",
      WARNING_EXPLANATIONS[warning.code] ?? UNKNOWN_WARNING_EXPLANATION,
      "warning-explanation",
    );
    if (warning.excerpt !== undefined) {
      appendText(item, "pre", warning.excerpt, "warning-excerpt");
    }
    list.append(item);
  }
  details.append(list);
  panel.append(details);
  card.append(panel);
}

export function providerCategory(provider) {
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
    (repository) =>
      repository.routing && repository.routing.status !== "unavailable",
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

function renderRepository(repository, machine, documentRoot, now, generatedAt) {
  const disclosure = disclosureState(documentRoot, machine, repository.name);
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
  renderTasks(card, repository ?? {}, disclosure);
  renderQuestions(card, repository ?? {});
  renderWorklog(card, repository ?? {}, disclosure);
  renderLogs(card, repository ?? {}, now, generatedAt);
  renderWarnings(card, repository ?? {}, disclosure);
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
  if (
    !value.warnings.every(
      (warning) =>
        isRecord(warning) &&
        typeof warning.code === "string" &&
        typeof warning.message === "string" &&
        (warning.line === undefined ||
          (Number.isSafeInteger(warning.line) && warning.line > 0)) &&
        (warning.excerpt === undefined ||
          (typeof warning.excerpt === "string" &&
            [...warning.excerpt].length <= MAX_WARNING_EXCERPT_CODE_POINTS)),
    )
  ) {
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

function isBoundedRoutingModelString(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ROUTING_MODEL_STRING_LENGTH
  );
}

function isRoutingModel(value) {
  return (
    isRecord(value) &&
    (value.source === "models.dev" || value.source === null) &&
    [value.pricesAsOf, value.name, value.family, value.releaseDate].every(
      isBoundedRoutingModelString,
    ) &&
    [value.contextWindow, value.maxOutputTokens].every(
      (limit) => Number.isSafeInteger(limit) && limit >= 0,
    ) &&
    isRecord(value.pricePerMillion) &&
    NOTIONAL_COMPONENTS.every(
      (component) =>
        value.pricePerMillion[component] === null ||
        (typeof value.pricePerMillion[component] === "number" &&
          Number.isFinite(value.pricePerMillion[component]) &&
          value.pricePerMillion[component] >= 0),
    )
  );
}

function isRoutingModels(value) {
  if (!isRecord(value) || Object.keys(value).length > MAX_ROUTING_MODELS) {
    return false;
  }
  return Object.entries(value).every(
    ([id, model]) =>
      isBoundedRoutingModelString(id) &&
      isRoutingModelId(id) &&
      isRoutingModel(model),
  );
}

function isRoutingData(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isRoutingTimestamp(value.recordedAt) ||
    !isRoutingModelId(value.model) ||
    !isRoutingModelId(value.smallModel) ||
    !isRecord(value.agents) ||
    (value.models !== undefined && !isRoutingModels(value.models))
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

function isCostTokens(value) {
  return (
    isRecord(value) &&
    ["input", "output", "reasoning", "cacheRead", "cacheWrite"].every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        value[key] >= 0,
    )
  );
}

function isCostCounters(value) {
  return (
    isRecord(value) &&
    ["usd", "messages", "sessions"].every(
      (key) =>
        typeof value[key] === "number" &&
        Number.isFinite(value[key]) &&
        value[key] >= 0,
    ) &&
    isCostTokens(value.tokens)
  );
}

function isCostsData(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isTimestamp(value.recordedAt) ||
    value.currency !== "USD" ||
    !isRecord(value.tasks) ||
    Object.keys(value.tasks).length > MAX_COST_TASKS
  ) {
    return false;
  }
  return Object.entries(value.tasks).every(([taskId, task]) => {
    if (
      (taskId !== "unattributed" && !/^T[1-9][0-9]*$/.test(taskId)) ||
      !isCostCounters(task) ||
      !isTimestamp(task.firstAt) ||
      !isTimestamp(task.lastAt) ||
      !isRecord(task.byModel) ||
      Object.keys(task.byModel).length > MAX_COST_MODELS_PER_TASK
    ) {
      return false;
    }
    return Object.entries(task.byModel).every(
      ([model, counters]) =>
        model.length > 0 &&
        model.length <= 1024 &&
        model.includes("/") &&
        isCostCounters(counters),
    );
  });
}

function isCostsResult(value) {
  return (
    isReaderResult(value) &&
    (value.status === "unavailable" || isCostsData(value.data))
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
    (value.costs === undefined || isCostsResult(value.costs)) &&
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

export async function readFleetResponse(response) {
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
    cost: "Unavailable",
  };
}

function repositoryCostData(repository) {
  return readerData(repository.costs)?.tasks;
}

function meteredTotal(repositories) {
  if (repositories.length === 0) return { text: "Unavailable" };
  let total = 0;
  let contributors = 0;
  const missingNames = [];
  for (const repository of repositories) {
    const tasks = repositoryCostData(repository);
    if (!tasks) {
      missingNames.push(repository.name ?? "Unknown repository");
      continue;
    }
    contributors += 1;
    for (const counters of Object.values(tasks)) {
      if (isCostCounters(counters)) {
        total += counters.usd;
        if (!Number.isFinite(total)) return { text: "Unavailable" };
      }
    }
  }
  if (contributors === 0) {
    return {
      text: "Unavailable",
      title: `Unavailable repositories: ${missingNames.join(", ")}`,
    };
  }
  const coverage =
    contributors < repositories.length
      ? ` (${contributors} of ${repositories.length} repos)`
      : "";
  return {
    text: `${formatUsd(total)}${coverage}`,
    title: missingNames.length
      ? `Unavailable repositories: ${missingNames.join(", ")}`
      : undefined,
  };
}

function notionalTotal(repositories) {
  if (repositories.length === 0) return undefined;
  let usd = 0;
  let partial = false;
  const pricesAsOf = new Set();
  let priced = false;
  let contributors = 0;
  const missingNames = [];
  for (const repository of repositories) {
    const tasks = repositoryCostData(repository);
    if (!tasks) {
      missingNames.push(repository.name ?? "Unknown repository");
      continue;
    }
    contributors += 1;
    const routing = readerData(repository.routing);
    for (const counters of Object.values(tasks)) {
      const notional = taskNotional(counters, routing);
      if (notional === undefined) return undefined;
      if (notional === null) continue;
      usd += notional.usd;
      if (!Number.isFinite(usd)) return undefined;
      priced = true;
      partial ||= notional.partial;
      notional.pricesAsOf.forEach((date) => pricesAsOf.add(date));
    }
  }
  if (contributors === 0) return undefined;
  return priced
    ? {
        usd,
        partial,
        pricesAsOf: [...pricesAsOf].sort(),
        contributors,
        repositories: repositories.length,
        missingNames,
      }
    : null;
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

function summarizeMachine(name, fleet, now, intervalMilliseconds = 30_000) {
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
  const cost = meteredTotal(repositories);
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
    age:
      now.valueOf() - new Date(fleet.generatedAt).valueOf() >
      intervalMilliseconds
        ? displayAge(fleet.generatedAt, now)
        : "",
    cost: cost.text,
    costTitle: cost.title,
    notional: notionalLabel(notionalTotal(repositories)),
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
  const costCell = textElement(
    documentRoot,
    "td",
    summary.cost,
    "cost-total metered-total",
  );
  if (summary.costTitle) costCell.title = summary.costTitle;
  if (summary.notional) {
    costCell.textContent = `${summary.cost} metered`;
    const notional = appendText(
      costCell,
      "span",
      summary.notional.text,
      "notional-total",
    );
    notional.title = summary.notional.title;
  }
  row.replaceChildren(
    textElement(documentRoot, "th", summary.name),
    livenessCell,
    textElement(documentRoot, "td", summary.currentTask),
    textElement(documentRoot, "td", summary.pullRequest),
    holdCell,
    textElement(documentRoot, "td", summary.questions),
    textElement(
      documentRoot,
      "td",
      summary.age,
      `age${summary.age && summary.age !== "Unavailable" ? " stale" : ""}`,
    ),
    costCell,
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

function worklogAge(repository, now) {
  const entries = readerData(repository.worklog)?.entries;
  if (!Array.isArray(entries)) return "Unknown";
  if (entries.length === 0) return "None";
  const entry = entries.at(-1);
  if (typeof entry?.date !== "string") return "Unknown";
  const time = typeof entry.time === "string" ? entry.time : "00:00";
  return displayAge(`${entry.date}T${time}:00.000Z`, now);
}

function summarizeRepository(repository, now) {
  const state = readerData(repository.state);
  const questions = readerData(repository.questions)?.open;
  const costTasks = repositoryCostData(repository);
  const unattributed = costLabel(costTasks?.unattributed);
  const notional = notionalLabel(notionalTotal([repository]));
  const cost = meteredTotal([repository]);
  return {
    name: repository.name ?? "Unknown repository",
    availability:
      repository.status === "available" ? "AVAILABLE" : "UNAVAILABLE",
    liveness: repository.liveness?.state ?? "CANNOT_VERIFY",
    currentTask: displayOptional(state?.currentTask),
    pullRequest:
      state?.pr === undefined
        ? "Unknown"
        : state.pr === null
          ? "None"
          : `PR #${state.pr}`,
    hold: state?.hold === true,
    questions: Array.isArray(questions) ? String(questions.length) : "Unknown",
    age: worklogAge(repository, now),
    cost: cost.text,
    costTitle: cost.title,
    notional,
    unattributed: unattributed?.text ?? (costTasks ? "None" : "Unavailable"),
    unattributedTitle: unattributed?.title,
  };
}

function renderRepositorySummaryRow(row, summary) {
  const documentRoot = row.ownerDocument;
  const availabilityCell = documentRoot.createElement("td");
  appendText(
    availabilityCell,
    "span",
    summary.availability,
    `status ${summary.availability === "AVAILABLE" ? "available" : "unavailable"}`,
  );
  const livenessCell = documentRoot.createElement("td");
  appendText(
    livenessCell,
    "span",
    summary.liveness,
    `liveness ${livenessClass(summary.liveness)}`,
  );
  const holdCell = documentRoot.createElement("td");
  if (summary.hold) appendText(holdCell, "span", "HELD", "badge held-badge");
  const unattributedCell = textElement(
    documentRoot,
    "td",
    summary.unattributed,
    "cost-unattributed",
  );
  if (summary.unattributedTitle)
    unattributedCell.title = summary.unattributedTitle;
  const costCell = textElement(
    documentRoot,
    "td",
    summary.cost,
    "cost-total metered-total",
  );
  if (summary.costTitle) costCell.title = summary.costTitle;
  if (summary.notional) {
    costCell.textContent = `${summary.cost} metered`;
    const notional = appendText(
      costCell,
      "span",
      summary.notional.text,
      "notional-total",
    );
    notional.title = summary.notional.title;
  }
  row.replaceChildren(
    textElement(documentRoot, "th", summary.name),
    availabilityCell,
    livenessCell,
    textElement(documentRoot, "td", summary.currentTask),
    textElement(documentRoot, "td", summary.pullRequest),
    holdCell,
    textElement(documentRoot, "td", summary.questions),
    textElement(documentRoot, "td", summary.age, "age"),
    costCell,
    unattributedCell,
  );
  row.firstElementChild.scope = "row";
}

function createRepositorySummary(documentRoot) {
  const scroll = documentRoot.createElement("div");
  const table = documentRoot.createElement("table");
  const head = documentRoot.createElement("thead");
  const headingRow = documentRoot.createElement("tr");
  const body = documentRoot.createElement("tbody");
  scroll.className = "table-scroll repository-summary-scroll";
  table.className = "repository-summary";
  for (const heading of [
    "Repository",
    "Status",
    "Liveness",
    "Current task",
    "PR",
    "Hold",
    "Questions",
    "Worklog age",
    "Total cost",
    "Unattributed",
  ]) {
    const cell = textElement(documentRoot, "th", heading);
    cell.scope = "col";
    headingRow.append(cell);
  }
  head.append(headingRow);
  table.append(head, body);
  scroll.append(table);
  return { scroll, body };
}

function createRepositoryView(
  repository,
  machine,
  machineIndex,
  index,
  documentRoot,
  now,
  generatedAt,
) {
  const summary = summarizeRepository(repository, now);
  const row = documentRoot.createElement("tr");
  const tab = documentRoot.createElement("button");
  const panel = documentRoot.createElement("section");
  const tabId = `repository-tab-${machineIndex}-${index}`;
  const panelId = `repository-panel-${machineIndex}-${index}`;
  renderRepositorySummaryRow(row, summary);
  tab.type = "button";
  tab.id = tabId;
  tab.className = "repository-tab";
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-controls", panelId);
  tab.setAttribute("aria-selected", "false");
  tab.tabIndex = -1;
  renderTabLabel(tab, summary);
  panel.id = panelId;
  panel.className = "repository-panel";
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", tabId);
  panel.hidden = true;
  panel.append(
    renderRepository(repository, machine, documentRoot, now, generatedAt),
  );
  return { identity: repository.name, row, tab, panel };
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
  return { identity, index, row, tab, panel, routing, grid, repositories: [] };
}

function updateMachineView(view, summary, fleet, now, unreachable = false) {
  renderSummaryRow(view.row, summary);
  renderTabLabel(view.tab, summary);
  const routing = renderRoutingStrip(fleet, view.grid.ownerDocument);
  view.routing.replaceWith(routing);
  view.routing = routing;
  if (unreachable) {
    view.repositories = [];
    view.grid.replaceChildren(
      textElement(view.grid.ownerDocument, "p", "UNREACHABLE", "unreachable"),
    );
    return;
  }
  if (!fleet) {
    view.repositories = [];
    view.grid.replaceChildren(
      textElement(view.grid.ownerDocument, "p", "Unavailable", "unavailable"),
    );
    return;
  }
  const documentRoot = view.grid.ownerDocument;
  const repositorySummary = createRepositorySummary(documentRoot);
  const repositoryTabs = documentRoot.createElement("div");
  const repositoryPanels = documentRoot.createElement("div");
  repositoryTabs.className = "repository-tabs";
  repositoryTabs.setAttribute("role", "tablist");
  repositoryTabs.setAttribute("aria-label", "Repositories");
  repositoryPanels.className = "repository-panels";
  view.repositories = fleet.repositories.map((repository, index) =>
    createRepositoryView(
      repository,
      view.identity,
      view.index,
      index,
      documentRoot,
      now,
      fleet.generatedAt,
    ),
  );
  repositorySummary.body.replaceChildren(
    ...view.repositories.map((repository) => repository.row),
  );
  repositoryTabs.replaceChildren(
    ...view.repositories.map((repository) => repository.tab),
  );
  repositoryPanels.replaceChildren(
    ...view.repositories.map((repository) => repository.panel),
  );
  view.grid.replaceChildren(
    repositorySummary.scroll,
    repositoryTabs,
    repositoryPanels,
  );
}

function dashboardHash(machine, repository) {
  const values = { machine };
  if (repository !== undefined) values.repo = repository;
  return `#${new URLSearchParams(values).toString()}`;
}

function hashSelection(windowRoot) {
  const values = new URLSearchParams(
    windowRoot?.location?.hash?.slice(1) ?? "",
  );
  return { machine: values.get("machine"), repository: values.get("repo") };
}

function installTabs(documentRoot, views) {
  tabControllers.get(documentRoot)?.cleanup();
  const windowRoot = documentRoot.defaultView;
  const listeners = [];

  function repositoryIndex(view, identity) {
    const index = view.repositories.findIndex(
      (repository) => repository.identity === identity,
    );
    return index >= 0 ? index : 0;
  }

  function selectRepository(view, index, focus = false) {
    view.repositories.forEach((repository, repositoryIndex) => {
      const selected = repositoryIndex === index;
      repository.tab.setAttribute("aria-selected", String(selected));
      repository.tab.tabIndex = selected ? 0 : -1;
      repository.panel.hidden = !selected;
    });
    if (focus) view.repositories[index]?.tab.focus();
  }

  function selectedRepository(view) {
    return view.repositories.find(
      (repository) => repository.tab.getAttribute("aria-selected") === "true",
    );
  }

  function select(
    index,
    repositoryIdentity,
    updateHash = false,
    focus = false,
  ) {
    views.forEach((view, viewIndex) => {
      const selected = viewIndex === index;
      view.tab.setAttribute("aria-selected", String(selected));
      view.tab.tabIndex = selected ? 0 : -1;
      view.panel.hidden = !selected;
    });
    if (focus) views[index].tab.focus();
    const view = views[index];
    if (view.repositories.length > 0) {
      selectRepository(view, repositoryIndex(view, repositoryIdentity));
    }
    if (updateHash && windowRoot?.location) {
      windowRoot.location.hash = dashboardHash(
        view.identity,
        selectedRepository(view)?.identity,
      );
    }
  }

  function selectFromHash(canonicalize) {
    const selection = hashSelection(windowRoot);
    const foundIndex = views.findIndex(
      (view) => view.identity === selection.machine,
    );
    const index = foundIndex >= 0 ? foundIndex : 0;
    const view = views[index];
    const foundRepository = view.repositories.some(
      (repository) => repository.identity === selection.repository,
    );
    select(index, foundRepository ? selection.repository : undefined);
    if (
      canonicalize &&
      (foundIndex < 0 || (view.repositories.length > 0 && !foundRepository)) &&
      windowRoot?.history
    ) {
      windowRoot.history.replaceState(
        null,
        "",
        `${windowRoot.location.pathname}${windowRoot.location.search}${dashboardHash(
          view.identity,
          selectedRepository(view)?.identity,
        )}`,
      );
    }
  }

  views.forEach((view, index) => {
    const onClick = () => select(index, undefined, true);
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
      select(targetIndex, undefined, true, true);
    };
    view.tab.addEventListener("click", onClick);
    view.tab.addEventListener("keydown", onKeyDown);
    listeners.push(
      [view.tab, "click", onClick],
      [view.tab, "keydown", onKeyDown],
    );
    view.repositories.forEach((repository, repositoryPosition) => {
      const onRepositoryClick = () => {
        selectRepository(view, repositoryPosition);
        if (windowRoot?.location) {
          windowRoot.location.hash = dashboardHash(
            view.identity,
            repository.identity,
          );
        }
      };
      const onRepositoryKeyDown = (event) => {
        let targetIndex;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          targetIndex = (repositoryPosition + 1) % view.repositories.length;
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          targetIndex =
            (repositoryPosition - 1 + view.repositories.length) %
            view.repositories.length;
        } else if (event.key === "Enter" || event.key === " ") {
          targetIndex = repositoryPosition;
        } else {
          return;
        }
        event.preventDefault();
        selectRepository(view, targetIndex, true);
        windowRoot.location.hash = dashboardHash(
          view.identity,
          view.repositories[targetIndex].identity,
        );
      };
      repository.tab.addEventListener("click", onRepositoryClick);
      repository.tab.addEventListener("keydown", onRepositoryKeyDown);
      listeners.push(
        [repository.tab, "click", onRepositoryClick],
        [repository.tab, "keydown", onRepositoryKeyDown],
      );
    });
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
  const intervalMilliseconds =
    loadStates.get(documentRoot)?.refreshIntervalMilliseconds ?? 30_000;

  machine.textContent = fleet?.hostname ?? "Local machine";
  updateSnapshotStatus(
    documentRoot,
    {
      lastGoodGeneratedAt: fleet?.generatedAt,
      refreshIntervalMilliseconds: intervalMilliseconds,
    },
    now,
  );
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
        ? summarizeMachine(
            view.identity,
            machines[index].fleet,
            now,
            intervalMilliseconds,
          )
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

export async function fetchPeerFleet(peer, fetcher, dependencyOverrides = {}) {
  const setTimeout =
    dependencyOverrides.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeout =
    dependencyOverrides.clearTimeout ??
    globalThis.clearTimeout.bind(globalThis);
  const controller = new AbortController();
  let timeout;
  const timeoutFailure = new Promise((_, reject) => {
    timeout = setTimeout(() => {
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
    clearTimeout(timeout);
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
  let peerTimedOut = false;
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
            summarizeMachine(
              peer.name,
              fleet,
              now,
              loadStates.get(documentRoot)?.refreshIntervalMilliseconds ??
                30_000,
            ),
            fleet,
            now,
          );
          installTabs(documentRoot, views);
        }
      } catch (cause) {
        if (
          cause instanceof Error &&
          cause.message === "Peer request timed out"
        ) {
          peerTimedOut = true;
        }
        if (loadGenerations.get(documentRoot) === generation) {
          updateMachineView(
            views[index + 1],
            unavailableSummary(peer.name),
            null,
            dependencies.now(),
            true,
          );
          installTabs(documentRoot, views);
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
  return peerTimedOut;
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
    setTimeout:
      dependencyOverrides.setTimeout ?? globalThis.setTimeout.bind(globalThis),
    clearTimeout:
      dependencyOverrides.clearTimeout ??
      globalThis.clearTimeout.bind(globalThis),
    now: dependencyOverrides.now ?? (() => new Date()),
  };
  const state = loadStates.get(documentRoot) ?? {
    lastGoodGeneratedAt: undefined,
    lastError: undefined,
    refreshIntervalMilliseconds: 30_000,
    paused: false,
    peerTimedOut: false,
  };
  loadStates.set(documentRoot, state);
  const refreshing = machineViews.has(documentRoot);
  const scroll = {
    repositoriesTop: repositories?.scrollTop ?? 0,
    repositoriesLeft: repositories?.scrollLeft ?? 0,
    windowX: documentRoot.defaultView?.scrollX ?? 0,
    windowY: documentRoot.defaultView?.scrollY ?? 0,
  };
  const generation = (loadGenerations.get(documentRoot) ?? 0) + 1;
  loadGenerations.set(documentRoot, generation);
  if (!refreshing) {
    tabControllers.get(documentRoot)?.cleanup();
    tabControllers.delete(documentRoot);
    machineViews.delete(documentRoot);
    if (machine) machine.textContent = "Loading local machine…";
    if (generated) generated.textContent = "Waiting for snapshot…";
    if (error) error.textContent = "";
    documentRoot.querySelector("#fleet-summary tbody")?.replaceChildren();
    documentRoot.querySelector("#machine-tabs")?.replaceChildren();
    repositories?.replaceChildren();
  }
  try {
    const response = await fetcher("/api/fleet");
    const fleet = await readFleetResponse(response);
    if (loadGenerations.get(documentRoot) !== generation) return false;
    renderFleet(fleet, documentRoot, dependencies.now());
    state.lastGoodGeneratedAt = fleet.generatedAt;
    state.lastError = undefined;
    state.peerTimedOut = false;
    if (repositories) {
      repositories.scrollTop = scroll.repositoriesTop;
      repositories.scrollLeft = scroll.repositoriesLeft;
    }
    const windowRoot = documentRoot.defaultView;
    if (
      (scroll.windowX !== 0 || scroll.windowY !== 0) &&
      typeof windowRoot?.scrollTo === "function"
    ) {
      windowRoot.scrollTo(scroll.windowX, scroll.windowY);
    }
    const views = machineViews.get(documentRoot);
    if (!views) return true;
    const peerTimedOut = await fanOutToPeers(
      fleet.peers,
      views,
      documentRoot,
      fetcher,
      dependencies,
      generation,
    );
    if (loadGenerations.get(documentRoot) !== generation) return false;
    state.peerTimedOut = peerTimedOut;
    updateSnapshotStatus(documentRoot, state, dependencies.now());
    return true;
  } catch (cause) {
    if (loadGenerations.get(documentRoot) !== generation) return false;
    state.lastError = cause instanceof Error ? cause.message : "Request failed";
    if (refreshing) {
      updateSnapshotStatus(documentRoot, state, dependencies.now());
    } else {
      if (machine) machine.textContent = "Local machine unavailable";
      repositories?.replaceChildren();
      if (error) error.textContent = state.lastError;
    }
    return false;
  }
}

function refreshSeconds(windowRoot) {
  const value = new URLSearchParams(windowRoot?.location?.search ?? "").get(
    "refresh",
  );
  if (!value || !/^[0-9]+$/.test(value)) return 30;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 3600
    ? seconds
    : 30;
}

export function startDashboard(
  documentRoot = document,
  fetcher = fetch,
  dependencyOverrides = {},
) {
  dashboardControllers.get(documentRoot)?.cleanup();
  const dependencies = {
    setTimeout:
      dependencyOverrides.setTimeout ?? globalThis.setTimeout.bind(globalThis),
    clearTimeout:
      dependencyOverrides.clearTimeout ??
      globalThis.clearTimeout.bind(globalThis),
    setInterval:
      dependencyOverrides.setInterval ??
      globalThis.setInterval.bind(globalThis),
    clearInterval:
      dependencyOverrides.clearInterval ??
      globalThis.clearInterval.bind(globalThis),
    now: dependencyOverrides.now ?? (() => new Date()),
  };
  const intervalMilliseconds = refreshSeconds(documentRoot.defaultView) * 1_000;
  const state = loadStates.get(documentRoot) ?? {};
  state.refreshIntervalMilliseconds = intervalMilliseconds;
  state.paused = documentRoot.hidden;
  loadStates.set(documentRoot, state);
  let refreshTimer;
  let ageTimer;
  let inFlight = false;
  let failures = 0;

  const clearRefreshTimer = () => {
    if (refreshTimer !== undefined) dependencies.clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };
  const schedule = (milliseconds) => {
    clearRefreshTimer();
    if (!documentRoot.hidden) {
      refreshTimer = dependencies.setTimeout(
        () => void refresh(),
        milliseconds,
      );
    }
  };
  const refresh = async () => {
    if (inFlight || documentRoot.hidden) return;
    inFlight = true;
    clearRefreshTimer();
    const success = await loadFleet(documentRoot, fetcher, dependencies);
    inFlight = false;
    if (success) {
      failures = 0;
      schedule(intervalMilliseconds);
    } else {
      failures += 1;
      schedule(Math.min(300, 30 * 2 ** failures) * 1_000);
    }
  };
  const onVisibilityChange = () => {
    state.paused = documentRoot.hidden;
    updateSnapshotStatus(documentRoot, state, dependencies.now());
    if (documentRoot.hidden) clearRefreshTimer();
    else void refresh();
  };
  const onRefreshClick = () => void refresh();
  documentRoot.addEventListener("visibilitychange", onVisibilityChange);
  documentRoot
    .querySelector("#refresh")
    ?.addEventListener("click", onRefreshClick);
  ageTimer = dependencies.setInterval(() => {
    const state = loadStates.get(documentRoot);
    if (state) updateSnapshotStatus(documentRoot, state, dependencies.now());
  }, 1_000);
  const controller = {
    cleanup() {
      clearRefreshTimer();
      if (ageTimer !== undefined) dependencies.clearInterval(ageTimer);
      documentRoot.removeEventListener("visibilitychange", onVisibilityChange);
      documentRoot
        .querySelector("#refresh")
        ?.removeEventListener("click", onRefreshClick);
    },
  };
  dashboardControllers.set(documentRoot, controller);
  void refresh();
  return controller;
}

// Auto-load when running in a real browser with a dashboard
if (
  typeof window !== "undefined" &&
  window.document?.querySelector("#repositories")
) {
  startDashboard();
}
