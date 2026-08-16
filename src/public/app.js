const machine = document.querySelector("#machine");
const repositories = document.querySelector("#repositories");
const error = document.querySelector("#error");

function addTextElement(parent, tag, text, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
}

function renderRepository(repository) {
  const card = document.createElement("article");
  card.className = "repository";
  addTextElement(card, "h3", repository.name);

  if (repository.status === "available") {
    addTextElement(card, "p", repository.project, "project");
    addTextElement(card, "p", repository.phase, "phase");
  } else {
    addTextElement(card, "p", "Unavailable", "unavailable");
    addTextElement(card, "p", repository.warning, "warning");
  }
  repositories.append(card);
}

async function loadFleet() {
  try {
    const response = await fetch("/api/fleet");
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const fleet = await response.json();
    machine.textContent = fleet.hostname;
    repositories.replaceChildren();
    fleet.repositories.forEach(renderRepository);
  } catch (cause) {
    machine.textContent = "Local machine unavailable";
    error.textContent =
      cause instanceof Error ? cause.message : "Request failed";
  }
}

void loadFleet();
