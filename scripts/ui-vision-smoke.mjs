/**
 * 三类真实图片冒烟：随机读图、真实控件、状态变体对比。
 * 证据写入运行目录，不把答案放进提示或文件名。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { probeVision } from '../ui-vision-client.js';
import { prepareCandidateImages } from '../ui-vision.js';

const DATA_ROOT = process.env.CTS_DATA_ROOT || '/Users/Admin/Documents/CTS';
const RUN_DIR = process.env.CTS_RUN_DIR || '/Users/Admin/Documents/CTS/reports/ui-vision-ling-20261117-151738';
const EVIDENCE = path.join(RUN_DIR, 'smoke', 'run-' + new Date().toISOString().replace(/[:.]/g, '-'));

function moduleDir(projectId) {
	const base = path.join(DATA_ROOT, 'artifacts', projectId);
	const entry = fs.readdirSync(base).find((name) => fs.existsSync(path.join(base, name, 'ui-index.json')));
	if (!entry) throw new Error('找不到 UI 索引');
	return path.join(base, entry);
}

function loadIndex(projectId) {
	return JSON.parse(fs.readFileSync(path.join(moduleDir(projectId), 'ui-index.json'), 'utf8'));
}

function objectById(index, id) {
	const object = (index.objects || []).find((entry) => entry.id === id);
	if (!object) throw new Error('找不到对象 ' + id);
	return object;
}

function candidateOf(object, suffix) {
	return {
		candidate_id: suffix, ui_id: object.id, name: object.name || object.texts?.[0] || '',
		role: object.role, page: object.page_name, state: object.state || '',
		source: object.s, revision: object.rev || '', asset_status: 'shot', shot: object.shot,
		target: {
			ui_id: object.id, source: object.s, node_id: object.n, revision: object.rev || '',
			board: object.board, x: object.x, y: object.y, w: object.w, h: object.h,
			shot_node: object.shot_node, shot_scope: object.shot_scope, shot_visibility: object.shot_visibility
		}
	};
}

function parseJson(text) {
	return JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 1));
}

function pyTestCard(target) {
	const script = String.raw`
import json, random, string, sys
from PIL import Image, ImageDraw, ImageFont
target = sys.argv[1]
rng = random.Random()
alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
code = ''.join(rng.choice(alphabet) for _ in range(4))
shape = rng.choice(['circle', 'square', 'triangle'])
color = rng.choice(['red', 'green', 'blue'])
colors = {'red': (210, 35, 35), 'green': (25, 140, 70), 'blue': (30, 80, 200)}
image = Image.new('RGB', (720, 420), (248, 248, 244))
draw = ImageDraw.Draw(image)
font = None
for path in ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf']:
    try:
        font = ImageFont.truetype(path, 120)
        break
    except Exception:
        pass
if font is None:
    font = ImageFont.load_default()
bbox = draw.textbbox((0, 0), code, font=font)
x = (720 - (bbox[2] - bbox[0])) // 2
draw.text((x, 55), code, fill=(20, 20, 20), font=font)
if shape == 'circle':
    draw.ellipse((270, 245, 450, 385), fill=colors[color])
elif shape == 'square':
    draw.rectangle((280, 250, 440, 380), fill=colors[color])
else:
    draw.polygon([(360, 238), (270, 388), (450, 388)], fill=colors[color])
image.save(target)
print(json.dumps({'code': code, 'shape': shape, 'color': color}))
`;
	const out = execFileSync('python3', ['-c', script, target], { encoding: 'utf8' });
	return JSON.parse(out.trim().split(/\r?\n/).at(-1));
}

const CODE_SCHEMA = {
	type: 'object', additionalProperties: false,
	required: ['code', 'shape', 'color'],
	properties: {
		code: { type: 'string' },
		shape: { type: 'string', enum: ['circle', 'square', 'triangle'] },
		color: { type: 'string', enum: ['red', 'green', 'blue'] }
	}
};
const CONTROL_SCHEMA = {
	type: 'object', additionalProperties: false,
	required: ['visible_text', 'description', 'controls'],
	properties: {
		visible_text: { type: 'string' }, description: { type: 'string' },
		controls: { type: 'array', items: { type: 'string' } }
	}
};
const COMPARE_SCHEMA = {
	type: 'object', additionalProperties: false,
	required: ['images', 'open_image_id', 'closed_image_id', 'differences'],
	properties: {
		images: {
			type: 'array', items: {
				type: 'object', additionalProperties: false,
				required: ['image_id', 'visible_text', 'description'],
				properties: { image_id: { type: 'string' }, visible_text: { type: 'string' }, description: { type: 'string' } }
			}
		},
		open_image_id: { type: 'string' }, closed_image_id: { type: 'string' },
		differences: { type: 'array', items: { type: 'string' } }
	}
};

function digest(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
	await fsp.mkdir(EVIDENCE, { recursive: true });
	const log = [];
	const record = (name, request, validation) => {
		const entry = { name, request, validation, at: new Date().toISOString() };
		log.push(entry);
		fs.appendFileSync(path.join(EVIDENCE, 'requests.jsonl'), JSON.stringify(entry) + '\n');
	};
	const projectDir = path.join(DATA_ROOT, 'projects', 'P-edb245e1ef');

	// 1. 随机读图：答案只存在于 ground_truth.json，不进入提示和文件名。
	const card = path.join(EVIDENCE, 'smoke-card.png');
	const truth = pyTestCard(card);
	writeJson(path.join(EVIDENCE, 'ground-truth.json'), truth);
	const cardImage = { image_id: 'card:' + digest(card).slice(0, 16), file: path.relative(projectDir, card), sha256: digest(card), width: 720, height: 420 };
	const read = await probeVision({
		projectDir, question: '读取图片：给出图中的四字符编码，并用英文枚举描述下方几何图形：shape 只能是 circle/square/triangle，color 只能是 red/green/blue。只能依据图片，看不清就写 unknown。', images: [cardImage], schema: CODE_SCHEMA, maxTokens: 1200
	});
	let readJson = {};
	let readPass = false;
	try {
		readJson = parseJson(read.content);
		readPass = String(readJson.code).toUpperCase() === truth.code && readJson.shape === truth.shape && readJson.color === truth.color;
	} catch {
		// 空输出或非 JSON 由记录保留原文，交给后续诊断。
	}
	record('visual_read', read, { pass: readPass, ground_truth: truth, parsed: readJson });

	// 2. 真实控件：P-v5 已截图的高对比按钮，图中可见“经济”。
	const v5ProjectDir = path.join(DATA_ROOT, 'projects', 'P-v5-test');
	const v5Index = loadIndex('P-v5-test');
	const modeObject = objectById(v5Index, 'mcp.e2dcf9cfd0882763ef572836::I314:40131;252:20539;201:19902;167:22883');
	const modeCandidate = await prepareCandidateImages({ projectDir: v5ProjectDir, index: v5Index, candidate: candidateOf(modeObject, 'smoke-control') });
	const modeControl = modeCandidate.images.find((image) => image.role === 'control_crop');
	const control = await probeVision({
		projectDir: v5ProjectDir, question: '这是设计稿中的控件局部图。请读出所有可见文字，描述控件形态和主要颜色。不要猜测。', images: [modeControl], schema: CONTROL_SCHEMA, maxTokens: 1200
	});
	let controlJson = {};
	let controlPass = false;
	try {
		controlJson = parseJson(control.content);
		controlPass = /经济/.test(controlJson.visible_text + ' ' + controlJson.description);
	} catch {
		// 由记录保留原始输出。
	}
	record('real_control', control, { pass: controlPass, object: { id: modeObject.id, name: modeObject.name }, parsed: controlJson });

	// 3. 状态对比：同一页面、同一控件名的关闭/开启设计变体，状态来自设计属性。
	const closed = objectById(v5Index, 'mcp.e2dcf9cfd0882763ef572836::81:721');
	const open = objectById(v5Index, 'mcp.e2dcf9cfd0882763ef572836::81:851');
	const closedPrepared = await prepareCandidateImages({ projectDir: v5ProjectDir, index: v5Index, candidate: candidateOf(closed, 'smoke-closed') });
	const openPrepared = await prepareCandidateImages({ projectDir: v5ProjectDir, index: v5Index, candidate: candidateOf(open, 'smoke-open') });
	const closedImage = closedPrepared.images.find((image) => image.role === 'control_crop');
	const openImage = openPrepared.images.find((image) => image.role === 'control_crop');
	const compare = await probeVision({
		projectDir: v5ProjectDir,
		question: `这是同一页面同一控件名的两个设计状态变体局部图。分别读出可见文字并描述外观差异，然后判断哪一张对应“开启”、哪一张对应“关闭”。image_id=${closedImage.image_id} 与 ${openImage.image_id}。`,
		images: [closedImage, openImage], schema: COMPARE_SCHEMA, maxTokens: 1400
	});
	let compareJson = {};
	let comparePass = false;
	try {
		compareJson = parseJson(compare.content);
		comparePass = compareJson.open_image_id === openImage.image_id && compareJson.closed_image_id === closedImage.image_id;
	} catch {
		// 由记录保留原始输出。
	}
	record('state_compare', compare, {
		pass: comparePass,
		closed: { ui_id: closed.id, state: closed.state, image_id: closedImage.image_id },
		open: { ui_id: open.id, state: open.state, image_id: openImage.image_id },
		parsed: compareJson
	});

	const summary = {
		model: log[0]?.request?.requested_model || '',
		returned_models: [...new Set(log.map((entry) => entry.request.returned_model))],
		tests: log.map((entry) => ({ name: entry.name, pass: entry.validation.pass, response_id: entry.request.response_id, usage: entry.request.usage, latency_ms: entry.request.latency_ms })),
		all_pass: log.every((entry) => entry.validation.pass)
	};
	writeJson(path.join(EVIDENCE, 'summary.json'), summary);
	console.log(JSON.stringify(summary, null, 1));
	if (!summary.all_pass) process.exitCode = 1;
}

main().catch((error) => {
	console.error(JSON.stringify({
		error: String(error?.message || error), kind: error?.kind || '', status: error?.status || 0,
		retry_after: error?.retry_after || 0,
		body: error?.data ? JSON.stringify(error.data).slice(0, 1200) : ''
	}, null, 1));
	process.exitCode = 1;
});