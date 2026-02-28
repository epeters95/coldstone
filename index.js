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

// llama 16k context has about 5 minute reply
const LOCAL_CHAT_MODEL = 'llama3.2-10k'; // 'llama16k';

const CHAT_HISTORY_PATH = 'chat_history.json';
const MAX_WEB_RESULTS = 3;
const DISCORD_MAX_MESSAGE_CHARS = 2000;
const MAX_REPLY_TOKENS = 350;

const userMessageHistory = Object.create(null);

const SYSTEM_PROMPT = `
# Tool Instructions
- You are a helpful, humorous personal assistant for conversation.
- The user might want recent information from the internet. If the user specifies they want a search by including a term in SEARCH_KEYWORDS, then use the function getWebSearchContext to get the internet search results for what the user wants.
- SEARCH_KEYWORDS: ["search online","online search","search web","search the web","look up","find online","web search","google","news"]
- When using 'getWebSearchContext', determine the query parameter to search with by summarizing the user's request in the context of the conversation.
- IF there are no search keywords, DO NOT CALL A FUNCTION.

You have access to the following functions:

getWebSearchContext(query)
- Description: Performs a web search for a single query and returns relevant results
- Parameters: Query (type: string, description: the search query string, required: true)


If a you choose to call a function ONLY reply in one of the following formats:
<function=getWebSearchContext>query</function>

where
query => String of the search terms

Reminder:
- When user is asking for a question that requires your reasoning, DO NOT USE a function call.
- When the user didn't specify search keywords, DO NOT USE getWebSearchContext!
- Function calls MUST be on one line, follow the specified format, and contain nothing else in the response.
- When a function call isn't needed, don't mention it at all.`;

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
        return {
            warning: `Function "${functionName}" returned empty results.`,
            context: null,
        };
    }
    
    const formatted = searchResponse.results.map((result, index) => {
        if (result !== undefined) {
            
            const snippet = (result.content || '').replace(/\s+/g, ' ').trim().slice(0, 500);
            return [
                `${index + 1}. ${result.title || 'Untitled'}`,
                `URL: ${result.url || 'N/A'}`,
                `Snippet: ${snippet || 'No snippet available.'}`,
            ].join('\n');
        }
    }).join('\n\n');

    console.log(`Collected search results: ${formatted}`);

    const today = new Date().toISOString().slice(0, 10);
    return [
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

    console.log("Extracting function text from " + responseText);
    const trimmed = String(responseText ?? '').trim();
    const match = trimmed.match(/^<function=([A-Za-z_][A-Za-z0-9_]*)>/);
    if (!match) {
        return {
            warning: 'Function call format was invalid, so I replied without search results.',
            context: null,
        }; 
    }

    const functionName = match[1];
    let argsText = trimmed.slice(match[0].length).trim();
    argsText = argsText.replace(/<\/function>\s*$/i, '').trim();

    const functionMap = {
        getWebSearchContext: getWebSearchContext
    };

    if (!Object.keys(functionMap).includes(functionName) || !argsText) {
        return {
            warning: 'Function call format was invalid, so I replied without search results.',
            context: null,
        };
    }

    try {

        console.log(`Calling Function "${functionName}" with arguments "${argsText}"`);

        const result = await functionMap[functionName](argsText)
        return result;
    
    } catch (error) {

        console.error(`Function "${functionName}" failed:`, error);
        return {
            warning: `Function "${functionName}" failed, so I replied without search results.`,
            context: null,
        };
    }
}

client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logging in as ${readyClient.user.tag}`);

    // Load chat history
    try {
        
        Object.assign(userMessageHistory, JSON.parse(fs.readFileSync(CHAT_HISTORY_PATH, 'utf8')))
        
    } catch (error) {
        
        console.error('Error loading history file ' + CHAT_HISTORY_PATH)

    }
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
        
        console.log(`Using chat history: ${JSON.stringify(userMessageHistory)}`);
        
        // First chat generation (response or function call)

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

        // Handle function call

        if (replyText.trimStart().startsWith('<function=')) {

            // Collect search results
            const functionResult = await extractDetailsAndCallFunction(
                replyText
            );
            if (functionResult) {
                webSearchWarning = functionResult.warning;
                webSearchContext = functionResult.context;
            }
            const finalMessages = webSearchContext
                ? [
                    { role: 'system', content: webSearchContext },
                    ...userMessageHistory[userId],
                ]
                : userMessageHistory[userId];

            // Generate response from search results

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

        // Send response in discord chat

        replyText = limitForDiscord(replyText);
        console.log(`Generated reply: ${replyText}`);

        await userMsg.reply(replyText);

        userMessageHistory[userId].push({
            role: 'assistant',
            content: replyText,
        });

        // Save messages to chat history file

        await fs.promises.writeFile(
            CHAT_HISTORY_PATH,
            JSON.stringify(userMessageHistory, null, 4),
            'utf8',
        );
    } catch (error) {
        console.error('Failed to generate message:', error);
    }
});
