# Local AI Agent

Experimental Chrome extension + localhost Node daemon that gives DeepSeek, Qwen, and Z.ai **approved** local coding tools.

## Features
- Automatic `<tool_call>` detection with a configurable 3-12 second result cooldown
- Draggable in-page activity monitor with live tool and send-countdown states
- Automatic failure results so the model can correct malformed or failed tool calls
- Automatic tool-protocol reinforcement on every outgoing Qwen message
- Project/workspace boundary
- Pairing token stored at `~/.deepseek-local/token`
- Project-specific or global auto-approval for file edits, deletes, and shell commands
- `read_file`, `write_file`, `edit_file`, `delete_file`, `list_directory`
- `run_command`, `git_status`, `git_diff`, `git_log`
- SQLite tool-call history at `~/.deepseek-local/history.db`
- Blocks obvious high-risk system commands

## Install
Requires Node.js 20+ and Chrome/Chromium.

```bash
npm install
npm run build
DEEPSEEK_WORKSPACE=/absolute/path/to/project npm start
```

The daemon prints a pairing token. In Chrome open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `extension/dist`. Open `https://chat.deepseek.com/`, `https://chat.qwen.ai/`, or `https://chat.z.ai/`, then open the extension popup, paste the token and absolute project path, and click **Connect**. If the chat tab was already open before the extension loaded, click **Attach Tab** once. After connecting, approval switches can be applied to the current project or to every project used by this browser profile.

## Chat instruction
Start a supported AI chat with something like:

```text
You have local tools. When you need one, output exactly one `<tool_call>...</tool_call>` block and no other text.
Inside that block, return JSON with the shape `{"name":"TOOL_NAME","arguments":{...}}`.
After receiving `<tool_result>`, continue. Available tools: read_file, write_file, edit_file, delete_file, list_directory, run_command, git_status, git_diff, git_log. Paths are relative to the active project. delete_file only removes individual files, not directories.
For edit_file use `{"path":"FILE","old_text":"EXACT EXISTING TEXT","new_text":"REPLACEMENT TEXT"}`.
```

Then ask: `Inspect this project and explain its structure.`

## Safety
Auto-approval is opt-in and disabled by default. Auto-approved shell commands still pass through the daemon's high-risk command blocklist. Keep the daemon on 127.0.0.1 and do not expose port 43121 publicly. Each supported chat DOM is third-party UI and can change; `extension/src/content.ts` isolates the adapter logic.

## Known limitation
Auto-submit is DOM-based. If a supported chat changes its composer/send-button implementation, tool execution still works but the adapter may need a selector/event update.
