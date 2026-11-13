// POST /api/simplify — Vercel serverless function. Holds the Anthropic API key (env ANTHROPIC_API_KEY)
// and rewrites one paragraph for the Glider extension. All logic is in ../lib/core.js.
import Anthropic from '@anthropic-ai/sdk';
import { handle, createLimiter } from '../lib/core.js';

const client = new Anthropic({ timeout: 25_000, maxRetries: 1 });   // reads ANTHROPIC_API_KEY
const limiter = createLimiter();

export default async function handler(req, res) {
  const out = await handle(
    {
      method: req.method,
      headers: req.headers,
      body: req.body,
      ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '',
    },
    { create: (params) => client.beta.messages.create(params), errors: Anthropic, env: process.env, limiter },
  );
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  if (out.body === null) res.status(out.status).end();
  else res.status(out.status).json(out.body);
}
