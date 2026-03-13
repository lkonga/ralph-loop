function filterPrdContent(prdContent: string): string {
	const lines = prdContent.split('\n');
	const checkedCount = lines.filter(l => l.match(/- \[x\]/i)).length;
	const uncheckedLines = lines.filter(l => l.match(/- \[ \]/));
	const totalTasks = checkedCount + uncheckedLines.length;
	const header = `Progress: ${checkedCount}/${totalTasks} tasks completed`;
	return [header, '', ...uncheckedLines].join('\n');
}

export function buildPrompt(taskDescription: string, prdContent: string, progressContent: string, maxProgressLines: number = 20): string {
	const MAX_LEN = 5000;
	const sanitized = taskDescription.trim().slice(0, MAX_LEN);

	const parts: string[] = [
		'===================================================================',
		'                       YOUR TASK TO IMPLEMENT',
		'===================================================================',
		'',
		sanitized,
		'',
		'===================================================================',
		'                       ROLE & BEHAVIOR',
		'===================================================================',
		'',
		'You are an autonomous coding agent. Complete the task below by editing files directly. If you encounter errors, debug and fix them — do not stop. If tests fail, fix the tests or the code. When done, mark the checkbox in PRD.md and append what you did to progress.txt. Do not ask questions — act.',
		'',
		'===================================================================',
		'    MANDATORY: UPDATE PRD.md AND progress.txt WHEN DONE',
		'===================================================================',
		'',
		'After completing the task:',
		'',
		`1. Git commit your code changes atomically: \`git add -A && git commit -m "feat: <short description>"\``,
		`2. In PRD.md, change:  - [ ] ${sanitized}`,
		`   To:                 - [x] ${sanitized}`,
		'',
		'3. Append to progress.txt what you did.',
		`4. Git commit the PRD.md + progress.txt update: \`git add PRD.md progress.txt && git commit -m "chore: mark task done"\``,
		'',
		'Commit OFTEN — after each meaningful change, not just at the end.',
		'All updates are required for the loop to continue!',
		'',
		'===================================================================',
		'                       PROJECT CONTEXT',
		'===================================================================',
		'',
		'## PRD.md:',
		'```markdown',
		filterPrdContent(prdContent),
		'```',
		'',
	];

	if (progressContent.trim()) {
		const lines = progressContent.split('\n');
		let displayContent: string;
		if (lines.length > maxProgressLines) {
			const omitted = lines.length - maxProgressLines;
			const kept = lines.slice(-maxProgressLines);
			displayContent = `[...${omitted} earlier entries omitted]\n${kept.join('\n')}`;
		} else {
			displayContent = progressContent;
		}
		parts.push('## progress.txt:');
		parts.push('```');
		parts.push(displayContent);
		parts.push('```');
		parts.push('');
	}

	return parts.join('\n');
}
