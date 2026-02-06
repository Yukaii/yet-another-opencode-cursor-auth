# OpenCode Cursor Auth

[![npm stable version](https://img.shields.io/npm/v/yet-another-opencode-cursor-auth?label=npm%20stable)](https://www.npmjs.com/package/yet-another-opencode-cursor-auth)
[![npm prerelease version](https://img.shields.io/npm/v/yet-another-opencode-cursor-auth/dev?label=npm%20prerelease%20(dev))](https://www.npmjs.com/package/yet-another-opencode-cursor-auth?activeTab=versions)

> **💡 Alternative Available**
>
> Check out [opencode-cursor-auth](https://github.com/POSO-PocketSolutions/opencode-cursor-auth) by POSO-PocketSolutions - another implementation you may want to consider.

> **⚠️ Experimental Project - Use at Your Own Risk**
>
> This is a highly experimental project with limited support. It integrates with Cursor services via an unofficial interface, which means:
>
> - **It may break at any time** without notice if Cursor changes their services
> - **No guarantees** of stability, compatibility, or continued functionality
> - **"It Works On My Machine™"** - your mileage may vary
> - **Not affiliated with or endorsed by Cursor** - this is an unofficial community project
>
> If it stops working, feel free to open an issue, but fixes depend on community contributions and ongoing compatibility work.

> **⚖️ Legal Disclaimer**
>
> This project may violate [Cursor's Terms of Service](https://www.cursor.com/terms-of-service).
>
> **Potential consequences include:**
> - Your Cursor account being suspended or terminated
> - Loss of access to Cursor services
>
> **By using this project, you acknowledge these risks and accept full responsibility.** This project is provided for educational and research purposes. The authors are not responsible for any consequences of using this software.

An OpenCode plugin that enables using Cursor's AI backend with OpenCode, featuring OAuth authentication, dynamic model discovery, and full tool calling support.

## Features

- **OpenCode Plugin**: Native integration with OpenCode via OAuth authentication
- **Full Tool Calling Support**: Complete support for function calling with bash, read, write, list, glob/grep
- **Dynamic Model Discovery**: Automatically fetches available models from Cursor's API
- **Streaming Support**: Real-time streaming responses via SSE

## NPM Release Channels

- **Stable (`latest`)**: Published when a GitHub Release is published.
- **Prerelease (`dev`)**: Auto-published on every push to `main` via the npm publish workflow.

Install the channel you want:

```bash
# Stable release
npm install yet-another-opencode-cursor-auth@latest

# Auto-published prerelease from main
npm install yet-another-opencode-cursor-auth@dev
```

If you want npm to always pull prerelease updates in your project, keep the dependency pinned to `@dev`.

## Quick Start with OpenCode

### 1. Configure OpenCode

Add the plugin and Cursor provider to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "yet-another-opencode-cursor-auth@latest"
  ],
  "provider": {
    "cursor": {
      "name": "Cursor"
    }
  }
}
```

You can pin a specific plugin channel/version using:

- Stable: `"yet-another-opencode-cursor-auth@latest"`
- Prerelease channel: `"yet-another-opencode-cursor-auth@dev"`
- Exact version: `"yet-another-opencode-cursor-auth@0.1.1"`

### 2. Authenticate

Run OpenCode and authenticate:

```bash
opencode auth login
```

Then:
1. Select **"other"** from the provider list
2. Type **"cursor"** as the provider name
3. Select **"OAuth with Cursor"**
4. Complete the browser-based OAuth flow

That's it! The plugin will:
- Handle OAuth authentication with Cursor
- Automatically discover and register all available models
- Provide a custom fetch handler (no proxy server needed)

## Available Models

Models are fetched dynamically from Cursor's API. Common models include:

- `auto` - Auto-select best model
- `sonnet-4.5` - Claude 4.5 Sonnet
- `sonnet-4.5-thinking` - Claude 4.5 Sonnet (Thinking)
- `opus-4.5` - Claude 4.5 Opus
- `gpt-5.1` - GPT 5.1
- `gemini-3-pro` - Gemini 3 Pro

Use the OpenCode model picker to see all available models.

## Tool Calling

The plugin supports full OpenAI-compatible tool calling. Cursor's built-in tools are mapped to OpenAI function calls:

| Cursor Tool | OpenAI Function | Description |
|-------------|-----------------|-------------|
| `shell` | `bash` | Execute shell commands |
| `read` | `read` | Read file contents |
| `write` | `write` | Write/create files |
| `ls` | `list` | List directory contents |
| `grep` | `grep` / `glob` | Search file contents / patterns |
| `mcp` | Original name | MCP tool passthrough |

## Architecture

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────┐
│   OpenCode  │────▶│  Plugin Fetch   │────▶│   Cursor    │
│             │◀────│  (no server)    │◀────│   API       │
└─────────────┘     └─────────────────┘     └─────────────┘
```

The plugin intercepts OpenCode's API requests and routes them directly to Cursor's Agent API via a custom fetch handler - no proxy server required.

---

## Development: Standalone Proxy Server

> **Note**: The standalone proxy server is primarily a development artifact used for testing and debugging. Most users should use the OpenCode plugin above.

For development, testing, or use with other OpenAI-compatible clients, a standalone proxy server is included.

### Prerequisites

- [Bun](https://bun.sh) v1.3.2+
- A Cursor account with valid credentials

### Running the Server

```bash
# Clone and install
git clone https://github.com/Yukaii/yet-another-opencode-cursor-auth.git
cd yet-another-opencode-cursor-auth
bun install

# Authenticate first
bun run demo:login

# Start the server
bun run server

# Or with custom port
PORT=8080 bun run server
```

The server starts on `http://localhost:18741` by default.

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completions (streaming/non-streaming) |
| `/v1/models` | GET | List available models |
| `/health` | GET | Health check |

### Usage Examples

#### With curl

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

#### With OpenAI SDK

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

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `18741` |
| `CURSOR_ACCESS_TOKEN` | Direct access token | - |
| `CURSOR_DEBUG` | Enable debug logging | `0` |
| `CURSOR_SESSION_REUSE` | Session reuse for tool calls | `1` (enabled) |

---

## Project Structure

```
yet-another-opencode-cursor-auth/
├── src/
│   ├── server.ts              # Standalone proxy server (dev artifact)
│   ├── index.ts               # Plugin exports
│   ├── lib/
│   │   ├── api/
│   │   │   ├── agent-service.ts   # Cursor Agent API client
│   │   │   └── cursor-models.ts   # Model discovery
│   │   ├── auth/                  # Authentication helpers
│   │   ├── openai-compat/         # Shared OpenAI compatibility layer
│   │   └── storage.ts             # Credential storage
│   └── plugin/
│       └── plugin.ts              # OpenCode plugin implementation
├── docs/                          # Documentation
└── scripts/                       # Utility scripts
```

## Documentation

- [Authentication Flow](docs/AUTH.md) - Detailed auth documentation
- [Cursor API Reference](docs/CURSOR_API.md) - Cursor's API protocol
- [OpenCode Plugin](docs/OPENCODE_PLUGIN.md) - Plugin implementation details

## Known Limitations

1. **Usage Metrics**: Token usage is estimated, not exact.
2. **Session Reuse**: Enabled by default. Set `CURSOR_SESSION_REUSE=0` to disable if you encounter issues.

## Development

```bash
# Run tests
bun test

# Run server with debug logging
CURSOR_DEBUG=1 bun run server

# Run demo scripts
bun run demo:status    # Check auth status
bun run demo:login     # Interactive login
bun run demo:logout    # Clear credentials
```

### Build artifacts

This repo intentionally does not commit build output under `dist/`.

```bash
mkdir -p dist
bun build src/index.ts --outfile dist/index.js
bun build src/plugin/index.ts --outfile dist/plugin.js
```

## Troubleshooting

### "No access token found"
Run `bun run demo:login` to authenticate, or set `CURSOR_ACCESS_TOKEN` environment variable.

### Tool calls not working
Ensure you're including the `tools` array in your request. The proxy only emits tool calls when tools are provided.

### Debug logging
Set `CURSOR_DEBUG=1` to enable verbose logging for troubleshooting.

## License

MIT

## Acknowledgments

- Built by implementing an OpenCode plugin against Cursor services
- Uses [Bun](https://bun.sh) for fast TypeScript execution
- Protocol buffers handled via [@bufbuild/protobuf](https://github.com/bufbuild/protobuf-es)
