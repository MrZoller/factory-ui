export const PEER_FETCH_TIMEOUT_MS = 5_000;
export const ANSWER_FETCH_TIMEOUT_MS = 5_000;
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
const MAX_PLAN_TASKS = 256;
const MAX_TASK_DEPENDENCIES = 32;
const MAX_DEPENDENCY_GRAPH_TASKS = MAX_PLAN_TASKS;
const MAX_COST_MODELS_PER_TASK = 64;
const MAX_METRICS_TASKS = 4096;
const MAX_METRICS_MAP_ENTRIES = 64;
const MAX_METRICS_KEY_LENGTH = 128;
const MAX_WARNING_EXCERPT_CODE_POINTS = 200;
const MAX_QUESTIONS = 128;
const MAX_QUESTION_QUEUE_ENTRIES = 256;
const MAX_QUESTION_TEXT_LENGTH = 256 * 1024;
const MAX_QUESTION_OPTIONS = 26;
const MAX_QUESTION_OPTION_LENGTH = 8192;
const MAX_QUESTION_FILED_AT_LENGTH = 64;
const MAX_ANSWER_TEXT_LENGTH = 10_000;
const MAX_ANSWER_RESPONSE_BYTES = 64 * 1024;
const MAX_STORED_ANSWER_LIFECYCLES = 128;
export const ANSWER_POLL_INTERVAL_MS = 5_000;
const ANSWER_STORAGE_KEY = "factory-ui.answer-lifecycle.v1";
const ANSWER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/;
const COMPLETED_TASK_LIMIT = 8;
const loadGenerations = new WeakMap();
const tabControllers = new WeakMap();
const machineViews = new WeakMap();
const loadStates = new WeakMap();
const dashboardControllers = new WeakMap();
const disclosureStates = new WeakMap();
const answerStores = new WeakMap();
const answerRuntimes = new WeakMap();

function disclosureState(documentRoot, machine, repository) {
  let machines = disclosureStates.get(documentRoot);
  if (!machines) disclosureStates.set(documentRoot, (machines = new Map()));
  let repositories = machines.get(machine);
  if (!repositories) machines.set(machine, (repositories = new Map()));
  let state = repositories.get(repository);
  if (!state) {
    state = {};
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

function displayCoarseAge(value, now) {
  if (typeof value !== "string") return "Unknown";
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) return "Unknown";
  const minutes = Math.floor(
    Math.max(0, now.valueOf() - timestamp) / (60 * 1_000),
  );
  if (minutes < 1) return "less than 1m ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function replaceText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function updateSnapshotStatus(documentRoot, state, now) {
  const generated = documentRoot.querySelector("#generated");
  if (generated && state.lastGoodGeneratedAt) {
    const stale =
      now.valueOf() - new Date(state.lastGoodGeneratedAt).valueOf() >
      state.refreshIntervalMilliseconds;
    const reason = state.lastError
      ? "refresh failed"
      : state.paused
        ? "paused"
        : state.peerTimedOut
          ? "peer timed out"
          : stale
            ? "snapshot too old"
            : undefined;
    if (generated.classList.contains("stale") !== stale) {
      generated.classList.toggle("stale", stale);
    }
    replaceText(
      generated,
      stale
        ? `Stale · last good snapshot ${displayCoarseAge(state.lastGoodGeneratedAt, now)} (${displayTime(state.lastGoodGeneratedAt)}) — ${reason}`
        : `Updated ${displayTime(state.lastGoodGeneratedAt)}${reason ? ` — ${reason}` : ""}`,
    );
  }
  if (state.lastError) {
    const error = documentRoot.querySelector("#error");
    if (error) {
      const suffix = state.lastGoodGeneratedAt
        ? ` · Last good snapshot ${displayCoarseAge(state.lastGoodGeneratedAt, now)}`
        : "";
      replaceText(error, `${state.lastError}${suffix}`);
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
  heading.className = "panel-title";
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
    discussion:
      /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*#discussion_r[1-9][0-9]*$/,
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
      (kind === "discussion"
        ? !/^#discussion_r[1-9][0-9]*$/.test(url.hash)
        : url.hash !== "")
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
    /\breview wait\b|\b(?:awaiting|awaited|waiting for) (?:review|CI|checks?|bots?)\b|\bin review\b|\b(?:review|verdict)(?: is| remains)?(?: still)? (?:in[- ]flight|pending)\b|\bawaiting [^.]{0,100}\bverdict\b/i,
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
  if (raw.startsWith(prefix)) {
    return {
      raw,
      content: raw.slice(prefix.length),
      malformed: false,
      heading: false,
    };
  }
  if (time === undefined) {
    const heading = new RegExp(
      `^## ${date}(?: — | - )([^\\r\\n]+)(?:\\r?\\n|$)`,
    ).exec(raw);
    if (heading && heading[1].trim().length > 0) {
      const body = raw.slice(heading[0].length).trim();
      return {
        raw,
        content: `${heading[1]}${body ? `\n${body}` : ""}`,
        headline: heading[1],
        body,
        malformed: false,
        heading: true,
      };
    }
  }
  return { raw, content: raw, malformed: true };
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

function conciseWorklogUrlLabel(href, kind) {
  const url = new URL(href);
  if (kind === "repository") return url.pathname.slice(1);
  if (kind === "branch") return `branch ${url.pathname.split("/tree/")[1]}`;
  if (kind === "pull") return `PR #${url.pathname.split("/").at(-1)}`;
  if (kind === "issue") return `#${url.pathname.split("/").at(-1)}`;
  if (kind === "commit") return url.pathname.split("/").at(-1).slice(0, 7);
  if (kind === "discussion") {
    return `PR #${url.pathname.split("/").at(-1)} discussion`;
  }
  return url.pathname.split("/").at(-1);
}

function safeBareGithubUrl(value) {
  for (const kind of [
    "repository",
    "branch",
    "pull",
    "issue",
    "commit",
    "plan",
    "spec",
    "worklog",
    "questions",
    "discussion",
  ]) {
    const href = safeGithubUrl(value, kind);
    if (href) return { href, label: conciseWorklogUrlLabel(href, kind) };
  }
  return undefined;
}

function appendWorklogHighlight(parent, text, repositoryUrl) {
  const pattern =
    /(`[^`\n]+`|https:\/\/[^\s<>"'`]+|\bT[1-9][0-9]*\b|\bPR #[1-9][0-9]*\b|(?<![A-Za-z0-9])#[1-9][0-9]*\b|\b[0-9a-fA-F]{40}\b)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > offset)
      parent.append(
        parent.ownerDocument.createTextNode(text.slice(offset, match.index)),
      );
    const token = match[0];
    if (token.startsWith("`")) {
      appendText(parent, "code", token.slice(1, -1));
    } else if (token.startsWith("https://")) {
      let candidate = token;
      let suffix = "";
      let safeUrl = safeBareGithubUrl(candidate);
      const punctuation = /[).,;:!?]+$/.exec(candidate);
      if (punctuation) {
        const stripped = candidate.slice(0, -punctuation[0].length);
        const strippedUrl = safeBareGithubUrl(stripped);
        if (strippedUrl) {
          suffix = punctuation[0];
          candidate = stripped;
          safeUrl = strippedUrl;
        }
      }
      if (safeUrl) {
        const link = textElement(parent.ownerDocument, "a", safeUrl.label);
        link.href = safeUrl.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "worklog-reference worklog-url";
        parent.append(link);
        if (suffix) parent.append(parent.ownerDocument.createTextNode(suffix));
      } else {
        parent.append(parent.ownerDocument.createTextNode(token));
      }
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
  const panel = addPanel(card, "Current", "current-panel", "panel-span-4");
  const heading = panel.querySelector("h4");
  appendText(
    heading,
    "span",
    repository?.status === "available" ? "AVAILABLE" : "UNAVAILABLE",
    repository?.status === "available"
      ? "chip chip-good status available"
      : "chip chip-warn status unavailable",
  );
  const state = readerData(repository.state);
  const list = panel.ownerDocument.createElement("dl");
  list.className = "facts current-facts";
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
  ["Active", "active", "active-work", "panel-span-12"],
  ["In review", "review", "review-work", "panel-span-12"],
  ["Next runnable", "nextRunnable", "runnable-work", "panel-span-12"],
  ["Blocked", "blocked", "blocked-work", "panel-span-12"],
];

const COMPLETED_TASK_GROUP = [
  ["Completed", "completed", "completed-work", "panel-span-12"],
];

const SIZE_LEGEND =
  "trivial: small, skips size gates · standard: one session, merges when clean · major: PR held for review";

const SIZE_DESCRIPTIONS = {
  trivial: "small, skips size gates",
  standard: "one session, merges when clean",
  major: "PR held for review",
};

const TASK_COLUMNS = ["Task", "Title", "Size", "Cost", "Review", "Refs"];

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
    title: `notional${notional.partial ? " (partial)" : ""}: subscription lane priced at models.dev list price as of ${notional.pricesAsOf.join(", ")}; not billed${missing}`,
  };
}

function costLabel(counters) {
  if (!isCostCounters(counters)) return null;
  const tokens = tokenTotal(counters);
  const prepaid = counters.usd === 0 && tokens > 0;
  return {
    text: prepaid ? "Prepaid" : formatUsd(counters.usd),
    detail: prepaid
      ? `subscription · ${tokens.toLocaleString()} tokens`
      : `metered · ${tokens.toLocaleString()} tokens`,
    kind: prepaid ? "prepaid" : "metered",
    title: `${tokens.toLocaleString()} tokens`,
  };
}

function taskMetricDigits(taskId) {
  return /^T([1-9][0-9]*)$/.exec(taskId ?? "")?.[1];
}

function compareDecimalDigits(left, right) {
  return (
    left.length - right.length || (left > right ? 1 : left < right ? -1 : 0)
  );
}

function oldestMetricTaskDigits(metrics) {
  let oldest;
  for (const taskId of Object.keys(metrics?.tasks ?? {})) {
    const digits = taskMetricDigits(taskId);
    if (digits && (!oldest || compareDecimalDigits(digits, oldest) < 0)) {
      oldest = digits;
    }
  }
  return oldest;
}

function findingSummary(findings, classes) {
  return classes
    .filter((name) => Number.isSafeInteger(findings?.[name]))
    .map((name) => `${findings[name]} ${name}`)
    .join(" · ");
}

function renderTaskReview(cell, task, metrics, oldestDigits) {
  const taskMetrics = metrics?.tasks?.[task?.id];
  const details = [];
  if (taskMetrics?.ship) {
    if (taskMetrics.ship.internal === null) {
      appendText(
        cell,
        "span",
        "panel unknown",
        "chip chip-muted review-chip review-unknown",
      );
    } else if (taskMetrics.ship.internal) {
      const internal = taskMetrics.ship.internal;
      appendText(
        cell,
        "span",
        `panel ${internal.rounds}r`,
        "chip chip-accent review-chip review-internal",
      );
      cell.lastElementChild.title = `${findingSummary(internal.findings, ["blocking", "minor", "invalid"])} · ${internal.fixed} fixed`;
      const panelDetails = [
        ...["blocking", "minor", "invalid"]
          .filter((name) => internal.findings?.[name] > 0)
          .map((name) => `${internal.findings[name]} ${name}`),
        ...(internal.fixed > 0 ? [`${internal.fixed} fixed`] : []),
      ];
      if (panelDetails.length > 0)
        details.push(`panel: ${panelDetails.join(" · ")}`);
    }
  }
  for (const [reviewer, review] of Object.entries(
    taskMetrics?.merge?.external ?? {},
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const findings = ["blocking", "minor", "refuted"];
    const chip = appendText(
      cell,
      "span",
      `${reviewer} ${review?.rounds ?? 0}r`,
      "chip chip-info review-chip review-external",
    );
    chip.title = `${findingSummary(review?.findings, findings)} · ${review?.fixPushes ?? 0} fix pushes`;
    const reviewerDetails = [
      ...findings
        .filter((name) => review?.findings?.[name] > 0)
        .map((name) => `${review.findings[name]} ${name}`),
      ...(review?.fixPushes > 0
        ? [
            `${review.fixPushes} fix ${review.fixPushes === 1 ? "push" : "pushes"}`,
          ]
        : []),
    ];
    if (reviewerDetails.length > 0)
      details.push(`${reviewer}: ${reviewerDetails.join(" · ")}`);
  }
  if (details.length > 0)
    appendText(cell, "span", details.join("; "), "review-detail");
  const digits = taskMetricDigits(task?.id);
  if (
    task?.pr !== undefined &&
    !taskMetrics?.ship &&
    !taskMetrics?.merge &&
    digits &&
    oldestDigits &&
    compareDecimalDigits(digits, oldestDigits) > 0
  ) {
    appendText(
      cell,
      "span",
      "metrics missing",
      "chip chip-muted chip-dashed review-missing",
    );
  }
}

function renderTask(tableBody, task, cost, routing, metrics, oldestDigits) {
  const item = tableBody.ownerDocument.createElement("tr");
  item.className = "task";
  appendText(item, "td", task?.id ?? "?", "task-id");
  const titleCell = appendText(
    item,
    "td",
    task?.title ?? "Untitled task",
    "task-title",
  );
  if (Array.isArray(task?.dependencies) && task.dependencies.length > 0) {
    appendText(
      titleCell,
      "span",
      `deps: ${task.dependencies.join(", ")}`,
      "task-deps",
    );
  }
  const size = task?.size ?? "unknown";
  const sizeCell = item.ownerDocument.createElement("td");
  sizeCell.className = "task-size task-numeric";
  sizeCell.title = Object.hasOwn(SIZE_DESCRIPTIONS, size)
    ? SIZE_DESCRIPTIONS[size]
    : SIZE_LEGEND;
  appendText(sizeCell, "span", size, "chip chip-muted task-size-chip");
  item.append(sizeCell);
  const costCell = item.ownerDocument.createElement("td");
  costCell.className = "task-cost-cell task-numeric";
  const label = costLabel(cost);
  if (label) {
    const costGroup = item.ownerDocument.createElement("span");
    costGroup.className = "task-cost-group";
    appendText(costGroup, "span", label.text, `task-cost cost-${label.kind}`);
    const taskListCost = taskNotional(cost, routing);
    const notional = notionalLabel(taskListCost);
    if (notional) {
      appendText(costGroup, "span", "·", "task-cost-separator");
      const notionalNode = appendText(
        costGroup,
        "span",
        `~${formatUsd(taskListCost.usd)}`,
        "task-notional",
      );
      notionalNode.title = notional.title;
    }
    costCell.append(costGroup);
    appendText(costCell, "span", label.detail, "task-cost-detail");
    costCell.title = `${label.detail}${notional ? ` · ${notional.text}; ${notional.title}` : ""}`;
  }
  item.append(costCell);
  const reviewCell = appendText(item, "td", "", "task-review");
  if (metrics) renderTaskReview(reviewCell, task, metrics, oldestDigits);
  const references = item.ownerDocument.createElement("td");
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
  item.append(references);
  tableBody.append(item);
}

function createTaskTable(panel, title, count) {
  const scroll = panel.ownerDocument.createElement("div");
  scroll.className = "task-table-scroll";
  const table = panel.ownerDocument.createElement("table");
  table.className = "task-list task-table";
  appendText(table, "caption", `${title} · ${count}`);
  const head = table.ownerDocument.createElement("thead");
  const headerRow = table.ownerDocument.createElement("tr");
  for (const column of TASK_COLUMNS) {
    const header = appendText(headerRow, "th", column);
    header.scope = "col";
    if (column === "Size") header.title = SIZE_LEGEND;
    if (column === "Size" || column === "Cost")
      header.className = "task-numeric";
  }
  head.append(headerRow);
  const body = table.ownerDocument.createElement("tbody");
  table.append(head, body);
  scroll.append(table);
  panel.append(scroll);
  return { body, scroll };
}

function taskIdDigits(task) {
  const match = /^T([1-9][0-9]*)$/.exec(task?.id ?? "");
  return match?.[1];
}

function compareTaskIdsDescending(left, right) {
  const leftDigits = taskIdDigits(left);
  const rightDigits = taskIdDigits(right);
  if (leftDigits === undefined) return rightDigits === undefined ? 0 : 1;
  if (rightDigits === undefined) return -1;
  return (
    rightDigits.length - leftDigits.length ||
    (rightDigits > leftDigits ? 1 : rightDigits < leftDigits ? -1 : 0)
  );
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
    return compareTaskIdsDescending(left, right);
  });
}

function renderTasks(card, repository, disclosure, groups = TASK_GROUPS) {
  const plan = readerData(repository.plan);
  const costs = readerData(repository.costs)?.tasks;
  const routing = readerData(repository.routing);
  const metrics = readerData(repository.metrics);
  const oldestDigits = oldestMetricTaskDigits(metrics);
  const emptyGroups = [];
  for (const [title, key, className, spanClass] of groups) {
    const planTasks = Array.isArray(plan?.[key]) ? plan[key] : [];
    if (plan && groups === TASK_GROUPS && planTasks.length === 0) {
      emptyGroups.push(title);
      continue;
    }
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
    const tasks =
      key === "completed" ? completedTasks(repository, planTasks) : planTasks;
    if (tasks.length === 0) {
      panel.classList.add("panel-empty");
      appendText(panel, "p", "None", "empty");
      continue;
    }
    const { body, scroll } = createTaskTable(panel, title, tasks.length);
    let expanded =
      key === "completed" && (disclosure.completedExpanded ?? false);
    const renderList = () => {
      body.replaceChildren();
      const visible =
        key === "completed" && !expanded
          ? tasks.slice(0, COMPLETED_TASK_LIMIT)
          : tasks;
      visible.forEach((task) =>
        renderTask(
          body,
          task,
          costs?.[task?.id],
          routing,
          ["active", "review", "completed"].includes(key) ? metrics : undefined,
          oldestDigits,
        ),
      );
      scroll.classList.toggle("task-list-scroll", expanded);
      if (expanded) scroll.tabIndex = 0;
      else scroll.removeAttribute("tabindex");
    };
    renderList();
    if (key === "completed" && tasks.length > COMPLETED_TASK_LIMIT) {
      const toggle = appendText(
        panel,
        "button",
        "",
        "button button-ghost completed-tasks-toggle",
      );
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
  if (emptyGroups.length > 0) {
    const strip = card.ownerDocument.createElement("section");
    strip.className = "empty-task-groups panel-span-12";
    strip.setAttribute("aria-label", "Empty task groups");
    emptyGroups.forEach((title, index) => {
      if (index > 0) {
        appendText(strip, "span", "·", "empty-task-separator");
      }
      const group = strip.ownerDocument.createElement("span");
      group.className = "empty-task-group";
      appendText(group, "strong", title);
      group.append(strip.ownerDocument.createTextNode(" · None"));
      strip.append(group);
    });
    card.append(strip);
  }
}

function metricNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function average(total, count) {
  if (!Number.isFinite(total) || !Number.isFinite(count) || count <= 0) {
    return "unknown";
  }
  const value = total / count;
  if (!Number.isFinite(value)) return "unknown";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function percentage(value, total) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return "0%";
  }
  const result = (value / total) * 100;
  return Number.isFinite(result) ? `${Math.round(result)}%` : "0%";
}

function measuredMetrics(metrics, size) {
  return Object.values(metrics?.tasks ?? {}).filter(
    (task) =>
      task?.ship &&
      task?.merge &&
      (size === undefined || task.ship.size === size),
  );
}

function metricAggregate(tasks) {
  const internal = {
    count: 0,
    rounds: 0,
    findings: { blocking: 0, minor: 0, invalid: 0 },
  };
  const external = {
    findings: { blocking: 0, minor: 0, refuted: 0 },
    fixPushes: 0,
    reviewers: new Map(),
  };
  let ciReruns = 0;
  for (const task of tasks) {
    if (task.ship.internal) {
      internal.count += 1;
      internal.rounds += metricNumber(task.ship.internal.rounds);
      for (const name of ["blocking", "minor", "invalid"]) {
        internal.findings[name] += metricNumber(
          task.ship.internal.findings?.[name],
        );
      }
    }
    for (const [reviewer, review] of Object.entries(
      task.merge.external ?? {},
    )) {
      const reviewerTotal = external.reviewers.get(reviewer) ?? {
        rounds: 0,
        tasks: 0,
      };
      reviewerTotal.rounds += metricNumber(review?.rounds);
      reviewerTotal.tasks += 1;
      external.reviewers.set(reviewer, reviewerTotal);
      external.fixPushes += metricNumber(review?.fixPushes);
      for (const name of ["blocking", "minor", "refuted"]) {
        external.findings[name] += metricNumber(review?.findings?.[name]);
      }
    }
    ciReruns += metricNumber(task.merge.ci?.reruns);
  }
  return { internal, external, ciReruns };
}

function reactionCount(reactions) {
  return Object.values(reactions ?? {}).reduce(
    (total, count) => total + metricNumber(count),
    0,
  );
}

function reviewCrossChecks(tasks) {
  const checks = [];
  for (const task of tasks) {
    if (!task.pr) {
      for (const [reviewer, review] of Object.entries(
        task.merge.external ?? {},
      ).sort(([left], [right]) => left.localeCompare(right))) {
        checks.push({
          task: task.ship.task ?? task.merge.task ?? "?",
          reviewer,
          reported: metricNumber(review?.rounds),
          mechanical: 0,
          comparable: false,
        });
      }
      continue;
    }
    const reviewers = new Set([
      ...Object.keys(task.merge.external ?? {}),
      ...Object.keys(task.pr.reviews ?? {}),
      ...Object.keys(task.pr.reactions ?? {}),
    ]);
    for (const reviewer of [...reviewers].sort()) {
      const review = task.merge.external?.[reviewer];
      const mechanical =
        metricNumber(task.pr?.reviews?.[reviewer]) +
        reactionCount(task.pr?.reactions?.[reviewer]);
      checks.push({
        task: task.ship.task ?? task.merge.task ?? "?",
        reviewer,
        reported: metricNumber(review?.rounds),
        mechanical,
        comparable: true,
      });
    }
  }
  return checks;
}

function appendReviewCrossChecks(parent, checks) {
  if (checks.length === 0) {
    appendText(parent, "span", "all match", "review-cross-check-summary muted");
    return 0;
  }
  const mismatches = checks.filter(
    (check) => check.comparable && check.reported !== check.mechanical,
  ).length;
  const unverified = checks.filter((check) => !check.comparable).length;
  const summaryParts = [];
  if (mismatches > 0)
    summaryParts.push(`${mismatches} mismatch${mismatches === 1 ? "" : "es"}`);
  if (unverified > 0) summaryParts.push(`${unverified} unverified`);
  const details = parent.ownerDocument.createElement("details");
  details.className = "review-cross-checks";
  appendText(
    details,
    "summary",
    summaryParts.length === 0 ? "all match" : summaryParts.join(" · "),
    mismatches === 0
      ? "review-cross-check-summary muted"
      : "review-cross-check-summary review-mismatch",
  );
  for (const check of checks) {
    const text = check.comparable
      ? `${check.task} ${check.reviewer}: ${check.reported}r vs ${check.mechanical} mechanical`
      : `${check.task} ${check.reviewer}: ${check.reported}r vs unknown mechanical`;
    appendText(
      details,
      "span",
      text,
      check.comparable && check.reported !== check.mechanical
        ? "review-cross-check review-mismatch"
        : "review-cross-check",
    );
  }
  parent.append(details);
  return mismatches;
}

function appendReviewAggregateRow(body, label, tasks, checks) {
  const row = body.ownerDocument.createElement("tr");
  appendText(row, "th", label);
  row.firstElementChild.scope = "row";
  if (tasks.length === 0) {
    const empty = appendText(row, "td", "No measured tasks", "empty");
    empty.colSpan = 6;
    body.append(row);
    return;
  }
  const aggregate = metricAggregate(tasks);
  const externalTotal =
    aggregate.external.findings.blocking +
    aggregate.external.findings.minor +
    aggregate.external.findings.refuted;
  appendText(row, "td", `${tasks.length} measured`, "review-measured");
  appendText(
    row,
    "td",
    `${average(aggregate.internal.rounds, aggregate.internal.count)} rounds · ${average(aggregate.internal.findings.blocking, aggregate.internal.count)} blocking · ${average(aggregate.internal.findings.minor, aggregate.internal.count)} minor · ${average(aggregate.internal.findings.invalid, aggregate.internal.count)} invalid${aggregate.internal.count < tasks.length ? ` · ${aggregate.internal.count}/${tasks.length} known` : ""}`,
  );
  const reviewerCell = row.ownerDocument.createElement("td");
  if (aggregate.external.reviewers.size === 0)
    reviewerCell.textContent = "None";
  for (const [reviewer, totals] of aggregate.external.reviewers) {
    appendText(
      reviewerCell,
      "span",
      `${reviewer} ${average(totals.rounds, totals.tasks)} rounds`,
      "review-reviewer-average",
    );
  }
  row.append(reviewerCell);
  appendText(
    row,
    "td",
    `${average(externalTotal, tasks.length)} findings/task · ${average(aggregate.external.findings.blocking, tasks.length)} blocking/task (${percentage(aggregate.external.findings.blocking, externalTotal)}) · ${average(aggregate.external.findings.minor, tasks.length)} minor/task (${percentage(aggregate.external.findings.minor, externalTotal)}) · ${average(aggregate.external.findings.refuted, tasks.length)} refuted/task (${percentage(aggregate.external.findings.refuted, externalTotal)})`,
  );
  appendText(
    row,
    "td",
    `${average(aggregate.external.fixPushes, tasks.length)} fix pushes/PR · ${average(aggregate.ciReruns, tasks.length)} CI reruns/PR`,
  );
  const crossCheck = row.ownerDocument.createElement("td");
  if (checks) appendReviewCrossChecks(crossCheck, checks);
  else appendText(crossCheck, "span", "—", "empty");
  row.append(crossCheck);
  body.append(row);
}

function renderReviewStrip(card, repository, disclosure) {
  const strip = card.ownerDocument.createElement("section");
  strip.className = "review-strip panel-span-12";
  const metrics = readerData(repository.metrics);
  if (!metrics) {
    appendText(strip, "h4", "Review", "panel-title");
    appendText(strip, "p", "Unavailable", "unavailable");
    card.append(strip);
    return;
  }
  const all = measuredMetrics(metrics);
  if (all.length === 0) {
    appendText(strip, "h4", "Review", "panel-title");
    appendText(strip, "p", "No measured tasks", "empty");
    card.append(strip);
    return;
  }
  const checks = reviewCrossChecks(all);
  const mismatchCount = checks.filter(
    (check) => check.comparable && check.reported !== check.mechanical,
  ).length;
  const disclosurePanel = strip.ownerDocument.createElement("details");
  disclosurePanel.className = "review-strip-details";
  disclosurePanel.open = disclosure.reviewOpen ?? false;
  disclosurePanel.addEventListener("toggle", () => {
    disclosure.reviewOpen = disclosurePanel.open;
  });
  appendText(
    disclosurePanel,
    "summary",
    `Review · ${all.length} measured · ${mismatchCount} mismatches`,
    "panel-title",
  );
  const scroll = strip.ownerDocument.createElement("div");
  scroll.className = "review-strip-scroll";
  const table = strip.ownerDocument.createElement("table");
  const head = strip.ownerDocument.createElement("thead");
  const headingRow = strip.ownerDocument.createElement("tr");
  for (const heading of [
    "Size",
    "Tasks",
    "Internal / task",
    "External rounds / reviewer",
    "External findings",
    "Fixes and CI",
    "Rounds cross-check",
  ]) {
    const cell = appendText(headingRow, "th", heading);
    cell.scope = "col";
  }
  head.append(headingRow);
  const body = strip.ownerDocument.createElement("tbody");
  appendReviewAggregateRow(body, "overall", all, checks);
  for (const size of ["trivial", "standard", "major"]) {
    const tasks = measuredMetrics(metrics, size);
    appendReviewAggregateRow(body, size, tasks);
  }
  table.append(head, body);
  scroll.append(table);
  disclosurePanel.append(scroll);
  strip.append(disclosurePanel);
  card.append(strip);
}

function questionParagraphs(value) {
  return String(value ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean);
}

function questionFallbackSections(value) {
  const sections = [];
  let current = null;
  const flush = () => {
    if (current?.lines.length) {
      sections.push({
        label: current.label,
        text: current.lines.join(" "),
      });
    }
    current = null;
  };
  for (const rawLine of String(value ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const field = /^(Context:|Options considered:)\s*(.*)$/.exec(line);
    if (field) {
      flush();
      current = { label: field[1], lines: field[2] ? [field[2]] : [] };
      continue;
    }
    if (current) current.lines.push(line);
    else current = { label: null, lines: [line] };
  }
  flush();
  return sections;
}

function appendQuestionOptionText(row, option) {
  const marker = option.recommended
    ? /\(\s*recommended\b[^)]*\)/i.exec(option.text)
    : null;
  if (marker?.index !== undefined) {
    row.append(
      row.ownerDocument.createTextNode(option.text.slice(0, marker.index)),
    );
    appendText(row, "span", marker[0], "chip chip-accent question-recommended");
    row.append(
      row.ownerDocument.createTextNode(
        option.text.slice(marker.index + marker[0].length),
      ),
    );
  } else {
    row.append(row.ownerDocument.createTextNode(option.text));
  }
  if (option.recommended && !/\(\s*recommended\b/i.test(option.text))
    appendText(
      row,
      "span",
      "(recommended)",
      "chip chip-accent question-recommended",
    );
}

function questionIsStructured(question) {
  const labelled =
    Array.isArray(question?.options) && question.options.length > 0;
  const prose =
    Array.isArray(question?.proseOptions) && question.proseOptions.length > 0;
  return question?.context !== undefined && (labelled || prose);
}

function renderQuestionOptions(parent, question, interactive) {
  const documentRoot = parent.ownerDocument;
  const labelled =
    Array.isArray(question?.options) && question.options.length > 0;
  const prose =
    Array.isArray(question?.proseOptions) && question.proseOptions.length > 0;
  const options = documentRoot.createElement(
    interactive && labelled ? "fieldset" : labelled ? "ol" : "ul",
  );
  options.className = `question-options${prose ? " question-options-prose" : ""}${interactive && labelled ? " question-options-edit" : ""}`;

  if (interactive && labelled) {
    appendText(options, "legend", "Options", "question-field-label");
  } else {
    appendText(parent, "h4", "Options", "question-field-label");
  }

  if (labelled) {
    for (const option of question.options) {
      const row = documentRoot.createElement(interactive ? "label" : "li");
      let content = row;
      if (interactive) {
        row.className = "answer-option";
        const input = documentRoot.createElement("input");
        input.type = "radio";
        input.name = interactive.name;
        input.value = option.label;
        input.checked = interactive.state.option === option.label;
        input.addEventListener("change", () => {
          interactive.state.option = option.label;
        });
        row.append(input);
        content = documentRoot.createElement("span");
        row.append(content);
      }
      appendText(content, "strong", option.label, "question-option-label");
      if (option.text) {
        content.append(documentRoot.createTextNode(" · "));
        appendQuestionOptionText(content, {
          ...option,
          text: questionParagraphs(option.text).join(" "),
        });
      } else if (option.recommended) {
        appendQuestionOptionText(content, option);
      }
      options.append(row);
    }
  } else {
    for (const option of question.proseOptions) {
      appendText(options, "li", questionParagraphs(option).join(" "));
    }
  }
  parent.append(options);
}

function renderQuestionBody(parent, question, interactiveOptions) {
  const documentRoot = parent.ownerDocument;
  const structured = questionIsStructured(question);
  const body = documentRoot.createElement("div");
  body.className = "question-body";

  if (structured) {
    appendText(body, "h4", "Context", "question-field-label");
    for (const paragraph of questionParagraphs(question.context))
      appendText(body, "p", paragraph, "question-context");
    renderQuestionOptions(body, question, interactiveOptions);
    if (question.qualifier !== undefined) {
      appendText(body, "h4", "Qualifier", "question-field-label");
      for (const paragraph of questionParagraphs(question.qualifier))
        appendText(body, "p", paragraph, "question-qualifier");
    }
  } else {
    const lines = String(question?.text ?? "").split("\n");
    if (/^## Q[1-9][0-9]*\b/.test(lines[0]?.trim() ?? "")) lines.shift();
    while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
    if (/^\*\*A:\*\*\s*$/.test(lines.at(-1)?.trim() ?? "")) lines.pop();
    while (lines.length > 0 && !lines.at(-1)?.trim()) lines.pop();
    for (const section of questionFallbackSections(lines.join("\n"))) {
      if (section.label)
        appendText(body, "h4", section.label, "question-field-label");
      appendText(body, "p", section.text, "question-fallback-text");
    }
  }
  parent.append(body);
  return structured;
}

const questionIdentityHeadings = new WeakMap();

function renderQuestions(card, repository, machine, now) {
  const open = readerData(repository.questions)?.open;
  if (Array.isArray(open) && open.length === 0) {
    const compact = card.ownerDocument.createElement("section");
    compact.className = "questions-compact panel-span-4";
    const heading = compact.ownerDocument.createElement("h4");
    heading.className = "panel-title";
    appendExternalOrText(
      heading,
      "Open questions",
      repository.questionsUrl,
      "questions",
    );
    heading.append(compact.ownerDocument.createTextNode(" · 0 · None"));
    compact.append(heading);
    card.append(compact);
    return;
  }
  const panel = addPanel(
    card,
    "Open questions",
    "questions-panel",
    "panel-span-4",
    repository.questionsUrl,
    "questions",
  );
  if (!open) {
    appendText(panel, "p", "Unavailable", "unavailable");
    return;
  }
  for (const question of open) {
    const item = panel.ownerDocument.createElement("article");
    item.className = "text-entry question";
    const identity = appendText(
      item,
      "h5",
      `${repository.name}/${question?.id ?? "?"} · ${question?.taskId ?? "?"}`,
      "question-durable-identity",
    );
    questionIdentityHeadings.set(identity, {
      machine,
      repository: repository.name,
      question: question?.id ?? "?",
      suffix: question?.taskId ?? "?",
    });
    appendText(
      item,
      "p",
      question?.title ?? "Untitled question",
      "entry-title",
    );
    if (question?.filedAt !== undefined) {
      appendText(
        item,
        "p",
        `Filed ${displayAge(question.filedAt, now)}`,
        "age",
      );
    }
    renderQuestionBody(item, question);
    panel.append(item);
  }
}

function renderWorklog(card, repository, disclosure, spanClass) {
  const panel = addPanel(
    card,
    "Recent worklog",
    "worklog-panel",
    spanClass,
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
  let rawVisible = disclosure.worklogRaw ?? false;
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
        : parsed.heading
          ? { headline: parsed.headline, remainder: parsed.body }
          : splitFirstSentence(parsed.content);
      const item = panel.ownerDocument.createElement("article");
      item.className = "worklog-entry";
      const meta = item.ownerDocument.createElement("div");
      meta.className = "worklog-meta muted";
      appendText(
        meta,
        "time",
        entry?.time ?? "Time unavailable",
        "worklog-time",
      );
      const event = parsed.malformed
        ? "other"
        : worklogEvent(sentence.headline);
      if (event !== "other") {
        meta.append(item.ownerDocument.createTextNode(" · "));
        appendText(meta, "span", event, "worklog-event");
      }
      const task = /\bT[1-9][0-9]*\b/.exec(parsed.content)?.[0];
      if (task) {
        meta.append(item.ownerDocument.createTextNode(" · "));
        const taskReference = appendExternalOrText(
          meta,
          task,
          worklogReferenceUrl(repository.repositoryUrl, "task", task),
          "plan",
        );
        taskReference.classList.add("worklog-reference", "worklog-task");
      }
      item.append(meta);
      const headlineText = item.ownerDocument.createElement("span");
      headlineText.className = "worklog-summary";
      appendWorklogHighlight(
        headlineText,
        sentence.headline,
        repository.repositoryUrl,
      );
      item.append(headlineText);
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
      const raw = appendText(item, "pre", parsed.raw, "verbatim worklog-raw");
      raw.hidden = !rawVisible;
      list.append(item);
    }
  };
  renderEntries();

  const rawToggle = appendText(
    panel,
    "button",
    rawVisible ? "Hide raw entries" : "Show raw entries",
    "button button-ghost worklog-raw-toggle",
  );
  rawToggle.type = "button";
  rawToggle.setAttribute("aria-expanded", String(rawVisible));
  rawToggle.addEventListener("click", () => {
    rawVisible = !rawVisible;
    disclosure.worklogRaw = rawVisible;
    rawToggle.textContent = rawVisible
      ? "Hide raw entries"
      : "Show raw entries";
    rawToggle.setAttribute("aria-expanded", String(rawVisible));
    for (const raw of list.querySelectorAll(".worklog-raw")) {
      raw.hidden = !rawVisible;
    }
  });

  if (newestFirst.length > visibleCount) {
    const toggle = appendText(
      panel,
      "button",
      `Show all ${newestFirst.length}`,
      "button button-secondary worklog-toggle",
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
    "chip liveness",
  );
  const liveness = repository.liveness?.state;
  status.classList.add(
    liveness === "RUNNING" ? "chip-good" : "chip-muted",
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
    appendText(list, "dt", label);
    const value = list.ownerDocument.createElement("dd");
    if (!timing) {
      value.textContent = "Unknown";
    } else {
      appendText(value, "span", displayTime(timing.startedAt), "timing-stamp");
      value.append(list.ownerDocument.createTextNode(" → "));
      appendText(
        value,
        "span",
        `${displayTime(timing.lastActivityAt)}${timing.durationMs === undefined ? "" : ` (${displayDuration(timing.durationMs)})`}`,
        "timing-stamp",
      );
    }
    list.append(value);
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
  QUESTIONS_OPTION_TOO_LONG:
    "A question option exceeds the structured rendering limit.",
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
  LOGS_TOO_MANY_ENTRIES:
    "The factory logs directory exceeds the bounded scan; archive old top-level logs.",
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
  CURRENT_ROUTING_NOT_CONFIGURED:
    "Current opencode routing is not configured on this machine.",
  CURRENT_ROUTING_INVALID_JSONC:
    "The current opencode configuration is not valid bounded JSONC.",
  CURRENT_ROUTING_INVALID_ROOT:
    "The current opencode configuration has an invalid root object.",
  CURRENT_ROUTING_INVALID_FIELD:
    "A current opencode routing field has an invalid value.",
  CURRENT_ROUTING_TOO_MANY_AGENTS:
    "The current opencode configuration has too many agents.",
  CURRENT_ROUTING_INVALID_AGENT:
    "An invalid current agent routing entry was omitted.",
  CURRENT_ROUTING_MISSING:
    "The configured current opencode configuration is missing.",
  CURRENT_ROUTING_TOO_LARGE:
    "The current opencode configuration exceeds the safe read limit.",
  CURRENT_ROUTING_UNAVAILABLE:
    "The current opencode configuration could not be read safely.",
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
  METRICS_INVALID_UTF8: "A metrics line is not valid UTF-8 text.",
  METRICS_INVALID_JSON: "A metrics line is not valid JSON.",
  METRICS_UNSUPPORTED_SCHEMA:
    "A metrics line uses an unsupported schema version.",
  METRICS_INVALID_EVENT: "A metrics line contains an invalid review event.",
  METRICS_LINE_TOO_LONG: "A metrics line exceeds the safe parsing limit.",
  METRICS_TOO_MANY_LINES:
    "The metrics file has more lines than the reader permits.",
  METRICS_WARNINGS_TRUNCATED:
    "Additional metrics warnings were omitted after the safety limit.",
  METRICS_MISSING: "The metrics file is missing.",
  METRICS_TOO_LARGE: "The metrics file exceeds the safe read limit.",
  METRICS_UNAVAILABLE: "The metrics file could not be read safely.",
  REPOSITORY_WARNING: "The repository snapshot is incomplete.",
});

export const UNKNOWN_WARNING_EXPLANATION =
  "This source reported a warning that this dashboard does not yet recognize.";

function warningExplanation(code) {
  return Object.hasOwn(WARNING_EXPLANATIONS, code)
    ? WARNING_EXPLANATIONS[code]
    : UNKNOWN_WARNING_EXPLANATION;
}

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
    ["metrics", repository.metrics],
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
  const exactRows = [...grouped.values()];
  const repeatGroups = new Map();
  for (const warning of exactRows) {
    if (warning.code === "WARNINGS_TRUNCATED") continue;
    const key = `${warning.source}\u0000${warning.code}`;
    const group = repeatGroups.get(key);
    if (group) group.push(warning);
    else repeatGroups.set(key, [warning]);
  }
  const collapsedKeys = new Set(
    [...repeatGroups.entries()]
      .filter(([, group]) => group.length > 3)
      .map(([key]) => key),
  );
  const collapsed = [];
  for (const warning of exactRows) {
    const key = `${warning.source}\u0000${warning.code}`;
    if (!collapsedKeys.has(key)) {
      collapsed.push(warning);
      continue;
    }
    if (collapsed.some((row) => row.repeatKey === key)) continue;
    const group = repeatGroups.get(key);
    collapsed.push({
      ...group[0],
      line: undefined,
      lines: group
        .map((row) => row.line)
        .filter((line) => line !== undefined)
        .slice(0, 3),
      moreLines: group.length - 3,
      count: group.reduce((total, row) => total + row.count, 0),
      repeatKey: key,
    });
  }
  return collapsed.sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      (left.lines?.[0] ?? left.line ?? Number.MAX_SAFE_INTEGER) -
        (right.lines?.[0] ?? right.line ?? Number.MAX_SAFE_INTEGER) ||
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
    repository.metrics,
  ]) {
    if (result?.status === "unavailable") return true;
  }
  if (warnings.some((warning) => warning.code.includes("TRUNCATED"))) {
    return true;
  }
  return !warnings.every(
    (warning) =>
      ["plan", "worklog"].includes(warning.source) &&
      Object.hasOwn(WARNING_EXPLANATIONS, warning.code),
  );
}

function renderWarnings(card, repository, disclosure, warnings) {
  if (warnings.length === 0) return;
  const documentRoot = card.ownerDocument;
  const panel = documentRoot.createElement("section");
  panel.className = "panel warnings-panel panel-span-4";
  const details = documentRoot.createElement("details");
  details.open =
    disclosure.warningsOpen ?? warningsShouldOpen(repository, warnings);
  const summary = documentRoot.createElement("summary");
  summary.addEventListener("click", () => {
    disclosure.warningsOpen = !details.open;
  });
  appendText(
    summary,
    "h4",
    `Warnings · ${warnings.length} · from this snapshot`,
    "panel-title",
  );
  details.append(summary);
  const list = documentRoot.createElement("ul");
  list.className = "warning-list";
  for (const warning of warnings) {
    const item = documentRoot.createElement("li");
    item.className = "warning-row";
    appendText(item, "span", warning.source, "warning-source");
    appendText(item, "code", warning.code, "warning-code");
    if (warning.lines !== undefined) {
      appendText(
        item,
        "span",
        `lines ${warning.lines.join(", ")} +${warning.moreLines} more`,
        "warning-line",
      );
    } else if (warning.line !== undefined) {
      appendText(item, "span", `line ${warning.line}`, "warning-line");
    }
    if (warning.count > 1) {
      appendText(item, "span", `×${warning.count}`, "warning-count");
    }
    appendText(
      item,
      "p",
      warningExplanation(warning.code),
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

function renderRoutingStrip(result, documentRoot, options = {}) {
  const strip = documentRoot.createElement("section");
  strip.className = "panel routing-panel routing-strip";
  appendText(strip, "h3", options.title ?? "Routing", "panel-title");
  const routing = readerData(result);
  if (!routing) {
    const notConfigured = result?.warnings?.some(
      (warning) => warning?.code === "CURRENT_ROUTING_NOT_CONFIGURED",
    );
    appendText(
      strip,
      "p",
      notConfigured ? "Not configured" : "Unavailable",
      "unavailable",
    );
    return strip;
  }

  if (options.recordedAt) {
    appendText(
      strip,
      "p",
      `Recorded ${displayAge(options.recordedAt, options.now)} · ${displayTime(options.recordedAt)}`,
      "routing-freshness age",
    );
  } else if (options.current) {
    appendText(
      strip,
      "p",
      "Current configuration · used for the next factory run",
      "routing-freshness",
    );
  }
  if (result?.status === "partial") {
    appendText(strip, "span", "Partial", "chip chip-warn routing-partial");
  }

  appendText(
    strip,
    "p",
    `default ${routing.model} · small ${routing.smallModel}`,
    "routing-defaults",
  );
  const list = documentRoot.createElement("dl");
  list.className = "routing-agents";

  const groups = new Map();
  for (const [name, agent] of Object.entries(routing.agents ?? {})) {
    const provider = agent?.provider ?? "other";
    const model = agent?.model ?? "Unknown";
    const key = JSON.stringify([provider, model]);
    const group = groups.get(key);
    if (group) group.agents.push({ name, steps: agent?.steps });
    else
      groups.set(key, {
        provider,
        model,
        agents: [{ name, steps: agent?.steps }],
      });
  }

  for (const group of groups.values()) {
    const row = documentRoot.createElement("div");
    row.className = "routing-row";
    const model = documentRoot.createElement("dt");
    model.className = "routing-model-cell";
    appendText(
      model,
      "span",
      group.provider,
      `routing-provider provider-${providerCategory(group.provider)}`,
    );
    appendText(model, "span", `/${group.model}`, "routing-model");

    const agents = documentRoot.createElement("dd");
    agents.className = "routing-agent-cell";
    for (const [index, agent] of group.agents.entries()) {
      if (index > 0) appendText(agents, "span", " · ", "routing-separator");
      appendText(agents, "strong", agent.name, "routing-agent");
      if (agent.steps !== null && agent.steps !== undefined) {
        agents.append(documentRoot.createTextNode(" "));
        appendText(agents, "span", `≤ ${agent.steps}`, "routing-steps muted");
      }
    }
    row.append(model, agents);
    list.append(row);
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
  card.append(
    renderRoutingStrip(repository?.routing, documentRoot, {
      title: "Last-run routing",
      recordedAt: readerData(repository?.routing)?.recordedAt,
      now,
    }),
  );
  renderCurrent(card, repository ?? {});
  renderLogs(card, repository ?? {}, now, generatedAt);
  renderQuestions(card, repository ?? {}, machine, now);
  renderTasks(card, repository ?? {}, disclosure);
  const warnings = collectWarnings(repository ?? {});
  renderWorklog(
    card,
    repository ?? {},
    disclosure,
    warnings.length > 0 ? "panel-span-8" : "panel-span-12",
  );
  renderWarnings(card, repository ?? {}, disclosure, warnings);
  renderReviewStrip(card, repository ?? {}, disclosure);
  renderTasks(card, repository ?? {}, disclosure, COMPLETED_TASK_GROUP);
  return card;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isReaderResult(value) {
  if (!isRecord(value) || !isWarnings(value.warnings)) return false;
  if (!["available", "partial", "unavailable"].includes(value.status)) {
    return false;
  }
  return value.status === "unavailable" || isRecord(value.data);
}

function isWarnings(value) {
  return (
    Array.isArray(value) &&
    value.every(
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
  );
}

function isQuestionOption(value) {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    value.label.length <= 128 &&
    typeof value.text === "string" &&
    value.text.length <= MAX_QUESTION_OPTION_LENGTH &&
    (value.recommended === undefined || typeof value.recommended === "boolean")
  );
}

function isQuestionTask(value, taskId) {
  return (
    isRecord(value) &&
    value.id === taskId &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    value.title.length <= MAX_QUESTION_OPTION_LENGTH &&
    (value.pr === undefined ||
      (Number.isSafeInteger(value.pr) && value.pr > 0)) &&
    (value.issueNumbers === undefined ||
      (Array.isArray(value.issueNumbers) &&
        value.issueNumbers.length <= 32 &&
        value.issueNumbers.every(
          (issue) => Number.isSafeInteger(issue) && issue > 0,
        ))) &&
    (value.prUrl === undefined || safeGithubUrl(value.prUrl, "pull")) &&
    (value.issueUrls === undefined ||
      (Array.isArray(value.issueUrls) &&
        value.issueUrls.length <= 32 &&
        value.issueUrls.every((url) => safeGithubUrl(url, "issue"))))
  );
}

function isQuestion(value) {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length <= 128 &&
    /^Q[1-9][0-9]*$/.test(value.id) &&
    typeof value.taskId === "string" &&
    value.taskId.length <= 128 &&
    /^T[1-9][0-9]*$/.test(value.taskId) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    value.title.length <= MAX_QUESTION_OPTION_LENGTH &&
    typeof value.text === "string" &&
    value.text.length <= MAX_QUESTION_TEXT_LENGTH &&
    (value.filedAt === undefined || isFiledAt(value.filedAt)) &&
    (value.context === undefined ||
      (typeof value.context === "string" &&
        value.context.length <= MAX_QUESTION_TEXT_LENGTH)) &&
    (value.qualifier === undefined ||
      (typeof value.qualifier === "string" &&
        value.qualifier.length <= MAX_QUESTION_TEXT_LENGTH)) &&
    (value.options === undefined ||
      (Array.isArray(value.options) &&
        value.options.length <= MAX_QUESTION_OPTIONS &&
        value.options.every(isQuestionOption))) &&
    (value.proseOptions === undefined ||
      (Array.isArray(value.proseOptions) &&
        value.proseOptions.length <= MAX_QUESTION_OPTIONS &&
        value.proseOptions.every(
          (option) =>
            typeof option === "string" &&
            option.length > 0 &&
            option.length <= MAX_QUESTION_OPTION_LENGTH,
        ))) &&
    (value.branch === undefined ||
      (typeof value.branch === "string" && value.branch.length <= 200)) &&
    (value.branchUrl === undefined ||
      safeGithubUrl(value.branchUrl, "branch")) &&
    (value.blockedTask === undefined ||
      isQuestionTask(value.blockedTask, value.taskId))
  );
}

function isFiledAt(value) {
  const fields =
    typeof value === "string" && value.length <= MAX_QUESTION_FILED_AT_LENGTH
      ? /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?Z$/.exec(
          value,
        )
      : null;
  if (fields === null || Number.isNaN(Date.parse(value))) return false;
  const date = new Date(value);
  return (
    date.getUTCFullYear() === Number(fields[1]) &&
    date.getUTCMonth() + 1 === Number(fields[2]) &&
    date.getUTCDate() === Number(fields[3]) &&
    date.getUTCHours() === Number(fields[4]) &&
    date.getUTCMinutes() === Number(fields[5]) &&
    date.getUTCSeconds() === Number(fields[6])
  );
}

function isQuestionsResult(value) {
  return (
    isReaderResult(value) &&
    (value.status === "unavailable" ||
      (Array.isArray(value.data.open) &&
        value.data.open.length <= MAX_QUESTIONS &&
        value.data.open.every(isQuestion)))
  );
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
        isRoutingModelId(`${agent.provider}/${agent.model}`) &&
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

function isCurrentRoutingData(value) {
  if (
    !isRecord(value) ||
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
        isRoutingModelId(`${agent.provider}/${agent.model}`) &&
        (agent.steps === null ||
          (Number.isSafeInteger(agent.steps) &&
            agent.steps >= 0 &&
            agent.steps <= MAX_ROUTING_STEPS)),
    )
  );
}

function isCurrentRoutingResult(value) {
  return (
    isReaderResult(value) &&
    (value.status === "unavailable" || isCurrentRoutingData(value.data))
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

function isMetricCounter(value, positive = false) {
  return Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
}

function isMetricKey(value, pattern) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_METRICS_KEY_LENGTH &&
    (!pattern || pattern.test(value))
  );
}

function isMetricMap(value, validateEntry, keyPattern) {
  return (
    isRecord(value) &&
    Object.keys(value).length <= MAX_METRICS_MAP_ENTRIES &&
    Object.entries(value).every(
      ([key, entry]) => isMetricKey(key, keyPattern) && validateEntry(entry),
    )
  );
}

function isMetricFindings(value, classes) {
  return (
    isRecord(value) && classes.every((name) => isMetricCounter(value[name]))
  );
}

function isShipMetric(value, taskId) {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.task === taskId &&
    value.event === "ship" &&
    ["trivial", "standard", "major"].includes(value.size) &&
    (value.reclassifiedFrom === null ||
      ["trivial", "standard", "major"].includes(value.reclassifiedFrom)) &&
    (value.internal === null ||
      (isRecord(value.internal) &&
        isMetricCounter(value.internal.rounds) &&
        isMetricCounter(value.internal.fixed) &&
        isMetricFindings(value.internal.findings, [
          "blocking",
          "minor",
          "invalid",
        ])))
  );
}

function isMergeMetric(value, taskId) {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.task === taskId &&
    value.event === "merge" &&
    isMetricCounter(value.pr, true) &&
    isMetricMap(
      value.external,
      (review) =>
        isRecord(review) &&
        isMetricCounter(review.rounds) &&
        isMetricCounter(review.fixPushes) &&
        isMetricFindings(review.findings, ["blocking", "minor", "refuted"]),
      /^[a-z0-9-]+$/,
    ) &&
    isRecord(value.ci) &&
    isMetricCounter(value.ci.runs) &&
    isMetricCounter(value.ci.reruns)
  );
}

function isMetricCounterMap(value) {
  return isMetricMap(value, isMetricCounter);
}

function isPullRequestMetric(value, taskId) {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.task === taskId &&
    value.event === "pr" &&
    value.by === "factory-git" &&
    isRoutingTimestamp(value.openedAt) &&
    isRoutingTimestamp(value.mergedAt) &&
    isMetricCounter(value.commits) &&
    isMetricCounter(value.commitsAfterOpen) &&
    isMetricCounterMap(value.reviews) &&
    isMetricCounterMap(value.issueComments) &&
    isMetricMap(value.reactions, isMetricCounterMap) &&
    isMetricMap(
      value.threads,
      (thread) =>
        isRecord(thread) &&
        isMetricCounter(thread.total) &&
        isMetricCounter(thread.resolved),
    ) &&
    isRecord(value.checkRuns) &&
    isMetricCounter(value.checkRuns.total) &&
    isMetricCounter(value.checkRuns.failed)
  );
}

function isMetricsData(value) {
  if (
    !isRecord(value) ||
    !isRecord(value.tasks) ||
    Object.keys(value.tasks).length > MAX_METRICS_TASKS
  ) {
    return false;
  }
  return Object.entries(value.tasks).every(([taskId, metrics]) => {
    if (!/^T[1-9][0-9]*$/.test(taskId) || !isRecord(metrics)) return false;
    const events = [metrics.ship, metrics.merge, metrics.pr].filter(
      (event) => event !== undefined,
    );
    return (
      events.length > 0 &&
      (metrics.ship === undefined || isShipMetric(metrics.ship, taskId)) &&
      (metrics.merge === undefined || isMergeMetric(metrics.merge, taskId)) &&
      (metrics.pr === undefined || isPullRequestMetric(metrics.pr, taskId))
    );
  });
}

function isMetricsResult(value) {
  return (
    isReaderResult(value) &&
    (value.status === "unavailable"
      ? value.data === undefined
      : isMetricsData(value.data))
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

function isAnswerIntakeDescriptor(value) {
  return (
    isRecord(value) &&
    typeof value.enabled === "boolean" &&
    typeof value.authRequired === "boolean"
  );
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
    isQuestionsResult(value.questions) &&
    isReaderResult(value.worklog) &&
    isReaderResult(value.logs) &&
    (value.routing === undefined || isRoutingResult(value.routing)) &&
    (value.costs === undefined || isCostsResult(value.costs)) &&
    (value.metrics === undefined || isMetricsResult(value.metrics)) &&
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
    (value.currentRouting !== undefined &&
      !isCurrentRoutingResult(value.currentRouting)) ||
    (value.warnings !== undefined && !isWarnings(value.warnings)) ||
    !Array.isArray(value.peers) ||
    value.peers.length > MAX_PEERS ||
    !value.peers.every(isPeer) ||
    (value.answerIntake !== undefined &&
      !isAnswerIntakeDescriptor(value.answerIntake))
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
    hold: "Unavailable",
    questions: "Unavailable",
    age: "Unavailable",
    cost: "Unavailable",
  };
}

function repositoryCostData(repository) {
  return readerData(repository.costs)?.tasks;
}

function meteredTotal(repositories) {
  if (repositories.length === 0) return { text: "—" };
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
  if (repositories.length === 0) return "—";
  const concrete = [];
  let everyNull = true;
  let failures = 0;
  for (const repository of repositories) {
    if (repository.state?.status === "unavailable") failures += 1;
    const state = readerData(repository.state);
    const value = state?.[key];
    if (value !== null) everyNull = false;
    if (value !== undefined && value !== null) {
      concrete.push({ name: repository.name, value: format(value) });
    }
  }
  if (failures === repositories.length) return "Unavailable";
  if (failures > 0) return "Unknown";
  if (concrete.length === 1) return concrete[0].value;
  if (concrete.length > 1) {
    return concrete.map(({ name, value }) => `${name}: ${value}`).join(", ");
  }
  return everyNull ? "—" : "Unknown";
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
    repositories.length === 0
      ? "—"
      : repositories.every(
            (repository) => repository.questions?.status === "unavailable",
          )
        ? "Unavailable"
        : questionLists.every(Array.isArray)
          ? String(
              questionLists.reduce((total, open) => total + open.length, 0),
            )
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
    hold:
      repositories.length === 0
        ? false
        : states.every((state) => state === undefined)
          ? "Unavailable"
          : states.some((state) => state === undefined)
            ? "Unknown"
            : states.some((state) => state?.hold === true),
    questions,
    age:
      now.valueOf() - new Date(fleet.generatedAt).valueOf() >
      intervalMilliseconds
        ? displayAge(fleet.generatedAt, now)
        : "—",
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

function summaryCellClass(value, base = "", numeric = false) {
  return [
    base,
    numeric ? "numeric-cell" : "",
    value === "Unknown" || value === "—" || value === "None recorded"
      ? "empty"
      : "",
    value === "Unavailable" ? "unavailable" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function renderSummaryRow(row, summary) {
  const documentRoot = row.ownerDocument;
  const livenessCell = documentRoot.createElement("td");
  appendText(
    livenessCell,
    "span",
    summary.liveness,
    `chip ${summary.liveness === "RUNNING" ? "chip-good" : summary.liveness === "Unavailable" ? "chip-warn" : "chip-muted"} liveness ${livenessClass(summary.liveness)}`,
  );
  const holdCell = textElement(
    documentRoot,
    "td",
    summary.hold === true ? "" : summary.hold === false ? "—" : summary.hold,
    summaryCellClass(summary.hold === false ? "—" : summary.hold),
  );
  if (summary.hold === true)
    appendText(holdCell, "span", "HELD", "chip chip-danger badge held-badge");
  const costCell = textElement(
    documentRoot,
    "td",
    summary.cost,
    summaryCellClass(summary.cost, "cost-total metered-total", true),
  );
  if (summary.costTitle) costCell.title = summary.costTitle;
  if (summary.cost.startsWith("$"))
    costCell.textContent = `${summary.cost} metered`;
  if (summary.notional) {
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
    textElement(
      documentRoot,
      "td",
      summary.currentTask,
      summaryCellClass(summary.currentTask),
    ),
    textElement(
      documentRoot,
      "td",
      summary.pullRequest,
      summaryCellClass(summary.pullRequest),
    ),
    holdCell,
    textElement(
      documentRoot,
      "td",
      summary.questions,
      summaryCellClass(summary.questions, "", true),
    ),
    textElement(
      documentRoot,
      "td",
      summary.age,
      summaryCellClass(
        summary.age,
        `age${summary.age !== "—" && summary.age !== "Unavailable" ? " stale" : ""}`,
        true,
      ),
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
  if (summary.hold === true) {
    children.push(
      textElement(
        documentRoot,
        "span",
        "HELD",
        "chip chip-danger badge held-badge",
      ),
    );
  }
  const questionCount = Number(summary.questions);
  if (Number.isSafeInteger(questionCount) && questionCount > 0) {
    children.push(
      textElement(
        documentRoot,
        "span",
        `${questionCount} question${questionCount === 1 ? "" : "s"}`,
        "chip chip-accent badge question-badge",
      ),
    );
  } else if (["Unavailable", "Unknown"].includes(summary.questions)) {
    const unavailable = textElement(
      documentRoot,
      "span",
      "?",
      "chip chip-muted badge question-badge question-badge-unavailable",
    );
    unavailable.title =
      summary.questions === "Unknown"
        ? "Questions unknown"
        : "Questions unavailable";
    children.push(unavailable);
  }
  tab.replaceChildren(...children);
}

function worklogAge(repository, now) {
  if (repository.worklog?.status === "unavailable") return "Unavailable";
  const entries = readerData(repository.worklog)?.entries;
  if (!Array.isArray(entries)) return "Unknown";
  if (entries.length === 0) return "—";
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
    currentTask:
      repository.state?.status === "unavailable"
        ? "Unavailable"
        : state?.currentTask === null
          ? "—"
          : displayOptional(state?.currentTask),
    pullRequest:
      repository.state?.status === "unavailable"
        ? "Unavailable"
        : state?.pr === undefined
          ? "Unknown"
          : state.pr === null
            ? "—"
            : `PR #${state.pr}`,
    hold:
      repository.state?.status === "unavailable"
        ? "Unavailable"
        : state?.hold === undefined
          ? "Unknown"
          : state.hold,
    questions:
      repository.questions?.status === "unavailable"
        ? "Unavailable"
        : Array.isArray(questions)
          ? String(questions.length)
          : "Unknown",
    age: worklogAge(repository, now),
    cost: cost.text,
    costTitle: cost.title,
    notional,
    unattributed:
      unattributed?.text ?? (costTasks ? "None recorded" : "Unavailable"),
    unattributedDetail: unattributed?.detail,
    unattributedKind: unattributed?.kind,
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
    `chip ${summary.availability === "AVAILABLE" ? "chip-good" : "chip-warn"} status ${summary.availability === "AVAILABLE" ? "available" : "unavailable"}`,
  );
  const livenessCell = documentRoot.createElement("td");
  appendText(
    livenessCell,
    "span",
    summary.liveness,
    `chip ${summary.liveness === "RUNNING" ? "chip-good" : "chip-muted"} liveness ${livenessClass(summary.liveness)}`,
  );
  const holdCell = textElement(
    documentRoot,
    "td",
    summary.hold === true ? "" : summary.hold === false ? "—" : summary.hold,
    summaryCellClass(summary.hold === false ? "—" : summary.hold),
  );
  if (summary.hold === true)
    appendText(holdCell, "span", "HELD", "chip chip-danger badge held-badge");
  const unattributedCell = textElement(
    documentRoot,
    "td",
    summary.unattributed,
    summaryCellClass(
      summary.unattributed,
      `cost-unattributed ${summary.unattributedKind ? `cost-${summary.unattributedKind}` : summary.unattributed === "None recorded" ? "cost-absent" : ""}`,
      true,
    ),
  );
  if (summary.unattributedDetail)
    appendText(
      unattributedCell,
      "span",
      summary.unattributedDetail,
      "cost-detail",
    );
  if (summary.unattributedTitle)
    unattributedCell.title = summary.unattributedTitle;
  const costCell = textElement(
    documentRoot,
    "td",
    summary.cost,
    summaryCellClass(summary.cost, "cost-total metered-total", true),
  );
  if (summary.costTitle) costCell.title = summary.costTitle;
  if (summary.cost.startsWith("$"))
    costCell.textContent = `${summary.cost} metered`;
  if (summary.notional) {
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
    textElement(
      documentRoot,
      "td",
      summary.currentTask,
      summaryCellClass(summary.currentTask),
    ),
    textElement(
      documentRoot,
      "td",
      summary.pullRequest,
      summaryCellClass(summary.pullRequest),
    ),
    holdCell,
    textElement(
      documentRoot,
      "td",
      summary.questions,
      summaryCellClass(summary.questions, "", true),
    ),
    textElement(
      documentRoot,
      "td",
      summary.age,
      summaryCellClass(summary.age, "age", true),
    ),
    costCell,
    unattributedCell,
  );
  row.firstElementChild.scope = "row";
}

function createRepositorySummary(documentRoot) {
  const region = documentRoot.createElement("div");
  const hint = textElement(
    documentRoot,
    "p",
    "Scroll horizontally for cost columns →",
    "repository-summary-hint",
  );
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
    "Factory overhead",
  ]) {
    const cell = textElement(documentRoot, "th", heading);
    cell.scope = "col";
    if (
      ["Questions", "Worklog age", "Total cost", "Factory overhead"].includes(
        heading,
      )
    ) {
      cell.className = "numeric-cell";
    }
    if (heading === "Factory overhead")
      cell.title = "Factory session usage not assigned to a task";
    headingRow.append(cell);
  }
  head.append(headingRow);
  table.append(head, body);
  scroll.append(table);
  region.className = "repository-summary-region";
  region.append(hint, scroll);
  return { region, body };
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
  tab.className = "tab repository-tab";
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

function createMachineView(identity, index, documentRoot, isPeer, origin) {
  const row = documentRoot.createElement("tr");
  const tab = documentRoot.createElement("button");
  const panel = documentRoot.createElement("section");
  const grid = documentRoot.createElement("div");
  const tabId = `machine-tab-${index}`;
  const panelId = `machine-panel-${index}`;
  tab.type = "button";
  tab.id = tabId;
  tab.className = "tab machine-tab";
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
  const routing = renderRoutingStrip(undefined, documentRoot, {
    title: "Current / next-run routing",
    current: true,
  });
  panel.append(routing, grid);
  return {
    identity,
    origin,
    index,
    row,
    tab,
    panel,
    routing,
    grid,
    repositories: [],
    fleet: null,
  };
}

function updateMachineView(view, summary, fleet, now, unreachable = false) {
  view.fleet = fleet;
  renderSummaryRow(view.row, summary);
  renderTabLabel(view.tab, summary);
  const routing = renderRoutingStrip(
    fleet?.currentRouting,
    view.grid.ownerDocument,
    {
      title: "Current / next-run routing",
      current: true,
    },
  );
  view.routing.replaceWith(routing);
  view.routing = routing;
  if (unreachable) {
    view.repositories = [];
    view.grid.replaceChildren(
      textElement(
        view.grid.ownerDocument,
        "p",
        "UNREACHABLE",
        "chip chip-warn unreachable",
      ),
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
  const fleetWarnings = documentRoot.createElement("section");
  fleetWarnings.className = "panel fleet-warnings";
  if (fleet.warnings?.length > 0) {
    appendText(
      fleetWarnings,
      "p",
      `Discovery warnings: ${fleet.warnings.map((warning) => warning.code).join(", ")}`,
      "warning-explanation",
    );
  }
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
    ...(fleet.warnings?.length > 0 ? [fleetWarnings] : []),
    repositorySummary.region,
    repositoryTabs,
    repositoryPanels,
  );
}

function dashboardHash(machine, repository, question) {
  const values = { machine };
  if (repository !== undefined) values.repo = repository;
  if (question !== undefined) values.question = question;
  return `#${new URLSearchParams(values).toString()}`;
}

function hashSelection(windowRoot) {
  const values = new URLSearchParams(
    windowRoot?.location?.hash?.slice(1) ?? "",
  );
  return {
    machine: values.get("machine"),
    repository: values.get("repo"),
    question: values.get("question"),
  };
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
    if (
      windowRoot?.location?.hash === "#question-queue" ||
      windowRoot?.location?.hash === "#dependency-graph"
    )
      return;
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
          selection.question ?? undefined,
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
  const onHashChange = () => {
    selectFromHash(true);
    renderQuestionQueue(documentRoot, views);
  };
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

function compareQuestionIds(left, right) {
  const leftDigits = left.slice(1);
  const rightDigits = right.slice(1);
  return compareDecimalDigits(leftDigits, rightDigits);
}

function compareQuestionText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function questionHash(machine, repository, question) {
  return dashboardHash(machine, repository, question);
}

function duplicateRepositoryNames(documentRoot, views) {
  const machinesByRepository = new Map();
  const visibleMachines = new Set(views.map((view) => view.identity));
  const add = (machine, repository) => {
    let machines = machinesByRepository.get(repository);
    if (!machines) {
      machines = new Set();
      machinesByRepository.set(repository, machines);
    }
    machines.add(machine);
  };
  for (const view of views) {
    for (const repository of view.fleet?.repositories ?? []) {
      add(view.identity, repository.name);
    }
  }
  for (const state of getAnswerStore(documentRoot).values()) {
    if (
      visibleMachines.has(state.machine) &&
      (state.id || state.status === "uncertain")
    )
      add(state.machine, state.repository);
  }
  return new Set(
    Array.from(machinesByRepository, ([repository, machines]) =>
      machines.size > 1 ? repository : undefined,
    ).filter(Boolean),
  );
}

function questionDisplayIdentity(
  machine,
  repository,
  question,
  duplicatedRepositories,
) {
  const identity = `${repository}/${question}`;
  return duplicatedRepositories.has(repository)
    ? `${machine}/${identity}`
    : identity;
}

function updateQuestionDetailIdentities(documentRoot, duplicatedRepositories) {
  for (const heading of documentRoot.querySelectorAll(
    ".question-durable-identity",
  )) {
    const parts = questionIdentityHeadings.get(heading);
    if (!parts) continue;
    heading.textContent = `${questionDisplayIdentity(
      parts.machine,
      parts.repository,
      parts.question,
      duplicatedRepositories,
    )} · ${parts.suffix}`;
  }
}

function compareQuestionQueueEntries(left, right) {
  return (
    compareQuestionText(left.repository.name, right.repository.name) ||
    compareQuestionIds(left.question.id, right.question.id) ||
    compareQuestionText(left.machine, right.machine)
  );
}

function insertBoundedQuestionEntry(entries, entry) {
  if (
    entries.length === MAX_QUESTION_QUEUE_ENTRIES &&
    compareQuestionQueueEntries(
      entry,
      entries[MAX_QUESTION_QUEUE_ENTRIES - 1],
    ) >= 0
  ) {
    return;
  }
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareQuestionQueueEntries(entry, entries[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  entries.splice(low, 0, entry);
  if (entries.length > MAX_QUESTION_QUEUE_ENTRIES) entries.pop();
}

function answerKey(machine, repository, question) {
  return `${machine}\u0000${repository}\u0000${question}`;
}

function validLifecycleString(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !ASCII_CONTROL.test(value)
  );
}

function validateStoredAnswerPayload(value, question) {
  if (
    !isRecord(value) ||
    value.question !== question ||
    (value.option !== undefined && !/^[A-Z]$/.test(value.option)) ||
    (value.text !== undefined &&
      (!validLifecycleString(value.text, MAX_ANSWER_TEXT_LENGTH) ||
        ASCII_CONTROL.test(value.text))) ||
    (value.option === undefined && value.text === undefined)
  ) {
    return null;
  }
  return {
    question,
    ...(value.option === undefined ? {} : { option: value.option }),
    ...(value.text === undefined ? {} : { text: value.text }),
  };
}

function validateStoredLifecycle(value) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !validLifecycleString(value.machine, 128) ||
    !validLifecycleString(value.repository, 128) ||
    typeof value.question !== "string" ||
    !/^Q[1-9][0-9]*$/.test(value.question) ||
    !["uncertain", "pending", "inflight", "accepted", "rejected"].includes(
      value.status,
    ) ||
    (value.actor !== undefined && !validLifecycleString(value.actor, 512)) ||
    (value.reason !== undefined && !validLifecycleString(value.reason, 512))
  ) {
    return null;
  }
  if (value.status === "uncertain") {
    const payload = validateStoredAnswerPayload(value.payload, value.question);
    if (
      value.id !== undefined ||
      value.actor !== undefined ||
      value.reason !== undefined ||
      value.secret !== undefined ||
      !ANSWER_UUID.test(String(value.idempotencyKey)) ||
      payload === null
    ) {
      return null;
    }
    return {
      version: 1,
      machine: value.machine,
      repository: value.repository,
      question: value.question,
      status: "uncertain",
      idempotencyKey: value.idempotencyKey,
      payload,
      stage: "review",
      secret: "",
      error: "Submission status uncertain; operator verification required",
    };
  }
  if (
    !ANSWER_UUID.test(String(value.id)) ||
    (value.status === "accepted" && value.actor === undefined) ||
    (value.status === "rejected" && value.reason === undefined) ||
    (["pending", "inflight"].includes(value.status) &&
      (value.actor !== undefined || value.reason !== undefined))
  ) {
    return null;
  }
  return {
    version: 1,
    machine: value.machine,
    repository: value.repository,
    question: value.question,
    id: value.id,
    status: value.status,
    ...(value.actor === undefined ? {} : { actor: value.actor }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
    resumed: true,
  };
}

function getAnswerStore(documentRoot) {
  let store = answerStores.get(documentRoot);
  if (store) return store;
  store = new Map();
  try {
    const raw =
      documentRoot.defaultView?.localStorage?.getItem(ANSWER_STORAGE_KEY);
    const values = raw === null || raw === undefined ? [] : JSON.parse(raw);
    if (
      Array.isArray(values) &&
      values.length <= MAX_STORED_ANSWER_LIFECYCLES
    ) {
      for (const value of values) {
        const lifecycle = validateStoredLifecycle(value);
        if (lifecycle !== null) {
          store.set(
            answerKey(
              lifecycle.machine,
              lifecycle.repository,
              lifecycle.question,
            ),
            lifecycle,
          );
        }
      }
    }
  } catch {
    // Storage is an optional durability aid; the current session still works.
  }
  answerStores.set(documentRoot, store);
  return store;
}

function persistAnswerStore(documentRoot, requiredState) {
  const states = [...getAnswerStore(documentRoot).values()].filter(
    (state) =>
      ANSWER_UUID.test(String(state.id)) ||
      (state.status === "uncertain" &&
        ANSWER_UUID.test(String(state.idempotencyKey)) &&
        state.payload !== undefined),
  );
  if (requiredState !== undefined) {
    const requiredIndex = states.indexOf(requiredState);
    if (requiredIndex >= 0) {
      states.splice(requiredIndex, 1);
      states.push(requiredState);
    }
  }
  const records = states.slice(-MAX_STORED_ANSWER_LIFECYCLES).map((state) =>
    state.status === "uncertain"
      ? {
          version: 1,
          machine: state.machine,
          repository: state.repository,
          question: state.question,
          status: state.status,
          payload: state.payload,
          idempotencyKey: state.idempotencyKey,
        }
      : {
          version: 1,
          machine: state.machine,
          repository: state.repository,
          question: state.question,
          id: state.id,
          status: state.status,
          ...(state.actor === undefined ? {} : { actor: state.actor }),
          ...(state.reason === undefined ? {} : { reason: state.reason }),
        },
  );
  try {
    const storage = documentRoot.defaultView?.localStorage;
    if (!storage) return false;
    storage.setItem(ANSWER_STORAGE_KEY, JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

function answerRuntime(documentRoot) {
  let runtime = answerRuntimes.get(documentRoot);
  if (runtime) return runtime;
  runtime = {
    fetcher: globalThis.fetch.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    randomUUID: browserRandomUUID,
    stopped: false,
  };
  answerRuntimes.set(documentRoot, runtime);
  return runtime;
}

function browserRandomUUID() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

function answerEndpoint(view, repository, id) {
  const path = `/api/repo/${encodeURIComponent(repository)}/answers${id ? `/${id}` : ""}`;
  return view.origin === undefined ? path : new URL(path, view.origin).href;
}

function answerAuthHeaders(state) {
  return state.authRequired ? { Authorization: `Bearer ${state.secret}` } : {};
}

async function readAnswerResponse(response, allowNotFound = false) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ANSWER_RESPONSE_BYTES) {
    throw new Error("Answer response is too large");
  }
  let text = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ANSWER_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("Answer response is too large");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.message === "Answer response is too large"
      ) {
        throw cause;
      }
      throw new Error("Invalid answer response");
    }
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid answer response");
  }
  if (!response.ok && !(allowNotFound && response.status === 404)) {
    const message =
      isRecord(value) && validLifecycleString(value.error, 512)
        ? value.error
        : `Answer request failed (${response.status})`;
    throw new Error(message);
  }
  return value;
}

async function fetchAnswerWithTimeout(runtime, input, init) {
  const controller = new AbortController();
  let timeout;
  const timeoutFailure = new Promise((_, reject) => {
    timeout = runtime.setTimeout(() => {
      controller.abort();
      reject(new Error("Answer request timed out"));
    }, ANSWER_FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      runtime.fetcher(input, { ...init, signal: controller.signal }),
      timeoutFailure,
    ]);
  } finally {
    runtime.clearTimeout(timeout);
  }
}

function rerenderQuestionQueue(documentRoot) {
  const views = machineViews.get(documentRoot);
  if (views) renderQuestionQueue(documentRoot, views);
}

function clearAnswerPoll(documentRoot, state) {
  if (state.pollTimer !== undefined) {
    answerRuntime(documentRoot).clearTimeout(state.pollTimer);
    state.pollTimer = undefined;
  }
}

function terminalAnswer(documentRoot, state, status, detail) {
  clearAnswerPoll(documentRoot, state);
  state.status = status;
  state.secret = "";
  state.polling = false;
  state.resumed = false;
  state.error = undefined;
  if (status === "accepted") state.actor = detail;
  else state.reason = detail;
  persistAnswerStore(documentRoot);
  rerenderQuestionQueue(documentRoot);
}

function validAnswerOutcome(value, id, question) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.id !== id ||
    value.question !== question ||
    value.source !== "factory-ui" ||
    !["pending", "inflight", "accepted", "rejected"].includes(value.status) ||
    !validLifecycleString(value.actor, 512) ||
    !isTimestamp(value.submittedAt)
  ) {
    return false;
  }
  return (
    (value.status !== "rejected" && value.reason === undefined) ||
    (value.status === "rejected" && validLifecycleString(value.reason, 512))
  );
}

function scheduleAnswerPoll(documentRoot, view, state) {
  const runtime = answerRuntime(documentRoot);
  clearAnswerPoll(documentRoot, state);
  if (
    runtime.stopped ||
    state.polling ||
    state.resumed ||
    (state.authRequired && !state.secret) ||
    !ANSWER_UUID.test(String(state.id)) ||
    ["accepted", "rejected"].includes(state.status)
  ) {
    return;
  }
  state.pollTimer = runtime.setTimeout(
    () => void pollAnswer(documentRoot, view, state),
    ANSWER_POLL_INTERVAL_MS,
  );
}

async function pollAnswer(documentRoot, view, state) {
  const runtime = answerRuntime(documentRoot);
  if (state.polling || runtime.stopped || (state.authRequired && !state.secret))
    return;
  state.polling = true;
  state.error = undefined;
  rerenderQuestionQueue(documentRoot);
  try {
    const response = await fetchAnswerWithTimeout(
      runtime,
      answerEndpoint(view, state.repository, state.id),
      { headers: answerAuthHeaders(state) },
    );
    const value = await readAnswerResponse(response, true);
    if (isRecord(value) && value.status === "unknown-record") {
      state.polling = false;
      state.secret = "";
      state.resumed = true;
      state.error = "Outcome record not found";
      rerenderQuestionQueue(documentRoot);
      return;
    }
    if (!validAnswerOutcome(value, state.id, state.question)) {
      throw new Error("Invalid answer outcome");
    }
    state.polling = false;
    if (value.status === "accepted") {
      terminalAnswer(documentRoot, state, "accepted", value.actor);
      return;
    }
    if (value.status === "rejected") {
      terminalAnswer(documentRoot, state, "rejected", value.reason);
      return;
    }
    state.status = value.status;
    persistAnswerStore(documentRoot);
    rerenderQuestionQueue(documentRoot);
    scheduleAnswerPoll(documentRoot, view, state);
  } catch (cause) {
    state.polling = false;
    state.secret = "";
    state.resumed = true;
    state.error = cause instanceof Error ? cause.message : "Tracking failed";
    rerenderQuestionQueue(documentRoot);
  }
}

async function submitAnswerFromQueue(documentRoot, view, state) {
  if (state.sending) return;
  const runtime = answerRuntime(documentRoot);
  state.sending = true;
  state.error = undefined;
  try {
    if (!state.idempotencyKey) state.idempotencyKey = runtime.randomUUID();
    state.status = "uncertain";
    if (!persistAnswerStore(documentRoot, state)) {
      state.sending = false;
      state.error = "Browser storage unavailable; submission not sent";
      rerenderQuestionQueue(documentRoot);
      return;
    }
    rerenderQuestionQueue(documentRoot);
    const response = await fetchAnswerWithTimeout(
      runtime,
      answerEndpoint(view, state.repository),
      {
        method: "POST",
        headers: {
          ...answerAuthHeaders(state),
          "Content-Type": "application/json",
          "Idempotency-Key": state.idempotencyKey,
        },
        body: JSON.stringify(state.payload),
      },
    );
    const value = await readAnswerResponse(response);
    if (
      !isRecord(value) ||
      value.status !== "pending" ||
      !ANSWER_UUID.test(String(value.id))
    ) {
      throw new Error("Invalid answer submission response");
    }
    state.id = value.id;
    state.status = "pending";
    state.sending = false;
    state.resumed = false;
    persistAnswerStore(documentRoot);
    rerenderQuestionQueue(documentRoot);
    scheduleAnswerPoll(documentRoot, view, state);
  } catch (cause) {
    state.sending = false;
    state.error = cause instanceof Error ? cause.message : "Submission failed";
    rerenderQuestionQueue(documentRoot);
  }
}

function renderAnswerLifecycle(
  parent,
  documentRoot,
  view,
  state,
  identity,
  allowResume = true,
) {
  const lifecycle = documentRoot.createElement("section");
  lifecycle.className = "answer-lifecycle";
  if (state.status === "accepted") {
    appendText(
      lifecycle,
      "strong",
      "applied/consumed",
      "answer-status chip chip-good",
    );
    appendText(
      lifecycle,
      "p",
      `${identity} · Answered by ${state.actor} via factory-ui`,
      "answer-attribution",
    );
  } else if (state.status === "rejected") {
    appendText(
      lifecycle,
      "strong",
      "rejected",
      "answer-status chip chip-danger",
    );
    appendText(lifecycle, "p", state.reason, "answer-reason");
    appendText(lifecycle, "p", identity, "answer-identity");
  } else {
    appendText(
      lifecycle,
      "strong",
      "pending application",
      "answer-status chip chip-info",
    );
    appendText(lifecycle, "p", identity, "answer-identity");
    if (state.error) appendText(lifecycle, "p", state.error, "answer-error");
    if (allowResume && state.authRequired && (state.resumed || !state.secret)) {
      const resume = documentRoot.createElement("div");
      resume.className = "answer-resume";
      const label = appendText(resume, "label", "Shared secret");
      const password = documentRoot.createElement("input");
      password.type = "password";
      password.autocomplete = "current-password";
      password.value = state.secret ?? "";
      password.addEventListener("input", () => {
        state.secret = password.value;
      });
      label.append(password);
      const button = appendText(
        resume,
        "button",
        state.polling ? "Tracking…" : "Resume tracking",
        "button button-secondary",
      );
      button.type = "button";
      button.disabled = state.polling;
      button.addEventListener("click", () => {
        state.secret = password.value;
        if (!state.secret) {
          state.error = "Shared secret is required";
          rerenderQuestionQueue(documentRoot);
          return;
        }
        state.resumed = false;
        void pollAnswer(documentRoot, view, state);
      });
      resume.append(button);
      lifecycle.append(resume);
    } else if (allowResume && !state.authRequired && state.resumed) {
      const resume = documentRoot.createElement("div");
      resume.className = "answer-resume";
      const button = appendText(
        resume,
        "button",
        state.polling ? "Tracking…" : "Resume tracking",
        "button button-secondary",
      );
      button.type = "button";
      button.disabled = state.polling;
      button.addEventListener("click", () => {
        state.resumed = false;
        void pollAnswer(documentRoot, view, state);
      });
      lifecycle.append(resume);
    }
  }
  parent.append(lifecycle);
}

function renderAnswerForm(
  parent,
  documentRoot,
  view,
  question,
  state,
  identity,
) {
  const form = documentRoot.createElement("div");
  form.className = "answer-form";
  if (state.stage === "review" || state.payload) {
    appendText(
      form,
      "h4",
      `Review answer · ${identity}`,
      "question-field-label",
    );
    if (state.payload?.option)
      appendText(
        form,
        "p",
        `Option: ${state.payload.option}`,
        "answer-review-value",
      );
    if (state.payload?.text)
      appendText(
        form,
        "p",
        `Text: ${state.payload.text}`,
        "answer-review-value",
      );
    if (state.idempotencyKey && state.authRequired) {
      const secretLabel = appendText(
        form,
        "label",
        "Shared secret",
        "answer-label",
      );
      const secret = documentRoot.createElement("input");
      secret.type = "password";
      secret.autocomplete = "current-password";
      secret.value = state.secret ?? "";
      secret.addEventListener("input", () => {
        state.secret = secret.value;
      });
      secretLabel.append(secret);
    }
    if (state.error) appendText(form, "p", state.error, "answer-error");
    const actions = documentRoot.createElement("div");
    actions.className = "answer-actions";
    const confirm = appendText(
      actions,
      "button",
      state.sending
        ? "Submitting…"
        : state.idempotencyKey
          ? "Check submission status"
          : "Confirm submission",
      "button button-primary",
    );
    confirm.type = "button";
    confirm.disabled = state.sending;
    confirm.addEventListener(
      "click",
      () => void submitAnswerFromQueue(documentRoot, view, state),
    );
    if (!state.idempotencyKey) {
      const cancel = appendText(
        actions,
        "button",
        "Cancel",
        "button button-secondary",
      );
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        state.stage = "edit";
        state.payload = undefined;
        state.error = undefined;
        rerenderQuestionQueue(documentRoot);
      });
    }
    form.append(actions);
    parent.append(form);
    return;
  }

  appendText(form, "h4", "Answer", "question-field-label");
  const textLabel = appendText(
    form,
    "label",
    question.qualifier ?? "Optional answer text",
    "answer-label",
  );
  const text = documentRoot.createElement("input");
  text.type = "text";
  text.maxLength = MAX_ANSWER_TEXT_LENGTH;
  text.value = state.text ?? "";
  text.addEventListener("input", () => {
    state.text = text.value;
  });
  textLabel.append(text);
  let secret;
  if (state.authRequired) {
    const secretLabel = appendText(
      form,
      "label",
      "Shared secret",
      "answer-label",
    );
    secret = documentRoot.createElement("input");
    secret.type = "password";
    secret.autocomplete = "current-password";
    secret.value = state.secret ?? "";
    secret.addEventListener("input", () => {
      state.secret = secret.value;
    });
    secretLabel.append(secret);
  }
  if (state.error) appendText(form, "p", state.error, "answer-error");
  const review = appendText(
    form,
    "button",
    "Review answer",
    "button button-primary",
  );
  review.type = "button";
  review.addEventListener("click", () => {
    const answerText = text.value.trim();
    state.text = text.value;
    state.secret = secret?.value ?? "";
    if (!state.option && !answerText) {
      state.error = "Select an option or enter answer text";
    } else if (answerText && ASCII_CONTROL.test(text.value)) {
      state.error = "Answer text cannot contain ASCII control characters";
    } else if (state.authRequired && !state.secret) {
      state.error = "Shared secret is required";
    } else {
      state.error = undefined;
      state.payload = {
        question: question.id,
        ...(state.option ? { option: state.option } : {}),
        ...(answerText ? { text: answerText } : {}),
      };
      state.stage = "review";
    }
    rerenderQuestionQueue(documentRoot);
  });
  parent.append(form);
}

function renderOwningDashboardLink(
  parent,
  view,
  machine,
  repository,
  question,
) {
  const message = parent.ownerDocument.createElement("p");
  message.className = "answer-owning-dashboard";
  message.append(
    parent.ownerDocument.createTextNode(
      "Answers are available only on the owning dashboard. ",
    ),
  );
  const link = textElement(parent.ownerDocument, "a", `Open ${machine}`);
  link.href = new URL(
    questionHash(machine, repository, question),
    view.origin,
  ).href;
  link.rel = "noopener noreferrer";
  message.append(link);
  parent.append(message);
}

function renderQuestionQueue(documentRoot, views, now = new Date()) {
  const list = documentRoot.querySelector("#question-queue-list");
  const heading = documentRoot.querySelector("#question-queue-heading");
  const headerCount = documentRoot.querySelector("#question-queue-count");
  if (!list || !heading) return;
  const entries = [];
  let openEntries = 0;
  let trackedEntries = 0;
  const visibleKeys = new Set();
  const questionOccurrences = new Map();
  const answerStore = getAnswerStore(documentRoot);
  const duplicatedRepositories = duplicateRepositoryNames(documentRoot, views);
  for (const view of views) {
    for (const repository of view.fleet?.repositories ?? []) {
      for (const question of readerData(repository.questions)?.open ?? []) {
        const key = answerKey(view.identity, repository.name, question.id);
        visibleKeys.add(key);
        questionOccurrences.set(key, (questionOccurrences.get(key) ?? 0) + 1);
        openEntries += 1;
        insertBoundedQuestionEntry(entries, {
          machine: view.identity,
          view,
          repository,
          question,
        });
      }
    }
  }
  for (const state of answerStore.values()) {
    if (
      visibleKeys.has(
        answerKey(state.machine, state.repository, state.question),
      )
    ) {
      continue;
    }
    const view = views.find(
      (candidate) => candidate.identity === state.machine,
    );
    if (!view || (!state.id && state.status !== "uncertain")) continue;
    trackedEntries += 1;
    insertBoundedQuestionEntry(entries, {
      machine: state.machine,
      view,
      repository: { name: state.repository },
      question: {
        id: state.question,
        title: "Answer lifecycle",
        taskId: "Unknown",
      },
      lifecycleOnly: true,
    });
  }
  const totalEntries = openEntries + trackedEntries;
  const countLabel =
    trackedEntries > 0
      ? `${openEntries} open · ${trackedEntries} tracked`
      : String(openEntries);
  heading.textContent =
    totalEntries > entries.length
      ? `Question queue · ${countLabel} · showing ${entries.length}`
      : `Question queue · ${countLabel}`;
  if (headerCount) headerCount.textContent = String(openEntries);
  if (entries.length === 0) {
    list.replaceChildren(
      textElement(documentRoot, "p", "No open questions", "empty"),
    );
    updateQuestionDetailIdentities(documentRoot, duplicatedRepositories);
    return;
  }
  const cards = entries.map(
    ({ machine, view, repository, question, lifecycleOnly }) => {
      const item = documentRoot.createElement("article");
      item.className = "question-queue-entry";
      const selection = hashSelection(documentRoot.defaultView);
      const key = answerKey(machine, repository.name, question.id);
      const displayIdentity = questionDisplayIdentity(
        machine,
        repository.name,
        question.id,
        duplicatedRepositories,
      );
      const hasUnambiguousLink =
        lifecycleOnly || questionOccurrences.get(key) === 1;
      if (
        hasUnambiguousLink &&
        selection.machine === machine &&
        selection.repository === repository.name &&
        selection.question === question.id
      ) {
        item.classList.add("question-queue-entry-linked");
        item.tabIndex = -1;
      }
      const title = documentRoot.createElement("h3");
      const titleText = `${displayIdentity} · ${question.title}`;
      if (hasUnambiguousLink) {
        const link = textElement(documentRoot, "a", titleText);
        link.href = questionHash(machine, repository.name, question.id);
        title.append(link);
      } else {
        title.textContent = titleText;
      }
      item.append(title);
      appendText(
        item,
        "p",
        `${machine} · ${repository.name}`,
        "question-location",
      );
      if (question.filedAt !== undefined) {
        appendText(
          item,
          "p",
          `Filed ${displayAge(question.filedAt, now)}`,
          "age",
        );
      }
      let answerState = answerStore.get(key);
      const intake = view.fleet?.answerIntake;
      const intakeEnabled = intake?.enabled === true;
      const authRequired = intake?.authRequired !== false;
      if (answerState) answerState.authRequired = authRequired;
      if (lifecycleOnly) {
        if (view.origin !== undefined) {
          if (answerState) {
            renderAnswerLifecycle(
              item,
              documentRoot,
              view,
              answerState,
              displayIdentity,
              false,
            );
          }
          if (intakeEnabled) {
            renderOwningDashboardLink(
              item,
              view,
              machine,
              repository.name,
              question.id,
            );
          }
        } else if (!intakeEnabled) {
          if (
            answerState &&
            ["accepted", "rejected"].includes(answerState.status)
          ) {
            renderAnswerLifecycle(
              item,
              documentRoot,
              view,
              answerState,
              displayIdentity,
            );
          }
        } else if (answerState?.status === "uncertain") {
          renderAnswerForm(
            item,
            documentRoot,
            view,
            question,
            answerState,
            displayIdentity,
          );
        } else if (answerState) {
          renderAnswerLifecycle(
            item,
            documentRoot,
            view,
            answerState,
            displayIdentity,
          );
          if (
            answerState.id &&
            (!authRequired || answerState.secret) &&
            ["pending", "inflight"].includes(answerState.status)
          ) {
            scheduleAnswerPoll(documentRoot, view, answerState);
          }
        }
        return item;
      }
      const task = question.blockedTask;
      const taskRow = documentRoot.createElement("p");
      taskRow.className = "question-task";
      appendText(taskRow, "strong", "Blocked task: ");
      appendExternalOrText(
        taskRow,
        question.taskId,
        task ? repository.planUrl : undefined,
        "plan",
      );
      if (task) taskRow.append(documentRoot.createTextNode(` · ${task.title}`));
      item.append(taskRow);
      const refs = documentRoot.createElement("p");
      refs.className = "question-links";
      const references = [];
      if (question.branch && safeGithubUrl(question.branchUrl, "branch"))
        references.push([question.branch, question.branchUrl, "branch"]);
      if (task?.pr) references.push([`PR #${task.pr}`, task.prUrl, "pull"]);
      for (const [index, issue] of (task?.issueNumbers ?? []).entries())
        references.push([`Issue #${issue}`, task.issueUrls?.[index], "issue"]);
      references.forEach(([label, url, kind], index) => {
        if (index > 0) refs.append(documentRoot.createTextNode(" · "));
        appendExternalOrText(refs, label, url, kind);
      });
      if (references.length > 0) item.append(refs);
      const structured = questionIsStructured(question);
      if (
        view.origin === undefined &&
        intakeEnabled &&
        structured &&
        !answerState
      ) {
        answerState = {
          machine,
          repository: repository.name,
          question: question.id,
          stage: "edit",
          text: "",
          secret: "",
          authRequired,
        };
        answerStore.set(key, answerState);
      }
      const interactiveOptions =
        view.origin === undefined &&
        intakeEnabled &&
        Array.isArray(question.options) &&
        question.options.length > 0 &&
        answerState &&
        !answerState.id &&
        answerState.stage !== "review" &&
        !answerState.payload
          ? {
              state: answerState,
              name: `answer-${view.identity}-${answerState.repository}-${question.id}`,
            }
          : undefined;
      renderQuestionBody(item, question, interactiveOptions);
      if (view.origin !== undefined) {
        if (answerState) {
          renderAnswerLifecycle(
            item,
            documentRoot,
            view,
            answerState,
            displayIdentity,
            false,
          );
        }
        if (structured && intakeEnabled) {
          renderOwningDashboardLink(
            item,
            view,
            machine,
            repository.name,
            question.id,
          );
        }
        return item;
      }
      if (!intakeEnabled) return item;
      if (answerState?.id) {
        answerState.authRequired = authRequired;
        renderAnswerLifecycle(
          item,
          documentRoot,
          view,
          answerState,
          displayIdentity,
        );
        if (
          (!authRequired || answerState.secret) &&
          ["pending", "inflight"].includes(answerState.status)
        ) {
          scheduleAnswerPoll(documentRoot, view, answerState);
        }
      } else if (structured) {
        answerState.authRequired = authRequired;
        renderAnswerForm(
          item,
          documentRoot,
          view,
          question,
          answerState,
          displayIdentity,
        );
      }
      return item;
    },
  );
  list.replaceChildren(...cards);
  updateQuestionDetailIdentities(documentRoot, duplicatedRepositories);
  list
    .querySelector(".question-queue-entry-linked")
    ?.scrollIntoView?.({ block: "start" });
}

function graphTaskState(task, repository) {
  const state = readerData(repository.state);
  if (task.status === "completed") return "done";
  if (task.status === "blocked") return "question-blocked";
  if (task.status === "active") return "building";
  if (task.status === "review" && state?.hold && state.currentTask === task.id)
    return "held";
  if (task.status === "review") return "review";
  return task.runnable ? "runnable" : "waiting";
}

function validGraphTask(task) {
  const local = task?.localDependencies ?? task?.dependencies;
  const cross = task?.crossRepoDependencies ?? [];
  return (
    isRecord(task) &&
    /^T[1-9][0-9]*$/.test(task.id) &&
    typeof task.title === "string" &&
    task.title.length <= MAX_QUESTION_TEXT_LENGTH &&
    ["todo", "active", "review", "completed", "blocked"].includes(
      task.status,
    ) &&
    typeof task.runnable === "boolean" &&
    Array.isArray(local) &&
    local.length <= MAX_TASK_DEPENDENCIES &&
    local.every((dependency) => /^T[1-9][0-9]*$/.test(dependency)) &&
    Array.isArray(cross) &&
    cross.length <= MAX_TASK_DEPENDENCIES &&
    cross.every((dependency) =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}#)[A-Za-z0-9._-]+#[1-9][0-9]*$/.test(
        dependency,
      ),
    )
  );
}

function graphDependencies(task) {
  return {
    local: task.localDependencies ?? task.dependencies ?? [],
    cross: task.crossRepoDependencies ?? [],
  };
}

function crossRepoIssueUrl(reference) {
  const match = /^([^/]+)\/([^#]+)#([1-9][0-9]*)$/.exec(reference);
  if (!match) return undefined;
  return `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`;
}

function graphQuestion(repository, taskId) {
  return (readerData(repository.questions)?.open ?? []).find(
    (question) => question.taskId === taskId,
  );
}

const GRAPH_STATE_LABELS = {
  runnable: "Runnable",
  waiting: "Waiting",
  building: "Building",
  review: "Review",
  "question-blocked": "Question blocked",
  held: "Review",
  done: "Done",
};

function renderDependencyTask(parent, machine, repository, task, localTasks) {
  const item = parent.ownerDocument.createElement("li");
  const state = graphTaskState(task, repository);
  item.className = `dependency-task dependency-state-${state}`;
  const header = parent.ownerDocument.createElement("div");
  header.className = "dependency-task-header";
  const identity = `${task.id} · ${task.title}`;
  const question = graphQuestion(repository, task.id);
  if (state === "question-blocked" && question) {
    const link = textElement(parent.ownerDocument, "a", identity);
    link.href = questionHash(machine, repository.name, question.id);
    link.className = "dependency-node-question";
    header.append(link);
  } else if (Number.isSafeInteger(task.pr) && task.pr > 0) {
    const repositoryUrl = safeGithubUrl(repository.repositoryUrl, "repository");
    const link = appendExternalOrText(
      header,
      identity,
      task.prUrl ??
        (repositoryUrl
          ? `${repositoryUrl.replace(/\/$/, "")}/pull/${task.pr}`
          : undefined),
      "pull",
    );
    if (link.tagName === "A") link.classList.add("dependency-node-pr");
  } else {
    appendText(header, "span", identity);
  }
  appendText(
    header,
    "span",
    GRAPH_STATE_LABELS[state],
    `chip dependency-state-chip dependency-state-${state}`,
  );
  if (state === "held")
    appendText(header, "span", "Held", "chip dependency-state-held");
  item.append(header);
  const issueNumbers = Array.isArray(task.issueNumbers)
    ? task.issueNumbers
        .filter((issue) => Number.isSafeInteger(issue) && issue > 0)
        .slice(0, MAX_TASK_DEPENDENCIES)
    : [];
  if (issueNumbers.length > 0) {
    const issues = parent.ownerDocument.createElement("div");
    issues.className = "dependency-node-issues";
    issueNumbers.forEach((issue, index) => {
      if (index > 0) issues.append(parent.ownerDocument.createTextNode(" · "));
      appendExternalOrText(
        issues,
        `Issue #${issue}`,
        Array.isArray(task.issueUrls) ? task.issueUrls[index] : undefined,
        "issue",
      );
    });
    item.append(issues);
  }
  const dependencies = graphDependencies(task);
  if (dependencies.local.length > 0 || dependencies.cross.length > 0) {
    const edges = parent.ownerDocument.createElement("div");
    edges.className = "dependency-edges";
    for (const dependency of dependencies.local) {
      const prerequisite = localTasks.get(dependency);
      const satisfied = prerequisite?.status === "completed";
      appendText(
        edges,
        "span",
        satisfied ? `✓ ${dependency}` : `← ${dependency}`,
        `dependency-edge dependency-edge-local${satisfied ? " dependency-edge-satisfied" : ""}`,
      );
    }
    for (const dependency of dependencies.cross) {
      const edge = parent.ownerDocument.createElement("span");
      edge.className =
        "dependency-edge dependency-edge-cross dependency-edge-cross-repo";
      edge.append(parent.ownerDocument.createTextNode("⇠ "));
      appendExternalOrText(
        edge,
        dependency,
        crossRepoIssueUrl(dependency),
        "issue",
      );
      edges.append(edge);
    }
    item.append(edges);
  }
  parent.append(item);
}

function renderDependencyGraph(documentRoot, views) {
  const graph = documentRoot.querySelector("#dependency-graph-list");
  if (!graph) return;
  const repositories = [];
  for (const view of views) {
    if (!view.fleet) {
      repositories.push({
        view,
        unavailableMachine: true,
      });
      continue;
    }
    for (const repository of view.fleet?.repositories ?? []) {
      const plan = readerData(repository.plan);
      if (
        !Array.isArray(plan?.tasks) ||
        plan.tasks.length > MAX_DEPENDENCY_GRAPH_TASKS
      ) {
        repositories.push({
          view,
          repository,
          error:
            repository.plan?.status === "unavailable"
              ? "Dependency data unavailable"
              : "Some malformed task data was isolated",
        });
        continue;
      }
      const validTasks = plan.tasks.filter(validGraphTask);
      repositories.push({
        view,
        repository,
        validTasks,
        malformed: validTasks.length !== plan.tasks.length,
        liveTasks: validTasks.filter((task) => {
          if (["active", "review", "blocked"].includes(task.status))
            return true;
          if (task.status !== "todo") return false;
          const dependencies = graphDependencies(task);
          return dependencies.local.length > 0 || dependencies.cross.length > 0;
        }),
        completedTasks: validTasks.filter(
          (task) => task.status === "completed",
        ),
      });
    }
  }

  const groups = [];
  const totalLive = repositories.reduce(
    (total, entry) => total + (entry.liveTasks?.length ?? 0),
    0,
  );
  let remainingLive = Math.min(totalLive, MAX_DEPENDENCY_GRAPH_TASKS);
  const renderedLive = remainingLive;
  for (const entry of repositories) {
    const group = documentRoot.createElement("article");
    group.className = `dependency-repository${entry.unavailableMachine ? " dependency-machine-unavailable" : ""}`;
    appendText(group, "p", entry.view.identity, "eyebrow dependency-machine");
    appendText(
      group,
      "h3",
      entry.unavailableMachine ? "Machine unavailable" : entry.repository.name,
    );
    if (entry.unavailableMachine) {
      appendText(group, "p", "Dependency data unavailable", "unavailable");
      groups.push(group);
      continue;
    }
    if (entry.error) {
      appendText(group, "p", entry.error, "unavailable");
      groups.push(group);
      continue;
    }
    if (entry.malformed) {
      appendText(
        group,
        "p",
        "Some malformed task data was isolated",
        "unavailable",
      );
    }
    const localTaskCounts = new Map();
    for (const task of entry.validTasks)
      localTaskCounts.set(task.id, (localTaskCounts.get(task.id) ?? 0) + 1);
    entry.localTasks = new Map(
      entry.validTasks
        .filter((task) => localTaskCounts.get(task.id) === 1)
        .map((task) => [task.id, task]),
    );
    const liveList = documentRoot.createElement("ol");
    liveList.className = "dependency-tasks";
    const liveCount = Math.min(entry.liveTasks.length, remainingLive);
    for (const task of entry.liveTasks.slice(0, liveCount)) {
      renderDependencyTask(
        liveList,
        entry.view.identity,
        entry.repository,
        task,
        entry.localTasks,
      );
    }
    remainingLive -= liveCount;
    if (liveList.childElementCount > 0) group.append(liveList);
    else if (
      !entry.malformed &&
      entry.validTasks.length > 0 &&
      entry.validTasks.every((task) => task.status === "completed")
    ) {
      appendText(
        group,
        "p",
        `all ${entry.completedTasks.length} tasks done`,
        "dependency-all-done",
      );
    } else if (entry.liveTasks.length > 0) {
      appendText(group, "p", "Tasks omitted by graph limit", "unavailable");
    } else {
      appendText(group, "p", "No dependency-bearing live tasks", "empty");
    }

    if (entry.completedTasks.length > 0) {
      entry.details = documentRoot.createElement("details");
      entry.details.className = "dependency-completed";
      appendText(
        entry.details,
        "summary",
        `show completed (${entry.completedTasks.length})`,
        "dependency-completed-summary",
      );
      entry.completedContent = documentRoot.createElement("div");
      entry.completedContent.className = "dependency-completed-content";
      entry.details.append(entry.completedContent);
      group.append(entry.details);
    }
    groups.push(group);
  }

  if (groups.length === 0) {
    graph.replaceChildren(
      textElement(documentRoot, "p", "No dependency data available", "empty"),
    );
    return;
  }
  graph.replaceChildren(...groups);

  let limitNotice;
  const updateCompleted = () => {
    let remainingCompleted = Math.max(
      0,
      MAX_DEPENDENCY_GRAPH_TASKS - renderedLive,
    );
    let renderedTasks = renderedLive;
    let displayedTasks = totalLive;
    for (const entry of repositories) {
      if (!entry.details) continue;
      entry.completedContent.replaceChildren();
      if (!entry.details.open) continue;
      displayedTasks += entry.completedTasks.length;
      const completedCount = Math.min(
        entry.completedTasks.length,
        remainingCompleted,
      );
      const completedList = documentRoot.createElement("ol");
      completedList.className = "dependency-tasks dependency-completed-tasks";
      for (const task of entry.completedTasks.slice(0, completedCount)) {
        renderDependencyTask(
          completedList,
          entry.view.identity,
          entry.repository,
          task,
          entry.localTasks,
        );
      }
      renderedTasks += completedCount;
      remainingCompleted -= completedCount;
      if (completedList.childElementCount > 0)
        entry.completedContent.append(completedList);
      if (completedCount < entry.completedTasks.length)
        appendText(
          entry.completedContent,
          "p",
          "Completed tasks omitted by graph limit",
          "unavailable",
        );
    }

    if (displayedTasks > renderedTasks) {
      if (!limitNotice) {
        limitNotice = textElement(
          documentRoot,
          "p",
          "",
          "dependency-limit chip chip-warn",
        );
        graph.insertBefore(limitNotice, graph.firstChild);
      }
      limitNotice.textContent = `Showing ${renderedTasks} of ${displayedTasks} tasks`;
    } else if (limitNotice) {
      limitNotice.remove();
      limitNotice = undefined;
    }
  };

  for (const entry of repositories)
    entry.details?.addEventListener("toggle", updateCompleted);
  updateCompleted();
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
    { identity: fleet.hostname, fleet, isPeer: false, origin: undefined },
    ...(Array.isArray(fleet.peers) ? fleet.peers : []).map((peer) => ({
      identity: peer.name,
      fleet: null,
      isPeer: true,
      origin: peer.origin,
    })),
  ];
  const views = machines.map((item, index) =>
    createMachineView(
      item.identity,
      index,
      documentRoot,
      item.isPeer,
      item.origin,
    ),
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
  renderQuestionQueue(documentRoot, views, now);
  renderDependencyGraph(documentRoot, views);
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
          renderQuestionQueue(documentRoot, views);
          renderDependencyGraph(documentRoot, views);
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
          renderQuestionQueue(documentRoot, views);
          renderDependencyGraph(documentRoot, views);
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
    randomUUID: dependencyOverrides.randomUUID ?? browserRandomUUID,
  };
  answerRuntimes.set(documentRoot, {
    fetcher,
    setTimeout: dependencies.setTimeout,
    clearTimeout: dependencies.clearTimeout,
    randomUUID: dependencies.randomUUID,
    stopped: false,
  });
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
      const runtime = answerRuntimes.get(documentRoot);
      if (runtime) runtime.stopped = true;
      for (const state of getAnswerStore(documentRoot).values()) {
        clearAnswerPoll(documentRoot, state);
        state.secret = "";
      }
      answerRuntimes.delete(documentRoot);
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
