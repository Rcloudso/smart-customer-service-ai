const CATALOGUE_INTENT = /型号|款式|系列|清单|有哪些|有什么/u;

export function expandRetrievalQuery(query: string): string {
  const normalized = query.trim();
  if (!normalized) return normalized;
  const additions: string[] = [];
  if (/gpu/i.test(normalized) && !normalized.includes('显卡')) additions.push('显卡');
  if (normalized.includes('显卡') && !/gpu/i.test(normalized)) additions.push('GPU');
  if ((/gpu/i.test(normalized) || normalized.includes('显卡')) && CATALOGUE_INTENT.test(normalized)) {
    additions.push('型号', '清单', '产品');
  }
  return [...new Set([normalized, ...additions])].join(' ');
}
