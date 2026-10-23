# Deploying Muzeum

About 15 minutes, once. After that it runs itself: every morning GitHub reads the museum websites, checks the readings, saves the data and republishes the site.

You need a GitHub account and an Anthropic API key (console.anthropic.com → API keys).

## 1. Put the code on GitHub

1. On github.com, click **New repository**. Name it `muzeum`. Choose **Public** (GitHub Pages is free for public repositories). Don't add a README.
2. Upload this folder. Either:
   - **No terminal:** on the new repository page, click **uploading an existing file**, drag in everything from this folder (including the hidden `.github` folder: on a Mac, press Cmd+Shift+. in Finder to show it), and commit.
   - **Terminal:** in this folder run
     ```
     git remote add origin https://github.com/<you>/muzeum.git
     git push -u origin main
     ```

## 2. Add the API key

**Settings → Secrets and variables → Actions → New repository secret**
- Name: `ANTHROPIC_API_KEY`
- Value: your key

Optional, under the **Variables** tab of the same page:
- `MUZEUM_MODEL`: the model that reads pages (default `claude-sonnet-5-5`; `claude-haiku-5-5` is cheaper)
- `MUZEUM_MAX_EXTRACTIONS`: the most pages read by the model per day (default 300)

## 3. Turn on GitHub Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

## 4. Allow the daily job to save its data

**Settings → Actions → General → Workflow permissions → Read and write permissions → Save.**

## 5. Start it

**Actions → Update museum data → Run workflow.** Leave the states as `ALL`.

- The first run finds every art museum on Wikidata (all 50 states and DC). It reads 300 visit pages, then reads 300 more each following day until every museum has been read once. After that, only pages that changed are sent to the model.
- When it finishes, the site is live at `https://<you>.github.io/muzeum/`. The address is also shown on the **deploy** step.
- Every run writes a summary on its Actions page: museums found, published, held, model calls and tokens.

## Every day after that

| What | Where |
| --- | --- |
| The site | `https://<you>.github.io/muzeum/` |
| Museums waiting for a person to check | The **Review queue** issue, updated daily |
| Visitor reports of wrong information | Issues labeled `data` (from **Report a problem** on any card) |
| What changed and when | The repository's commit history (one "Data run" commit a day) |
| A run that failed | GitHub emails you. The site keeps its last good version. |

### Checking a held museum

Open the museum's page from the review issue and compare its hours with the page. If they're right, copy that museum's line from the issue into `pipeline/overrides.json` and commit. Its card then shows **Open** instead of **Usually open**. The confirmation ends by itself if the museum's page changes.

The same file also handles these cases:

```json
{
  "mus_example_art_museum": {"confirm_hash": "…from the review issue…", "note": "Checked 2026-10-24"},
  "mus_not_really_a_museum": {"exclude": "Private collection, not open to visitors"},
  "mus_wrong_page": {"url": "https://example.org/visit/hours"},
  "mus_missing_street": {"set": {"location.street": "111 S Michigan Ave"}}
}
```

### If the circuit breaker trips

A run that would publish far fewer museums than the day before (below 80%) stops before replacing the site. The run fails, you get an email, and the site stays as it was. Read the run summary. If the drop is real (for example, after you excluded many records), run the workflow again with **allow_shrink** ticked.

## Cost

Each page sent to the model is roughly 3,000 to 12,000 input tokens and about 600 output tokens. Unchanged pages cost nothing. Each run's summary shows its exact token counts. Multiply them by the current per-token prices on Anthropic's pricing page to see the cost. Lower `MUZEUM_MAX_EXTRACTIONS`, or switch `MUZEUM_MODEL` to Haiku, to spend less.

## Custom domain (optional)

**Settings → Pages → Custom domain.** GitHub shows the DNS records to add at your registrar.
