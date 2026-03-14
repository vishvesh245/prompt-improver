# PromptPulse — Chrome Web Store Listing

## Name
PromptPulse — Grammarly for AI Prompts

## Short Description (132 chars max)
Instantly score and improve your AI prompts — works on ChatGPT, Claude, and Gemini. Like Grammarly, but for prompts.

## Detailed Description

**PromptPulse scores your AI prompts in real-time and suggests improvements — like Grammarly, but for ChatGPT, Claude, and Gemini.**

Ever hit send on a prompt and gotten a mediocre response? The problem usually isn't the AI — it's the prompt. PromptPulse fixes that.

### How It Works
1. Type a prompt in ChatGPT, Claude, or Gemini
2. A small badge appears with a quality score (1-10)
3. Click it to see specific issues and an improved version
4. One click to apply the improvement — or keep yours

### What You Get
- **Real-time scoring** — see your prompt quality as you type
- **Specific feedback** — not vague tips, but actual issues ("No output format specified", "Missing audience context")
- **One-click improvements** — AI-rewritten prompts that preserve your intent
- **Savings Dashboard** — track time and money saved with detailed ROI analytics
- **Works everywhere** — ChatGPT, Claude, and Gemini supported

### Free to Start
- **10 free analyses** — no API key needed
- **Unlimited with your own key** — bring your Anthropic, OpenAI, or Google API key (costs less than $0.001 per analysis)

### Privacy First
- Your API key stays in your browser
- Prompts are analyzed in real-time and never stored
- No tracking, no ads, no data selling
- [Full privacy policy](https://vishvesh245.github.io/prompt-improver/privacy-policy.html)

### Why PromptPulse?
Most people don't realize their prompts are vague until they get a bad response. PromptPulse catches the gap *before* you hit send — saving you time and tokens.

---

## Category
Productivity

## Language
English

## Privacy Policy URL
https://vishvesh245.github.io/prompt-improver/privacy-policy.html

## Single Purpose Description (for Google review)
Analyzes and improves AI prompts on ChatGPT, Claude, and Gemini chat interfaces.

## Permissions Justification

| Permission | Justification |
| --- | --- |
| `storage` | Stores user's API key, free usage count, and analytics data locally in the browser |
| Host: `claude.ai/*` | Injects prompt analysis badge and popup UI into Claude chat |
| Host: `chat.openai.com/*`, `chatgpt.com/*` | Injects prompt analysis badge and popup UI into ChatGPT chat |
| Host: `gemini.google.com/*` | Injects prompt analysis badge and popup UI into Gemini chat |
| Host: `prompt-improver-production.up.railway.app/*` | Backend API that forwards prompts to AI providers for analysis |

---

## Screenshots Needed (1280x800 or 640x400)

### Screenshot 1: Hero — Badge on ChatGPT
- Show ChatGPT with a prompt typed
- Yellow badge visible: "Good start — tap to improve"
- Caption: "Real-time prompt scoring on ChatGPT"

### Screenshot 2: Popup — Low Score with Issues
- Show the popup card with score 5/10
- Issues list visible with red/yellow dots
- Improved version visible
- Caption: "See exactly what's wrong and get a better version"

### Screenshot 3: Popup — High Score
- Show popup with score 9/10
- "Looks great, keep mine" button prominent
- Caption: "High scores mean your prompt is ready to go"

### Screenshot 4: Savings Dashboard
- Show the full savings dashboard with stats
- Caption: "Track your time and money saved with detailed analytics"

### Screenshot 5: Works on All 3 Platforms
- Split view or collage showing badge on Claude, ChatGPT, Gemini
- Caption: "Works on ChatGPT, Claude, and Gemini"

---

## Icon Design Spec

### Concept
A pulse/heartbeat line (like an EKG) — representing real-time prompt quality monitoring

### Colors
- Primary: #38bdf8 → #0284c7 (Sky Blue gradient — matches the extension's accent color)
- Accent: #4ade80 (green pulse line — matches the "good score" color)
- Background: Sky Blue gradient on rounded square

### Sizes Needed
- 16x16 (toolbar)
- 48x48 (extensions page)
- 128x128 (Chrome Web Store / install dialog)
- 1200x800 (promotional image)

### Style
- Clean, minimal, modern
- Should be recognizable at 16x16
- No text in the icon (text only in promo tiles)

---

## Promo Image (1200x800)
- File: `promo-1200x800.html` / `promo-1200x800.png`
- Shows PromptPulse branding, tagline "Grammarly for your AI prompts"
- Includes mockup of badge + popup card
- Platform chips for ChatGPT, Claude, Gemini
- Slate Dark (#0d1117) background with Sky Blue accents
