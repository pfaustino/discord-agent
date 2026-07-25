import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const COMMANDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'commands');

/** Load every command module in src/commands/. Each must export
 * {data: SlashCommandBuilder, execute: (interaction) => Promise<void>}.
 * Adding a new command later is just: drop a new file in that folder. */
export async function loadCommands() {
  const commands = new Map();
  for (const file of readdirSync(COMMANDS_DIR)) {
    if (!file.endsWith('.js')) continue;
    const mod = await import(path.join(COMMANDS_DIR, file));
    if (!mod.data || !mod.execute) {
      console.warn(`[commands] skipping ${file}: missing data/execute export`);
      continue;
    }
    commands.set(mod.data.name, mod);
  }
  return commands;
}
