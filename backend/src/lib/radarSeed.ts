import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { CreateBlipInput, RadarQuadrant, RadarRing } from "@mindfultech/shared";
import { ddb, tables } from "./ddb";
import { log } from "./logger";
import { newBlip, putBlipIfAbsent, SCAN_PK } from "./radar";

// ---------------------------------------------------------------------------
// The radar's starting point (Phase 61). An empty radar says nothing, so the
// first time it's opened it is filled with the stack MindfulTech already
// builds on (this very app: Adopt), what it has in use with care (Trial), and
// what is worth a look or a pause (Assess, Hold). It's a first draft of the
// team's stance, written once: admins move, edit and remove blips from there,
// and the scans propose the rest. Never written again, even if the radar is
// emptied on purpose (the `seeded` row).
// ---------------------------------------------------------------------------

/** Who wrote the starter blips. */
export const RADAR_SEED_AUTHOR = "seed";
const SEED_ID = "seeded";

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
      "Our default for product features: AI Notes, the AI News analysis and the radar scans run on it through Amazon Bedrock. Fast and cheap enough for one request per call or per day.",
      "https://www.anthropic.com/claude",
      { modelId: "claude-haiku-5-5", provider: "Anthropic" },
    ],
    [
      "Claude Opus 5.5",
      "Trial",
      "What we build with (Claude Code). Worth trying inside products where a task needs more reasoning than Haiku gives; check the cost per task first.",
      "https://www.anthropic.com/claude",
      { modelId: "claude-opus-5-5", provider: "Anthropic" },
    ],
    [
      "Claude Sonnet 5.5",
      "Assess",
      "The middle tier: assess it for client features where Haiku falls short and Opus is more than the job needs.",
      "https://www.anthropic.com/claude",
      { modelId: "claude-sonnet-5-5", provider: "Anthropic" },
    ],
    [
      "Claude Fable 5.2",
      "Assess",
      "Anthropic's most capable model. Assess for long, autonomous engineering tasks; pricier than Opus.",
      "https://www.anthropic.com/claude",
      { modelId: "claude-fable-5-2", provider: "Anthropic" },
    ],
    [
      "OpenAI Whisper",
      "Adopt",
      "Speech to text for call notes and voice messages. Good with Spanish and mixed Spanish/English.",
      "https://platform.openai.com/docs/guides/speech-to-text",
      { provider: "OpenAI" },
    ],
    [
      "Amazon Polly (neural)",
      "Adopt",
      "Reads the AI News summary aloud in Latin American Spanish (voice Lupe). Cents a month at our volume.",
      "https://aws.amazon.com/polly/",
      { provider: "AWS" },
    ],
    [
      "OpenAI GPT models",
      "Assess",
      "Not in our products today. Assess per client when they already work with OpenAI or need something Claude doesn't cover.",
      "https://platform.openai.com/docs/models",
      { provider: "OpenAI" },
    ],
    [
      "Google Gemini",
      "Assess",
      "Not in use. Assess for clients on Google Cloud and for very long multimodal inputs.",
      "https://ai.google.dev/",
      { provider: "Google" },
    ],
    [
      "Open-weight models",
      "Assess",
      "Llama, Mistral and similar, self-hosted. Assess only when a client needs data to stay on their own infrastructure; running them is real work.",
      undefined,
    ],
  ],
  Frameworks: [
    [
      "React",
      "Adopt",
      "The web app is React; our default for client front ends.",
      "https://react.dev/",
    ],
    [
      "Vite",
      "Adopt",
      "Builds and serves the web app. Fast, little configuration.",
      "https://vite.dev/",
    ],
    [
      "Tailwind CSS",
      "Adopt",
      "All of the app's styling, with design tokens and container queries.",
      "https://tailwindcss.com/",
    ],
    [
      "Zustand",
      "Adopt",
      "Client state in small stores. Simple enough that nobody misses Redux.",
      "https://zustand.docs.pmnd.rs/",
    ],
    [
      "Zod",
      "Adopt",
      "One schema shared by the web and the server for every request.",
      "https://zod.dev/",
    ],
    [
      "Anthropic SDK",
      "Adopt",
      "How we call Claude, on Bedrock, with structured outputs for anything a program reads.",
      "https://docs.anthropic.com/en/api/client-sdks",
    ],
    [
      "WebRTC (mesh)",
      "Trial",
      "Our calls: peer to peer, up to six people. Works within the team; across restrictive networks it needs a TURN relay we don't run yet.",
      "https://webrtc.org/",
    ],
    [
      "Tauri",
      "Trial",
      "The desktop app's shell. Lighter than Electron; keep an eye on platform differences.",
      "https://tauri.app/",
    ],
    [
      "Model Context Protocol",
      "Assess",
      "The standard way to give models tools and data. Assess for client integrations and our own agents.",
      "https://modelcontextprotocol.io/",
    ],
    [
      "Claude Agent SDK",
      "Assess",
      "Claude Code's agent loop as a library. Assess for agents we would host for clients.",
      "https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk",
    ],
    [
      "LangChain",
      "Hold",
      "We call models directly with the SDK and haven't needed the abstraction. Don't start new work on it without a reason.",
      "https://www.langchain.com/",
    ],
  ],
  Infrastructure: [
    [
      "AWS Lambda",
      "Adopt",
      "Every backend handler. Nothing to keep running, pennies at our scale.",
      "https://aws.amazon.com/lambda/",
    ],
    [
      "Amazon DynamoDB",
      "Adopt",
      "All of the app's data, on demand. Design the keys for the queries first.",
      "https://aws.amazon.com/dynamodb/",
    ],
    [
      "Amazon Bedrock",
      "Adopt",
      "Where our Claude calls run: IAM instead of API keys, one bill.",
      "https://aws.amazon.com/bedrock/",
    ],
    [
      "AWS CDK",
      "Adopt",
      "All infrastructure as TypeScript, tested like the rest of the code.",
      "https://aws.amazon.com/cdk/",
    ],
    [
      "API Gateway WebSockets",
      "Adopt",
      "Real-time chat and call signalling without servers. Mind the 32 KB frame limit.",
      "https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api.html",
    ],
    [
      "Amazon Cognito",
      "Adopt",
      "Sign-in, groups for roles, invitations for externals. Its emails are basic.",
      "https://aws.amazon.com/cognito/",
    ],
    [
      "S3 + CloudFront",
      "Adopt",
      "Hosts the web app and every attachment, with presigned URLs.",
      "https://aws.amazon.com/cloudfront/",
    ],
    [
      "Web Push",
      "Adopt",
      "Notifications on phones and desktops without an app store (on iPhone, from the Home Screen app).",
      "https://developer.mozilla.org/en-US/docs/Web/API/Push_API",
    ],
    [
      "TURN relay",
      "Assess",
      "What calls with people on other networks need when a direct connection fails. A monthly cost; assess a managed one.",
      "https://webrtc.org/getting-started/turn-server",
    ],
    [
      "Vector search",
      "Assess",
      "Embeddings and a vector index for searching by meaning. Our search is by keyword today; assess when a client needs retrieval.",
      undefined,
    ],
    [
      "Kubernetes",
      "Hold",
      "More to run than a team our size should take on. Serverless first.",
      "https://kubernetes.io/",
    ],
  ],
  DevTools: [
    [
      "Claude Code",
      "Adopt",
      "How most of this app was written, reviewed and deployed. The default way to work.",
      "https://www.anthropic.com/claude-code",
    ],
    [
      "TypeScript",
      "Adopt",
      "One language across web, server, infrastructure and shared types.",
      "https://www.typescriptlang.org/",
    ],
    [
      "pnpm workspaces",
      "Adopt",
      "The monorepo: web, backend, infra and shared in one install.",
      "https://pnpm.io/workspaces",
    ],
    [
      "Vitest",
      "Adopt",
      "Every test, in every package. The deploy doesn't run without them passing.",
      "https://vitest.dev/",
    ],
    [
      "GitHub Actions",
      "Adopt",
      "Lint, tests and deploy on every push to main, with OIDC into AWS (no stored keys).",
      "https://github.com/features/actions",
    ],
    [
      "ESLint + Prettier",
      "Adopt",
      "No style debates: the deploy checks both.",
      "https://eslint.org/",
    ],
    [
      "Playwright",
      "Trial",
      "Used to check screens at phone and desktop sizes. Not yet a suite that runs on every deploy.",
      "https://playwright.dev/",
    ],
    [
      "Claude Code skills",
      "Trial",
      "Reusable instructions for Claude Code, shared in AI Skills. Worth growing the team's own set.",
      "https://docs.anthropic.com/en/docs/claude-code/skills",
    ],
    [
      "Cursor",
      "Assess",
      "An AI editor some clients' teams use. Assess to work alongside them.",
      "https://cursor.com/",
    ],
    [
      "GitHub Copilot",
      "Assess",
      "Common in clients' teams. Assess for where it fits next to Claude Code.",
      "https://github.com/features/copilot",
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
 * Fills an empty radar with the starter blips, once ever: the `seeded` row is
 * claimed first (one atomic write), so two people opening it at once write it
 * once, and a radar emptied later on purpose stays empty.
 * @returns whether this call wrote them.
 */
export async function seedRadarOnce(now = Date.now()): Promise<boolean> {
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
  const blips = starterBlips().map((input) => newBlip(input, RADAR_SEED_AUTHOR, now));
  await Promise.all(blips.map((blip) => putBlipIfAbsent(blip)));
  log.info("radar seeded", { blips: blips.length });
  return true;
}
