import pool from "./db.js";

export async function getAllSettings(): Promise<Record<string, string>> {
  const result = await pool.query(`SELECT key, value FROM settings`);
  const settings: Record<string, string> = {};
  for (const row of result.rows) {
    settings[row.key as string] = row.value as string;
  }
  return settings;
}

export async function getSetting(key: string): Promise<string | null> {
  const result = await pool.query(
    `SELECT value FROM settings WHERE key = $1`,
    [key],
  );
  return result.rows.length > 0 ? (result.rows[0].value as string) : null;
}

export async function putSettings(
  entries: Record<string, string>,
): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [key, value],
    );
  }
  // Invalidate the cache so next read picks up new values
  cachedSettings = null;
}

// ---------------------------------------------------------------------------
// In-memory cache (invalidated on putSettings)
// ---------------------------------------------------------------------------

let cachedSettings: Record<string, string> | null = null;

export async function getCachedSettings(): Promise<Record<string, string>> {
  if (!cachedSettings) {
    cachedSettings = await getAllSettings();
  }
  return cachedSettings;
}
