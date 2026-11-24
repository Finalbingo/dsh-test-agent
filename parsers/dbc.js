/**
 * DBC (CAN database) → one block per message, carrying its signals and comments.
 * Signal names, ranges and value tables are the vocabulary the agent needs to
 * write test steps, so they are kept verbatim rather than normalised.
 */

function parseMessage(line) {
	const match = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\S+)/.exec(line);
	if (!match) return null;
	return { rawId: Number(match[1]), name: match[2], dlc: Number(match[3]), sender: match[4], signals: [] };
}

function parseSignal(line, message) {
	const match = /^SG_\s+(\w+)\s*(?:\w+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]*)\)\s*\[([^|]*)\|([^\]]*)\]\s*"([^"]*)"\s*(.*)$/.exec(line);
	if (!match) return null;
	const [, name, startBit, length, byteOrder, sign, factor, offset, min, max, unit, receivers] = match;
	return {
		name,
		startBit: Number(startBit),
		length: Number(length),
		byteOrder: byteOrder === '1' ? 'intel' : 'motorola',
		signed: sign === '-',
		factor: Number(factor),
		offset: Number(offset),
		min: Number(min),
		max: Number(max),
		unit,
		receivers: receivers.trim(),
		values: [],
		comment: ''
	};
}

/** DBC files from vehicle OEMs are usually GB18030; fall back when UTF-8 is invalid. */
function decode(buffer) {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
	} catch {
		try {
			return new TextDecoder('gb18030').decode(buffer);
		} catch {
			return buffer.toString('utf8');
		}
	}
}

/** @returns {Array<{kind:string, text:string, location:string}>} */
export function parseDbc(buffer) {
	const text = decode(buffer).replace(/\r\n?/g, '\n');
	const messages = [];
	let current = null;
	const comments = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.startsWith('BO_ ')) {
			current = parseMessage(trimmed);
			if (current) messages.push(current);
			continue;
		}
		if (trimmed.startsWith('SG_ ') && current) {
			const signal = parseSignal(trimmed, current);
			if (signal) current.signals.push(signal);
			continue;
		}
		if (trimmed.startsWith('CM_ ')) comments.push(trimmed);
		if (trimmed.startsWith('VAL_ ')) {
			const match = /^VAL_\s+(\d+)\s+(\w+)\s+(.*);$/.exec(trimmed);
			if (!match) continue;
			const message = messages.find((item) => item.rawId === Number(match[1]));
			const signal = message?.signals.find((item) => item.name === match[2]);
			if (!signal) continue;
			const pairs = [...match[3].matchAll(/(-?\d+)\s+"([^"]*)"/g)].map((item) => `${item[1]}=${item[2]}`);
			signal.values.push(...pairs);
		}
	}
	// Comments arrive after the messages they describe; attach by name.
	for (const comment of comments) {
		const messageComment = /^CM_\s+BO_\s+(\d+)\s+"((?:[^"\\]|\\.)*)";/.exec(comment);
		if (messageComment) {
			const message = messages.find((item) => item.rawId === Number(messageComment[1]));
			if (message) message.comment = messageComment[2].replace(/\\"/g, '"');
			continue;
		}
		const signalComment = /^CM_\s+SG_\s+(\d+)\s+(\w+)\s+"((?:[^"\\]|\\.)*)";/.exec(comment);
		if (signalComment) {
			const message = messages.find((item) => item.rawId === Number(signalComment[1]));
			const signal = message?.signals.find((item) => item.name === signalComment[2]);
			if (signal) signal.comment = signalComment[3].replace(/\\"/g, '"');
		}
	}

	return messages.map((message) => {
		const lines = [
			`报文 ${message.name}（ID 0x${message.rawId.toString(16).toUpperCase()} / ${message.rawId}，DLC ${message.dlc}，发送方 ${message.sender}）`,
			message.comment ? `说明：${message.comment}` : '',
			`信号 ${message.signals.length} 条：`
		].filter(Boolean);
		for (const signal of message.signals) {
			const range = signal.min === signal.max ? String(signal.min) : `${signal.min}~${signal.max}`;
			const values = signal.values.length > 0 ? `；取值 ${signal.values.join(' / ')}` : '';
			const note = signal.comment ? `；说明 ${signal.comment}` : '';
			lines.push(`- ${signal.name}：${signal.startBit}|${signal.length}@${signal.byteOrder}，${signal.signed ? '有符号' : '无符号'}，${range}${signal.unit ? ` ${signal.unit}` : ''}，接收方 ${signal.receivers}${values}${note}`);
		}
		return { kind: 'message', text: lines.join('\n'), location: message.name };
	});
}
