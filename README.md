# PromptPulse — Grammarly for AI Prompts

> Instantly score and improve your AI prompts. Works on ChatGPT, Claude, and Gemini.

<!-- [Chrome Web Store](link-here) · -->
[Privacy Policy](https://vishvesh245.github.io/prompt-improver/privacy-policy.html)

---

## The Problem

**80% of AI users write vague, underspecified prompts — and don't realize it until they get a mediocre response.**

You spend 30 seconds writing a prompt. The AI gives you a generic answer. You rephrase, retry, add context — another 2 minutes gone. Multiply that by every conversation, every day.

The root cause isn't the AI model. It's the prompt. But unlike writing (where Grammarly catches your mistakes), there's nothing that catches a bad prompt *before* you hit send.

**That's what PromptPulse does.**

It sits quietly inside ChatGPT, Claude, and Gemini. The moment you finish typing, it scores your prompt on a 1–10 scale across 7 quality dimensions. If there's room to improve, it tells you exactly what's missing — and offers a rewritten version in one click.

No workflow change. No switching tabs. No copy-pasting into another tool.

---

## How It Works

```
Type a prompt  →  Badge appears with score  →  Click to see issues  →  One click to apply fix
```

1. **Type** your prompt in ChatGPT, Claude, or Gemini as usual
2. **See** a real-time quality score badge appear (1–10)
3. **Click** the badge to see specific issues and an AI-improved version
4. **Apply** the improved prompt with one click — or keep yours if the score is high

---

## Features

### Real-Time Scoring
A small badge scores your prompt as you type. Color-coded: red (needs work) → yellow (good start) → green (great prompt). You know instantly if your prompt needs attention.

### Specific, Actionable Feedback
Not vague tips like "be more specific." PromptPulse identifies exact issues:
- *"No output format specified"*
- *"Missing audience context"*
- *"Too vague — add constraints"*
- *"No success criteria defined"*

### One-Click Improvement
Every analysis includes an AI-rewritten prompt that preserves your intent but fills the gaps. One click replaces your prompt. Don't like it? Keep yours.

### Savings Dashboard
Track the value PromptPulse delivers over time:
- **Time saved** per prompt (weighted by follow-up probability)
- **Money saved** in token costs from fewer retries
- **Score improvement** trends across your history
- **ROI breakdown** with probability-weighted modeling

### Multi-Platform
Works identically on:
- ✅ **ChatGPT** (chat.openai.com / chatgpt.com)
- ✅ **Claude** (claude.ai)
- ✅ **Gemini** (gemini.google.com)

### Privacy First
- Your API key never leaves your browser
- Prompts are analyzed in real-time and **never stored** on our servers
- No tracking, no ads, no data selling
- Zero third-party analytics

---

## Scoring System

Prompts are scored on **7 dimensions**, each weighted by impact on AI output quality:

| Dimension | Weight | What it measures |
|---|---|---|
| Specificity | 20% | Clear, concrete ask vs vague request |
| Context | 15% | Background info the AI needs |
| Structure | 15% | Logical organization of the prompt |
| Constraints | 15% | Boundaries, format, length requirements |
| Audience | 10% | Who the output is for |
| Intent | 15% | What success looks like |
| Examples | 10% | Reference examples or patterns |

A local heuristic (`quickScore`) provides instant badge scoring. The full AI-powered analysis runs when you click the badge, giving detailed issue breakdown and an improved prompt.

[Full methodology →](extension/dashboard-methodology.html)

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (Chrome Extension - Manifest V3)           │
│                                                     │
│  Content Script ──→ Background Service Worker       │
│  (badge + popup)     (storage, stats, API relay)    │
│       │                       │                     │
│       │                       ▼                     │
│       │              chrome.storage.local            │
│       │              (API key, stats, config)        │
└───────┼─────────────────────────┼───────────────────┘
        │                         │
        ▼                         ▼
   User sees                Railway Backend
   score + popup         (Node.js + Express)
                               │
                    ┌──────────┼──────────┐
                    ▼          ▼          ▼
                 Claude    GPT-4o     Gemini
                (Anthropic) (OpenAI)  (Google)
```

**Content Script** — Detects prompt input on ChatGPT/Claude/Gemini, runs local scoring, renders the badge and popup UI. Injected via `content_scripts` in manifest.

**Background Service Worker** — Handles API calls to the backend, manages `chrome.storage.local` for API keys, usage counts, stats tracking, and remote config fetching.

**Railway Backend** — Express server that validates requests, routes to the user's chosen AI provider, and returns the analysis. Also serves remote config (free limit, minimum prompt length) so we can tune settings without pushing an extension update.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Extension | Chrome Manifest V3, vanilla JS, CSS |
| Backend | Node.js, Express, Zod validation |
| AI Providers | Anthropic Claude, OpenAI GPT-4o-mini, Google Gemini Flash |
| Hosting | Railway (auto-deploy from `main`) |
| Storage | `chrome.storage.local` (all user data stays in browser) |

---

## Getting Started (Development)

### Backend

```bash
git clone https://github.com/vishvesh245/prompt-improver.git
cd prompt-improver
npm install

# Set environment variables
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GOOGLE_API_KEY=...

npm start
# Server runs on http://localhost:3000
```

### Extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Navigate to [ChatGPT](https://chatgpt.com), [Claude](https://claude.ai), or [Gemini](https://gemini.google.com)
5. Start typing a prompt — the PromptPulse badge appears automatically

### Configuration

The backend serves remote config at `GET /config`:

```json
{
  "freeLimit": 5,
  "minPromptLength": 10
}
```

This lets you change the free tier limit or minimum prompt length without pushing an extension update.

---

## Free Tier

- **5 free analyses** — no API key, no signup
- **Unlimited** with your own key — bring an Anthropic, OpenAI, or Google API key
- Cost per analysis with your own key: **< $0.001**

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check + available providers |
| `GET` | `/models` | List supported AI models |
| `GET` | `/config` | Remote config (freeLimit, minPromptLength) |
| `POST` | `/improve` | Analyze and improve a prompt |

### POST /improve

```json
{
  "prompt": "Write me a blog post about AI",
  "provider": "anthropic",
  "apiKey": "sk-ant-...",
  "model": "claude-sonnet-4-20250514"
}
```

Returns:

```json
{
  "score": 4,
  "issues": ["No target audience specified", "No desired length or format", "Missing tone/style guidance"],
  "improved": "Write a 1,500-word blog post for tech-savvy professionals about...",
  "improved_score": 9
}
```

---

## Privacy

PromptPulse is built with privacy as a core principle:

- **API keys** are stored only in `chrome.storage.local` — never sent to our server (they go directly to the AI provider)
- **Prompt text** is sent to the backend only for analysis — it is processed in real-time and **never logged or stored**
- **Analytics** (scores, timestamps) are stored locally in your browser only
- **No cookies**, no fingerprinting, no third-party scripts
- **Open source** — audit the code yourself

[Full Privacy Policy →](https://vishvesh245.github.io/prompt-improver/privacy-policy.html)

---


## License

MIT

---
