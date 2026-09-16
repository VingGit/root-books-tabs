import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatDatePattern, hasTimeTokens, matchDatePatternInFilename } from '../src/date-pattern';

function localTime(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
	return new Date(year, month - 1, day, hour, minute, second).getTime();
}

test('supported tokens format with literal prefix and suffix text', () => {
	const date = new Date(2026, 8, 7, 5, 4, 3);
	assert.equal(formatDatePattern(date, 'note-YYYY.MM.DD_HH-mm-ss-end'), 'note-2026.09.07_05-04-03-end');
	assert.equal(hasTimeTokens('DD.MM.YYYY'), false);
	assert.equal(hasTimeTokens('DD.MM.YYYY HH-mm'), true);
});

test('date-only collision formatting appends time without duplicating an existing time', () => {
	const date = new Date(2026, 8, 7, 5, 4, 3);
	assert.equal(formatDatePattern(date, 'DD.MM.YYYY', true), '07.09.2026_at_05-04');
	assert.equal(formatDatePattern(date, 'DD.MM.YYYY_HH-mm', true), '07.09.2026_05-04');
	assert.equal(formatDatePattern(date, '', true), '');
});

test('filename matching is unanchored and treats separators as literals', () => {
	assert.equal(
		matchDatePatternInFilename('prefix_[07.09.2026](05+04+03)_suffix.md', '[DD.MM.YYYY](HH+mm+ss)'),
		localTime(2026, 9, 7, 5, 4, 3),
	);
	assert.equal(
		matchDatePatternInFilename('outside-day-07.09.2026-end-text.md', 'day-DD.MM.YYYY-end'),
		localTime(2026, 9, 7),
	);
});

test('filename matching skips invalid calendar matches and accepts the next valid substring', () => {
	assert.equal(
		matchDatePatternInFilename('bad-31.02.2026-good-29.02.2024.md', 'DD.MM.YYYY'),
		localTime(2024, 2, 29),
	);
	assert.equal(matchDatePatternInFilename('bad-29.02.2023.md', 'DD.MM.YYYY'), null);
	assert.equal(matchDatePatternInFilename('bad-07.09.2026_24-00-00.md', 'DD.MM.YYYY_HH-mm-ss'), null);
});

test('two-digit years use the same 2000-based convention as ordering frontmatter', () => {
	assert.equal(matchDatePatternInFilename('entry-07-09-26.md', 'DD-MM-YY'), localTime(2026, 9, 7));
});

test('date tokens do not match inside a longer run of digits', () => {
	assert.equal(matchDatePatternInFilename('entry-12026-09-07.md', 'YYYY-MM-DD'), null);
	assert.equal(matchDatePatternInFilename('entry-2026-09-070.md', 'YYYY-MM-DD'), null);
});

test('patterns without supported tokens and inconsistent repeated tokens do not match', () => {
	assert.equal(matchDatePatternInFilename('entry-2026.md', 'entry-date'), null);
	assert.equal(matchDatePatternInFilename('2026-2025-09-07.md', 'YYYY-YYYY-MM-DD'), null);
});
