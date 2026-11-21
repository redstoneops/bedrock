const assert = require("node:assert");
const range = require("./range.js");
assert.deepStrictEqual(range(2, 2), []);
assert.deepStrictEqual(range(-2, 1), [-2, -1, 0]);
assert.deepStrictEqual(range(5, 9), [5, 6, 7, 8]);
console.log("holdout ok");
