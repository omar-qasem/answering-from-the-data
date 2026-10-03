# Answer Path Explorer: source

The explorer runs the team console's own code in the browser: `entry.ts` imports the modules in `../team-console/src` (ingest, hybrid search, table query, rules, templates, fact check and both graph definitions) and esbuild bundles them into `engine.js`. Only the AI calls are left out, so the graphs read with the backend's rules and write with its templates, exactly as the backend does without keys.

| File | What it is |
| --- | --- |
| `entry.ts` | Builds the dataset and search index from the sample file and exposes the functions the page calls |
| `ui.js` | The page: the sequence drawing of the three paths, the LangGraph view, the search lab |
| `page.css`, `page.body.html` | Styles and markup |
| `build.mjs`, `assemble.mjs` | Bundle the engine, then inline everything into one HTML file |
| `test-engine.ts` | Checks the explorer against the backend: same search scores for 52 mentions, same drafts for all 22 demo comments |

```bash
npm install
npm run build   # writes dist/Answer-Path-Explorer.html
npm test        # compares the explorer's engine with the backend's functions
```

The test also imports the backend's own graph runner, so run `npm install` in `../team-console` before `npm test`.
