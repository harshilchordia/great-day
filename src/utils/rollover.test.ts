/**
 * Regression tests for the sync -> generate sequence.
 *
 * Run with: npm test
 *
 * These use a fake vault whose `read` deliberately returns stale content after a
 * `modify`, reproducing the Obsidian behaviour that caused new tasks added in a
 * daily note's "New tasks" section to be silently erased: rollover appended them
 * to TODOs.md, then note generation re-read the file, got the pre-write cached
 * copy, and rewrote TODOs.md from that stale parse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTodos, serialiseTodos, extractNewTaskTag, stripTag } from './todosParser.ts';
import type { TodosData } from '../types.ts';

const TODOS = [
	'# Day',
	'- [ ] existing day task',
	'',
	'# Week',
	'',
	'# Month',
	'',
	'# Year',
	'',
	'# Scheduled',
	'',
].join('\n');

/** Appends a tagged new task the way syncRollover does. */
function appendNewTask(data: TodosData, rawText: string): void {
	const tag = extractNewTaskTag(rawText);
	if (!tag) return;
	const text = stripTag(rawText);
	if (data.tasks[tag.scope].some((t) => t.text === text)) return;
	data.tasks[tag.scope].push({
		raw: `- [ ] ${text}`,
		text,
		done: false,
		scope: tag.scope,
		indent: 0,
		scheduledDate: null,
		shownCount: 0,
	});
}

/**
 * A vault whose read returns the content as of the *previous* write, modelling
 * Obsidian serving a cached copy immediately after modify().
 */
class StaleVault {
	private committed: string;
	private pending: string | null = null;
	constructor(initial: string) {
		this.committed = initial;
	}
	read(): string {
		return this.committed;
	}
	modify(content: string): void {
		// The write lands, but a subsequent read still sees the old content until
		// the cache flushes.
		this.pending = content;
	}
	/** The content a later reader would eventually observe. */
	settled(): string {
		return this.pending ?? this.committed;
	}
}

test('new tagged task survives the sync -> generate sequence', () => {
	const vault = new StaleVault(TODOS);

	// --- rollover: parse, append the new task, write back ---
	const synced = parseTodos(vault.read());
	appendNewTask(synced, 'Email Rahul at Sabi Vinod Khosla BCI startup (W)');
	vault.modify(serialiseTodos(synced));

	assert.equal(synced.tasks.week.length, 1, 'task should be appended in memory');

	// --- generate: must use the synced data, NOT re-read the vault ---
	// Re-reading here is what used to lose the task: the read returns stale text.
	const staleReparse = parseTodos(vault.read());
	assert.equal(
		staleReparse.tasks.week.length,
		0,
		'sanity: a re-read really does miss the new task',
	);

	// Generation rewrites TODOs from whatever it parsed. Using the synced object
	// keeps the task; using the stale re-read would erase it.
	vault.modify(serialiseTodos(synced));

	assert.match(
		vault.settled(),
		/Email Rahul at Sabi Vinod Khosla BCI startup/,
		'new task must still be present after generation rewrites TODOs',
	);
});

test('generating from a stale re-read is what erased the task', () => {
	const vault = new StaleVault(TODOS);

	const synced = parseTodos(vault.read());
	appendNewTask(synced, 'Email Rahul at Sabi Vinod Khosla BCI startup (W)');
	vault.modify(serialiseTodos(synced));

	// The old, buggy path: re-read and rewrite from that.
	vault.modify(serialiseTodos(parseTodos(vault.read())));

	assert.doesNotMatch(
		vault.settled(),
		/Email Rahul at Sabi Vinod Khosla BCI startup/,
		'documents the regression: the stale path drops the task',
	);
});

test('all scope headings survive a round-trip even when empty', () => {
	const out = serialiseTodos(parseTodos(TODOS));
	for (const heading of ['# Day', '# Week', '# Month', '# Year', '# Scheduled']) {
		assert.ok(out.includes(heading), `${heading} must be preserved`);
	}
});

test('serialising never fuses two tasks onto one line', () => {
	const data = parseTodos(TODOS);
	// Text carrying an embedded checkbox must not produce two tasks on one line.
	data.tasks.day.push({
		raw: '- [ ] x',
		text: 'first task- [ ] second task',
		done: false,
		scope: 'day',
		indent: 0,
		scheduledDate: null,
		shownCount: 0,
	});
	const out = serialiseTodos(data);
	for (const line of out.split('\n')) {
		const checkboxes = line.match(/- \[[ xX]\]/g) ?? [];
		assert.ok(checkboxes.length <= 1, `line has ${checkboxes.length} checkboxes: ${line}`);
	}
});
