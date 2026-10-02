import assert from "node:assert/strict";
import test from "node:test";
import {
	extractDateFromFilename,
	formatDateManagerValue,
	formatMomentDate,
	parsedToDate,
	rewriteFilenameDate,
	validateDateFormat,
} from "../src/date-format";

test("validates formats that contain a year, month, and day", () => {
	assert.equal(validateDateFormat("DD.MM.YYYY"), "DD.MM.YYYY");
	assert.equal(validateDateFormat("YYYY-MM-DD HH.mm"), "YYYY-MM-DD HH.mm");
	assert.equal(validateDateFormat("HH.mm"), null);
});

test("extracts a valid filename date without accepting impossible dates", () => {
	assert.deepEqual(
		extractDateFromFilename("notes_02.10.2026_topic", "DD.MM.YYYY"),
		{
			year: 2026,
			month: 10,
			day: 2,
			start: 6,
			end: 16,
			text: "02.10.2026",
		},
	);
	assert.equal(
		extractDateFromFilename("31.02.2026_topic", "DD.MM.YYYY"),
		null,
	);
});

test("rewrites only the matched date", () => {
	assert.equal(
		rewriteFilenameDate("02.10.2026_topic", "DD.MM.YYYY", "YYYY-MM-DD"),
		"2026-10-02_topic",
	);
});

test("formats Moment-like filename tokens", () => {
	const date = new Date(2026, 9, 2, 7, 8, 9);
	assert.equal(
		formatMomentDate(date, "YYYY-MM-DD HH.mm.ss"),
		"2026-10-02 07.08.09",
	);
});

test("formats Date Manager tokens and quoted literals", () => {
	const date = new Date(2026, 9, 2, 7, 8, 9);
	assert.equal(
		formatDateManagerValue(date, "yyyy-MM-dd'T'HH:mm:ss"),
		"2026-10-02T07:08:09",
	);
});

test("keeps fallback time when a filename contains only a date", () => {
	const parsed = extractDateFromFilename("02.10.2026_topic", "DD.MM.YYYY");
	assert.ok(parsed);
	const result = parsedToDate(parsed, new Date(2020, 0, 1, 12, 13, 14, 15));
	assert.deepEqual(
		[
			result.getFullYear(),
			result.getMonth(),
			result.getDate(),
			result.getHours(),
			result.getMinutes(),
		],
		[2026, 9, 2, 12, 13],
	);
});
