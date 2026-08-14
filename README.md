# Local AI Agent

Experimental Chrome extension + localhost Node daemon that gives DeepSeek, Qwen, and Z.ai **approved** local coding tools.

## Features
- Automatic `<tool_call>` detection with a configurable 3-12 second result cooldown
- Background `run_command` execution with live elapsed-time polling and resume after tab refresh
- Unique `tool_call_id` correlation across requests, delayed results, failures, and SQLite history
- Draggable in-page activity monitor with live tool and send-countdown states
- Direct Connect and Stop controls in the floating monitor, scoped to the current tab
- Automatic failure results so the model can correct malformed or failed tool calls
- Strict tool-protocol reinforcement on every outgoing DeepSeek, Qwen, and Z.ai message, including a ban on provider-native tools
- Provider-wide recovery for wrapped, fenced, and renderer-stripped JSON tool calls
- Copy-ready initial prompt in the extension popup
- GLM/Z.ai streamed and rendered fenced-JSON tool-call detection when the model omits `<tool_call>` markup
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

### Standalone Windows daemon

With Bun installed on the build machine, create a portable Windows x64 executable:

```bash
npm run build:exe
```

Share `release/local-ai-agent-windows-x64.exe`. The recipient does not need Node.js, npm, or Bun. Run the executable, keep its console window open, and use the printed pairing token in the extension popup. The popup sets the active project path after connecting.

## Chat instruction
DeepSeek, Qwen, and Z.ai receive the strict V4 protocol automatically with every outgoing message. It explicitly disables provider-native tools, requires local calls to be emitted as literal assistant text, and explains delayed shell results. The equivalent protocol is:

```text
Never invoke native or built-in provider tools. The only permitted tools are read_file, write_file, edit_file, delete_file, list_directory, run_command, git_status, git_diff, and git_log.
When local work is required, emit exactly one plain-text `<tool_call>` envelope containing strict JSON shaped as `{"name":"TOOL_NAME","arguments":{}}`, then stop and wait for `<tool_result>`.
Do not add prose or Markdown fences around a tool call, simulate a result, or merely describe file and shell actions. Paths are relative to the active project. For edit_file use path, old_text, and new_text.
Each result includes a unique tool_call_id. run_command executes in the background, so wait for its delayed result with the same ID and do not repeat the command while it is pending.
```

Then ask: `Inspect this project and explain its structure.`

## Safety
Auto-approval is opt-in and disabled by default. Auto-approved shell commands still pass through the daemon's high-risk command blocklist. Keep the daemon on 127.0.0.1 and do not expose port 43121 publicly. Each supported chat DOM is third-party UI and can change; `extension/src/content.ts` isolates the adapter logic.

## Known limitation
Auto-submit is DOM-based. If a supported chat changes its composer/send-button implementation, tool execution still works but the adapter may need a selector/event update. Background job state survives a chat-tab refresh but remains in daemon memory, so restarting the daemon while a command is running loses that job.
