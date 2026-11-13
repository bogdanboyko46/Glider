# Glider rewrite service (proxy)

A single serverless function. It holds the Anthropic API key and rewrites one paragraph at a time for the Glider extension, so the extension never contains a key.

```
extension (simplify/claude.js)  --POST {text, lineText}-->  /api/simplify  --Anthropic SDK-->  Claude
```

## Deploy (Vercel)

```bash
cd proxy
vercel login                       # once
vercel link                        # create or pick the project
vercel env add ANTHROPIC_API_KEY production     # paste the key when asked; it is stored by Vercel, not in this repo
vercel deploy --prod
```

The address to give the extension is `https://<your-project>.vercel.app/api/simplify`. Either paste it into the extension's Options page (Rewrite service address), or set `DEFAULT_SERVICE_URL` in `glider-extension/simplify/claude.js` so every install uses it.

## Settings (environment variables)

| Name | Needed | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | The key the service calls Claude with |
| `GLIDER_MODEL` | no | Model to use. Default `claude-opus-5-5`; `claude-haiku-5-5` is faster and far cheaper |
| `GLIDER_EXTENSION_IDS` | no | Comma-separated extension ids allowed to call the service. Empty allows any extension |
| `GLIDER_PROXY_TOKEN` | no | An access code the extension must send (`DEFAULT_SERVICE_TOKEN` in `claude.js`, or the Options page) |

## What protects it

- Only requests with an extension origin are answered; `GLIDER_EXTENSION_IDS` narrows that to your extension.
- Text must be 20 to 6000 characters. The prompt and model are fixed on the server; callers cannot change them.
- A rate limit of 20 rewrites per 10 minutes per install and 300 an hour overall.

These are brakes, not guarantees. The rate limit is kept in memory, so it resets when the function restarts and is counted separately on each running instance. An origin header and an access code shipped inside an extension can both be copied by someone determined. **Set a monthly spend limit on the Anthropic key** in the Anthropic Console; that is the real cap.

## Privacy

The service receives the paragraph the reader is stuck on (and the line they slowed on), sends it to Anthropic, and returns the rewrite. It stores nothing and logs no text. It does not receive the page address, any account, or eye-tracking data. A random per-install id is sent only so the rate limit can tell installs apart.

## Test

```bash
node tests/proxy.test.mjs          # request handling with a fake Anthropic client, no network
```
