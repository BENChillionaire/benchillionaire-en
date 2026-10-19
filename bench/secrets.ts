/**
 * Reads a secret from the environment as `<ITEM>_<FIELD>`: the OpenRouter key is
 * `OPENROUTER_API_TOKEN`. Never printed or written anywhere.
 */
export async function loadSecret(itemTitle: string, fieldLabel: string): Promise<string> {
  const name = `${itemTitle}_${fieldLabel}`.toUpperCase();
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} (e.g. in a .env file, which Bun loads automatically).`);
  return value;
}
