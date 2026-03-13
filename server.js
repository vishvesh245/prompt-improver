import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { dirname } from "path";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────
// 1. PROVIDER CONFIG
// ─────────────────────────────────────────────

const PROVIDERS = {
  anthropic: { label: "Anthropic", defaultModel: "claude-sonnet-4-20250514", keyPrefix: "sk-ant-" },
  openai:    { label: "OpenAI",    defaultModel: "gpt-4o",                   keyPrefix: "sk-"     },
  google:    { label: "Google",    defaultModel: "gemini-1.5-pro",            keyPrefix: "AIza"    },
};

// ─────────────────────────────────────────────
// 2. SYSTEM PROMPT
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert prompt engineer with deep knowledge of how LLMs work.
When given a prompt, analyze it and return ONLY a valid JSON object — no markdown, no backticks, no preamble.

Return exactly this structure:
{
  "score": <integer 1-10>,
  "issues": [<string>],
  "improved": "<the rewritten prompt>",
  "changes": [<string — what changed and why>],
  "tips": [<string — 1-2 tips specific to this prompt type>],
  "token_estimate": {
    "original_tokens": <integer>,
    "improved_tokens": <integer>
  }
}

Scoring guide:
  1-3  → Vague, no context, no intent, or too short to act on (e.g. "help", "make it better", "a")
  4-6  → Clear intent and defined output type, but missing role, format, or constraints.
         A prompt like "write a blog post about X" or "give me 5 tips for Y" belongs here.
         Do not score these below 4.
  7-8  → Clear intent, good context, role or format present, only minor gaps remain
  9-10 → Specific, role set, format defined, constraints clear, ready to use as-is

Issue flagging rules — HARD LIMITS, no exceptions:
  - Prompts scoring 7 or higher: return MAXIMUM 2 issues. Hard limit.
  - Prompts scoring 4-6: return MAXIMUM 3 issues. Most impactful only.
  - Prompts scoring 1-3: return MAXIMUM 5 issues. Core problems only.
  - Never flag hypothetical improvements or optional extras the user did not ask for.

Improvement rules:
  - Add a role if helpful ("You are a senior...")
  - Specify output format (JSON, bullet list, paragraph, table, etc.)
  - Add constraints (length, tone, audience, language)
  - Break complex asks into explicit steps
  - Remove ambiguity — never leave the model guessing
  - NEVER change the user's original intent
  - If the user explicitly specifies a language (e.g. "en español", "in French"),
    preserve that exact language instruction in the improved prompt
  - Concise and targeted beats long and exhaustive`;

// ─────────────────────────────────────────────
// 3. PROVIDER ADAPTERS
// ─────────────────────────────────────────────

async function callAnthropic(userPrompt, apiKey, model) {
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model, max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Analyze and improve this prompt:\n\n${userPrompt}` }],
  });
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  return { text, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
}

async function callOpenAI(userPrompt, apiKey, model) {
  const client = new OpenAI({ apiKey });
  const res = await client.chat.completions.create({
    model, max_tokens: 1500,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user",   content: `Analyze and improve this prompt:\n\n${userPrompt}` },
    ],
  });
  const text = res.choices[0]?.message?.content || "";
  return { text, usage: { input: res.usage.prompt_tokens, output: res.usage.completion_tokens } };
}

async function callGoogle(userPrompt, apiKey, model) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const geminiModel = genAI.getGenerativeModel({ model });
  const res = await geminiModel.generateContent(
    `${SYSTEM_PROMPT}\n\nAnalyze and improve this prompt:\n\n${userPrompt}`
  );
  const text = res.response.text();
  const usage = res.response.usageMetadata;
  return {
    text,
    usage: { input: usage?.promptTokenCount || 0, output: usage?.candidatesTokenCount || 0 },
  };
}

const ADAPTERS = { anthropic: callAnthropic, openai: callOpenAI, google: callGoogle };

// ─────────────────────────────────────────────
// 4. CORE ENGINE
// ─────────────────────────────────────────────

async function improvePrompt({ prompt, apiKey, provider, model }) {
  const providerKey = provider.toLowerCase();
  const adapter = ADAPTERS[providerKey];
  if (!adapter) throw new Error(`Unsupported provider: ${provider}`);

  const resolvedModel = model || PROVIDERS[providerKey]?.defaultModel;
  const { text, usage } = await adapter(prompt, apiKey, resolvedModel);

  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Engine returned malformed JSON. Please retry.");
  }

  parsed.meta = { provider: providerKey, model: resolvedModel, input_tokens: usage.input, output_tokens: usage.output };
  return parsed;
}

// ─────────────────────────────────────────────
// 5. INPUT VALIDATION
// ─────────────────────────────────────────────

const RequestSchema = z.object({
  prompt:   z.string().min(5, "Prompt must be at least 5 characters").max(4000, "Prompt exceeds 4000 character limit"),
  api_key:  z.string().min(10, "Invalid API key"),
  provider: z.enum(["anthropic", "openai", "google"]).default("anthropic"),
  model:    z.string().optional(),
});

// ─────────────────────────────────────────────
// 6. REST API
// ─────────────────────────────────────────────

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(express.static(__dirname));  // serves index.html at root

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: "Too many requests. Please wait 15 minutes." } });
app.use("/improve", limiter);

app.get("/health", (_, res) => res.json({ status: "ok", providers: Object.keys(PROVIDERS) }));
app.get("/models", (_, res) => res.json({ providers: PROVIDERS }));

app.post("/improve", async (req, res) => {
  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

  const { prompt, api_key, provider, model } = parsed.data;
  try {
    const result = await improvePrompt({ prompt, apiKey: api_key, provider, model });
    return res.json({ success: true, data: result });
  } catch (err) {
    const status  = err?.status || 500;
    const message =
      status === 401 ? `Invalid ${provider} API key.` :
      status === 429 ? `Your ${provider} account is rate limited.` :
      err.message || "Something went wrong.";
    return res.status(status).json({ error: message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`REST API → http://localhost:${PORT}`));

// ─────────────────────────────────────────────
// 7. MCP SERVER
// ─────────────────────────────────────────────

function createMcpServer() {
  const mcpServer = new McpServer({ name: "prompt-improver", version: "1.0.0" });
  mcpServer.tool(
    "improve_prompt",
    {
      prompt:   z.string().min(5).max(4000).describe("The prompt you want to improve"),
      api_key:  z.string().describe("Your API key for the chosen provider"),
      provider: z.enum(["anthropic", "openai", "google"]).default("anthropic").describe("Which AI provider key you are using"),
      model:    z.string().optional().describe("Optional: specific model e.g. gpt-4o-mini"),
    },
    async ({ prompt, api_key, provider, model }) => {
      try {
        const result = await improvePrompt({ prompt, apiKey: api_key, provider, model });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );
  return mcpServer;
}

// Remote HTTP MCP — Claude Desktop connects to /mcp
app.get("/mcp", (req, res) => {
  res.json({ name: "prompt-improver", version: "1.0.0", description: "Analyzes and improves prompts for any AI model" });
});

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.delete("/mcp", (req, res) => res.status(200).end());

// Local stdio MCP — for power users running locally
if (process.argv.includes("--mcp")) {
  const transport = new StdioServerTransport();
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
  console.error("MCP server running via stdio");
}
