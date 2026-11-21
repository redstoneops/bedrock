const assert = require("node:assert");
const range = require("./range.js");
assert.deepStrictEqual(range(0, 3), [0, 1, 2]);
console.log("ok");
