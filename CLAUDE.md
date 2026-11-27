# Notes for coding agents

## Line endings: LF everywhere

`.gitattributes` (`* text=auto eol=lf`) makes Git store all text files with LF and check them out with LF, on Windows too. Binary assets (`png`, `ico`, `icns`, `pdf`) are marked `binary`.

- Write files with LF. On Windows, Python in text mode (`open(p, 'w')`) writes CRLF, so use `open(p, 'w', encoding='utf-8', newline='\n')`. The Edit/Write tools, `sed -i` and heredocs in Git Bash keep LF.
- Git converts CRLF to LF when you stage a file, but the working copy keeps the CRLF and the "CRLF will be replaced by LF" warnings are noise. Fix such a file: `sed -i 's/\r$//' FILE`.
- Before committing, check that `git diff --stat` matches the size of your change. If a file shows as fully rewritten, something other than your edit changed it.
- New binary file types belong in `.gitattributes` as `binary`.
