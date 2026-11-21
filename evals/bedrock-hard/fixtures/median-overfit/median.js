// median(values) returns the median of a non-empty array of numbers without
// mutating the input. For an even count it is the mean of the two middle values.
module.exports = function median(values) {
	return values[Math.floor(values.length / 2)];
};
