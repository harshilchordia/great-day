import type { App } from 'obsidian';
import { TFile, Notice, normalizePath, moment } from 'obsidian';
import type { GreatDaySettings } from '../settings';
import type { TaskScope, SyncResult, Task } from '../types';
import {
	parseTodos,
	extractNewTaskTag,
	stripTag,
	extractDateTag,
	stripDateTag,
	serialiseTodos,
} from './todosParser';
import { getDailyNoteFile } from './dailyNoteGenerator';

/** Marker written at the end of a daily note after rollover to prevent double-sync. */
const SYNCED_MARKER = '<!-- great-day-synced -->';

/** Matches a checkbox task line. */
const TASK_RE = /^(\s*)- \[([ xX])\] (.*)$/;

/** A parsed task from the daily note (under Tasks section). */
interface ParsedTask {
	raw: string;
	done: boolean;
	text: string;
	indent: number;
	/** Where this task came from, extracted from urgency tag. */
	originScope: TaskScope;
	/** Scheduled date if the task had a (DD-MM-YYYY) tag. */
	originDate: string | null;
}

/** Result of parsing a daily note. */
interface DailyNoteTasks {
	pulledTasks: ParsedTask[];
	newTasks: ParsedTask[];
}

/** Extracts the origin scope and date from a task's urgency tag. */
function extractOrigin(text: string): { scope: TaskScope; date: string | null; cleanText: string } {
	// Check for date tag first
	const dateTag = extractDateTag(text);
	if (dateTag) {
		return { scope: 'scheduled', date: dateTag, cleanText: stripDateTag(text) };
	}
	// Check for scope tag
	const tagResult = extractNewTaskTag(text);
	if (tagResult) {
		return { scope: tagResult.scope, date: null, cleanText: stripTag(text) };
	}
	// No tag — default to day
	return { scope: 'day', date: null, cleanText: text };
}

/** Parses a daily note's content into pulled tasks and new tasks. */
function parseDailyNote(
	content: string,
	settings: GreatDaySettings,
): DailyNoteTasks {
	const lines = content.split('\n');
	const pulledTasks: ParsedTask[] = [];
	const newTasks: ParsedTask[] = [];

	let inNewTasksSection = false;
	let inTasksSection = false;

	for (const line of lines) {
		const trimmedLower = line.trim().toLowerCase();
		const headingMatch = trimmedLower.match(/^#+\s+(.+)$/);

		if (headingMatch) {
			const headingText = headingMatch[1] ?? '';
			inNewTasksSection = headingText === settings.addTasksHeading.toLowerCase();
			inTasksSection = false;
			continue;
		}

		const taskMatch = line.match(TASK_RE);
		if (taskMatch) {
			const indentStr = taskMatch[1] ?? '';
			const doneChar = taskMatch[2] ?? ' ';
			const text = taskMatch[3] ?? '';
			const indent = indentStr.replace(/\t/g, '    ').length;
			const origin = extractOrigin(text);

			const taskObj: ParsedTask = {
				raw: line,
				done: doneChar.toLowerCase() === 'x',
				text: origin.cleanText,
				indent,
				originScope: origin.scope,
				originDate: origin.date,
			};

			if (inNewTasksSection) {
				newTasks.push(taskObj);
			} else if (inTasksSection) {
				if (indent > 0) {
					pulledTasks.push(taskObj);
				}
			} else {
				if (trimmedLower === '- [ ] tasks' || trimmedLower === '- [x] tasks') {
					inTasksSection = true;
				}
			}
		} else {
			if (inTasksSection && trimmedLower === '') {
				inTasksSection = false;
			}
		}
	}

	return { pulledTasks, newTasks };
}

/** Checks whether a daily note has already been synced. */
export function isNoteSynced(content: string): boolean {
	return content.includes(SYNCED_MARKER);
}

/** Converts overdue scheduled tasks to day tasks. */
function convertOverdueScheduled(data: ReturnType<typeof parseTodos>, todayDateTag: string): void {
	const overdue: Task[] = [];
	const remaining: Task[] = [];
	for (const task of data.tasks.scheduled) {
		if (!task.done && task.scheduledDate && task.scheduledDate !== todayDateTag) {
			// Check if the date is in the past
			const taskDate = moment(task.scheduledDate, 'DD-MM-YYYY');
			const today = moment(todayDateTag, 'DD-MM-YYYY');
			if (taskDate.isBefore(today)) {
				overdue.push({ ...task, scope: 'day', scheduledDate: null });
				continue;
			}
		}
		remaining.push(task);
	}
	data.tasks.scheduled = remaining;
	data.tasks.day.push(...overdue);
}

/**
 * Syncs a daily note back to TODOs:
 * - Checked pulled tasks → removed from TODOs
 * - Unchecked pulled tasks → stay in TODOs (rolled back)
 * - New tasks with tags → appended to the right TODOs section
 * - Overdue scheduled tasks → converted to day tasks
 */
export async function syncRollover(
	app: App,
	settings: GreatDaySettings,
	noteDate: moment.Moment,
): Promise<SyncResult> {
	const dailyFile = getDailyNoteFile(app, settings, noteDate);
	if (!dailyFile) {
		return { rolledBack: [], completed: [], appended: { day: [], week: [], month: [], year: [], scheduled: [] } };
	}

	const dailyContent = await app.vault.read(dailyFile);

	if (isNoteSynced(dailyContent)) {
		return { rolledBack: [], completed: [], appended: { day: [], week: [], month: [], year: [], scheduled: [] } };
	}

	const parsed = parseDailyNote(dailyContent, settings);

	const todosFile = app.vault.getAbstractFileByPath(
		normalizePath(settings.todosFilePath),
	);
	if (!todosFile || !(todosFile instanceof TFile)) {
		new Notice('Great day: todos file not found for rollover sync.');
		return { rolledBack: [], completed: [], appended: { day: [], week: [], month: [], year: [], scheduled: [] } };
	}

	const todosRaw = await app.vault.read(todosFile);
	const data = parseTodos(todosRaw);

	// Convert overdue scheduled tasks to day
	convertOverdueScheduled(data, noteDate.format('DD-MM-YYYY'));

	const result: SyncResult = {
		rolledBack: [],
		completed: [],
		appended: { day: [], week: [], month: [], year: [], scheduled: [] },
	};

	// Collect completed task texts (use clean text without tags)
	const completedTexts = new Set<string>();
	for (const task of parsed.pulledTasks) {
		if (task.done) {
			completedTexts.add(task.text);
		}
	}

	// Remove completed tasks from TODOs (also remove their sub-tasks)
	for (const scope of ['day', 'week', 'month', 'year', 'scheduled'] as TaskScope[]) {
		const indicesToRemove = new Set<number>();
		for (let i = 0; i < data.tasks[scope].length; i++) {
			const task = data.tasks[scope][i]!;
			if (completedTexts.has(task.text)) {
				indicesToRemove.add(i);
				result.completed.push(task.text);
				for (let j = i + 1; j < data.tasks[scope].length; j++) {
					const subTask = data.tasks[scope][j]!;
					if (subTask.indent > task.indent) {
						indicesToRemove.add(j);
					} else {
						break;
					}
				}
			}
		}
		data.tasks[scope] = data.tasks[scope].filter(
			(_, idx) => !indicesToRemove.has(idx),
		);
	}

	// Process new tasks
	for (const task of parsed.newTasks) {
		if (task.done) continue;
		if (!task.text.trim()) continue;

		// Check for date tag first (DD-MM-YYYY)
		const dateTag = extractDateTag(task.text);
		if (dateTag) {
			const cleanText = stripDateTag(task.text);
			// Avoid duplicates
			if (!data.tasks.scheduled.some(t => t.text === cleanText && t.scheduledDate === dateTag)) {
				data.tasks.scheduled.push({
					raw: `- [ ] ${cleanText} (${dateTag})`,
					text: cleanText,
					done: false,
					scope: 'scheduled',
					indent: 0,
					scheduledDate: dateTag,
				});
				result.appended.scheduled.push(cleanText);
			}
			continue;
		}

		// Check for scope tag (D/W/M/Y)
		const tagResult = extractNewTaskTag(task.text);
		if (tagResult) {
			const cleanText = stripTag(task.text);
			if (!data.tasks[tagResult.scope].some(t => t.text === cleanText)) {
				data.tasks[tagResult.scope].push({
					raw: `- [ ] ${cleanText}`,
					text: cleanText,
					done: false,
					scope: tagResult.scope,
					indent: 0,
					scheduledDate: null,
				});
				result.appended[tagResult.scope].push(cleanText);
			}
		}
	}

	// Write back TODOs
	const newTodos = serialiseTodos(data);
	await app.vault.modify(todosFile, newTodos);

	// Mark the daily note as synced
	const updatedContent = dailyContent.trimEnd() + '\n\n' + SYNCED_MARKER + '\n';
	await app.vault.modify(dailyFile, updatedContent);

	// Collect rolledBack (unchecked pulled tasks)
	for (const task of parsed.pulledTasks) {
		if (!task.done) {
			result.rolledBack.push(task.text);
		}
	}

	return result;
}

/**
 * Syncs all unsynced previous daily notes before creating a new one.
 */
export async function syncPreviousNotes(
	app: App,
	settings: GreatDaySettings,
	targetDate: moment.Moment,
): Promise<SyncResult> {
	const combined: SyncResult = {
		rolledBack: [],
		completed: [],
		appended: { day: [], week: [], month: [], year: [], scheduled: [] },
	};

	for (let i = 1; i <= 30; i++) {
		const checkDate = targetDate.clone().subtract(i, 'day');
		const file = getDailyNoteFile(app, settings, checkDate);
		if (!file) continue;

		const content = await app.vault.read(file);
		if (isNoteSynced(content)) break;

		const result = await syncRollover(app, settings, checkDate);
		combined.rolledBack.push(...result.rolledBack);
		combined.completed.push(...result.completed);
		combined.appended.day.push(...result.appended.day);
		combined.appended.week.push(...result.appended.week);
		combined.appended.month.push(...result.appended.month);
		combined.appended.year.push(...result.appended.year);
		combined.appended.scheduled.push(...result.appended.scheduled);
	}

	return combined;
}
