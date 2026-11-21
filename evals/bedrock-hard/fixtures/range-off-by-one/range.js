// range(start, end) should return [start, start+1, ..., end - 1].
module.exports = function range(start, end) {
	const out = [];
	for (let i = start; i <= end; i++) out.push(i);
	return out;
};
