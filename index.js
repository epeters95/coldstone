import dotenv from 'dotenv';
import ollama from 'ollama';

dotenv.config();

import { Client, Events, GatewayIntentBits } from 'discord.js';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const userMessageHistory = {};
// E.g.
//   { user1: [
//     {"role": "user", "content": input },
//     {"role": "assistant", "content": response }
//   ]}

client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logging in as ${readyClient.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

client.on("messageCreate", async (userMsg) => {

    // Skip generation if bot or not mentioned

    if (userMsg.author.bot) return;
    if (!userMsg.mentions.has(client.user)) return;

    console.log(`Received message: ${userMsg.content}`);

    // Generate reply

    userMsgText = userMsg.content.replace(/@\d+/g, "");

    try {
        let reply = await ollama.chat({
            model: "llama3.2",
            messages: [
                {
                    role: "user",
                    content: userMsgText
                }
            ]
        });

        console.log(`Generated reply: ${reply.message.content}`);
        
        // Send reply 
        userMsg.reply(reply.message.content);

        // Add to history
        if (typeof userMessageHistory[userMsg.author] === "undefined") {
            userMessageHistory[userMsg.author] = [];
        }
        userMessageHistory[userMsg.author].push({
            "role": "user",
            "content": userMsgText
        });
        userMessageHistory[userMsg.author].push({
            "role": "assistant",
            "content": reply.message.content
        });

    } catch (error) {
        console.error("Failed to generate message:", error);
    }
});