import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

interface PipelineStage {
  id: string;
}

interface Role {
  id: string;
  phase: string;
}

interface HowModule {
  PIPELINE: PipelineStage[];
  ROLES: Role[];
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
    `${source}\nreturn { PIPELINE, ROLES, renderHow };`,
  )() as HowModule;
}

const { PIPELINE, ROLES, renderHow } = await browserModule("./how.js");

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
    expect(
      Array.from(document.querySelectorAll(".pipeline-stage"), (stage) =>
        stage.getAttribute("data-phase"),
      ),
    ).toEqual(PIPELINE.map(({ id }) => id));
    expect(document.querySelector(".approval-gate")?.textContent).toBe(
      "Spec approval",
    );
    expect(document.querySelectorAll(".approval-gate")[1]?.textContent).toBe(
      "Plan approval",
    );
    expect(document.querySelector(".hold-branch")?.textContent).toContain(
      "Major / hold",
    );
    expect(document.querySelector(".hold-branch")?.textContent).toContain(
      "Human merge authority",
    );
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
      document.querySelector('[data-role="driver"] .agent-cost')?.textContent,
    ).toBe("$1.25 metered");
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
    renderHow([{ identity: "mini", fleet: data }], document);

    const route = document.querySelector(
      '[data-role="architect"] .agent-route',
    )!;
    expect(route.textContent).toContain(hostile);
    expect(route.querySelector(".provider-other")).not.toBeNull();
    expect(
      document.querySelectorAll("img, script, [onerror], [onclick]"),
    ).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });
});
