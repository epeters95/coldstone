import dotenv from 'dotenv';
import ollama from 'ollama';
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
const MAX_WEB_RESULTS = 5;
const DISCORD_MAX_MESSAGE_CHARS = 2000;
const MAX_REPLY_TOKENS = 350;
const MAX_HISTORY_MESSAGES = 5;
const SERP_API_KEY = process.env.SERP_API_KEY;

const userMessageHistory = Object.create(null);

const SEARCH_KEYWORDS = ["search online","online search","search web","search the web","look up","find online","web search","google","news"];

const SYSTEM_PROMPT = `
# Tool Instructions
- You are a helpful, humorous personal assistant for conversation.
- The user might want recent information from the internet. If the user specifies they want a search by including a term in SEARCH_KEYWORDS, then use the function getWebSearchContext to get the internet search results for what the user wants.
- SEARCH_KEYWORDS: ${JSON.stringify(SEARCH_KEYWORDS)}
- When using 'getWebSearchContext', determine the query parameter to search with by summarizing the user's request in the context of the conversation.
- IF there are no search keywords, DO NOT CALL A FUNCTION.

You have access to the following function:

- Name: getWebSearchContext(query)
- Description: Performs a web search for a single query and returns relevant results
- Parameters: Query (type: string, description: the search query string, required: true)


If you choose to call a function ONLY reply in the following format:
<function=getWebSearchContext>query</function>

where
query => The search terms

Reminder:
- Only use a function call if the user specified search keywords, otherwise DO NOT USE getWebSearchContext!
- Function calls MUST be on one line, follow the specified format, and contain nothing else in the response.
- When a function call isn't needed, don't mention it at all.`;

const TRUNCATION_SUFFIX = '\n\n[Response truncated]';

function stripBotMention(text) {
    return text.replace(/<@!?&?\d+>/g, '').trim();
}

function addMessageToHistory(userId, message) {
    if (typeof userMessageHistory[userId] === 'undefined') {
        userMessageHistory[userId] = [];
    }

    if (userMessageHistory[userId].length >= MAX_HISTORY_MESSAGES) {
        userMessageHistory[userId].shift();
    }

    userMessageHistory[userId].push(message);
}


function sanitizeHistoryForModel(messages) {
    const pattern = new RegExp(
        SEARCH_KEYWORDS.map(kw => kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
        'gi'
    );
    return messages.map(msg => ({
        ...msg,
        content: msg.content.replace(pattern, '(retrieval phrase)'),
    }));
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
    const organicResults = Array.isArray(searchResponse?.organic_results)
        ? searchResponse.organic_results.slice(0, Math.min(Math.max(MAX_WEB_RESULTS, 1), 10))
        : [];

    if (!organicResults.length) {
        if (!searchResponse?.results?.length) {
            return null;
        }
    }

    const formatted = organicResults.map((result, index) => {
        const snippet = (result?.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 500);
        return [
            `${index + 1}. ${result?.title || 'Untitled'}`,
            `URL: ${result?.link || 'N/A'}`,
            `Snippet: ${snippet || 'No snippet available.'}`,
        ].join('\n');
    }).join('\n\n');

    console.log(`Collected search results: ${formatted}`);
    return [
        `When answering, use the web search results below from today (${new Date().toDateString()}). This current information takes priority over your existing knowledge.`,
        '',
        'WEB SEARCH RESULTS',
        formatted,
    ].join('\n');
}

async function getWebSearchContext(query) {
    if (!SERP_API_KEY) {
        return {
            warning: 'Web search requested, but SERPAPI_API_KEY is not set. Replying without web search.',
            context: null,
        };
    }

    if (!query) {
        return {
            warning: 'Web search requested, but query is empty. Replying without web search.',
            context: null,
        };
    }

    const maxResults = Math.min(Math.max(MAX_WEB_RESULTS, 1), 10);
    const searchUrl = new URL('https://serpapi.com/search');
    searchUrl.searchParams.set('engine', 'google');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('num', String(maxResults));
    searchUrl.searchParams.set('api_key', SERP_API_KEY);

    const response = await fetch(searchUrl.toString());
    if (!response.ok) {
        throw new Error(`SerpAPI request failed with ${response.status}`);
    }

    const searchResponse = await response.json();
    const context = formatWebSearchContext(searchResponse);
    if (!context) {
        return {
            warning: 'Web search returned no results. Replying without web search.',
            context: null,
        };
    }

    return {
        warning: null,
        context: context,
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

    addMessageToHistory(userId, {
        role: 'user',
        content: userMsgText,
    });

    try {
        let webSearchWarning = null;
        let webSearchContext = null;
        
        // First chat generation (response or function call)

        userMsg.channel.sendTyping()

        const initialReply = await ollama.chat({
            model: LOCAL_CHAT_MODEL,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                ...sanitizeHistoryForModel(userMessageHistory[userId]),
            ],
            options: {
                num_predict: MAX_REPLY_TOKENS,
            },
        });

        let replyText = String(initialReply.message?.content ?? '');

        // Handle function call

        if (replyText.trimStart().startsWith('<function=')) {

            userMsg.react('🔍');

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
                    ...(userMessageHistory[userId]
                        .slice(1, userMessageHistory[userId].length)),
                ]
                : userMessageHistory[userId];

            // Generate response from search results

            userMsg.channel.sendTyping()

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

        addMessageToHistory(userId, {
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
