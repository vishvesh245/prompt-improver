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
  anthropic: { label: "Anthropic", defaultModel: "claude-haiku-4-5-20251001", keyPrefix: "sk-ant-" },
  openai:    { label: "OpenAI",    defaultModel: "gpt-4o-mini",               keyPrefix: "sk-"     },
  google:    { label: "Google",    defaultModel: "gemini-2.0-flash",           keyPrefix: "AIza"    },
};

// ─────────────────────────────────────────────
// 2. SYSTEM PROMPT
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `Expert prompt engineer. Return ONLY valid JSON — no markdown, no backticks.

Structure:
{"score":<1-10>,"issues":[{"text":"<specific observation>","severity":"high|medium|low"}],"improved":"<rewritten prompt>","changes":["<what changed>"],"tips":["<1-2 tips>"]}

Issues: specific plain language, NOT generic. BAD:"No context" GOOD:"Didn't say who it's for"
Severity: high=missing critical info, medium=missing format/audience/scope, low=nice-to-have

Score: 1-3=vague/no context, 4-6=clear intent but missing role/format/constraints (don't underscore), 7-8=good with minor gaps, 9-10=ready to use
Issue limits: score 7+: max 2, score 4-6: max 3, score 1-3: max 5. No hypothetical extras.

Improve: add role if helpful, specify format, add constraints (length/tone/audience), break complex asks into steps, remove ambiguity, NEVER change intent, preserve language instructions. Concise beats exhaustive.`;

// ─────────────────────────────────────────────
// 3. PROVIDER ADAPTERS
// ─────────────────────────────────────────────

async function callAnthropic(userPrompt, apiKey, model) {
  const client = new Anthropic({ apiKey });
  const res = await client.messages.create({
    model, max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Analyze and improve this prompt:\n\n${userPrompt}` }],
  });
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  return { text, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
}

async function callOpenAI(userPrompt, apiKey, model) {
  const client = new OpenAI({ apiKey });
  const res = await client.chat.completions.create({
    model, max_tokens: 800,
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

// Free tier endpoint — uses server's own API key (for Chrome extension)
const freeLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: "Too many free requests. Please add your own API key." } });

const FreeRequestSchema = z.object({
  prompt: z.string().min(5, "Prompt must be at least 5 characters").max(4000, "Prompt exceeds 4000 character limit"),
});

app.post("/improve-free", freeLimiter, async (req, res) => {
  const serverKey = process.env.ANTHROPIC_API_KEY;
  if (!serverKey) return res.status(503).json({ error: "Free tier is not configured on this server." });

  const parsed = FreeRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0].message });

  try {
    const result = await improvePrompt({
      prompt: parsed.data.prompt,
      apiKey: serverKey,
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",  // cheapest model for free tier
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Something went wrong." });
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
const sessions = new Map();  // sessionId → transport

app.get("/mcp", (req, res) => {
  res.json({ name: "prompt-improver", version: "1.0.0", description: "Analyzes and improves prompts for any AI model" });
});

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];

    // Existing session — route to it
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // New session — create transport + server
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);

    // Store session after handling (sessionId is set after initialize)
    if (transport.sessionId) {
      sessions.set(transport.sessionId, transport);
    }
  } catch (err) {
    console.error("MCP error:", err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.delete("/mcp", (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId);
    transport.close?.();
    sessions.delete(sessionId);
  }
  res.status(200).end();
});

// Local stdio MCP — for power users running locally
if (process.argv.includes("--mcp")) {
  const transport = new StdioServerTransport();
  const mcpServer = createMcpServer();
  await mcpServer.connect(transport);
  console.error("MCP server running via stdio");
}
