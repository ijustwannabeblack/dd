client.on('message', message => {
    if (message.content.startsWith('.up')) {
        const args = message.content.split(' ').slice(1);
        if (args.length > 0) {
            message.reply('Hi');
        }
    }
});