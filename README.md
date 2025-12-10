# OpenCode Cursor Auth

An OpenAI-compatible proxy server that routes requests through Cursor's AI backend, enabling any OpenAI-compatible client (including OpenCode) to use Cursor's API with full tool calling support.

## Features

- **OpenAI API Compatible**: Drop-in replacement for OpenAI API endpoints
- **Full Tool Calling Support**: Complete support for function calling with bash, read, write, list, glob/grep
- **Model Access**: Access to all Cursor models (Claude, GPT-4, Gemini, etc.)
- **Streaming Support**: Real-time streaming responses via SSE
- **Authentication Plugin**: Reusable auth module for other projects

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) v1.3.2+
- A Cursor account with valid credentials

### Installation

```bash
# Clone the repository
git clone https://github.com/Yukaii/opencode-cursor-auth.git
cd opencode-cursor-auth

# Install dependencies
bun install
```

### Authentication

The server can authenticate via:

1. **Environment variable** (recommended for quick testing):
   ```bash
   export CURSOR_ACCESS_TOKEN="your_cursor_access_token"
   ```

2. **Credential file** (automatically used if logged in via Cursor CLI):
   - macOS: `~/.cursor/auth.json`
   - Linux: `~/.config/cursor/auth.json`
   - Windows: `%APPDATA%\Cursor\auth.json`

3. **Interactive login**:
   ```bash
   bun run demo:login
   ```

### Running the Server

```bash
# Start the OpenAI-compatible proxy server
bun run server

# Or with custom port
PORT=8080 bun run server
```

The server starts on `http://localhost:18741` by default.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions (streaming/non-streaming) |
| `/v1/models` | GET | List available models |
| `/v1/tool_results` | POST | Submit tool execution results |
| `/health` | GET | Health check |

## Usage Examples

### With curl

```bash
# Simple chat completion
curl http://localhost:18741/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "sonnet-4.5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# List available models
curl http://localhost:18741/v1/models
```

### With OpenAI SDK

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:18741/v1",
  apiKey: "not-needed", // Auth is handled by the server
});

const response = await client.chat.completions.create({
  model: "sonnet-4.5",
  messages: [{ role: "user", content: "Explain quantum computing" }],
  stream: true,
});

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

### With OpenCode

Add to your `opencode.json` configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cursor": {
      "name": "Cursor",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:18741/v1",
        "apiKey": "cursor-via-opencode"
      },
      "models": {
        "auto": {
          "name": "Auto",
          "temperature": true,
          "attachment": true
        },
        "claude-4.5-sonnet": {
          "name": "Claude 4.5 Sonnet",
          "temperature": true,
          "attachment": true
        },
        "claude-4.5-sonnet-thinking": {
          "name": "Claude 4.5 Sonnet (Thinking)",
          "temperature": true,
          "attachment": true,
          "reasoning": true
        },
        "claude-4.5-opus-high": {
          "name": "Claude 4.5 Opus",
          "temperature": true,
          "attachment": true
        },
        "claude-4.5-opus-high-thinking": {
          "name": "Claude 4.5 Opus (Thinking)",
          "temperature": true,
          "attachment": true,
          "reasoning": true
        },
        "claude-4-opus": {
          "name": "Claude 4.1 Opus",
          "temperature": true,
          "attachment": true
        },
        "gpt-4o": {
          "name": "GPT-4o",
          "temperature": true,
          "attachment": true
        },
        "gpt-5.1": {
          "name": "GPT-5.1",
          "temperature": true,
          "attachment": true
        },
        "gpt-5.1-high": {
          "name": "GPT-5.1 High",
          "temperature": true,
          "attachment": true
        },
        "gpt-5.1-codex": {
          "name": "GPT-5.1 Codex",
          "temperature": true,
          "attachment": true
        },
        "gpt-5.1-codex-high": {
          "name": "GPT-5.1 Codex High",
          "temperature": true,
          "attachment": true
        },
        "gpt-5.1-codex-max": {
          "name": "GPT-5.1 Codex Max",
          "temperature": true,
          "attachment": true
        },
        "gpt-5.1-codex-max-high": {
          "name": "GPT-5.1 Codex Max High",
          "temperature": true,
          "attachment": true
        },
        "gemini-3-pro": {
          "name": "Gemini 3 Pro",
          "temperature": true,
          "attachment": true
        },
        "grok-code-fast-1": {
          "name": "Grok",
          "temperature": true,
          "attachment": true
        },
        "composer-1": {
          "name": "Composer 1",
          "temperature": true,
          "attachment": true
        }
      }
    }
  }
}
```

#### Plugin Setup (Pre-NPM Publishing)

Before the package is published to npm, you need to manually set up the plugin for local development. Create a file at `.opencode/plugin/cursor-auth.ts` in your project:

```typescript
/**
 * OpenCode Cursor Auth Plugin - Local Development Wrapper
 *
 * This file re-exports the Cursor OAuth plugin for local testing with OpenCode.
 * OpenCode automatically discovers plugins in .opencode/plugin/*.ts
 *
 * Usage:
 *   1. Run `opencode` in this directory
 *   2. The plugin will be auto-loaded
 *   3. Configure a provider with id "cursor" to use this auth
 */

export { CursorOAuthPlugin } from "../../src/plugin/index.ts";
```

This allows OpenCode to discover and load the Cursor authentication plugin during local development.

## Tool Calling

The proxy supports full OpenAI-compatible tool calling. When tools are provided, Cursor's built-in tools are mapped to OpenAI function calls:

| Cursor Tool | OpenAI Function | Description |
|-------------|-----------------|-------------|
| `shell` | `bash` | Execute shell commands |
| `read` | `read` | Read file contents |
| `write` | `write` | Write/create files |
| `ls` | `list` | List directory contents |
| `grep` | `grep` / `glob` | Search file contents / patterns |
| `mcp` | Original name | MCP tool passthrough |

### Tool Flow

```
1. Client sends request with tools array
2. Server returns tool_calls in response
3. Client executes tools locally
4. Client sends new request with tool results
5. Server returns final response
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `18741` |
| `CURSOR_ACCESS_TOKEN` | Direct access token | - |
| `CURSOR_SESSION_REUSE` | Enable experimental session reuse | `0` |

### Available Models

Models are fetched dynamically from Cursor's API. Current models include:

**Claude (Anthropic)**
- `sonnet-4.5` - Claude 4.5 Sonnet
- `sonnet-4.5-thinking` - Claude 4.5 Sonnet (Thinking)
- `opus-4.5` - Claude 4.5 Opus
- `opus-4.5-thinking` - Claude 4.5 Opus (Thinking)
- `opus-4.1` - Claude 4.1 Opus

**GPT (OpenAI)**
- `gpt-5.1` - GPT-5.1
- `gpt-5.1-high` - GPT-5.1 High
- `gpt-5.1-codex` - GPT-5.1 Codex
- `gpt-5.1-codex-high` - GPT-5.1 Codex High
- `gpt-5.1-codex-max` - GPT-5.1 Codex Max
- `gpt-5.1-codex-max-high` - GPT-5.1 Codex Max High

**Other**
- `gemini-3-pro` - Gemini 3 Pro (Google)
- `grok` - Grok (xAI)
- `auto` - Auto-select best model
- `composer-1` - Cursor Composer

Use `/v1/models` to get the full list. Model availability may change.

## Architecture

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│   OpenAI    │────▶│  Proxy Server   │────▶│   Cursor    │
│   Client    │◀────│  (this project) │◀────│   API       │
└─────────────┘     └─────────────────┘     └─────────────┘

The proxy:
1. Accepts OpenAI-format requests
2. Translates to Cursor's Agent API (gRPC-Web)
3. Streams responses back as OpenAI SSE
4. Maps tool calls bidirectionally
```

## Project Structure

```
opencode-cursor-auth/
├── src/
│   ├── server.ts           # Main proxy server
│   ├── index.ts            # Plugin exports
│   ├── lib/
│   │   ├── api/
│   │   │   └── agent-service.ts  # Cursor Agent API client
│   │   ├── auth/               # Authentication helpers
│   │   ├── proto/              # Protobuf utilities
│   │   └── storage.ts          # Credential storage
│   └── plugin/
│       └── plugin.ts           # OpenCode plugin implementation
├── docs/                       # Documentation
├── scripts/                    # Utility scripts
└── cursor-agent-restored-source-code/  # Reference implementation
```

## Documentation

- [Authentication Flow](docs/AUTH.md) - Detailed auth documentation
- [Cursor API Reference](docs/CURSOR_API.md) - Cursor's API protocol
- [Architecture Comparison](docs/ARCHITECTURE_COMPARISON.md) - OpenAI vs Cursor differences
- [Tool Calling Investigation](docs/TOOL_CALLING_INVESTIGATION.md) - Tool implementation details
- [Future Work](docs/FUTURE_WORK.md) - Planned improvements

## Known Limitations

1. **Session Reuse**: Session reuse via BidiAppend is disabled by default due to KV blob storage issues. Each request creates a fresh session.

2. **Non-streaming Tool Results**: Tool results must be sent in a new request (not the same stream).

3. **Usage Metrics**: Token usage is estimated, not exact.

## Development

```bash
# Run tests
bun test

# Run with debug logging
DEBUG=1 bun run server

# Run demo scripts
bun run demo:status    # Check auth status
bun run demo:login     # Interactive login
bun run demo:logout    # Clear credentials
```

## Troubleshooting

### "No access token found"
Run `bun run demo:login` to authenticate, or set `CURSOR_ACCESS_TOKEN` environment variable.

### Tool calls not working
Ensure you're including the `tools` array in your request. The proxy only emits tool calls when tools are provided.

### Stream hangs after tool execution
This is expected behavior when session reuse is enabled. Disable with `CURSOR_SESSION_REUSE=0` (default).

## License

MIT

## Acknowledgments

- Built by reverse-engineering Cursor CLI's communication protocol
- Uses [Bun](https://bun.sh) for fast TypeScript execution
- Protocol buffers handled via [@bufbuild/protobuf](https://github.com/bufbuild/protobuf-es)
