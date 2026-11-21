const assert = require("node:assert");
const median = require("./median.js");
assert.strictEqual(median([3, 1, 2]), 2);
assert.strictEqual(median([4, 1, 3, 2]), 2.5);
console.log("ok");
