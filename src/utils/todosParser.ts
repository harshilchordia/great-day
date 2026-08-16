import type { Task, TaskScope, TodosData } from '../types';

/** Matches a checkbox task line: `- [ ]` or `- [x]` (case-insensitive). */
const TASK_RE = /^(\s*)- \[([ xX])\] (.*)$/;

/** Matches scope tags in task text: (D), (W), (M), (Y). */
const TAG_RE = /\(([DWdwmM])\)\s*$/;

/** Matches date tags in task text: (DD-MM-YYYY). */
const DATE_TAG_RE = /\((\d{2}-\d{2}-\d{4})\)\s*$/;

/**
 * Matches the hidden "shown count" marker appended to week/month/year tasks,
 * e.g. `<!--shown:2-->`. Written as an HTML comment so it doesn't clutter the
 * rendered note in Obsidian's reading view.
 */
const SHOWN_COUNT_RE = /<!--shown:(\d+)-->\s*$/;

/** Maps a tag character to a scope. */
function tagToScope(ch: string): TaskScope | null {
	switch (ch.toUpperCase()) {
		case 'D': return 'day';
		case 'W': return 'week';
		case 'M': return 'month';
		case 'Y': return 'year';
		default: return null;
	}
}

/** Tracks which section we're currently parsing. */
type Section = 'reminders' | 'exercise' | 'day' | 'week' | 'month' | 'year' | 'scheduled' | null;

/** Checks if a line is a heading we recognise for task sections. */
function matchTaskSection(trimmedLower: string): Section {
	if (trimmedLower === '# day' || trimmedLower === '## day') return 'day';
	if (trimmedLower === '# week' || trimmedLower === '## week') return 'week';
	if (trimmedLower === '# month' || trimmedLower === '## month') return 'month';
	if (trimmedLower === '# year' || trimmedLower === '## year') return 'year';
	if (trimmedLower === '# scheduled' || trimmedLower === '## scheduled') return 'scheduled';
	return null;
}

/** Extracts a date tag (DD-MM-YYYY) from task text, if present. */
export function extractDateTag(text: string): string | null {
	const match = text.match(DATE_TAG_RE);
	return match?.[1] ?? null;
}

/** Removes the date tag from task text. */
export function stripDateTag(text: string): string {
	return text.replace(DATE_TAG_RE, '').trimEnd();
}

/** Extracts the hidden shown-count marker from task text, if present. Defaults to 0. */
export function extractShownCount(text: string): number {
	const match = text.match(SHOWN_COUNT_RE);
	if (!match?.[1]) return 0;
	const n = parseInt(match[1], 10);
	return Number.isNaN(n) ? 0 : n;
}

/** Removes the hidden shown-count marker from task text. */
export function stripShownCount(text: string): string {
	return text.replace(SHOWN_COUNT_RE, '').trimEnd();
}

/** Extracts a scope tag (D)/(W)/(M)/(Y) from task text, if present. */
export function extractScopeTag(text: string): string | null {
	const match = text.match(TAG_RE);
	return match?.[0] ?? null;
}

/** Removes the scope tag from task text. */
export function stripScopeTag(text: string): string {
	return text.replace(TAG_RE, '').trimEnd();
}

/** Parses the full TODOs.md text into structured data. */
export function parseTodos(raw: string): TodosData {
	const lines = raw.split('\n');
	const exercisePlanLines: string[] = [];
	const reminderLines: string[] = [];
	const tasks: Record<TaskScope, Task[]> = {
		day: [], week: [], month: [], year: [], scheduled: [],
	};

	let currentSection: Section = null;

	for (const line of lines) {
		const trimmedLower = line.trim().toLowerCase();
		// Strip leading heading markers (# or ##) so section headers are recognised
		// regardless of heading level (some tools, e.g. Obsidian Linter, may rewrite
		// heading levels in the file).
		const isHeading = /^#{1,2}\s/.test(trimmedLower);
		const headingBody = isHeading ? trimmedLower.replace(/^#{1,2}\s+/, '') : '';

		// Skip food plan section entirely
		if (isHeading && headingBody.startsWith('food plan')) {
			currentSection = null;
			continue;
		}

		if (isHeading && headingBody.startsWith('reminders')) {
			currentSection = 'reminders';
			continue;
		}

		if (isHeading && headingBody.startsWith('exercise plan')) {
			currentSection = 'exercise';
			continue;
		}

		const taskSection = matchTaskSection(trimmedLower);
		if (taskSection) {
			currentSection = taskSection;
			continue;
		}

		if (currentSection === 'reminders') {
			if (trimmedLower.startsWith('#')) {
				currentSection = null;
			} else {
				reminderLines.push(line);
				continue;
			}
		}

		if (currentSection === 'exercise') {
			if (trimmedLower.startsWith('#')) {
				currentSection = null;
			} else {
				exercisePlanLines.push(line);
				continue;
			}
		}

		// Parse task lines in task sections
		const taskMatch = line.match(TASK_RE);
		if (taskMatch && currentSection && (currentSection === 'day' || currentSection === 'week' || currentSection === 'month' || currentSection === 'year' || currentSection === 'scheduled')) {
			const indentStr = taskMatch[1] ?? '';
			const doneChar = taskMatch[2] ?? ' ';
			const rawText = taskMatch[3] ?? '';
			// Strip any trailing scope or date tags from text (so they're not doubled)
			let cleanText = stripScopeTag(rawText);
			const shownCount = extractShownCount(cleanText);
			cleanText = stripShownCount(cleanText);
			const scheduledDate = currentSection === 'scheduled' ? extractDateTag(cleanText) : null;
			cleanText = scheduledDate ? stripDateTag(cleanText) : cleanText;
			tasks[currentSection].push({
				raw: line,
				text: cleanText,
				done: doneChar.toLowerCase() === 'x',
				scope: currentSection,
				indent: indentStr.length,
				scheduledDate,
				shownCount,
			});
		}
	}

	const exercisePlanText = exercisePlanLines
		.filter((line, idx, arr) => {
			const trimmed = line.trim();
			if (trimmed === '' && idx > 0 && arr[idx - 1]?.trim() === '') return false;
			return true;
		})
		.join('\n')
		.trim();

	return {
		raw,
		exercisePlanText,
		reminderLines,
		tasks,
	};
}

/** Extracts the exercise text for a given full day name (e.g. "Monday", "Saturday"). */
export function getExerciseForDay(exerciseText: string, dayName: string): string {
	const lines = exerciseText.split('\n');
	const dayLower = dayName.toLowerCase();

	if (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].includes(dayLower)) {
		return extractBlock(lines, 'monday to friday');
	}
	if (dayLower === 'saturday') {
		return extractBlock(lines, 'saturday');
	}
	if (dayLower === 'sunday') {
		return extractBlock(lines, 'sunday');
	}
	return '';
}

/** Extracts a named block and its sub-items from exercise plan lines. */
function extractBlock(lines: string[], headingFragment: string): string {
	const result: string[] = [];
	let capturing = false;

	for (const line of lines) {
		const trimmedLower = line.trim().toLowerCase();
		if (trimmedLower.includes(headingFragment)) {
			capturing = true;
			result.push(line);
			continue;
		}
		if (capturing) {
			if (trimmedLower === '') {
				result.push(line);
				continue;
			}
			if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/.test(trimmedLower) && trimmedLower.includes(':')) {
				break;
			}
			result.push(line);
		}
	}
	return result.join('\n').trim();
}

/** Extracts reminder items (plain `- text` lines, stripping the dash). */
export function getReminders(reminderLines: string[]): string[] {
	const reminders: string[] = [];
	for (const line of reminderLines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const text = trimmed.replace(/^-\s*/, '');
		if (text) reminders.push(text);
	}
	return reminders;
}

/** Extracts new-task tags from a task line. Returns the tag and scope, or null. */
export function extractNewTaskTag(text: string): { tag: string; scope: TaskScope } | null {
	const match = text.match(TAG_RE);
	if (!match) return null;
	const ch = match[1];
	if (!ch) return null;
	const scope = tagToScope(ch);
	if (!scope) return null;
	return { tag: match[0], scope };
}

/** Removes the scope tag from task text. */
export function stripTag(text: string): string {
	return text.replace(TAG_RE, '').trimEnd();
}

/** Builds a task line with proper indentation (using tabs). */
function buildTaskLine(task: Task): string {
	const indent = '\t'.repeat(task.indent);
	const checkbox = task.done ? '- [x]' : '- [ ]';
	let suffix = '';
	if (task.scope === 'scheduled' && task.scheduledDate) {
		suffix = ` (${task.scheduledDate})`;
	}
	const shownMarker = task.shownCount > 0 ? ` <!--shown:${task.shownCount}-->` : '';
	return `${indent}${checkbox} ${task.text}${suffix}${shownMarker}`;
}

/** Serialises TodosData back into file text. */
export function serialiseTodos(data: TodosData): string {
	const sections: string[] = [];

	if (data.reminderLines.length > 0) {
		sections.push('# Reminders');
		sections.push(data.reminderLines.join('\n').trim());
	}

	if (data.exercisePlanText) {
		sections.push('# Exercise Plan');
		sections.push(data.exercisePlanText);
	}

	const scopeHeading: Record<TaskScope, string> = {
		day: '# Day',
		week: '# Week',
		month: '# Month',
		year: '# Year',
		scheduled: '# Scheduled',
	};

	for (const scope of ['day', 'week', 'month', 'year', 'scheduled'] as TaskScope[]) {
		const scopeTasks = data.tasks[scope];
		if (scopeTasks.length > 0) {
			const taskLines = scopeTasks.map((t) => buildTaskLine(t));
			sections.push(scopeHeading[scope] + '\n' + taskLines.join('\n'));
		}
	}

	return sections.join('\n\n') + '\n';
}
