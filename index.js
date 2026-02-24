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

client.once(Events.ClientReady, (readyClient) => {
    console.log(`Ready! Logging in as ${readyClient.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

client.on("messageCreate", async (message) => {

    if (message.author.bot) return;

    if (!message.mentions.has(client.user)) return;

    console.log(`Received message: ${message.content}`);

    // Generate reply

    message.content = message.content.replace(/@\d+/g, "");

    let reply = await ollama.chat({
        model: "llama3.2",
        messages: [{role: "user", content: message.content }]
    });

    console.log(`Generated reply: ${reply.message.content}`);
    
    message.reply(reply.message.content);
});