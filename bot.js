const Discord = require('discord.js');
const client = new Discord.Client();

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

client.on('message', message => {
    if (message.content.startsWith('.up')) {
        const args = message.content.split(' ').slice(1);
        if (args.length > 0) {
            message.reply('Hi');
        }
    }
});

// Add your bot token here
client.login('YOUR_BOT_TOKEN');