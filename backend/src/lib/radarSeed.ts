import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CreateBlipInput, RadarQuadrant, RadarRing } from "@mindfultech/shared";
import { ddb, tables } from "./ddb";
import { log } from "./logger";
import { deleteBlip, listBlips, newBlip, putBlipIfAbsent, SCAN_PK } from "./radar";

// ---------------------------------------------------------------------------
// The radar's starting point (Phase 61; rewritten in Phase 62). An empty radar
// says nothing, so it starts with what is changing how software is built and
// sold: agents, voice, generated media, the tools that write the code. Not
// the plumbing everyone already has (React, Vite, a linter): a radar is for
// what deserves a decision. Adopt is what we already rely on, Trial what we
// are trying, Assess what to explore, Hold what not to start. It's a first
// draft of the team's stance: admins move, edit and remove blips from there,
// and the scans propose the rest.
// ---------------------------------------------------------------------------

/** Who wrote the starter blips. */
export const RADAR_SEED_AUTHOR = "seed";
/** The list's version: a new one is written once more, over the untouched starters. */
const SEED_ID = "seeded-v2";

type Starter = [
  name: string,
  ring: RadarRing,
  description: string,
  link?: string,
  meta?: Record<string, string>,
];

const STARTER: Record<RadarQuadrant, Starter[]> = {
  Models: [
    [
      "Claude Haiku 5.5",
      "Adopt",
      "Our default inside products: AI Notes, the AI News analysis and the radar scans run on it through Amazon Bedrock. Fast and cheap enough to put a model behind every feature.",
      "https://www.anthropic.com/claude",
      { modelId: "claude-haiku-5-5", provider: "Anthropic" },
    ],
    [
      "Claude Opus 5.5",
      "Trial",
      "What we build with. Worth trying inside products where a task needs real reasoning or long autonomous work; check the cost per task first.",
      "https://www.anthropic.com/claude",
      { modelId: "claude-opus-5-5", provider: "Anthropic" },
    ],
    [
      "Claude Fable 5.2",
      "Assess",
      "Anthropic's most capable generally available model. Assess for hours-long engineering tasks an agent finishes on its own.",
      "https://www.anthropic.com/claude",
      { modelId: "claude-fable-5-2", provider: "Anthropic" },
    ],
    [
      "ElevenLabs voices",
      "Adopt",
      "Reads the AI News update with a voice people actually want to listen to. The gap with stock text-to-speech is the difference between a feature used and one ignored.",
      "https://elevenlabs.io",
      { provider: "ElevenLabs" },
    ],
    [
      "Speech-to-speech models",
      "Assess",
      "Models that listen and answer in audio directly, with interruptions and tone. They turn phone lines, support and sales calls into software. Assess for a client pilot.",
    ],
    [
      "Video generation models",
      "Assess",
      "Text and image to video with sound (Sora, Veo and others). Good enough for ads, product demos and training clips; assess for clients' marketing work.",
    ],
    [
      "Image generation and editing",
      "Trial",
      "Editing a real photo by describing the change, with consistent characters and readable text. Try it for clients' catalogues and campaigns.",
    ],
    [
      "Open-weight models",
      "Assess",
      "Llama, Qwen, DeepSeek and others close the gap every few months. Assess when a client's data can't leave their own infrastructure.",
    ],
    [
      "On-device small models",
      "Assess",
      "Models of a few billion parameters running on a phone or laptop: private, offline and free per request. Assess for features that must work without a network.",
    ],
    [
      "Extended thinking",
      "Trial",
      "Letting the model reason before it answers, with an effort setting per task. Our news analysis uses it; try it wherever a wrong answer costs more than a slow one.",
    ],
    [
      "World models and robotics",
      "Assess",
      "Models that predict how a scene evolves, and the robot policies trained on them. Far from our work today; follow it because it moves fast.",
    ],
    [
      "Fine-tuning our own models",
      "Hold",
      "A better prompt, tools and examples beat a fine-tune for almost everything we do, and the next model release erases the gain. Don't start one without numbers.",
    ],
  ],
  Frameworks: [
    [
      "Agent Skills",
      "Adopt",
      "Know-how packaged as folders an agent loads when it needs them. Our AI Skills library is built on it: the cheapest way to make an agent good at our way of working.",
      "https://www.anthropic.com/news/skills",
    ],
    [
      "Model Context Protocol",
      "Trial",
      "The standard plug between an agent and a system (CRM, ERP, databases). One connector serves every model and every client; build ours as MCP servers.",
      "https://modelcontextprotocol.io",
    ],
    [
      "Claude Agent SDK",
      "Trial",
      "The loop behind Claude Code, as a library: tools, permissions, subagents, context management. Our starting point for agents that follow a defined workflow.",
      "https://docs.claude.com/en/api/agent-sdk/overview",
    ],
    [
      "Computer-use agents",
      "Assess",
      "Agents that operate a screen like a person: click, type, read. They automate the systems that have no API, which is most of what our clients run.",
    ],
    [
      "Multi-agent orchestration",
      "Assess",
      "A lead agent that splits work among parallel workers and checks their results. Powerful and expensive; assess where a task is wide rather than deep.",
    ],
    [
      "Voice agents",
      "Assess",
      "Agents on a phone call that book, answer and sell, in natural Spanish. The most direct way AI reaches clients' customers; assess with one real line.",
    ],
    [
      "Structured outputs",
      "Adopt",
      "The API holds the model to a JSON schema, so its answer goes straight into code. Every AI feature of ours relies on it.",
    ],
    [
      "Prompt caching",
      "Adopt",
      "Reusing the long, repeated part of a prompt at a fraction of the price and latency. What makes chat over a large context affordable.",
    ],
    [
      "Agentic retrieval",
      "Trial",
      "Letting the agent search, read and search again instead of one vector lookup. Better answers over a company's documents than classic retrieval pipelines.",
    ],
    [
      "Agent-to-agent protocols",
      "Assess",
      "Standards for agents of different companies to find each other, negotiate and pay. Early; it decides how our clients' agents will talk to their suppliers'.",
    ],
    [
      "Generative interfaces",
      "Assess",
      "The model builds the screen for the question asked: a chart, a form, a small app, instead of a block of text. Assess for dashboards and internal tools.",
    ],
    [
      "LangChain",
      "Hold",
      "Layers of abstraction over what the model APIs now do directly. Don't start new work on it; call the SDK.",
    ],
  ],
  Infrastructure: [
    [
      "Amazon Bedrock",
      "Adopt",
      "Frontier models inside our AWS account: one bill, IAM permissions, no keys to guard and data that stays put. How every model call of ours runs.",
      "https://aws.amazon.com/bedrock/",
    ],
    [
      "Serverless everything",
      "Adopt",
      "Lambda, DynamoDB and managed queues: no servers to patch, costs near zero when idle. It lets three people run what used to need an operations team.",
    ],
    [
      "Managed agent runtimes",
      "Assess",
      "The provider runs the agent's loop, its sandbox and its sessions; we send the task. Assess against running the loop ourselves on Lambda.",
    ],
    [
      "Agent sandboxes",
      "Assess",
      "MicroVMs that start in milliseconds so an agent can run code and browse safely. Needed the day our agents execute what they write.",
    ],
    [
      "Evals and LLM observability",
      "Trial",
      "Traces of every model call and a test set that says whether a prompt change made things better. Without it, quality is an opinion.",
    ],
    [
      "AI gateways",
      "Assess",
      "One entry point for every model: routing, fallback, budgets and logs per client. Assess once we run more than one provider in production.",
    ],
    [
      "Vector and hybrid search",
      "Assess",
      "Search by meaning plus keywords, now built into the databases we already use. Assess for search across messages, files and call notes.",
    ],
    [
      "Edge inference",
      "Assess",
      "Small models served from points of presence near the user, in tens of milliseconds. Assess for autocomplete, moderation and classification.",
    ],
    [
      "Real-time media over WebRTC",
      "Trial",
      "Our calls run on it. The same transport carries voice agents: audio in, audio out, with no perceptible delay.",
    ],
    [
      "Durable agent workflows",
      "Assess",
      "Long tasks that survive failures and wait for a human's approval for days. What separates a demo agent from one a business can depend on.",
    ],
    [
      "Confidential computing for AI",
      "Assess",
      "Inference inside hardware enclaves, so not even the provider sees the data. Watch it for clients in banking and health.",
    ],
    [
      "Our own GPU servers",
      "Hold",
      "Buying or renting GPUs to serve models ourselves. Capacity sits idle, models change every quarter; pay per token instead.",
    ],
    [
      "Kubernetes",
      "Hold",
      "More platform than a team our size should operate. Serverless covers what we build.",
    ],
  ],
  DevTools: [
    [
      "Claude Code",
      "Adopt",
      "How this app is written: an agent that reads the repository, edits, runs the tests and deploys. Engineers direct and review; they rarely type the code.",
      "https://claude.com/claude-code",
    ],
    [
      "Cloud coding agents",
      "Adopt",
      "The same agent running in the cloud, several tasks at once, from a phone. A feature is asked for in a message and arrives as a deployed change.",
    ],
    [
      "AI code review",
      "Trial",
      "An agent that reviews every change for bugs and security before a person looks. Try it on all repositories; it catches what tired reviewers miss.",
    ],
    [
      "Spec-driven development",
      "Trial",
      "Writing what the software must do, precisely, and letting agents implement and verify it. The specification becomes the asset; the code is regenerated.",
    ],
    [
      "Browser-testing agents",
      "Trial",
      "An agent that opens the app, uses it like a person and reports what broke, with screenshots. Replaces brittle end-to-end scripts.",
    ],
    [
      "AI app builders",
      "Assess",
      "A working prototype from a description in minutes (v0, Lovable, Bolt). Assess for sales: show a client their idea running in the first meeting.",
    ],
    [
      "Design-to-code agents",
      "Assess",
      "From a Figma file or a screenshot to components in our design system. Assess to cut the handoff between design and engineering.",
    ],
    [
      "Evals as tests",
      "Assess",
      "Model behaviour checked in CI like any other test: a prompt change that makes answers worse fails the build.",
    ],
    [
      "Cursor",
      "Assess",
      "The AI editor many clients' teams use. Assess where it fits next to Claude Code.",
      "https://cursor.com",
    ],
    [
      "GitHub Copilot agents",
      "Assess",
      "Agents assigned to issues inside GitHub. Common in clients' teams; assess to work the way they do.",
      "https://github.com/features/copilot",
    ],
    [
      "Unreviewed generated code",
      "Hold",
      "Shipping what an agent wrote with no tests and no reading. Fast until the first incident; every change still passes tests and a review.",
    ],
  ],
};

/** The starter blips as inputs (quadrant included), in a stable order. */
export function starterBlips(): CreateBlipInput[] {
  return (Object.entries(STARTER) as Array<[RadarQuadrant, Starter[]]>).flatMap(
    ([quadrant, items]) =>
      items.map(([name, ring, description, link, meta]) => ({
        name,
        quadrant,
        ring,
        description,
        ...(link && { link }),
        ...(meta && { meta }),
      })),
  );
}

/**
 * Writes the starter blips, once per version of the list: the version's row
 * is claimed first (one atomic write), so two people opening the radar at
 * once write it once, and a radar emptied later on purpose stays empty.
 * A newer list replaces the starters nobody has touched (still written by
 * `RADAR_SEED_AUTHOR`); blips people or the scans added or edited are kept.
 * @returns whether this call wrote them.
 */
export async function seedRadarOnce(now = Date.now()): Promise<boolean> {
  const seeded = await ddb.send(
    new GetCommand({ TableName: tables.techRadar, Key: { pk: SCAN_PK, id: SEED_ID } }),
  );
  if (seeded?.Item) return false;
  try {
    await ddb.send(
      new PutCommand({
        TableName: tables.techRadar,
        Item: { pk: SCAN_PK, id: SEED_ID, at: now },
        ConditionExpression: "attribute_not_exists(id)",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
  const stale = (await listBlips()).filter((blip) => blip.updatedBy === RADAR_SEED_AUTHOR);
  await Promise.all(stale.map((blip) => deleteBlip(blip.id)));
  const blips = starterBlips().map((input) => newBlip(input, RADAR_SEED_AUTHOR, now));
  await Promise.all(blips.map((blip) => putBlipIfAbsent(blip)));
  log.info("radar seeded", { blips: blips.length, replaced: stale.length });
  return true;
}
