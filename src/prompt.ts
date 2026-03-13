export function buildPrompt(taskDescription: string, prdContent: string, progressContent: string): string {
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
		'    MANDATORY: UPDATE PRD.md AND progress.txt WHEN DONE',
		'===================================================================',
		'',
		'After completing the task:',
		'',
		`1. In PRD.md, change:  - [ ] ${sanitized}`,
		`   To:                 - [x] ${sanitized}`,
		'',
		'2. Append to progress.txt what you did.',
		'',
		'Both updates are required for the loop to continue!',
		'',
		'===================================================================',
		'                       PROJECT CONTEXT',
		'===================================================================',
		'',
		'## PRD.md:',
		'```markdown',
		prdContent,
		'```',
		'',
	];

	if (progressContent.trim()) {
		parts.push('## progress.txt:');
		parts.push('```');
		parts.push(progressContent);
		parts.push('```');
		parts.push('');
	}

	return parts.join('\n');
}
