const assert = require("node:assert");
const parseLine = require("./csv.js");
assert.deepStrictEqual(parseLine("a,b,c"), ["a", "b", "c"]);
assert.deepStrictEqual(parseLine('a,"b,c",d'), ["a", "b,c", "d"]);
console.log("ok");
