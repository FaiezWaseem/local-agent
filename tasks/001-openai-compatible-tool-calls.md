# OpenAI-compatible tool calls are not supported by `/v1/chat/completions`

## Status

Completed

## Resolution

- Added validation and bridge forwarding for function `tools`, `tool_choice`, `parallel_tool_calls`, assistant `tool_calls`, and `role: "tool"` messages.
- Added a schema-aware provider prompt that requires literal local envelopes instead of provider-native tools.
- Added non-streaming `message.tool_calls` and streaming `delta.tool_calls` normalization with stable call IDs and `finish_reason: "tool_calls"`.
- Added safe handling for required, forced, automatic, and disabled tool choices.
- Added integration coverage for tool-result continuation and browser regression coverage for arbitrary client function names.

## Summary

Text completions worked through `/v1/chat/completions`, but OpenAI-compatible tool calling did not. Requests from OpenCode could include tool definitions, yet DeepSeek responded with normal prose instead of returning `message.tool_calls` or emitting a local `<tool_call>` for the extension.

## Original behavior

- The completion request schema allows unknown fields, but the bridge forwards only `model`, `messages`, and `stream` to the extension.
- `tools` and `tool_choice` are not represented in the extension bridge request.
- Non-streaming responses always return `message: {role: "assistant", content}`.
- Streaming responses emit only `delta.content`.
- `finish_reason` is not normalized to `tool_calls` when DeepSeek emits a local tool request.
- OpenCode therefore receives prose such as a request for more review details instead of a callable file tool.

## Reproduction

1. Connect a DeepSeek browser tab to the daemon.
2. Configure OpenCode with the local OpenAI-compatible base URL and `deepseek-web` model.
3. Ask OpenCode to review the files in a project.
4. Observe that `/v1/chat/completions` succeeds, but the response contains text rather than an OpenAI tool call.

The captured OpenCode conversation ended as follows:

```text
USER: reveiw this project
ASSISTANT: I'll review the project structure. Let me start by exploring the codebase.
USER: ?
ASSISTANT: What would you like me to focus on in the review?
USER: yes revewi the files
```

The request also contains OpenCode's system instructions and available tool context, but DeepSeek does not invoke a tool.

## Expected behavior

- Accept OpenAI `tools` and `tool_choice` fields without dropping them.
- Preserve `role: "tool"`, `tool_call_id`, assistant `tool_calls`, and related conversation fields.
- Instruct DeepSeek to select from the supplied OpenAI tools while still using the local text protocol internally.
- Convert a detected local `<tool_call>` into an OpenAI-compatible response:

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_...",
        "type": "function",
        "function": {
          "name": "list_directory",
          "arguments": "{\"path\":\".\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

- For streaming requests, emit `delta.tool_calls` chunks followed by `finish_reason: "tool_calls"`.

## Acceptance criteria

- An OpenCode project-review request produces a `list_directory` or equivalent supplied tool call instead of prose.
- Non-streaming and streaming responses follow the OpenAI tool-call shape.
- Multiple calls in a conversation retain stable, unique `tool_call_id` values.
- Tool-result messages can be sent back through `/v1/chat/completions` and DeepSeek continues the original task.
- Integration tests cover `tools`, forced and automatic `tool_choice`, streamed tool-call arguments, and tool-result continuation.
