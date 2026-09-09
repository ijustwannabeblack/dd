client.on('message', message => {
  if (message.content === '.up') {
    message.channel.send(`Hi! <@${message.author.id}>`);
  }
});