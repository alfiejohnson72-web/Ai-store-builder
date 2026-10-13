// Timestamped console logging, shared by every part of the bot.
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

module.exports = { log };
