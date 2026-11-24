export const REVIEW_STAGES = {
	contracts: { title: '需求合同', id: 'contract_id', checks: '核对原文义务、条件、动作、状态、请求与反馈的区别。指出未确认的信号映射及被合并的不同预期。' },
	outline: { title: '测试大纲', id: 'scenario_id', checks: '核对批准范围与需求覆盖，检查有依据的异常、边界和联动是否缺失。说明必测缺口或范围外事项。' },
	points: { title: '测试点', id: 'point_id', checks: '核对条件、动作、预期和判据。逐项检查发送、即时显示、反馈、时限及其原文去向。' },
	cases: { title: '测试用例', id: 'case_id', checks: '核对前置、准备、步骤、观察对象、通过条件、失败留证、恢复及图证的用途。' }
};

export function authorRole(stage) {
	return ['facts', 'features', 'states', 'contracts'].includes(stage) ? 'requirements' : 'design';
}

export const STAGE_SKILLS = {
	facts: 'cts-facts', features: 'cts-facts', states: 'cts-facts', contracts: 'cts-facts',
	outline: 'cts-test-design', points: 'cts-test-design', cases: 'cts-case-authoring', review: 'cts-review'
};

export const ROLE_INSTRUCTIONS = {
	requirements: '角色：三源分析 Agent。以本轮选定的需求文档、通信/接口矩阵与 UI 设计资料为准，分别提取条件、触发、请求、反馈、界面状态与时限，保持三源对齐与可追溯。字段拼写、收发方向、枚举取值、阈值或时序存在冲突或缺失时，保留原文并标明待裁决事项，不凭常识补全。',
	design: '角色：测试设计与用例编写 Agent。只从当前冻结的需求事实、接口定义、UI 控件与批准范围推导测试设计与可执行用例。兼顾场景覆盖完整、技术参数精确与执行步骤简洁可读，明确区分可执行判据与待确认缺口。',
	review: '角色：独立审查 Agent。只挑错不改写，逐条核对三源一致性、步骤可执行性、预期可判定性与准备/恢复闭环，绝不漏报、不凑数。'
};
