const assert = require("node:assert");
const median = require("./median.js");
assert.strictEqual(median([10]), 10);
assert.strictEqual(median([9, 7, 8, 1, 2]), 7);
assert.strictEqual(median([-1, -3]), -2);
const input = [3, 2, 1];
median(input);
assert.deepStrictEqual(input, [3, 2, 1], "median must not mutate its input");
console.log("holdout ok");
