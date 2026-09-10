client.on('message', message => {
  if (message.content === '.test') {
    message.channel.send('hi!');
  }
});