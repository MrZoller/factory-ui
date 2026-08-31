import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const stylesheet = await Bun.file(
  new URL("./styles.css", import.meta.url),
).text();
const howHtml = await Bun.file(new URL("./how.html", import.meta.url)).text();

interface PipelineStage {
  id: string;
}

interface Role {
  id: string;
  phase: string;
}

interface Operator {
  id: string;
}

interface HowModule {
  PIPELINE: PipelineStage[];
  ROLES: Role[];
  OPERATORS: Operator[];
  OPERATOR_EDGES: { id: string }[];
  renderHow: (machines: unknown[], documentRoot?: Document) => void;
}

async function browserModule(path: string): Promise<HowModule> {
  let source = (await Bun.file(new URL(path, import.meta.url)).text()).replace(
    /import \{[\s\S]+?\} from "\/app\.js";/,
    `const MAX_CONCURRENT_PEER_FETCHES = 4;
     const providerCategory = (provider) =>
       provider === "openai" || provider === "opencode" || provider === "amazon-bedrock"
         ? provider
         : "other";
     const readFleetResponse = async (response) => response.json();
     const fetchPeerFleet = async () => { throw new Error("not used by renderHow"); };`,
  );
  source = source
    .replaceAll("export const ", "const ")
    .replaceAll("export async function ", "async function ")
    .replaceAll("export function ", "function ");
  return new Function(
    `${source}\nreturn { PIPELINE, ROLES, OPERATORS, OPERATOR_EDGES, renderHow };`,
  )() as HowModule;
}

const { PIPELINE, ROLES, OPERATORS, OPERATOR_EDGES, renderHow } =
  await browserModule("./how.js");

function howDocument(hash = ""): Document {
  const window = new Window({ url: `https://dashboard.test/how${hash}` });
  const document = window.document as unknown as Document;
  document.body.innerHTML = [
    '<div id="how-machine-tabs" role="tablist" aria-label="Machines"></div>',
    '<div id="how-machines"></div>',
  ].join("");
  return document;
}

function counters(usd: number) {
  return {
    usd,
    messages: 1,
    sessions: 1,
    tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function model(name: string, overrides: Record<string, unknown> = {}) {
  return {
    source: "models.dev",
    pricesAsOf: "2026-08-16",
    name,
    family: "gpt",
    releaseDate: "2026-08-01",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricePerMillion: {
      input: 1.25,
      output: 10,
      cacheRead: 0.25,
      cacheWrite: null,
    },
    ...overrides,
  };
}

function fleet(overrides: Record<string, unknown> = {}) {
  const agents = Object.fromEntries(
    ROLES.filter(({ id }) => id !== "driver" && id !== "small_model").map(
      ({ id }, index) => [
        id,
        {
          provider: index % 2 === 0 ? "openai" : "amazon-bedrock",
          model: `${id}-model`,
          steps: index + 1,
        },
      ],
    ),
  );
  const routes = [
    ["openai/gpt-5.6", 1.25],
    ["opencode/gpt-5-mini", 0],
    ...Object.entries(agents).map(([role, route]) => [
      `${route.provider}/${route.model}`,
      0.5,
    ]),
  ];
  return {
    hostname: "mini",
    repositories: [
      {
        routing: {
          status: "available",
          data: {
            model: "openai/gpt-5.6",
            smallModel: "opencode/gpt-5-mini",
            agents,
            models: {
              "openai/gpt-5.6": model("GPT 5.6"),
              "opencode/gpt-5-mini": model("GPT 5 Mini", {
                source: null,
                pricePerMillion: {
                  input: null,
                  output: null,
                  cacheRead: null,
                  cacheWrite: null,
                },
              }),
              ...Object.fromEntries(
                Object.values(agents).map((route) => [
                  `${route.provider}/${route.model}`,
                  model(`${route.model} display name`),
                ]),
              ),
            },
          },
        },
        costs: {
          status: "available",
          data: {
            currency: "USD",
            tasks: {
              T24: {
                byModel: Object.fromEntries(
                  routes.map(([model, usd]) => [
                    model,
                    counters(usd as number),
                  ]),
                ),
              },
            },
          },
        },
      },
    ],
    ...overrides,
  };
}

describe("how factory works page", () => {
  test("renders the keyboard-reachable operator lane and both paths", () => {
    const document = howDocument();
    renderHow([{ identity: "<hostile-machine>", fleet: fleet() }], document);

    const lane = document.querySelector<HTMLElement>(".operators-lane")!;
    expect(lane.tabIndex).toBe(0);
    expect(lane.getAttribute("aria-label")).toBe("Operators");
    expect(document.querySelector("#operators-title")).toBeNull();
    expect(
      Array.from(
        lane.querySelectorAll<HTMLElement>(".operator-node"),
        (node) => node.dataset.operator,
      ),
    ).toEqual(OPERATORS.map(({ id }) => id));
    expect(lane.textContent).toContain("Approves spec and plan");
    expect(lane.textContent).toContain("coordinate peer operator sessions");
    expect(lane.textContent).toContain("one fresh opencode session per task");
    expect(
      Array.from(
        lane.querySelectorAll<HTMLElement>(".operator-edge"),
        (edge) => edge.dataset.edge,
      ),
    ).toEqual(OPERATOR_EDGES.map(({ id }) => id));
    expect(lane.querySelector("[data-edge=direct]")?.classList).toContain(
      "operator-edge-alternative",
    );
    expect(lane.querySelector("[data-edge=direct]")?.classList).toContain(
      "chip-dashed",
    );
    expect(lane.querySelector("[data-edge=assisted]")?.classList).not.toContain(
      "chip-dashed",
    );
    expect(lane.textContent).toContain(
      "Everything below runs identically either way.",
    );
    expect(document.querySelector("script")).toBeNull();
    expect(document.body.textContent).toContain("<hostile-machine>");
  });

  test("renders the complete guarded pipeline and live role routing overlay", () => {
    const document = howDocument();
    renderHow([{ identity: "mini", fleet: fleet() }], document);

    expect(PIPELINE.map(({ id }) => id)).toEqual([
      "spec",
      "plan",
      "build",
      "ship",
      "shepherd",
      "merge",
    ]);
    const stages = document.querySelector(".pipeline-stages")!;
    expect(
      Array.from(stages.querySelectorAll(".pipeline-stage"), (stage) =>
        stage.getAttribute("data-phase"),
      ),
    ).toEqual(PIPELINE.map(({ id }) => id));
    expect(
      Array.from(
        document.querySelectorAll(".gate"),
        (gate) => gate.textContent,
      ),
    ).toEqual([
      "Spec approval",
      "Plan approval",
      "Major / holdHuman merge authority",
    ]);
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(".agent-node"),
        (node) => node.dataset.role,
      ),
    ).toEqual(ROLES.map(({ id }) => id));
    ROLES.forEach(({ id, phase }) => {
      const role = document.querySelector<HTMLElement>(`[data-role="${id}"]`)!;
      expect(role.closest(".pipeline-stage")?.getAttribute("data-phase")).toBe(
        phase,
      );
    });
    const architect = document.querySelector('[data-role="architect"]')!;
    expect(architect.querySelector(".provider-openai")?.textContent).toBe(
      "openai",
    );
    expect(architect.querySelector(".routing-steps")?.textContent).toBe(
      "steps ≤ 1",
    );
    expect(architect.querySelector(".agent-cost")?.textContent).toBe(
      "$0.50 metered",
    );
    expect(
      document.querySelector('[data-role="small_model"] .provider-opencode'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-role="small_model"] .agent-cost')
        ?.textContent,
    ).toBe("sub");
    expect(
      document.querySelector('[data-role="driver"] .agent-cost')?.textContent,
    ).toBe("$1.25 metered");
    const driver = document.querySelector('[data-role="driver"]')!;
    expect(driver.querySelector(".agent-route")?.getAttribute("title")).toBe(
      "openai/gpt-5.6",
    );
    const details = driver.querySelector<HTMLDetailsElement>(
      ".agent-model-details",
    )!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe(
      "Limits & list prices",
    );
    expect(details.querySelector(".agent-model-name")?.textContent).toBe(
      "GPT 5.6",
    );
    expect(details.querySelector(".agent-model-limits")?.textContent).toBe(
      "Context 1.05M · Max output 128K",
    );
    expect(details.querySelector(".agent-list-prices")?.textContent).toBe(
      "List / M · input $1.25 · output $10.00 · cache read $0.25 · cache write Unpriced",
    );
    const smallModelDetails = document.querySelector(
      '[data-role="small_model"] .agent-model-details',
    )!;
    expect(
      smallModelDetails.querySelector(".agent-list-prices")?.textContent,
    ).toBe("Unpriced");
    expect(document.querySelectorAll(".agent-model-details")).toHaveLength(
      ROLES.length,
    );
    ROLES.forEach(({ id }) => {
      expect(
        document.querySelectorAll(`[data-role="${id}"] > .agent-model-details`),
      ).toHaveLength(1);
    });
  });

  test("selects machines from the hash, supports keyboard tabs, and renders unavailable machines", () => {
    const document = howDocument("#machine=remote");
    const window = document.defaultView!;
    renderHow(
      [
        { identity: "mini", fleet: fleet() },
        { identity: "remote", fleet: null },
      ],
      document,
    );
    const tabs = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '#how-machine-tabs [role="tab"]',
      ),
    );
    const panels = Array.from(
      document.querySelectorAll<HTMLElement>('#how-machines [role="tabpanel"]'),
    );

    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ]);
    expect(panels.map((panel) => panel.hidden)).toEqual([true, false]);
    expect(panels[1]?.textContent).toContain("Unavailable");
    tabs[1]?.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(document.activeElement).toBe(tabs[0]!);
    expect(window.location.hash).toBe("#machine=mini");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1]);
  });

  test("keeps hostile provider and model data literal and inert", () => {
    const document = howDocument();
    const hostile =
      '<img src=x onerror="globalThis.pwned=1"><script>pwned=2</script>';
    const data = fleet();
    const repository = data.repositories[0];
    if (!repository) throw new Error("fixture must include a repository");
    repository.routing.data.agents.architect = {
      provider: hostile,
      model: hostile,
      steps: 3,
    };
    (repository.routing.data.models as Record<string, unknown>)[
      `${hostile}/${hostile}`
    ] = model(hostile, { family: hostile });
    renderHow([{ identity: "mini", fleet: data }], document);

    const route = document.querySelector(
      '[data-role="architect"] .agent-route',
    )!;
    expect(route.textContent).toContain(hostile);
    expect(route.getAttribute("title")).toBe(`${hostile}/${hostile}`);
    expect(
      document.querySelector('[data-role="architect"] .agent-model-name')
        ?.textContent,
    ).toBe(hostile);
    expect(route.querySelector(".provider-other")).not.toBeNull();
    expect(
      document.querySelectorAll("img, script, [onerror], [onclick]"),
    ).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  test("prefers current next-run routing and clearly falls back to legacy last-run routing", () => {
    const document = howDocument();
    const current = fleet({
      currentRouting: {
        status: "partial",
        data: {
          model: "openai/current",
          smallModel: "openai/current-small",
          agents: {
            architect: {
              provider: "openai",
              model: "current-architect",
              steps: 3,
            },
          },
        },
        warnings: [
          { code: "CURRENT_ROUTING_INVALID_AGENT", message: "omitted" },
        ],
      },
    });
    renderHow([{ identity: "mini", fleet: current }], document);
    expect(document.querySelector(".how-routing-source")?.textContent).toBe(
      "Routing source: current configuration for the next factory run",
    );
    expect(
      document.querySelector('[data-role="driver"] .agent-route')?.textContent,
    ).toBe("openai/current");

    const legacyDocument = howDocument();
    renderHow([{ identity: "mini", fleet: fleet() }], legacyDocument);
    expect(
      legacyDocument.querySelector(".how-routing-source")?.textContent,
    ).toBe(
      "Routing source: legacy peer fallback from a repository last-run snapshot",
    );
  });

  test("renders a missing role as unavailable without inventing model cost", () => {
    const document = howDocument();
    const data = fleet();
    const repository = data.repositories[0];
    if (!repository) throw new Error("missing repository fixture");
    delete repository.routing.data.agents.docsmith;
    repository.routing.data.agents.verifier = {
      provider: "openai",
      model: "unused-model",
      steps: 8,
    };

    renderHow([{ identity: "mini", fleet: data }], document);

    expect(
      document.querySelector('[data-role="docsmith"] .unavailable')
        ?.textContent,
    ).toBe("Unavailable");
    expect(
      document.querySelector('[data-role="verifier"] .agent-cost'),
    ).toBeNull();
  });

  test("labels zero-dollar model usage with tokens as subscription", () => {
    const document = howDocument();

    renderHow([{ identity: "mini", fleet: fleet() }], document);

    expect(
      document.querySelector('[data-role="small_model"] .agent-cost')
        ?.textContent,
    ).toBe("sub");
  });

  test("preserves selected diagram scroll, tab focus, and Operators lane focus across rerenders", () => {
    const document = howDocument("#machine=remote");
    const machines = [
      { identity: "mini", fleet: fleet() },
      { identity: "remote", fleet: fleet({ hostname: "remote" }) },
    ];
    renderHow(machines, document);
    const selectedTab = document.querySelector<HTMLButtonElement>(
      '[aria-selected="true"]',
    )!;
    const diagram = document.querySelector<HTMLElement>(
      ".how-machine-panel:not([hidden]) .pipeline-diagram",
    )!;
    selectedTab.focus();
    diagram.scrollLeft = 187;

    renderHow(machines, document);

    expect(document.activeElement?.textContent).toBe("remote");
    expect(
      document.querySelector<HTMLElement>(
        ".how-machine-panel:not([hidden]) .pipeline-diagram",
      )?.scrollLeft,
    ).toBe(187);

    const operatorsLane = document.querySelector<HTMLElement>(
      ".how-machine-panel:not([hidden]) .operators-lane",
    )!;
    operatorsLane.focus();

    renderHow(machines, document);

    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Operators",
    );
    expect(
      document.activeElement?.closest<HTMLElement>(".how-machine-panel")
        ?.hidden,
    ).toBe(false);
  });

  test("preserves each machine's open model disclosure and its focused summary across peer updates", () => {
    const document = howDocument("#machine=remote");
    const machines = [
      { identity: "mini", fleet: fleet() },
      { identity: "remote", fleet: fleet({ hostname: "remote" }) },
    ];
    renderHow(machines, document);
    const summary = document.querySelector<HTMLElement>(
      '.how-machine-panel:not([hidden]) [data-role="driver"] .agent-model-details summary',
    )!;
    const details = summary.closest<HTMLDetailsElement>("details")!;
    details.open = true;
    summary.focus();

    renderHow(
      [
        { identity: "mini", fleet: fleet({ hostname: "mini updated" }) },
        { identity: "remote", fleet: fleet({ hostname: "remote updated" }) },
      ],
      document,
    );

    const refreshedSummary = document.querySelector<HTMLElement>(
      '.how-machine-panel:not([hidden]) [data-role="driver"] .agent-model-details summary',
    )!;
    expect(refreshedSummary.closest<HTMLDetailsElement>("details")?.open).toBe(
      true,
    );
    expect(document.activeElement).toBe(refreshedSummary);
  });

  test("wraps provider/model routes and uses a 3x2 pipeline grid below 1500px without diagram overflow", () => {
    expect(stylesheet).toMatch(
      /\.pipeline-stages\s*\{[^}]*grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/s,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 93\.749rem\)[\s\S]*?\.pipeline-stages\s*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/,
    );
    expect(stylesheet).toMatch(
      /@media \(max-width: 49\.999rem\)[\s\S]*?\.pipeline-stages,[\s\S]*?\.operator-nodes\s*\{[^}]*minmax\(0, 1fr\)/,
    );
    expect(stylesheet).toMatch(/\.operator-nodes\s*\{[^}]*repeat\(3, 1fr\)/s);
    expect(stylesheet).toMatch(
      /@media \(max-width: 93\.749rem\)[\s\S]*?\.operator-nodes\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/,
    );
    expect(stylesheet).not.toContain("min-width: 100rem");
    expect(stylesheet).not.toMatch(/\.pipeline-stage\s*\{[^}]*min-height:/s);
    expect(stylesheet).not.toMatch(/\.how-machine-panel\s*\{[^}]*overflow-x:/s);
    expect(stylesheet).not.toContain('content: "↳"');
  });

  test("wraps model routes rather than truncating them", () => {
    expect(stylesheet).toMatch(
      /\.agent-route\s*\{[^}]*overflow-wrap:\s*anywhere;/s,
    );
    expect(stylesheet).not.toMatch(
      /\.agent-route\s*\{[^}]*?(?:text-overflow:\s*ellipsis|white-space:\s*nowrap|overflow:\s*hidden)/s,
    );
  });

  test("allows long unbroken model display names to wrap inside disclosures", () => {
    expect(stylesheet).toMatch(
      /\.agent-model-name\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
  });

  test("keeps the shared compact header and a single concise intro", () => {
    const window = new Window();
    const document = window.document;
    document.documentElement.innerHTML = howHtml;

    expect(
      document.querySelector(".dashboard-header .header-primary"),
    ).not.toBeNull();
    expect(
      document.querySelector(".dashboard-header .header-secondary"),
    ).not.toBeNull();
    expect(document.querySelectorAll(".how-intro h2")).toHaveLength(1);
    expect(document.querySelectorAll(".how-intro > p")).toHaveLength(1);
    expect(document.querySelector(".how-intro .eyebrow")).toBeNull();
  });
});
