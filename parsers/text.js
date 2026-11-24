/** Plain text / markdown / html / csv → the same block shape the docx parser emits. */

function unescapeHtml(value) {
	return value
		.replace(/&nbsp;/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

export function htmlToBlocks(html) {
	const cleaned = html
		.replace(/<script\b[\s\S]*?<\/script>/gi, '')
		.replace(/<style\b[\s\S]*?<\/style>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '');
	const blocks = [];
	for (const match of cleaned.matchAll(/<(h[1-6]|p|li|div|td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
		const tag = match[1].toLowerCase();
		const text = unescapeHtml(match[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
		if (text === '') continue;
		if (/^h[1-6]$/.test(tag)) blocks.push({ kind: 'heading', level: Number(tag[1]), text, location: '' });
		else blocks.push({ kind: 'para', text, location: '' });
	}
	if (blocks.length === 0) {
		const text = unescapeHtml(cleaned.replace(/<[^>]+>/g, '\n')).replace(/\n{2,}/g, '\n').trim();
		if (text !== '') blocks.push({ kind: 'para', text, location: '' });
	}
	return blocks;
}

export function markdownToBlocks(text) {
	const blocks = [];
	const stack = [];
	for (const raw of text.split('\n')) {
		const line = raw.trimEnd();
		if (line.trim() === '') continue;
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			stack.length = Math.max(0, level - 1);
			stack[level - 1] = heading[2].trim();
			blocks.push({ kind: 'heading', level, text: heading[2].trim(), location: stack.filter(Boolean).join(' / ') });
			continue;
		}
		const row = /^\s*\|(.+)\|\s*$/.exec(line);
		if (row) {
			const cells = row[1].split('|').map((cell) => cell.trim());
			if (cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '')) continue;
			blocks.push({ kind: 'table-row', rows: [cells], location: stack.filter(Boolean).join(' / ') });
			continue;
		}
		blocks.push({ kind: 'para', text: line, location: stack.filter(Boolean).join(' / ') });
	}
	return blocks;
}

export function csvToBlocks(text) {
	const lines = text.split('\n').filter((line) => line.trim() !== '');
	return lines.map((line) => ({
		kind: 'table-row',
		rows: [line.split(',').map((cell) => cell.replace(/^"|"$/g, '').trim())],
		location: ''
	}));
}

export function parseText(buffer, extension) {
	const text = buffer.toString('utf8');
	if (extension === '.html' || extension === '.htm') return htmlToBlocks(text);
	if (extension === '.csv') return csvToBlocks(text);
	if (extension === '.md' || extension === '.markdown') return markdownToBlocks(text);
	if (extension === '.json') {
		try {
			return [{ kind: 'para', text: JSON.stringify(JSON.parse(text), null, 2), location: '' }];
		} catch {
			return [{ kind: 'para', text, location: '' }];
		}
	}
	return markdownToBlocks(text.replace(/^#{1,6}\s+/gm, (match) => match));
}
