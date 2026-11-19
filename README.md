# AI Quota

A Wox plugin that shows local Codex, Cursor, Claude, Grok, and OpenCode Go quotas inside the launcher.

![Screenshot of AI Quota in Wox](./screenshot.png)

## Install

```bash
wpm install Wox.Plugin.AIQuota
```

## Usage

Type `quota` in Wox to list every plan it can find on this machine, or narrow it down with a command:

| Command    | Shows                                             |
| ---------- | ------------------------------------------------- |
| `codex`    | Codex rate limit windows                          |
| `cursor`   | Cursor plan, model and request usage              |
| `claude`   | Claude Code session and weekly usage              |
| `grok`     | Grok CLI credits and Grok Bot usage               |
| `opencode` | OpenCode Go rolling, weekly and monthly allowance |

Append `refresh` (for example `quota refresh`) to bypass the cache.

### OpenCode Go

The OpenCode Go allowance is read from `https://opencode.ai/zen/go/v1/usage` with the organization API key created in the OpenCode Console. The plugin never stores the key; it reads it from an environment variable at refresh time:

```bash
# macOS / Linux
export OPENCODE_GO_API_KEY="sk-..."

# Windows (PowerShell, persists for the current user)
setx OPENCODE_GO_API_KEY "sk-..."
```

Restart Wox after changing the variable so the launcher process picks it up. A different variable name can be configured in the plugin settings (_OpenCode Go API key environment variable_).

The Go endpoint reports the plan-wide rolling, weekly and monthly windows as a used percentage plus the reset instant. Each window becomes one row with a progress bar; a `rate-limited` window is labelled as such. When the variable is missing the plugin stays out of the combined list and only `opencode` explains what to set; an invalid key or a key without a Go subscription is reported as an error.

## Development

```bash
pnpm install
pnpm test        # jest
pnpm lint
pnpm build       # ncc bundle into dist/
pnpm package     # dist/Wox.Plugin.AIQuota.wox
```
