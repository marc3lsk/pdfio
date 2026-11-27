# Notes for coding agents

## Line endings: keep each file's existing style

The repo has no `.gitattributes` and `core.autocrlf=false`, so Git stores exactly the bytes you write. Line endings are mixed:

- **CRLF:** `index.html`, `src/platform.ts`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- **LF:** everything else, and all new files

If you change a file's line endings, the diff turns into a rewrite of the whole file. Rules:

- Keep the line endings a file already has. New files use LF.
- On Windows, scripted edits are the usual cause. Python in text mode (`open(p, 'w')`) writes CRLF. Use `open(p, 'w', encoding='utf-8', newline='')` and keep the newlines from the text you read. The Edit/Write tools, `sed -i` and heredocs in Git Bash keep the existing endings.
- Before committing, check that `git diff --stat` matches the size of your change. If a file shows as fully rewritten, compare with `git diff --ignore-cr-at-eol --stat`. When the two differ, you changed line endings by accident; restore the original style before you commit.
- To check a file: `tr -cd '\r' < FILE | wc -c` (0 = LF). To compare with the committed version: `git show HEAD:FILE | tr -cd '\r' | wc -c`.
