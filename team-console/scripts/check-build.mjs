// Build step: there is nothing to compile (Netlify bundles the functions); this only checks the files are in place.
import { existsSync, readdirSync } from 'node:fs';

const need = ['public/index.html', 'public/app.js', 'public/styles.css', 'netlify/functions/api-state.mts', 'src/service.ts', 'src/seed-csv.ts'];
const missing = need.filter((f) => !existsSync(f));
if (missing.length) {
  console.error(`Missing files: ${missing.join(', ')}`);
  process.exit(1);
}
const fns = readdirSync('netlify/functions').filter((f) => f.endsWith('.mts'));
console.log(`Team console: ${fns.length} functions found.`);
const chat = process.env.GROQ_API_KEY ? 'GROQ_API_KEY' : process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : '';
console.log(chat ? `${chat} is set: a chat model drafts the replies.` : 'No chat model key visible to the build (fine if it is scoped to Functions only): rules and templates draft the replies.');
console.log(process.env.JINA_API_KEY ? 'JINA_API_KEY is set: search uses Jina vectors.' : 'No JINA_API_KEY visible to the build.');
