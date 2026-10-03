# Team console — Netlify site with the backend

The marketing team page, the API (Netlify Functions) and the two LangGraph graphs. Deploy this site first.

## 1. Deploy

**Option A — drag and drop (be logged in to Netlify)**

1. Open https://app.netlify.com/drop
2. Drag this zip onto the page. Netlify installs the packages and runs the build.
3. Open `https://YOUR-SITE.netlify.app/api/health`
   - You see JSON → done, go to step 2.
   - You see "Page not found" → only the files were published, not the functions. Use option B.

**Option B — Netlify CLI (always deploys the functions; needs Node.js 20+)**

```bash
unzip Team-Console.zip -d team-console
cd team-console
npm install
npm install -g netlify-cli
netlify login
netlify deploy --prod --site-name pick-a-name
```

**Option C — GitHub**

1. Push the unzipped folder to a new GitHub repository.
2. Netlify → Add new project → Import an existing project → choose the repository → Deploy. Settings come from `netlify.toml`.

## 2. Free AI: Groq writes the replies, Jina powers the search

1. **Groq** (reads the comments and writes the replies): sign in at https://console.groq.com → **API Keys** → **Create API Key**. The key starts with `gsk_`.
2. **Jina** (AI vectors for the search; Groq has no embedding model): get a free key at https://jina.ai. It starts with `jina_`.
3. Netlify → your site → Site configuration → Environment variables → add `GROQ_API_KEY` and `JINA_API_KEY`. Scope: all (or at least Functions).
4. Deploy again so the keys are picked up: drag the same zip onto the site's **Deploys** page.
5. Open the console → **Health** → **Test the key**. It should say "Chat: works · openai/gpt-oss-120b" and "Embeddings: work".
6. If the demo was already running before you added the key, its starting drafts came from rules and templates. **Setup** → **Reset the demo** drafts them again with Groq.

The replies are written by `openai/gpt-oss-120b` on Groq. To use another Groq model, set `GROQ_MODEL` (for example `openai/gpt-oss-20b`). Groq's models read text only, so the post graph reads the caption, not the image. The search index rebuilds itself with Jina vectors on the first draft.

**What the Groq free tier means here.** The free tier allows about 8,000 tokens a minute and 200,000 a day for `openai/gpt-oss-120b`. It counts each call's prompt plus its output cap, so one draft (read the comment, then write the reply) takes about 4,000 to 5,000 tokens of the minute's allowance.

- After a deploy or a reset, the 18 starting comments are drafted one after another by a single background job, about two a minute, so the last ones are ready after roughly 10 minutes. The queue shows which comment is being drafted and which are waiting their turn.
- A new comment from the feed gets its own background job. It is ready in a few seconds, or within about a minute while the starting drafts are still running.
- Each reset drafts all 18 comments again, which uses a good part of the daily allowance. If a limit is reached, the draft comes from rules and templates, and "How this draft was made" says why.

## 3. Other chat models (optional)

Groq is used when `GROQ_API_KEY` is set. Without it, one of these writes the replies (add it the same way, then deploy again):

- `GEMINI_API_KEY`: a Gemini key from Google AI Studio.
- `OPENAI_API_KEY`: OpenAI, or any OpenAI-compatible API (also set `OPENAI_BASE_URL` and `OPENAI_MODEL`).

Other optional variables:

| Variable | What it does |
| --- | --- |
| `GROQ_MODEL` | Default `openai/gpt-oss-120b`. |
| `GROQ_MAX_TOKENS` | Output cap per Groq call, default `1000` (300 to 4000). Raise it only if a draft's notes say the model ran out of tokens. |
| `AI_CONCURRENCY` | Drafts one background job writes at the same time. Default 1 with Groq, 4 with the others. |
| `GEMINI_MODEL` | Default `gemini-flash-latest`. |
| `JINA_EMBED_MODEL` | Default `jina-embeddings-v5-text-small` (falls back to v4 or v3 if not available). |
| `EMBED_PROVIDER` | `jina`, `gemini`, `openai` or `none`. By default Jina is used when its key is set. |
| `LLM_PROVIDER` | `groq`, `gemini`, `openai` or `none`, when more than one chat key is set. |
| `TEAM_PASSCODE` | Locks the team actions (reply, draft, upload, reset) behind a passcode. |
| `FEED_URL` | Address of the feed site, used by the "Open the feed" link. |

Without any key the site still works: rules read the comments, templates write the replies, and search runs on words and character vectors.

## 4. Connect the feed

1. Deploy `Feed-Simulator.zip` (steps in its README).
2. In the console: **Setup** → paste the feed address → **Save** → **Open the feed ↗**. The link connects the feed to this console.

## 5. Use it

1. On the feed, pick a customer under "Comment as" and ask under a post, e.g. `وين بلاقيه بإربد؟`
2. In the console the comment appears under its post with a prepared reply, plus the shops and visit dates it relied on.
3. Click **Reply now** (or **Edit** first). The reply shows on the feed within seconds.
4. **Data** → drop a new CSV to replace the availability file (the sample is `public/sample/pos_availability.csv`).
5. **Setup** → **Reset the demo** to start over.
