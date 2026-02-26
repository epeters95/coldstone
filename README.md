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
   - `OLLAMA_WEB_MAX_RESULTS=5` (optional)

## Web Search Behavior

- If a Discord message looks like a web-search request (`search`, `latest`, `news`, `today`, etc.), the bot calls Ollama's `webSearch` API and injects those results into the chat context before generating a reply.
- If `OLLAMA_API_KEY` is not set or web search fails, the bot falls back to a normal local reply and says so.
