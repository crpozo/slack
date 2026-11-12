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
const SEED_ID = "seeded-v3";

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

/** A way MindfulTech could put each to work, for itself or a client (shown as its use case). */
const USE_CASES: Record<string, string> = {
  "Claude Haiku 5.5":
    "Classify and answer a client's support tickets or WhatsApp messages in Spanish for cents a day; summarize every sales call into the CRM.",
  "Claude Opus 5.5":
    "Let it migrate a client's legacy system module by module, or audit a codebase for security before we take over its maintenance.",
  "Claude Fable 5.2":
    "Hand it a whole feature overnight (spec in, tested pull request out) on our own products, and compare the cost with a developer's day.",
  "ElevenLabs voices":
    "A daily audio briefing for a client's managers; product videos and phone menus in a natural Ecuadorian voice without a recording studio.",
  "Speech-to-speech models":
    "A phone line that books appointments for a clinic or a car dealership's service shop, 24 hours a day, and hands off to a person when needed.",
  "Video generation models":
    "Short social videos for a dealership's weekly offers, or training clips for a client's new staff, made from a script in an afternoon.",
  "Image generation and editing":
    "Place a client's product in new scenes for its online catalogue; retouch real-estate or vehicle photos in bulk.",
  "Open-weight models":
    "Run a model inside a bank's or hospital's own servers to process documents that are not allowed to leave the building.",
  "On-device small models":
    "An offline assistant in a field technician's phone: fills the inspection form by voice where there is no signal.",
  "Extended thinking":
    "Review contracts or invoices against a client's rules, where a careful wrong-answer check matters more than a fast reply.",
  "World models and robotics":
    "Nothing to build yet; follow it for clients in logistics and manufacturing who will ask about warehouse automation.",
  "Fine-tuning our own models":
    "Only if a client has thousands of labelled examples and a narrow task (classifying their own documents) that prompts can't reach.",
  "Agent Skills":
    "Package how we quote, deploy and review code as skills, so every agent and new hire works the MindfulTech way from the first day.",
  "Model Context Protocol":
    "An MCP server for a client's ERP or CRM: their staff ask in plain Spanish for stock, invoices or a customer's history.",
  "Claude Agent SDK":
    "An agent that processes an importer's purchase orders end to end: reads the email, checks stock, drafts the reply, asks for approval.",
  "Computer-use agents":
    "Operate a client's old desktop or government web portal with no API: file the forms, download the reports, every morning.",
  "Multi-agent orchestration":
    "Research a market for a proposal: one agent per competitor in parallel, a lead agent that writes the comparison.",
  "Voice agents":
    "Follow up a dealership's leads by phone within minutes, qualify them and book the test drive in the salesperson's calendar.",
  "Structured outputs":
    "Extract the fields of invoices, IDs and contracts straight into a client's database, with no hand typing and no parsing errors.",
  "Prompt caching":
    "A chat over a client's whole policy manual or product catalogue that stays cheap however many questions their staff ask.",
  "Agentic retrieval":
    "An internal assistant that answers from a client's contracts, manuals and tickets, citing the document each answer comes from.",
  "Agent-to-agent protocols":
    "Later: a client's purchasing agent that asks suppliers' agents for quotes. For now, design our agents so they can be called by others.",
  "Generative interfaces":
    "A dashboard where a manager asks a question and gets the chart built for it, instead of us coding one report per request.",
  LangChain:
    "If a client's project already uses it, maintain it; for anything new we call the model's SDK directly.",
  "Amazon Bedrock":
    "Offer clients AI features where their data never leaves their own AWS account: an easy answer to their legal team.",
  "Serverless everything":
    "Launch a client's product with hosting that costs a few dollars a month until it has real users, then scales by itself.",
  "Managed agent runtimes":
    "Ship a client's agent without building the infrastructure around it: sessions, sandbox and logs come with the service.",
  "Agent sandboxes":
    "A data-analysis assistant that runs the code it writes over a client's spreadsheets, safely isolated from everything else.",
  "Evals and LLM observability":
    "Before changing a client's chatbot prompt, run 100 real past conversations and show them the before-and-after numbers.",
  "AI gateways":
    "One place to cap each client's monthly AI spend and switch model when a provider is down or changes its prices.",
  "Vector and hybrid search":
    "Search across everything a company has written (chats, files, call notes) by meaning, starting with this app.",
  "Edge inference":
    "Instant suggestions while a salesperson types a quote, or moderation of user content, without a round trip to a large model.",
  "Real-time media over WebRTC":
    "Add calls with live AI notes to a client's product, or connect a voice agent to their existing web app.",
  "Durable agent workflows":
    "A credit or purchase approval that an agent prepares and that waits days for a manager's signature without losing its place.",
  "Confidential computing for AI":
    "A requirement to bring up when a bank or clinic says their data can't be seen by any provider.",
  "Our own GPU servers":
    "Only for a client legally unable to use any cloud; otherwise show them the cost per token against an idle server.",
  Kubernetes:
    "Keep running it where a client already has it; propose serverless when we build something new for them.",
  "Claude Code":
    "Deliver in days what used to be quoted in weeks; let a client's request made in a meeting be live the same afternoon.",
  "Cloud coding agents":
    "Fix a client's bug from a phone while travelling; run several improvements at once and review them in the morning.",
  "AI code review":
    "Offer it as a service: an automatic security and quality review on every change in a client's repositories.",
  "Spec-driven development":
    "Agree the specification with the client in plain language, then generate and verify the software from it; changes start in the spec.",
  "Browser-testing agents":
    "Before every release, an agent walks a client's checkout or booking flow and sends screenshots of anything broken.",
  "AI app builders":
    "Bring a clickable prototype of the client's idea to the first sales meeting instead of a slide deck.",
  "Design-to-code agents":
    "Turn a client's Figma into working screens in our component library the same day the design is approved.",
  "Evals as tests":
    "A client's assistant can't go live if its answers on the test questions got worse: quality becomes part of the pipeline.",
  Cursor:
    "Work comfortably inside a client's team that standardised on it; share our skills and rules with them.",
  "GitHub Copilot agents":
    "Assign routine issues in a client's repository to the agent they already pay for, and review its pull requests.",
  "Unreviewed generated code":
    "The rule to state in every proposal: AI writes, a person reviews and tests answer for the result.",
};

/** The starter blips as inputs (quadrant included), in a stable order. */
export function starterBlips(): CreateBlipInput[] {
  return (Object.entries(STARTER) as Array<[RadarQuadrant, Starter[]]>).flatMap(
    ([quadrant, items]) =>
      items.map(([name, ring, description, link, meta]) => {
        const useCase = USE_CASES[name];
        return {
          name,
          quadrant,
          ring,
          description,
          ...(link && { link }),
          ...((meta || useCase) && { meta: { ...meta, ...(useCase && { useCase }) } }),
        };
      }),
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
