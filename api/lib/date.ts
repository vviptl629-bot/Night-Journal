/**
 * `YYYY-MM-DD` 文本列的月份边界。
 *
 * entry_date / diary_date 都是 SQLite 的 TEXT 列，值为 `YYYY-MM-DD`。
 * 这种定长、零填充的格式下，字典序比较与日期先后比较是等价的，
 * 所以范围筛选可以直接用字符串 gte / lt，不必引入日期对象。
 *
 * 之所以不传 Date 给这些列：SQLite 驱动（node:sqlite / better-sqlite3）
 * 不接受 JS Date 作为绑定参数，传了会直接报错。
 */
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function monthRange(
  year: number,
  month: number,
): { start: string; end: string } {
  const start = `${year}-${pad(month)}-01`;

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const end = `${nextYear}-${pad(nextMonth)}-01`;

  return { start, end };
}

/** 取当天所在的 `YYYY-MM-DD`（本地时区），用于「今天」的默认日期。 */
export function todayKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
