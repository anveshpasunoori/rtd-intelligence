# RTD & Appraisal Decision Intelligence Platform — local dev copy

This is a self-contained single-file app (`index.html`) — all HTML, CSS, and JS
in one file, with seeded demo data baked in. It needs a local static file
server (not `file://`) because it uses `fetch`/ES module-style features that
browsers block on the file:// protocol, and because the .xlsx upload parser
uses browser APIs that behave more consistently served over http.

## Run it

From this folder, pick whichever you have installed:

```bash
# Option 1 — Python (usually pre-installed on macOS)
python3 -m http.server 5173

# Option 2 — Node (if you have it)
npx serve . -l 5173
```

Then open **http://localhost:5173** in your browser.

## Notes

- This is a standalone prototype, separate from the FastAPI/React app in the
  sibling `backend/` and `frontend/` folders in this project — it doesn't
  share a data model or server with that app. It's a fully client-side
  build: all "backend" logic (rules engine, xlsx parsing, scoring) runs in
  the browser, and data is kept in `sessionStorage`/in-memory only, so a
  hard refresh or new browser profile starts from the seeded demo data again.
- It's also published as a hosted Claude Artifact at:
  https://claude.ai/code/artifact/ffe1e02c-4af2-42ae-b19a-d160cebb34c1
  This local copy is the same app, running on your own machine so the URL
  reads as `localhost` instead.
- To update this local copy after further changes are made in the Claude
  session, just ask Claude to re-sync it — it will overwrite `index.html`
  here.
