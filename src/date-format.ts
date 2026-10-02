export interface ParsedFilenameDate {
	year: number;
	month: number;
	day: number;
	hour?: number;
	minute?: number;
	second?: number;
	start: number;
	end: number;
	text: string;
}

const MOMENT_TOKENS = [
	"YYYY",
	"YY",
	"MM",
	"DD",
	"HH",
	"mm",
	"ss",
	"M",
	"D",
	"H",
	"m",
	"s",
] as const;
type MomentToken = (typeof MOMENT_TOKENS)[number];

const TOKEN_PATTERNS: Record<MomentToken, string> = {
	YYYY: "(?<YYYY>\\d{4})",
	YY: "(?<YY>\\d{2})",
	MM: "(?<MM>0[1-9]|1[0-2])",
	M: "(?<M>[1-9]|1[0-2])",
	DD: "(?<DD>0[1-9]|[12]\\d|3[01])",
	D: "(?<D>[1-9]|[12]\\d|3[01])",
	HH: "(?<HH>[01]\\d|2[0-3])",
	H: "(?<H>\\d|1\\d|2[0-3])",
	mm: "(?<mm>[0-5]\\d)",
	m: "(?<m>\\d|[1-5]\\d)",
	ss: "(?<ss>[0-5]\\d)",
	s: "(?<s>\\d|[1-5]\\d)",
};

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenize(
	format: string,
): Array<{ token?: MomentToken; literal?: string }> {
	const parts: Array<{ token?: MomentToken; literal?: string }> = [];
	for (let index = 0; index < format.length;) {
		const token = MOMENT_TOKENS.find((candidate) =>
			format.startsWith(candidate, index),
		);
		if (token) {
			parts.push({ token });
			index += token.length;
			continue;
		}

		const start = index;
		index += 1;
		while (
			index < format.length &&
			!MOMENT_TOKENS.some((candidate) =>
				format.startsWith(candidate, index),
			)
		) {
			index += 1;
		}
		parts.push({ literal: format.slice(start, index) });
	}
	return parts;
}

export function validateDateFormat(format: string): string | null {
	const normalized = format.trim();
	if (!normalized) return null;
	const tokens = tokenize(normalized).flatMap((part) =>
		part.token ? [part.token] : [],
	);
	const hasYear = tokens.includes("YYYY") || tokens.includes("YY");
	const hasMonth = tokens.includes("MM") || tokens.includes("M");
	const hasDay = tokens.includes("DD") || tokens.includes("D");
	return hasYear && hasMonth && hasDay ? normalized : null;
}

function compiledMatcher(format: string): RegExp | null {
	const valid = validateDateFormat(format);
	if (!valid) return null;
	const body = tokenize(valid)
		.map((part) =>
			part.token
				? TOKEN_PATTERNS[part.token]
				: escapeRegex(part.literal ?? ""),
		)
		.join("");
	return new RegExp(`(?<!\\d)${body}(?!\\d)`);
}

function numberGroup(
	groups: Record<string, string> | undefined,
	...names: string[]
): number | undefined {
	for (const name of names) {
		const value = groups?.[name];
		if (value !== undefined) return Number(value);
	}
	return undefined;
}

export function extractDateFromFilename(
	name: string,
	format: string,
): ParsedFilenameDate | null {
	const matcher = compiledMatcher(format);
	if (!matcher) return null;
	const match = matcher.exec(name);
	if (!match) return null;

	const yearValue = numberGroup(match.groups, "YYYY", "YY");
	const month = numberGroup(match.groups, "MM", "M");
	const day = numberGroup(match.groups, "DD", "D");
	if (yearValue === undefined || month === undefined || day === undefined)
		return null;
	const year = match.groups?.YY !== undefined ? 2000 + yearValue : yearValue;
	const hour = numberGroup(match.groups, "HH", "H");
	const minute = numberGroup(match.groups, "mm", "m");
	const second = numberGroup(match.groups, "ss", "s");
	const test = new Date(
		year,
		month - 1,
		day,
		hour ?? 0,
		minute ?? 0,
		second ?? 0,
		0,
	);
	if (
		test.getFullYear() !== year ||
		test.getMonth() !== month - 1 ||
		test.getDate() !== day ||
		(hour !== undefined && test.getHours() !== hour) ||
		(minute !== undefined && test.getMinutes() !== minute) ||
		(second !== undefined && test.getSeconds() !== second)
	) {
		return null;
	}

	return {
		year,
		month,
		day,
		...(hour === undefined ? {} : { hour }),
		...(minute === undefined ? {} : { minute }),
		...(second === undefined ? {} : { second }),
		start: match.index,
		end: match.index + match[0].length,
		text: match[0],
	};
}

function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0");
}

export function formatMomentDate(date: Date, format: string): string {
	const values: Record<MomentToken, string> = {
		YYYY: pad(date.getFullYear(), 4),
		YY: pad(date.getFullYear() % 100, 2),
		MM: pad(date.getMonth() + 1),
		M: String(date.getMonth() + 1),
		DD: pad(date.getDate()),
		D: String(date.getDate()),
		HH: pad(date.getHours()),
		H: String(date.getHours()),
		mm: pad(date.getMinutes()),
		m: String(date.getMinutes()),
		ss: pad(date.getSeconds()),
		s: String(date.getSeconds()),
	};
	return tokenize(format)
		.map((part) => (part.token ? values[part.token] : (part.literal ?? "")))
		.join("");
}

export function rewriteFilenameDate(
	name: string,
	oldFormat: string,
	newFormat: string,
): string | null {
	const parsed = extractDateFromFilename(name, oldFormat);
	if (!parsed || !validateDateFormat(newFormat)) return null;
	const replacement = formatMomentDate(
		new Date(
			parsed.year,
			parsed.month - 1,
			parsed.day,
			parsed.hour ?? 0,
			parsed.minute ?? 0,
			parsed.second ?? 0,
		),
		newFormat,
	);
	return `${name.slice(0, parsed.start)}${replacement}${name.slice(parsed.end)}`;
}

export function formatDateManagerValue(date: Date, format: string): string {
	const replacements: Record<string, string> = {
		yyyy: pad(date.getFullYear(), 4),
		MM: pad(date.getMonth() + 1),
		dd: pad(date.getDate()),
		HH: pad(date.getHours()),
		mm: pad(date.getMinutes()),
		ss: pad(date.getSeconds()),
		SSS: pad(date.getMilliseconds(), 3),
	};
	let result = "";
	let quoted = false;
	for (let index = 0; index < format.length;) {
		if (format[index] === "'") {
			quoted = !quoted;
			index += 1;
			continue;
		}
		const token = quoted
			? undefined
			: ["yyyy", "SSS", "MM", "dd", "HH", "mm", "ss"].find((item) =>
					format.startsWith(item, index),
				);
		if (token) {
			result += replacements[token];
			index += token.length;
		} else {
			result += format[index];
			index += 1;
		}
	}
	return result;
}

export function parsedToDate(parsed: ParsedFilenameDate, fallback: Date): Date {
	return new Date(
		parsed.year,
		parsed.month - 1,
		parsed.day,
		parsed.hour ?? fallback.getHours(),
		parsed.minute ?? fallback.getMinutes(),
		parsed.second ?? fallback.getSeconds(),
		fallback.getMilliseconds(),
	);
}
