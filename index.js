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
const MAX_WEB_RESULTS = Number(process.env.OLLAMA_WEB_MAX_RESULTS || 5);
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

function shouldUseWebSearch(text) {
    const lower = text.toLowerCase();
    return (
        /\b(search|look up|find online|web search|google)\b/.test(lower) ||
        /\b(latest|current|today|news|recent|up[- ]to[- ]date)\b/.test(lower)
    );
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

    const searchResponse = await cloudOllama.webSearch({
        query,
        max_results: Math.min(Math.max(MAX_WEB_RESULTS, 1), 10),
    });

    return {
        warning: null,
        context: formatWebSearchContext(searchResponse),
    };
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
        const useWebSearch = shouldUseWebSearch(userMsgText);
        let webSearchWarning = null;
        let webSearchContext = null;

        if (useWebSearch) {
            try {
                const webSearchResult = await getWebSearchContext(userMsgText);
                webSearchWarning = webSearchResult.warning;
                webSearchContext = webSearchResult.context;
            } catch (error) {
                console.error('Web search failed:', error);
                webSearchWarning = 'Web search failed, so I replied without search results.';
            }
        }

        const messages = webSearchContext
            ? [
                { role: 'system', content: webSearchContext },
                ...userMessageHistory[userId],
            ]
            : userMessageHistory[userId];

        const reply = await ollama.chat({
            model: LOCAL_CHAT_MODEL,
            messages,
        });

        let replyText = reply.message.content;
        if (webSearchWarning) {
            replyText = `${webSearchWarning}\n\n${replyText}`;
        }

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
