import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { DISCORD_TOKEN } from './config.js';
import { loadCommands } from './load-commands.js';
import { handleMessage } from './textChat.js';
import * as voice from './voice.js';

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required (see .env.example)');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});
client.commands = await loadCommands();

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} (${c.user.id}) — ${c.guilds.cache.size} guild(s)`);
  voice.init(c);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`command ${interaction.commandName} failed:`, err);
    const reply = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleMessage(client, message);
  } catch (err) {
    console.error('message handling failed:', err);
  }
});

client.on(Events.VoiceStateUpdate, voice.handleVoiceStateUpdate);

process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

client.login(DISCORD_TOKEN);
