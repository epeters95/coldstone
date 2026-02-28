# Coldstone

*Serving Sorbet*

## Setup

1. Install dependencies:
   `npm install`
2. Make sure your local Ollama server is running and has your chat model (default: `llama3.2`).
3. Create a `.env` file with:
   - `DISCORD_TOKEN=...`
   - `OLLAMA_API_KEY=...` (required for Ollama web search)
   - `OLLAMA_CHAT_MODEL=llama3.2` (optional)
   - `OLLAMA_WEB_MAX_RESULTS=4` (optional)

## Web Search Behavior

- The bot first does a normal local chat call.
- If the model response starts with `<function=...>`, the bot parses the function call and executes it through a function map (currently `getWebSearchContext`).
- After the function result is returned, the bot does a final local chat call with web-search context injected as a system message.
- If `OLLAMA_API_KEY` is not set or web search fails, the bot falls back to a normal local reply and says so.
