export const cursorSettingSources = ["project", "user", "plugins"] as const;

export type CursorSettingSource = (typeof cursorSettingSources)[number];

const allowed = new Set<string>(cursorSettingSources);

export function settingSourcesOf(raw: string | null | undefined): { settingSources?: CursorSettingSource[] } {
  const settingSources = parseCursorSettingSources(raw);
  return settingSources.length ? { settingSources } : {};
}

export function parseCursorSettingSources(raw: string | null | undefined): CursorSettingSource[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const list: CursorSettingSource[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (!allowed.has(value) || seen.has(value)) continue;
    seen.add(value);
    list.push(value as CursorSettingSource);
  }
  return list;
}

export function formatCursorSettingSources(
  values: unknown,
): { ok: true; stored: string; list: CursorSettingSource[] } | { ok: false; message: string } {
  if (!Array.isArray(values) || values.some((item) => typeof item !== "string")) {
    return { ok: false, message: "配置层格式不对" };
  }
  if (values.some((item) => !allowed.has(item))) {
    return { ok: false, message: "配置层只能是 project、user、plugins" };
  }
  const list = cursorSettingSources.filter((item) => values.includes(item));
  return { ok: true, stored: list.join(","), list: [...list] };
}
