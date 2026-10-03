# Tests

Unit tests for the team console, run against `../team-console/src`.

| Test | What it checks |
| --- | --- |
| `t_ingest.ts` | CSV parsing, day-first dates, statuses from words or quantities, the catalog and its Arabic names |
| `t_search.ts` | 42 product and place names in Arabic, English and with typos resolve to the right catalog entry with no AI; unclear words become a choice or no match |
| `t_search_sem.ts` | The same kind of checks with test vectors switched on, so the third ranking never breaks a word-level tie (رز stays a choice) |
| `t_query.ts` | The table query: places, widening, pack sizes ("2 كيلو", "the big one") |
| `t_reply.ts` | Writes the template reply for 15 cases and fact-checks each one; also shows the facts handed to the model |
| `t_understand.ts` | Prints how the rules (used when there is no AI key) read 22 comments: intent, products, places |
| `t_config.ts` | Which provider is used for each combination of keys |
| `t_prompt_size.ts` | Prints the token size of each AI call, which matters on Groq's free tier |
| `t_groq.ts` | The Groq client: strict JSON schema, retries, 429 waits, the daily cap |
| `t_batch.ts` | The background job: 18 drafts in turn within a time budget, hand-off to a fresh job, reset mid-batch |

`mock-openai.ts` is the local stand-in for Groq, Jina, OpenAI and Gemini: it checks the requests the app sends and answers with the same formats, errors and rate limits (for Groq, 8,000 tokens a minute).

```bash
cd ../team-console && npm install
cd ../tests && ./run-all.sh
```
