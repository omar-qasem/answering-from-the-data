# Feed simulator — static Netlify site

A photo feed for a fictional brand. Customers comment here; the brand's replies come from the team console.

1. Deploy the team console first and copy its address, e.g. `https://my-team-console.netlify.app`
2. Open https://app.netlify.com/drop and drag this zip onto the page.
3. Open the new site. It asks once for the team console address: paste it → **Connect**.
   - Or open the feed from the console (Setup → Open the feed ↗), which connects it by itself.
   - Or set `API_BASE` in `config.js` before uploading.
4. Pick a customer under **Comment as** and write a comment. Use **+** to publish a new post as the brand.
