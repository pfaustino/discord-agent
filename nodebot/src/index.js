import { Client, Events, GatewayIntentBits } from 'discord.js';
import { DISCORD_TOKEN } from './config.js';
import { loadCommands } from './load-commands.js';

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required (see .env.example)');
  process.exit(1);
}

// Layer 1: just enough to connect and answer a slash command. More intents
// get added as later layers need them (message content, members, voice).
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = await loadCommands();

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} (${c.user.id}) — ${c.guilds.cache.size} guild(s)`);
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

process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err));

client.login(DISCORD_TOKEN);
