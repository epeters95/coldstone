import dotenv from 'dotenv';
import ollama, { Ollama } from 'ollama';
import fs from 'node:fs';

dotenv.config();

import { Client, Events, GatewayIntentBits } from 'discord.js';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const userMessageHistory = Object.create(null);
const LOCAL_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL || 'llama3.2';
const MAX_WEB_RESULTS = Number(process.env.OLLAMA_WEB_MAX_RESULTS || 4);
const DISCORD_MAX_MESSAGE_CHARS = 2000;
const MAX_REPLY_TOKENS = 350;

const SYSTEM_PROMPT = `Cutting Knowledge Date: December 2023
Today Date: February 26 2026

# Tool Instructions
- You are a helpful personal assistant.
- When the user indicates an intent to search and includes any of the words ("search","look up","find online","web search","google","latest","current","today","news","recent", "up to date"), use the function 'getWebSearchContext' to get the internet search results for a provided search query.
- When using 'getWebSearchContext', determine the query parameter to search with by summarizing the user's request into relevant terms.

You have access to the following functions:

{
  "name": "getWebSearchContext",
  "description": "Performs a web search for a single query and returns relevant results.",
  "parameters": {
    "query": {
      "param_type": "string",
      "description": "the search query string",
      "required": true
    },
  }
}


If a you choose to call a function ONLY reply in the following format:
<{start_tag}={function_name}>{parameters}{end_tag}
where

start_tag => \`<function\`
parameters => a JSON dict with the function argument name as key and function argument value as value.
end_tag => \`</function>\`

Here is an example,
<function=example_function_name>{"example_name": "example_value"}</function>

Reminder:
- When user is asking for a question that requires your reasoning, DO NOT USE OR FORCE a function call
- Function calls MUST follow the specified format
- Required parameters MUST be specified
- Only call one function at a time
- Put the entire function call reply on one line
- When returning a function call, don't add anything else to your response`;

const TRUNCATION_SUFFIX = '\n\n[Response truncated]';

const cloudOllama = process.env.OLLAMA_API_KEY
    ? new Ollama({
        host: process.env.OLLAMA_CLOUD_HOST || 'https://ollama.com',
        headers: {
            Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
        },
    })
    : null;

function stripBotMention(text) {
    return text.replace(/<@!?\d+>/g, '').trim();
}


function limitForDiscord(text) {
    const normalized = String(text ?? '').trim();
    if (normalized.length <= DISCORD_MAX_MESSAGE_CHARS) {
        return normalized;
    }

    const headLimit = Math.max(DISCORD_MAX_MESSAGE_CHARS - TRUNCATION_SUFFIX.length, 1);
    return `${normalized.slice(0, headLimit).trimEnd()}${TRUNCATION_SUFFIX}`;
}

function formatWebSearchContext(searchResponse) {
    if (!searchResponse?.results?.length) {
        return null;
    }

    const formatted = searchResponse.results.map((result, index) => {
        const snippet = (result.content || '').replace(/\s+/g, ' ').trim().slice(0, 500);
        return [
            `${index + 1}. ${result.title || 'Untitled'}`,
            `URL: ${result.url || 'N/A'}`,
            `Snippet: ${snippet || 'No snippet available.'}`,
        ].join('\n');
    }).join('\n\n');

    const today = new Date().toISOString().slice(0, 10);
    return [
        `Current date: ${today}.`,
        'Use the web search results below when answering. Prefer recent facts and mention dates when relevant.',
        'If the results are insufficient, say so.',
        '',
        'WEB SEARCH RESULTS',
        formatted,
    ].join('\n');
}

async function getWebSearchContext(query) {
    if (!cloudOllama) {
        return {
            warning: 'Web search requested, but OLLAMA_API_KEY is not set. Replying without web search.',
            context: null,
        };
    }

    if (!query) {
        return {
            warning: 'Web search requested, but query is empty. Replying without web search.',
            context: null,
        };
    }

    const searchResponse = await cloudOllama.webSearch({
        query,
        max_results: Math.min(Math.max(MAX_WEB_RESULTS, 1), 10),
    });

    return {
        warning: null,
        context: formatWebSearchContext(searchResponse),
    };
}


async function extractDetailsAndCallFunction(responseText) {

    const trimmed = String(responseText ?? '').trim();
    const match = trimmed.match(/^<function=([A-Za-z_][A-Za-z0-9_]*)>/);
    if (!match) return null;

    const functionName = match[1];
    let argsText = trimmed.slice(match[0].length).trim();
    argsText = argsText.replace(/<\/function>\s*$/i, '').trim();

    const functionMap = {
        getWebSearchContext: {
            func: getWebSearchContext,
            param: "query" //TODO: expand to array
        }
    };

    if (!Object.keys(functionMap).includes(functionName) || !argsText) {
        return {
            warning: 'Function call format was invalid, so I replied without search results.',
            context: null,
        };
    }

    try {

        // Parse JSON (leaves extendable for multiple params)
        const parsedArgs = JSON.parse(argsText);
        
        console.log(`Calling Function "${functionName}" with arguments "${argsText}"`);

        // Lookup the params defined in functionMap and pass to function
        // Not the best way to do this (arg names not validated, only functionName)
        // TODO: find different approach
        result = await functionMap[functionName].func(parsedArgs[functionMap[functionName].param])
        return result;
    
    } catch (error) {

        if (!parsedArgs || typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) {
            console.error("Wrong argument types");
        }
        console.error(`Function "${functionName}" failed:`, error);
        return {
            warning: `Function "${functionName}" failed, so I replied without search results.`,
            context: null,
        };
    }
}

client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logging in as ${readyClient.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

client.on('messageCreate', async (userMsg) => {
    if (userMsg.author.bot) return;
    if (!userMsg.mentions.has(client.user)) return;

    console.log(`Received message: ${userMsg.content}`);

    const userId = userMsg.author.id;
    const userMsgText = stripBotMention(userMsg.content);
    if (!userMsgText) return;

    if (typeof userMessageHistory[userId] === 'undefined') {
        userMessageHistory[userId] = [];
    }

    userMessageHistory[userId].push({
        role: 'user',
        content: userMsgText,
    });

    try {
        let webSearchWarning = null;
        let webSearchContext = null;

        const initialReply = await ollama.chat({
            model: LOCAL_CHAT_MODEL,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                ...userMessageHistory[userId],
            ],
            options: {
                num_predict: MAX_REPLY_TOKENS,
            },
        });

        let replyText = String(initialReply.message?.content ?? '');

        if (replyText.trimStart().startsWith('<function=')) {
            const functionResult = await extractDetailsAndCallFunction(
                replyText
            );
            webSearchWarning = functionResult.warning;
            webSearchContext = functionResult.context;

            const finalMessages = webSearchContext
                ? [
                    { role: 'system', content: webSearchContext },
                    ...userMessageHistory[userId],
                ]
                : userMessageHistory[userId];

            const finalReply = await ollama.chat({
                model: LOCAL_CHAT_MODEL,
                messages: finalMessages,
                options: {
                    num_predict: MAX_REPLY_TOKENS,
                },
            });

            replyText = String(finalReply.message?.content ?? '');
        }

        if (webSearchWarning) {
            replyText = `${webSearchWarning}\n\n${replyText}`;
        }

        replyText = limitForDiscord(replyText);
        console.log(`Generated reply: ${replyText}`);

        await userMsg.reply(replyText);

        userMessageHistory[userId].push({
            role: 'assistant',
            content: replyText,
        });

        await fs.promises.writeFile(
            'chat_history.json',
            JSON.stringify(userMessageHistory, null, 4),
            'utf8',
        );
    } catch (error) {
        console.error('Failed to generate message:', error);
    }
});
