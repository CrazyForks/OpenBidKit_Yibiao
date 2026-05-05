export const safeJsonParse = <T,>(raw: string | null): T | null => {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const extractJsonContent = (content: string): string => {
  const normalized = content.trim();
  if (!normalized.startsWith('```')) {
    return normalized;
  }

  const lines = normalized.split(/\r?\n/);
  const firstLine = lines[0]?.trim().toLowerCase();
  const lastLine = lines[lines.length - 1]?.trim();

  if ((firstLine === '```' || firstLine === '```json') && lastLine?.startsWith('```')) {
    return lines.slice(1, -1).join('\n').trim();
  }

  return normalized;
};
