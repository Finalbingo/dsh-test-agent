/** 合同草稿的必填字段要显式标出，确认时报错点名缺项。node cts-agent/scripts/test-contracts-fields.mjs */
import assert from 'node:assert/strict';
import { editContract } from '../contracts.js';

const features = [{ feature_id: 'FTR_001' }];
const facts = [{ fact_id: 'F-0001', statement: '单击提交后状态变为待审批', evidence_refs: ['E-0001'] }];
const evidence = [{ id: 'E-0001', source: 'prd/需求.md', location: '2. 提交', text: '单击提交，状态变为待审批。' }];
const base = { feature_id: 'FTR_001', title: '提交', trigger: '单击【提交】', condition: '', expected: '状态变为待审批', fact_refs: ['F-0001'] };

const draft = editContract(null, base, features, facts, evidence, false, []);
assert.deepEqual(draft.missing_fields, ['前置条件']);
assert.equal(draft.status, 'draft');
assert.throws(() => editContract(draft, base, features, facts, evidence, true, []), /请补齐前置条件/);

const complete = editContract(null, { ...base, condition: '文档处于草稿状态' }, features, facts, evidence, false, []);
assert.deepEqual(complete.missing_fields, []);
const approved = editContract(null, { ...base, condition: '文档处于草稿状态' }, features, facts, evidence, true, []);
assert.equal(approved.status, 'approved');
console.log('合同必填字段标记与确认错误点名通过');
