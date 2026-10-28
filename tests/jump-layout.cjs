const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const context = {$: {}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cep/jump-timeline.jsx'), 'utf8'), context);
const ranges = Array.from({length: 5}, (_, i) => ({start_frame: 1000, end_frame: 1600, timeline_start_frame: 120+i*1200}));
const parts = ranges.flatMap((_, i) => [
  {start_frame: 1020, end_frame: 1200, range_index: i},
  {start_frame: 1300, end_frame: 1500, range_index: i}
]);
const layout = context.$._SVMJumpLayout(parts, ranges);
for (let i=0;i<5;i++) {
  assert.equal(layout.spans[i*2].dest, ranges[i].timeline_start_frame);
  assert.equal(layout.spans[i*2+1].dest, ranges[i].timeline_start_frame+180);
}
assert.equal(layout.content, 1900);
assert.equal(layout.frames, 5300);
assert.throws(() => context.$._SVMJumpLayout(parts.slice().reverse(), ranges));
console.log('Five independent clip groups retain their starts; internal gaps collapse.');
