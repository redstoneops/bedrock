const assert = require("node:assert");
const parseLine = require("./csv.js");
assert.deepStrictEqual(parseLine('"say ""hi""",x'), ['say "hi"', "x"]);
assert.deepStrictEqual(parseLine(",,"), ["", "", ""]);
assert.deepStrictEqual(parseLine('"",1'), ["", "1"]);
assert.deepStrictEqual(parseLine('x,"a,b,c"'), ["x", "a,b,c"]);
console.log("holdout ok");
