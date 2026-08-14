# Shell tool calls with quoted commands repeatedly fail JSON parsing

## Status

Open

## Summary

DeepSeek frequently emits `run_command` calls whose command contains unescaped double quotes. The extension rejects the entire tool call before it reaches the daemon, making ordinary commands such as `python -c "print('hello world')"` appear unsupported.

## Captured failure

```xml
<tool_call>
{"name":"run_command","arguments":{"command":"python -c "print('hello world')""}}
</tool_call>
```

```json
{
  "tool": "run_command",
  "tool_call_id": "call_2bf5eca6-9c2e-4942-b307-d393e59af0d3",
  "success": false,
  "phase": "parse",
  "error": "Found <tool_call> markup but could not parse its JSON: Expected ',' or '}' after property value in JSON at position 57 (line 1 column 58)",
  "retryable": true,
  "instruction": "Retry with exactly one tool call containing valid JSON."
}
```

## Important distinction

The captured payload is invalid JSON. The quotes surrounding `print('hello world')` terminate the `command` string because they are not escaped. Parentheses and single quotes are not the parser problem.

The valid strict-JSON form is:

```xml
<tool_call>
{"name":"run_command","arguments":{"command":"python -c \"print('hello world')\""}}
</tool_call>
```

This issue is therefore both a provider-protocol reliability problem and a parser recovery/feedback gap. The parser must continue accepting valid escaped commands and may recover malformed provider output only when the intended boundaries are deterministic.

## Reproduction

1. Ask DeepSeek to execute `python -c "print('hello world')"` through `run_command`.
2. Let DeepSeek emit the captured unescaped payload.
3. Observe a parse-phase failure before `/tool` can execute the command.
4. Retry with the valid escaped payload and verify whether it parses and executes.

## Expected behavior

- Properly escaped JSON commands containing double quotes, single quotes, parentheses, backslashes, and spaces parse without alteration.
- Protocol reinforcement gives DeepSeek a concrete quoted-shell example on every relevant message.
- A deterministic repair path can recover common unescaped command quotes without changing the command's meaning.
- Ambiguous malformed input is never executed.
- Parse failures return the malformed location plus a corrected `run_command` example, rather than only a generic retry instruction.

## Acceptance criteria

- A regression test executes the valid `python -c \"print('hello world')\"` tool call successfully.
- Regression tests cover PowerShell quoting, Windows paths, nested JSON, backslashes, and commands containing parentheses.
- Deterministically recoverable malformed commands are repaired and marked as repaired in diagnostics.
- Ambiguous malformed commands fail safely and include an immediately usable corrected example.
- Realtime stream parsing and DOM parsing produce the same result for identical tool-call text.
