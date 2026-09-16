export const SUPPORTED_DATE_TOKENS = ['YYYY', 'YY', 'MM', 'DD', 'HH', 'mm', 'ss'] as const;

export type DatePatternToken = typeof SUPPORTED_DATE_TOKENS[number];

const TOKEN_PATTERN = /YYYY|YY|MM|DD|HH|mm|ss/g;
const TOKEN_DIGITS: Record<DatePatternToken, string> = {
	YYYY: '\\d{4}',
	YY: '\\d{2}',
	MM: '\\d{2}',
	DD: '\\d{2}',
	HH: '\\d{2}',
	mm: '\\d{2}',
	ss: '\\d{2}',
};

/** True when the supported pattern already carries a time component. */
export function hasTimeTokens(pattern: string): boolean {
	return /HH|mm|ss/.test(pattern);
}

/** Render the supported date tokens. Date-only collision names receive a stable time suffix. */
export function formatDatePattern(date: Date, pattern: string, includeCollisionTime = false): string {
	const normalized = pattern.trim();
	if (!normalized || !Number.isFinite(date.getTime())) return '';
	const rendered = replaceTokens(normalized, date);
	if (!includeCollisionTime || hasTimeTokens(normalized)) return rendered;
	return `${rendered}_at_${replaceTokens('HH-mm', date)}`;
}

/** Find the first valid date matching the pattern anywhere in a filename. */
export function matchDatePatternInFilename(filename: string, pattern: string): number | null {
	const compiled = compilePattern(pattern.trim());
	if (!compiled) return null;
	for (const match of filename.matchAll(compiled.expression)) {
		const timestamp = timestampFromMatch(match, compiled.tokens);
		if (timestamp !== null) return timestamp;
	}
	return null;
}

function replaceTokens(pattern: string, date: Date): string {
	const values: Record<DatePatternToken, string> = {
		YYYY: String(date.getFullYear()),
		YY: String(date.getFullYear()).slice(-2),
		MM: String(date.getMonth() + 1).padStart(2, '0'),
		DD: String(date.getDate()).padStart(2, '0'),
		HH: String(date.getHours()).padStart(2, '0'),
		mm: String(date.getMinutes()).padStart(2, '0'),
		ss: String(date.getSeconds()).padStart(2, '0'),
	};
	return pattern.replace(TOKEN_PATTERN, token => values[token as DatePatternToken]);
}

function compilePattern(pattern: string): { expression: RegExp; tokens: DatePatternToken[] } | null {
	if (!pattern) return null;
	const matches = [...pattern.matchAll(TOKEN_PATTERN)];
	if (!matches.length) return null;
	const tokens: DatePatternToken[] = [];
	let source = '';
	let cursor = 0;
	for (const match of matches) {
		const index = match.index ?? 0;
		source += escapeRegExp(pattern.slice(cursor, index));
		const token = match[0] as DatePatternToken;
		tokens.push(token);
		source += `(${TOKEN_DIGITS[token]})`;
		cursor = index + token.length;
	}
	source += escapeRegExp(pattern.slice(cursor));
	if ((matches[0]?.index ?? -1) === 0) source = `(?:^|[^0-9])${source}`;
	const last = matches[matches.length - 1]!;
	if ((last.index ?? 0) + last[0].length === pattern.length) source += '(?=$|[^0-9])';
	return { expression: new RegExp(source, 'g'), tokens };
}

function timestampFromMatch(match: RegExpMatchArray, tokens: DatePatternToken[]): number | null {
	const captured = new Map<DatePatternToken, number>();
	for (const [index, token] of tokens.entries()) {
		const value = Number(match[index + 1]);
		const previous = captured.get(token);
		if (previous !== undefined && previous !== value) return null;
		captured.set(token, value);
	}
	const fullYear = captured.get('YYYY');
	const shortYear = captured.get('YY');
	if (fullYear !== undefined && shortYear !== undefined && fullYear % 100 !== shortYear) return null;
	const year = fullYear ?? (shortYear !== undefined ? 2000 + shortYear : 2000);
	const month = captured.get('MM') ?? 1;
	const day = captured.get('DD') ?? 1;
	const hour = captured.get('HH') ?? 0;
	const minute = captured.get('mm') ?? 0;
	const second = captured.get('ss') ?? 0;
	if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;

	const date = new Date(0);
	date.setFullYear(year, month - 1, day);
	date.setHours(hour, minute, second, 0);
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
		|| date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
	return date.getTime();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
